import { describe, expect, it } from "vitest";
import brand from "../../brand.json";
import { makeApp } from "./helpers";

// Clock: Monday 2026-11-23 12:00Z (07:00 New York). Owner default hours Mon-Fri 09:00-17:00 New York, min notice 4h.
const TUE_10 = "2026-11-24T15:00:00.000Z"; // Tue 10:00 New York
const TUE_1030 = "2026-11-24T15:30:00.000Z";

async function ownerWithToken(t: ReturnType<typeof makeApp>) {
  const user = await t.signup();
  const tok = await t.req("POST", "/api/v1/tokens", { name: "test", scopes: ["read", "write"] });
  expect(tok.status).toBe(201);
  return { user, auth: { authorization: `Bearer ${tok.body.token}` } };
}

function bookBody(p: Record<string, unknown> = {}) {
  return { username: "olive", slug: "30min", start: TUE_10, timezone: "Europe/Berlin", name: "Ivan Invitee", email: "Ivan@Example.com", ...p };
}

describe("auth and security", () => {
  it("signup creates defaults and then closes signup", async () => {
    const t = makeApp();
    const u = await t.signup();
    expect(u.username).toBe("olive");
    const ets = await t.req("GET", "/api/v1/event-types");
    expect(ets.body.items.map((e: any) => e.slug)).toEqual(["30min"]);
    // The default event type takes the brand color, whatever brand.json currently says.
    expect(ets.body.items[0].color).toBe(brand.primary);
    t.clearSession();
    const again = await t.req("POST", "/api/v1/auth/signup", { email: "x@example.com", password: "0123456789ab", name: "X", username: "xxx", timezone: "UTC" });
    expect(again.status).toBe(403);
  });

  it("login, session, logout and wrong password", async () => {
    const t = makeApp();
    await t.signup();
    t.clearSession();
    expect((await t.req("GET", "/api/v1/auth/session")).status).toBe(401);
    expect((await t.req("POST", "/api/v1/auth/login", { email: "owner@example.com", password: "nope" })).status).toBe(401);
    const ok = await t.req("POST", "/api/v1/auth/login", { email: "OWNER@example.com", password: "correct horse battery" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect((await t.req("GET", "/api/v1/auth/session")).status).toBe(200);
    expect((await t.req("POST", "/api/v1/auth/logout")).status).toBe(200);
    expect((await t.req("GET", "/api/v1/me")).status).toBe(401);
  });

  it("cookie-authenticated mutations need the CSRF token", async () => {
    const t = makeApp();
    await t.signup();
    const r = await t.req("PATCH", "/api/v1/me", { name: "Hacked" }, { "x-csrf-token": "wrong" });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/CSRF/);
    expect((await t.req("PATCH", "/api/v1/me", { name: "Olive O." })).body.user.name).toBe("Olive O.");
  });

  it("refuses cross-origin login", async () => {
    const t = makeApp();
    await t.signup();
    const r = await t.req("POST", "/api/v1/auth/login", { email: "owner@example.com", password: "correct horse battery" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("API tokens: hashed at rest, scoped, revocable", async () => {
    const t = makeApp();
    await t.signup();
    const ro = await t.req("POST", "/api/v1/tokens", { name: "ro", scopes: ["read"] });
    const token = ro.body.token as string;
    expect(token).toMatch(/^sw_/);
    const rows = await t.db.all<any>("SELECT * FROM api_tokens");
    expect(JSON.stringify(rows)).not.toContain(token);
    const auth = { authorization: `Bearer ${token}` };
    expect((await t.req("GET", "/api/v1/event-types", undefined, auth)).status).toBe(200);
    expect((await t.req("POST", "/api/v1/event-types", { name: "Nope" }, auth)).status).toBe(403);
    expect((await t.req("POST", "/api/v1/tokens", { name: "x", scopes: ["read"] }, auth)).status).toBe(403);
    expect((await t.req("DELETE", `/api/v1/tokens/${ro.body.apiToken.id}`)).status).toBe(200);
    expect((await t.req("GET", "/api/v1/event-types", undefined, auth)).status).toBe(401);
  });

  it("password exchange issues a CLI token", async () => {
    const t = makeApp();
    await t.signup();
    t.clearSession();
    const r = await t.req("POST", "/api/v1/auth/token", { email: "owner@example.com", password: "correct horse battery", name: "cli" });
    expect(r.status).toBe(201);
    expect((await t.req("GET", "/api/v1/me", undefined, { authorization: `Bearer ${r.body.token}` })).body.user.username).toBe("olive");
  });

  it("validates input and reports field issues", async () => {
    const t = makeApp();
    await t.signup();
    const bad = await t.req("PATCH", "/api/v1/availability", { timezone: "Mars/Olympus", weekly: { "1": [{ start: "10:00", end: "09:00" }] } });
    expect(bad.status).toBe(400);
    const paths = bad.body.error.details.issues.map((i: any) => i.path);
    expect(paths).toContain("timezone");
    const overlap = await t.req("PATCH", "/api/v1/availability", { weekly: { "1": [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] } });
    expect(overlap.status).toBe(400);
    expect((await t.req("POST", "/api/v1/event-types", { name: "Z", location: { kind: "zoom", value: "not a url" } })).status).toBe(400);
  });

  it("rate limits public booking writes", async () => {
    const t = makeApp({ env: { RATE_LIMIT_PUBLIC_WRITE: "3" } });
    await t.signup();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await t.req("POST", "/api/v1/public/bookings", bookBody({ start: "2026-11-25T15:00:00Z", email: `a${i}@example.org` }))).status);
    expect(codes.slice(0, 3).filter((c) => c === 429)).toHaveLength(0);
    expect(codes[3]).toBe(429);
    const r = await t.req("POST", "/api/v1/public/bookings", bookBody());
    expect(r.headers.get("retry-after")).toBeTruthy();
  });
});

describe("availability and event types", () => {
  it("defaults a new event type to Google Meet only when a calendar is connected", async () => {
    const t = makeApp();
    await t.signup();
    const before = await t.req("POST", "/api/v1/event-types", { name: "No calendar" });
    expect(before.status).toBe(201);
    expect(before.body.eventType.location).toEqual({ kind: "custom", value: "The organizer will share meeting details" });
    const start = await t.req("POST", "/api/v1/integrations/mock/connect");
    const u = new URL(start.body.url);
    await t.req("GET", `${u.pathname}${u.search}`);
    expect((await t.req("POST", "/api/v1/event-types", { name: "With calendar" })).body.eventType.location).toEqual({ kind: "google_meet" });
    // An explicit location always wins.
    expect((await t.req("POST", "/api/v1/event-types", { name: "Phone", location: { kind: "phone" } })).body.eventType.location).toEqual({ kind: "phone" });
  });

  it("overrides change public slots", async () => {
    const t = makeApp();
    await t.signup();
    const before = await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=America/New_York");
    expect(before.body.days[0].slots).toHaveLength(16);
    await t.req("PUT", "/api/v1/availability/overrides/2026-11-24", { intervals: [{ start: "12:00", end: "13:00" }] });
    const after = await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=America/New_York");
    expect(after.body.days[0].slots.map((s: any) => s.start)).toEqual(["2026-11-24T17:00:00.000Z", "2026-11-24T17:30:00.000Z"]);
    await t.req("PUT", "/api/v1/availability/overrides/2026-11-24", { intervals: [] });
    expect((await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=America/New_York")).body.days).toEqual([]);
    await t.req("DELETE", "/api/v1/availability/overrides/2026-11-24");
    expect((await t.req("GET", "/api/v1/availability")).body.availability.overrides).toEqual({});
  });

  it("event type CRUD, slugs and visibility", async () => {
    const t = makeApp();
    await t.signup();
    const c = await t.req("POST", "/api/v1/event-types", {
      name: "Intro Call!",
      durations: [15, 45],
      location: { kind: "phone" },
      questions: [{ id: "topic", label: "Topic", kind: "select", required: true, options: ["Sales", "Support"] }],
    });
    expect(c.status).toBe(201);
    expect(c.body.eventType.slug).toBe("intro-call");
    expect(c.body.eventType.defaultDuration).toBe(15);
    expect(c.body.eventType.url).toBe("http://slotwise.test/olive/intro-call");
    const dup = await t.req("POST", "/api/v1/event-types", { name: "Other", slug: "intro-call" });
    expect(dup.status).toBe(409);
    const pub = await t.req("GET", "/api/v1/public/users/olive");
    expect(pub.body.eventTypes).toHaveLength(2);
    expect(JSON.stringify(pub.body)).not.toContain("owner@example.com");
    await t.req("PATCH", `/api/v1/event-types/${c.body.eventType.id}`, { active: false });
    expect((await t.req("GET", "/api/v1/public/users/olive")).body.eventTypes).toHaveLength(1);
    expect((await t.req("GET", "/api/v1/public/users/olive/event-types/intro-call")).status).toBe(404);
    expect((await t.req("DELETE", `/api/v1/event-types/${c.body.eventType.id}`)).status).toBe(200);
    const links = await t.req("GET", "/api/v1/me/links");
    expect(links.body.profileUrl).toBe("http://slotwise.test/olive");
  });

  it("validates custom answers and phone", async () => {
    const t = makeApp();
    await t.signup();
    await t.req("POST", "/api/v1/event-types", {
      name: "Call",
      location: { kind: "phone" },
      questions: [{ id: "topic", label: "Topic", kind: "select", required: true, options: ["Sales", "Support"] }],
    });
    const missing = await t.req("POST", "/api/v1/public/bookings", bookBody({ slug: "call" }));
    expect(missing.status).toBe(400);
    const badOpt = await t.req("POST", "/api/v1/public/bookings", bookBody({ slug: "call", answers: { topic: "Other" }, phone: "+1 555 0100" }));
    expect(badOpt.status).toBe(400);
    const ok = await t.req("POST", "/api/v1/public/bookings", bookBody({ slug: "call", answers: { topic: "Sales" }, phone: "+1 555 0100" }));
    expect(ok.status).toBe(201);
    expect(ok.body.booking.answers).toEqual({ topic: "Sales" });
    expect(ok.body.booking.location).toEqual({ kind: "phone", value: "+1 555 0100" });
  });
});

describe("booking lifecycle", () => {
  it("book, notify, view, reschedule, cancel", async () => {
    const t = makeApp();
    await ownerWithToken(t);
    const slots = await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=Europe/Berlin");
    expect(slots.body.days[0].date).toBe("2026-11-24");
    expect(slots.body.days[0].slots[0].start).toBe("2026-11-24T14:00:00.000Z");

    const b = await t.req("POST", "/api/v1/public/bookings", bookBody({ guests: ["g@example.com"] }));
    expect(b.status).toBe(201);
    const { booking, manageToken, manageUrl } = b.body;
    expect(booking.invitee.email).toBe("ivan@example.com");
    expect(booking.localDate).toBe("2026-11-24");
    expect(manageUrl).toBe(`http://slotwise.test/booking/${booking.id}?token=${encodeURIComponent(manageToken)}`);
    const stored = await t.db.first<any>("SELECT * FROM bookings WHERE id = ?", [booking.id]);
    expect(JSON.stringify(stored)).not.toContain(manageToken);

    // slot is gone
    const after = await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=UTC");
    expect(after.body.days[0].slots.map((s: any) => s.start)).not.toContain(TUE_10);

    const notes = await t.req("GET", `/api/v1/notifications?bookingId=${booking.id}`);
    expect(notes.body.items.map((n: any) => `${n.kind}:${n.audience}`).sort()).toEqual(["booked:guest", "booked:invitee", "booked:owner"]);
    expect(notes.body.items.find((n: any) => n.audience === "guest").to).toBe("g@example.com");
    expect(notes.body.items.find((n: any) => n.audience === "guest").body).not.toContain(manageToken);
    const inviteeMail = notes.body.items.find((n: any) => n.audience === "invitee");
    expect(inviteeMail.body).toContain(manageUrl);
    expect(inviteeMail.body).toContain("Europe/Berlin");

    expect((await t.req("GET", `/api/v1/public/bookings/${booking.id}?token=wrong-token-123`)).status).toBe(404);
    const view = await t.req("GET", `/api/v1/public/bookings/${booking.id}?token=${encodeURIComponent(manageToken)}`);
    expect(view.body.owner.name).toBe("Olive Owner");

    const upcoming = await t.req("GET", "/api/v1/bookings?status=upcoming");
    expect(upcoming.body.items).toHaveLength(1);

    const rs = await t.req("POST", `/api/v1/public/bookings/${booking.id}/reschedule`, { token: manageToken, start: "2026-11-25T16:00:00Z" });
    expect(rs.status).toBe(200);
    expect(rs.body.booking.start).toBe("2026-11-25T16:00:00.000Z");
    expect(rs.body.booking.rescheduleCount).toBe(1);
    // the old slot is free again
    const freed = await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=UTC");
    expect(freed.body.days[0].slots.map((s: any) => s.start)).toContain(TUE_10);

    const cancel = await t.req("POST", `/api/v1/public/bookings/${booking.id}/cancel`, { token: manageToken, reason: "Conflict" });
    expect(cancel.body.booking.status).toBe("cancelled");
    expect(cancel.body.booking.cancelledBy).toBe("invitee");
    expect((await t.req("POST", `/api/v1/public/bookings/${booking.id}/cancel`, { token: manageToken })).status).toBe(409);
    expect((await t.req("GET", "/api/v1/bookings?status=cancelled")).body.items).toHaveLength(1);
    const kinds = (await t.req("GET", `/api/v1/notifications?bookingId=${booking.id}`)).body.items.map((n: any) => n.kind);
    expect(kinds.filter((k: string) => k === "rescheduled")).toHaveLength(3);
    expect(kinds.filter((k: string) => k === "cancelled")).toHaveLength(3);
  });

  it("owner cancel via API token", async () => {
    const t = makeApp();
    const { auth } = await ownerWithToken(t);
    const b = await t.req("POST", "/api/v1/public/bookings", bookBody());
    const c = await t.req("POST", `/api/v1/bookings/${b.body.booking.id}/cancel`, { reason: "Sick" }, auth);
    expect(c.status).toBe(200);
    expect(c.body.booking.cancelledBy).toBe("owner");
    expect(c.body.booking.cancelReason).toBe("Sick");
  });

  it("rejects starts that are not offered", async () => {
    const t = makeApp();
    await t.signup();
    for (const start of [
      "2026-11-24T15:10:00Z", // off grid
      "2026-11-24T05:00:00Z", // outside hours
      "2026-11-23T15:00:00Z", // inside min notice (now is 12:00Z, notice 4h)
      "2026-11-28T15:00:00Z", // Saturday
      "2027-06-01T14:00:00Z", // beyond 60 days
    ]) {
      const r = await t.req("POST", "/api/v1/public/bookings", bookBody({ start }));
      expect(r.status, start).toBe(409);
    }
    expect((await t.req("POST", "/api/v1/public/bookings", bookBody({ duration: 45 }))).status).toBe(400);
  });

  it("enforces daily limits with limit_reached", async () => {
    const t = makeApp();
    await t.signup();
    await t.req("PATCH", "/api/v1/availability", { maxPerDay: 1 });
    expect((await t.req("POST", "/api/v1/public/bookings", bookBody())).status).toBe(201);
    const second = await t.req("POST", "/api/v1/public/bookings", bookBody({ start: "2026-11-24T18:00:00Z", email: "b@example.org" }));
    expect(second.status).toBe(409);
    const day = await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-25&timezone=America/New_York");
    expect(day.body.days.map((d: any) => d.date)).toEqual(["2026-11-25"]);
  });

  it("buffers stored at booking time protect neighbours", async () => {
    const t = makeApp();
    await t.signup();
    await t.req("PATCH", "/api/v1/availability", { bufferAfter: 30 });
    expect((await t.req("POST", "/api/v1/public/bookings", bookBody())).status).toBe(201);
    expect((await t.req("POST", "/api/v1/public/bookings", bookBody({ start: TUE_1030, email: "c@example.org" }))).status).toBe(409);
    expect((await t.req("POST", "/api/v1/public/bookings", bookBody({ start: "2026-11-24T16:00:00Z", email: "d@example.org" }))).status).toBe(201);
  });
});

describe("calendar integration (mock provider)", () => {
  it("connect, hide busy, write events, cancel them, keep tokens encrypted", async () => {
    const t = makeApp();
    await t.signup();
    const ints = await t.req("GET", "/api/v1/integrations");
    expect(ints.body.providers.map((p: any) => p.id)).toEqual(["google", "mock"]);
    expect(ints.body.providers.find((p: any) => p.id === "google").configured).toBe(false);
    expect((await t.req("POST", "/api/v1/integrations/google/connect")).status).toBe(400);

    const start = await t.req("POST", "/api/v1/integrations/mock/connect");
    const url = new URL(start.body.url);
    expect(url.pathname).toBe("/oauth/mock/callback");
    const cb = await t.req("GET", `${url.pathname}${url.search}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/app/integrations?connected=mock");
    // state is single use
    expect((await t.req("GET", `${url.pathname}${url.search}`)).headers.get("location")).toMatch(/error=/);

    const conns = (await t.req("GET", "/api/v1/integrations")).body.connections;
    expect(conns).toHaveLength(1);
    expect(conns[0].checkCalendarIds).toEqual(["primary"]);
    expect(conns[0].writeCalendarId).toBe("primary");
    const raw = await t.db.first<any>("SELECT enc_tokens FROM calendar_connections");
    expect(raw.enc_tokens).toMatch(/^v1\./);
    expect(raw.enc_tokens).not.toContain("accessToken");

    await t.req("POST", "/api/v1/dev/mock-calendar/events", { start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" });
    const slots = await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=UTC");
    const starts = slots.body.days[0].slots.map((s: any) => s.start);
    expect(starts).not.toContain(TUE_10);
    expect(starts).not.toContain(TUE_1030);
    expect((await t.req("POST", "/api/v1/public/bookings", bookBody())).status).toBe(409);

    const b = await t.req("POST", "/api/v1/public/bookings", bookBody({ start: "2026-11-24T17:00:00Z" }));
    expect(b.status).toBe(201);
    expect(b.body.booking.external.calendarId).toBe("primary");
    expect(b.body.booking.location.joinUrl).toMatch(/^https:\/\/meet\.mock\.invalid\//);
    const evs = (await t.req("GET", "/api/v1/dev/mock-calendar/events")).body.items;
    const written = evs.find((e: any) => e.source === "app");
    expect(written.attendees[0].email).toBe("ivan@example.com");
    expect(written.summary).toBe("30 minute meeting with Ivan Invitee");

    await t.req("POST", `/api/v1/public/bookings/${b.body.booking.id}/reschedule`, { token: b.body.manageToken, start: "2026-11-24T18:00:00Z" });
    const moved = (await t.req("GET", "/api/v1/dev/mock-calendar/events")).body.items.find((e: any) => e.source === "app");
    expect(moved.start).toBe("2026-11-24T18:00:00.000Z");

    await t.req("POST", `/api/v1/bookings/${b.body.booking.id}/cancel`, {});
    const cancelled = (await t.req("GET", "/api/v1/dev/mock-calendar/events")).body.items.find((e: any) => e.source === "app");
    expect(cancelled.status).toBe("cancelled");
  });

  it("OAuth callback must come from the owner who started it", async () => {
    const t = makeApp({ env: { ALLOW_SIGNUP: "true" } });
    await t.signup();
    const start = await t.req("POST", "/api/v1/integrations/mock/connect");
    const url = new URL(start.body.url);
    t.clearSession();
    await t.signup({ email: "mallory@example.com", username: "mallory" });
    const cb = await t.req("GET", `${url.pathname}${url.search}`);
    expect(cb.headers.get("location")).toMatch(/error=/);
    expect((await t.req("GET", "/api/v1/integrations")).body.connections).toHaveLength(0);
  });
});

describe("concurrency", () => {
  it("exactly one of many concurrent requests for the same slot wins", async () => {
    const t = makeApp();
    await t.signup();
    const N = 30;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => t.req("POST", "/api/v1/public/bookings", bookBody({ email: `p${i}@example.org` }))));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(N - 1);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("slot_taken");
    const n = await t.db.first<any>("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'");
    expect(n.n).toBe(1);
  });

  it("overlapping slots of different durations cannot both be booked", async () => {
    const t = makeApp();
    await t.signup();
    await t.req("POST", "/api/v1/event-types", { name: "Long", slug: "long", durations: [60] });
    const reqs = [];
    for (let i = 0; i < 10; i++) {
      reqs.push(t.req("POST", "/api/v1/public/bookings", bookBody({ slug: "long", start: TUE_10, email: `l${i}@example.org` })));
      reqs.push(t.req("POST", "/api/v1/public/bookings", bookBody({ start: TUE_1030, email: `s${i}@example.org` })));
    }
    const codes = (await Promise.all(reqs)).map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
  });

  it("concurrent reschedules into the same slot: one wins", async () => {
    const t = makeApp();
    await t.signup();
    const a = await t.req("POST", "/api/v1/public/bookings", bookBody({ start: "2026-11-25T15:00:00Z" }));
    const b = await t.req("POST", "/api/v1/public/bookings", bookBody({ start: "2026-11-25T16:00:00Z", email: "b@example.org" }));
    const target = "2026-11-26T15:00:00Z";
    const res = await Promise.all([
      t.req("POST", `/api/v1/public/bookings/${a.body.booking.id}/reschedule`, { token: a.body.manageToken, start: target }),
      t.req("POST", `/api/v1/public/bookings/${b.body.booking.id}/reschedule`, { token: b.body.manageToken, start: target }),
      t.req("POST", "/api/v1/public/bookings", bookBody({ start: target, email: "c@example.org" })),
    ]);
    expect(res.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
  });
});

describe("setup code", () => {
  it("signup requires SETUP_CODE when configured", async () => {
    const t = makeApp({ env: { SETUP_CODE: "open-sesame-123" } });
    const body = { email: "o@example.com", password: "correct horse battery", name: "O", username: "ooo", timezone: "UTC" };
    expect((await t.req("GET", "/healthz")).body).toMatchObject({ signupOpen: true, setupCodeRequired: true });
    expect((await t.req("POST", "/api/v1/auth/signup", body)).status).toBe(403);
    expect((await t.req("POST", "/api/v1/auth/signup", { ...body, setupCode: "wrong" })).status).toBe(403);
    expect((await t.req("POST", "/api/v1/auth/signup", { ...body, setupCode: "open-sesame-123" })).status).toBe(201);
    // Signup is closed once the owner exists, so no setup code is asked for any more.
    expect((await t.req("GET", "/healthz")).body).toMatchObject({ signupOpen: false, setupCodeRequired: false });
  });
  it("stays required for further signups when signup is left open", async () => {
    const t = makeApp({ env: { SETUP_CODE: "open-sesame-123", ALLOW_SIGNUP: "true" } });
    await t.req("POST", "/api/v1/auth/signup", { email: "o@example.com", password: "correct horse battery", name: "O", username: "ooo", timezone: "UTC", setupCode: "open-sesame-123" });
    expect((await t.req("GET", "/healthz")).body).toMatchObject({ signupOpen: true, setupCodeRequired: true });
  });
});
