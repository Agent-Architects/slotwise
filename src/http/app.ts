import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { Service, type Deps } from "../core/service.js";
import { timingSafeEqual } from "../core/crypto.js";
import type { User } from "../core/types.js";
import * as V from "../core/validate.js";
import { ApiError, parse } from "../core/validate.js";

const SESSION_COOKIE = "sw_session";

type Env = {
  Variables: {
    svc: Service;
    user: User;
    auth: { kind: "session"; csrf: string } | { kind: "token"; scopes: string[] };
  };
};

export interface AppOptions {
  /** Build the per-request dependencies (Workers builds them from env bindings). */
  deps: (c: Context) => Deps | Promise<Deps>;
  /** Serve the SPA shell and static assets for non-API paths. */
  assets?: (c: Context) => Promise<Response>;
  adapter: string;
  clientIp: ClientIp;
}

/**
 * Client address for rate limiting. Headers like cf-connecting-ip are only trustworthy when a proxy we control
 * sets them, so each hosting adapter decides: Workers trusts cf-connecting-ip (Cloudflare overwrites it), Node
 * uses the socket address unless TRUST_PROXY names the header its reverse proxy sets.
 */
export type ClientIp = (c: Context) => string;

export const socketIp: ClientIp = (c) => (c.env as any)?.incoming?.socket?.remoteAddress ?? "local";

export function nodeClientIp(trustHeader?: string): ClientIp {
  const h = trustHeader?.trim().toLowerCase();
  if (!h) return socketIp;
  return (c) => {
    const v = c.req.header(h);
    if (!v) return socketIp(c);
    // X-Forwarded-For: the last entry is the one our own proxy appended.
    const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
    return (h === "x-forwarded-for" ? parts[parts.length - 1] : parts[0]) ?? socketIp(c);
  };
}

export const cloudflareClientIp: ClientIp = (c) => c.req.header("cf-connecting-ip") ?? "unknown";

async function body(c: Context): Promise<unknown> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/json")) throw new ApiError(415 as number, "bad_request", "Send JSON with Content-Type: application/json");
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "bad_request", "Malformed JSON");
  }
}

export function createApp(opts: AppOptions) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      const d = err.details as any;
      if (err.status === 429 && d?.retryAfter) c.header("Retry-After", String(d.retryAfter));
      return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status as any);
    }
    console.error("unhandled", err);
    return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
  });

  app.use("*", async (c, next) => {
    c.set("svc", new Service(await opts.deps(c)));
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Frame-Options", "DENY");
    if (!c.req.path.startsWith("/api/")) {
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    } else c.header("Cache-Control", "no-store");
  });

  app.get("/healthz", async (c) => {
    const svc = c.get("svc");
    await svc.db.first("SELECT 1 AS ok");
    const signupOpen = svc.config.allowSignup || (await svc.userCount()) === 0;
    return c.json({
      ok: true,
      name: "slotwise",
      version: svc.config.version,
      adapter: opts.adapter,
      calendarProviders: svc.providers.map((p) => ({ id: p.id, configured: p.configured() })),
      emailProvider: svc.mailer.id,
      signupOpen,
      // Only meaningful while someone can still sign up; once the owner exists on a closed instance it is false.
      setupCodeRequired: signupOpen && Boolean(svc.config.setupCode),
    });
  });

  const api = new Hono<Env>();

  const isSecure = (c: Context) => new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
  const setSession = (c: Context, token: string) =>
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: isSecure(c), sameSite: "Lax", path: "/", maxAge: 30 * 86400 });

  const rl = (bucket: "publicRead" | "publicWrite" | "auth"): MiddlewareHandler<Env> => async (c, next) => {
    const svc = c.get("svc");
    await svc.rateLimit(`${bucket}:${opts.clientIp(c)}`, svc.config.rateLimits[bucket]);
    await next();
  };

  // Cookie-authenticated login/signup must come from our own origin (login CSRF).
  const sameOrigin: MiddlewareHandler<Env> = async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin && origin !== c.get("svc").config.appUrl) {
      throw new ApiError(403, "forbidden", "Cross-origin request refused");
    }
    await next();
  };

  // Owner routes share one auth middleware; unknown paths must still be 404, not 401.
  const OWNER_PREFIXES = ["/me", "/tokens", "/availability", "/schedules", "/event-types", "/bookings", "/notifications", "/integrations", "/dev/"];
  const authOwner: MiddlewareHandler<Env> = async (c, next) => {
    const rel = c.req.path.replace(/^\/api\/v1/, "");
    if (!OWNER_PREFIXES.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`) || (p.endsWith("/") && rel.startsWith(p)))) {
      throw new ApiError(404, "not_found", "No such endpoint");
    }
    const svc = c.get("svc");
    const h = c.req.header("authorization");
    if (h) {
      const m = /^Bearer\s+(\S+)$/i.exec(h);
      const t = m ? await svc.tokenAuth(m[1]!) : null;
      if (!t) throw new ApiError(401, "unauthorized", "Invalid or revoked API token");
      const need = c.req.method === "GET" || c.req.method === "HEAD" ? "read" : "write";
      if (!t.scopes.includes(need)) throw new ApiError(403, "forbidden", `Token lacks the ${need} scope`);
      c.set("user", t.user);
      c.set("auth", { kind: "token", scopes: t.scopes });
      return next();
    }
    const cookie = getCookie(c, SESSION_COOKIE);
    const s = cookie ? await svc.session(cookie) : null;
    if (!s) throw new ApiError(401, "unauthorized", "Sign in required");
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const sent = c.req.header("x-csrf-token") ?? "";
      if (!timingSafeEqual(sent, s.csrf)) throw new ApiError(403, "forbidden", "Missing or invalid CSRF token");
    }
    c.set("user", s.user);
    c.set("auth", { kind: "session", csrf: s.csrf });
    return next();
  };

  const sessionOnly: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get("auth").kind !== "session") throw new ApiError(403, "forbidden", "New API tokens can only be created from a signed-in browser session or POST /auth/token");
    await next();
  };

  // ----- auth -----
  api.post("/auth/signup", rl("auth"), sameOrigin, async (c) => {
    const svc = c.get("svc");
    const input = parse(V.signup, await body(c));
    const user = await svc.signup(input);
    const s = await svc.createSession(user.id);
    setSession(c, s.token);
    return c.json({ user, csrfToken: s.csrf }, 201);
  });

  api.post("/auth/login", rl("auth"), sameOrigin, async (c) => {
    const svc = c.get("svc");
    const input = parse(V.login, await body(c));
    const user = await svc.login(input.email, input.password);
    const s = await svc.createSession(user.id);
    setSession(c, s.token);
    return c.json({ user, csrfToken: s.csrf });
  });

  api.post("/auth/logout", async (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      const svc = c.get("svc");
      const s = await svc.session(cookie);
      if (s && !timingSafeEqual(c.req.header("x-csrf-token") ?? "", s.csrf)) throw new ApiError(403, "forbidden", "Missing or invalid CSRF token");
      await svc.deleteSession(cookie);
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  api.get("/auth/session", async (c) => {
    const svc = c.get("svc");
    const cookie = getCookie(c, SESSION_COOKIE);
    const s = cookie ? await svc.session(cookie) : null;
    if (!s) throw new ApiError(401, "unauthorized", "Not signed in");
    return c.json({ user: s.user, csrfToken: s.csrf });
  });

  api.post("/auth/token", rl("auth"), async (c) => {
    const svc = c.get("svc");
    const input = parse(V.tokenExchange, await body(c));
    const user = await svc.login(input.email, input.password);
    return c.json(await svc.createApiToken(user.id, input.name, input.scopes), 201);
  });

  // ----- owner -----
  const owner = new Hono<Env>();
  owner.use("*", authOwner);

  owner.get("/me", (c) => c.json({ user: c.get("user") }));
  owner.patch("/me", async (c) => c.json({ user: await c.get("svc").patchUser(c.get("user").id, parse(V.profilePatch, await body(c))) }));
  owner.post("/me/password", async (c) => {
    const p = parse(V.passwordChange, await body(c));
    const keep = c.get("auth").kind === "session" ? getCookie(c, SESSION_COOKIE) : undefined;
    const r = await c.get("svc").changePassword(c.get("user").id, p.currentPassword, p.newPassword, keep, p.revokeTokens);
    return c.json({ ok: true, ...r });
  });
  owner.post("/me/email", async (c) => {
    const p = parse(V.emailChange, await body(c));
    return c.json({ user: await c.get("svc").changeEmail(c.get("user").id, p.currentPassword, p.email) });
  });
  owner.get("/me/links", async (c) => c.json(await c.get("svc").links(c.get("user"))));

  owner.get("/tokens", async (c) => c.json({ items: await c.get("svc").listTokens(c.get("user").id) }));
  owner.post("/tokens", sessionOnly, async (c) => {
    const p = parse(V.tokenCreate, await body(c));
    return c.json(await c.get("svc").createApiToken(c.get("user").id, p.name, p.scopes), 201);
  });
  owner.delete("/tokens/:id", async (c) => {
    await c.get("svc").revokeToken(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });

  owner.get("/availability", async (c) => c.json({ availability: await c.get("svc").getAvailability(c.get("user").id) }));
  owner.patch("/availability", async (c) =>
    c.json({ availability: await c.get("svc").patchAvailability(c.get("user").id, parse(V.availabilityPatch, await body(c))) }),
  );
  owner.put("/availability/overrides/:date", async (c) => {
    const date = parse(V.dateStr, c.req.param("date"));
    const p = parse(V.overridePut, await body(c));
    return c.json({ availability: await c.get("svc").setOverride(c.get("user").id, date, p.intervals) });
  });
  owner.delete("/availability/overrides/:date", async (c) => {
    const date = parse(V.dateStr, c.req.param("date"));
    return c.json({ availability: await c.get("svc").setOverride(c.get("user").id, date, null) });
  });

  owner.get("/event-types", async (c) => {
    const svc = c.get("svc");
    const u = c.get("user");
    return c.json({ items: (await svc.listEventTypes(u.id)).map((e) => svc.withUrl(u.username, e)) });
  });
  owner.post("/event-types", async (c) => {
    const svc = c.get("svc");
    const u = c.get("user");
    const e = await svc.createEventType(u.id, parse(V.eventTypeCreate, await body(c)));
    return c.json({ eventType: svc.withUrl(u.username, e) }, 201);
  });
  owner.get("/event-types/:id", async (c) => {
    const svc = c.get("svc");
    const u = c.get("user");
    return c.json({ eventType: svc.withUrl(u.username, await svc.getEventType(u.id, c.req.param("id"))) });
  });
  owner.patch("/event-types/:id", async (c) => {
    const svc = c.get("svc");
    const u = c.get("user");
    const e = await svc.patchEventType(u.id, c.req.param("id"), parse(V.eventTypePatch, await body(c)));
    return c.json({ eventType: svc.withUrl(u.username, e) });
  });
  owner.delete("/event-types/:id", async (c) => {
    await c.get("svc").deleteEventType(c.get("user").id, c.req.param("id"), c.req.query("force") === "true");
    return c.json({ ok: true });
  });

  const listQuery = z.object({
    status: z.enum(["upcoming", "past", "cancelled", "all", "range"]).default("upcoming"),
    from: V.isoInstant.optional(),
    to: V.isoInstant.optional(),
    eventTypeId: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().max(80).optional(),
  });
  owner.get("/bookings", async (c) => c.json(await c.get("svc").listBookings(c.get("user").id, parse(listQuery, c.req.query()))));
  owner.get("/bookings/export", async (c) => {
    const q = parse(listQuery.omit({ limit: true, cursor: true }), c.req.query());
    const csv = await c.get("svc").exportCsv(c.get("user").id, q);
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="slotwise-meetings-${q.status}.csv"`,
    });
  });
  owner.get("/bookings/:id", async (c) => c.json({ booking: await c.get("svc").ownerBooking(c.get("user").id, c.req.param("id")) }));
  const slotRange = z.object({ from: V.dateStr, to: V.dateStr, timezone: V.tz });
  owner.get("/bookings/:id/slots", async (c) => c.json(await c.get("svc").ownerBookingSlots(c.get("user").id, c.req.param("id"), parse(slotRange, c.req.query()))));
  owner.post("/bookings/:id/reschedule", async (c) => {
    const p = parse(z.object({ start: V.isoInstant }), await body(c));
    return c.json({ booking: await c.get("svc").rescheduleByOwner(c.get("user").id, c.req.param("id"), p.start) });
  });
  owner.post("/bookings/:id/request-reschedule", async (c) => {
    const raw = c.req.header("content-type")?.includes("application/json") ? await body(c) : {};
    const p = parse(V.ownerCancel, raw);
    return c.json({ booking: await c.get("svc").requestReschedule(c.get("user").id, c.req.param("id"), p.reason) });
  });
  owner.post("/bookings/:id/cancel", async (c) => {
    const raw = c.req.header("content-type")?.includes("application/json") ? await body(c) : {};
    const p = parse(V.ownerCancel, raw);
    return c.json({ booking: await c.get("svc").cancelByOwner(c.get("user").id, c.req.param("id"), p.reason) });
  });

  owner.get("/me/alerts", async (c) => c.json({ items: await c.get("svc").alerts(c.get("user").id) }));

  owner.get("/schedules", async (c) => c.json({ items: await c.get("svc").listSchedules(c.get("user").id) }));
  owner.post("/schedules", async (c) => c.json({ schedule: await c.get("svc").createSchedule(c.get("user").id, parse(V.scheduleCreate, await body(c))) }, 201));
  owner.get("/schedules/:id", async (c) => c.json({ schedule: await c.get("svc").getSchedule(c.get("user").id, c.req.param("id")) }));
  owner.patch("/schedules/:id", async (c) =>
    c.json({ schedule: await c.get("svc").patchSchedule(c.get("user").id, c.req.param("id"), parse(V.schedulePatch, await body(c))) }),
  );
  owner.delete("/schedules/:id", async (c) => {
    await c.get("svc").deleteSchedule(c.get("user").id, c.req.param("id"), c.req.query("force") === "true");
    return c.json({ ok: true });
  });
  owner.put("/schedules/:id/overrides/:date", async (c) => {
    const date = parse(V.dateStr, c.req.param("date"));
    const p = parse(V.overridePut, await body(c));
    return c.json({ schedule: await c.get("svc").setScheduleOverride(c.get("user").id, c.req.param("id"), date, p.intervals) });
  });
  owner.delete("/schedules/:id/overrides/:date", async (c) => {
    const date = parse(V.dateStr, c.req.param("date"));
    return c.json({ schedule: await c.get("svc").setScheduleOverride(c.get("user").id, c.req.param("id"), date, null) });
  });

  owner.get("/notifications", async (c) => c.json({ items: await c.get("svc").listNotifications(c.get("user").id, c.req.query("bookingId")) }));

  owner.get("/integrations", async (c) => {
    const svc = c.get("svc");
    const conns = await svc.connections(c.get("user").id);
    return c.json({
      providers: svc.providers.map((p) => ({ id: p.id, name: p.name, configured: p.configured() })),
      connections: conns.map((r) => svc.connectionView(r)),
      email: { provider: svc.mailer.id },
      appUrl: svc.config.appUrl,
    });
  });
  owner.post("/integrations/:provider/connect", async (c) => c.json({ url: await c.get("svc").startConnect(c.get("user").id, c.req.param("provider")) }));
  owner.get("/integrations/connections/:id/calendars", async (c) => c.json({ items: await c.get("svc").listCalendars(c.get("user").id, c.req.param("id")) }));
  owner.patch("/integrations/connections/:id", async (c) =>
    c.json({ connection: await c.get("svc").patchConnection(c.get("user").id, c.req.param("id"), parse(V.connectionPatch, await body(c))) }),
  );
  owner.delete("/integrations/connections/:id", async (c) => {
    await c.get("svc").deleteConnection(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });

  owner.get("/dev/mock-calendar/events", async (c) => {
    if (!c.get("svc").config.mockCalendar) throw new ApiError(404, "not_found", "Not found");
    return c.json({ items: await c.get("svc").mockEvents(c.get("user").id) });
  });
  owner.post("/dev/mock-calendar/events", async (c) => {
    if (!c.get("svc").config.mockCalendar) throw new ApiError(404, "not_found", "Not found");
    return c.json({ event: await c.get("svc").addMockBusy(c.get("user").id, parse(V.mockEvent, await body(c))) }, 201);
  });
  // Simulates the provider failing (expired grant, outage) so fail-closed behavior can be verified.
  owner.post("/dev/mock-calendar/fail", async (c) => {
    if (!c.get("svc").config.mockCalendar) throw new ApiError(404, "not_found", "Not found");
    const p = parse(z.object({ fail: z.boolean() }), await body(c));
    await c.get("svc").setMockFailure(c.get("user").id, p.fail);
    return c.json({ fail: p.fail });
  });

  // ----- public -----
  const pub = new Hono<Env>();
  pub.get("*", rl("publicRead"));
  pub.post("*", rl("publicWrite"));

  pub.get("/users/:username", async (c) => {
    const svc = c.get("svc");
    const u = await svc.userByUsername(c.req.param("username"));
    const ets = (await svc.listEventTypes(u.id)).filter((e) => e.active);
    return c.json({ owner: svc.publicOwner(u), eventTypes: ets.map((e) => svc.publicEventTypeView(e)) });
  });
  pub.get("/users/:username/event-types/:slug", async (c) => {
    const svc = c.get("svc");
    const { owner, eventType } = await svc.publicEventType(c.req.param("username"), c.req.param("slug"));
    const av = await svc.getAvailability(owner.id);
    return c.json({ owner: svc.publicOwner(owner), eventType: { ...svc.publicEventTypeView(eventType), maxGuests: av.maxGuests } });
  });
  const slotsQuery = z.object({
    from: V.dateStr,
    to: V.dateStr,
    timezone: V.tz,
    duration: z.coerce.number().int().optional(),
    excludeBooking: z.string().max(40).optional(),
    token: z.string().max(200).optional(),
  });
  pub.get("/users/:username/event-types/:slug/slots", async (c) => {
    const q = parse(slotsQuery, c.req.query());
    return c.json(await c.get("svc").publicSlots(c.req.param("username"), c.req.param("slug"), q));
  });
  pub.post("/bookings", async (c) => c.json(await c.get("svc").createBooking(parse(V.bookingCreate, await body(c))), 201));
  pub.get("/bookings/:id", async (c) => c.json(await c.get("svc").publicBooking(c.req.param("id"), c.req.query("token") ?? "")));
  pub.post("/bookings/:id/cancel", async (c) => {
    const p = parse(V.bookingCancel, await body(c));
    return c.json({ booking: await c.get("svc").cancelByInvitee(c.req.param("id"), p.token, p.reason) });
  });
  pub.post("/bookings/:id/reschedule", async (c) => {
    const p = parse(V.bookingReschedule, await body(c));
    return c.json({ booking: await c.get("svc").reschedule(c.req.param("id"), p.token, p.start, p.timezone) });
  });

  api.route("/public", pub);
  api.route("/", owner);
  api.all("*", () => {
    throw new ApiError(404, "not_found", "No such endpoint");
  });
  app.route("/api/v1", api);

  app.get("/oauth/:provider/callback", async (c) => {
    const svc = c.get("svc");
    const provider = c.req.param("provider");
    const err = c.req.query("error");
    if (err) return c.redirect(`/app/integrations?error=${encodeURIComponent(err)}`);
    const cookie = getCookie(c, SESSION_COOKIE);
    const s = cookie ? await svc.session(cookie) : null;
    try {
      await svc.finishConnect(provider, c.req.query("code") ?? "", c.req.query("state") ?? "", s?.user.id ?? null);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not connect the calendar";
      if (!(e instanceof ApiError)) console.error("oauth callback", e);
      return c.redirect(`/app/integrations?error=${encodeURIComponent(msg)}`);
    }
    return c.redirect(`/app/integrations?connected=${encodeURIComponent(provider)}`);
  });

  if (opts.assets) {
    const assets = opts.assets;
    app.get("*", (c) => assets(c));
  }
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  return app;
}
