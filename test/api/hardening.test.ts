// Hardening and owner features: rate limits, input validation, answer labels, calendar failures, reschedule,
// first-owner signup, password and email changes, schedules, pagination, unknown paths, daily limits, CLI bootstrap.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../../src/adapters/sqlite-node";
import { makeApp } from "./helpers";

const TUE_10 = "2026-11-24T15:00:00.000Z"; // Tue 10:00 New York (clock: Mon 2026-11-23 12:00Z)
const book = (p: Record<string, unknown> = {}) => ({ username: "olive", slug: "30min", start: TUE_10, timezone: "UTC", name: "Ivy", email: "ivy@example.com", ...p });
const slotsUrl = (slug = "30min", date = "2026-11-24", extra = "") => `/api/v1/public/users/olive/event-types/${slug}/slots?from=${date}&to=${date}&timezone=UTC${extra}`;

async function connectMock(t: ReturnType<typeof makeApp>) {
  const start = await t.req("POST", "/api/v1/integrations/mock/connect");
  const u = new URL(start.body.url);
  await t.req("GET", `${u.pathname}${u.search}`);
}

describe("rate limit client address", () => {
  it("ignores spoofed cf-connecting-ip / x-real-ip / x-forwarded-for by default", async () => {
    const t = makeApp({ env: { RATE_LIMIT_PUBLIC_WRITE: "3" } });
    await t.signup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const h: Record<string, string> = [{ "cf-connecting-ip": `203.0.113.${i}` }, { "x-real-ip": `198.51.100.${i}` }, { "x-forwarded-for": `192.0.2.${i}` }][i % 3] as Record<string, string>;
      codes.push((await t.req("POST", "/api/v1/public/bookings", {}, h)).status);
    }
    expect(codes.slice(3).every((c) => c === 429)).toBe(true);
  });
  it("honors the header named by TRUST_PROXY", async () => {
    const t = makeApp({ env: { RATE_LIMIT_PUBLIC_WRITE: "3", TRUST_PROXY: "x-forwarded-for" } });
    await t.signup();
    const codes: number[] = [];
    // Our proxy appends the real client last; a client-supplied first entry must not matter.
    for (let i = 0; i < 6; i++) codes.push((await t.req("POST", "/api/v1/public/bookings", {}, { "x-forwarded-for": `203.0.113.66, 10.0.0.${i}` })).status);
    expect(codes.includes(429)).toBe(false);
    const same: number[] = [];
    for (let i = 0; i < 5; i++) same.push((await t.req("POST", "/api/v1/public/bookings", {}, { "x-forwarded-for": `198.51.100.${i}, 10.0.0.99` })).status);
    expect(same.at(-1)).toBe(429);
  });
});

describe("invalid times are 400, never 500", () => {
  it.each([
    ["PATCH", "/api/v1/availability", { weekly: { "1": [{ start: "25:00", end: "26:00" }] } }],
    ["PATCH", "/api/v1/availability", { weekly: { "1": [{ start: "09:00", end: "9am" }] } }],
    ["PUT", "/api/v1/availability/overrides/2026-12-01", { intervals: [{ start: "24:30", end: "25:00" }] }],
    ["POST", "/api/v1/schedules", { name: "x", weekly: { "2": [{ start: "99:99", end: "10:00" }, { start: "08:00", end: "09:00" }] } }],
  ])("%s %s", async (method, path, body) => {
    const t = makeApp();
    await t.signup();
    const r = await t.req(method as string, path as string, body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_request");
  });
});

describe("answers keep their question labels", () => {
  it("snapshots labels at booking time and uses them in calendar event and emails", async () => {
    const t = makeApp();
    await t.signup();
    await connectMock(t);
    const et = await t.req("POST", "/api/v1/event-types", {
      name: "Intro",
      slug: "intro",
      questions: [{ id: "qmwthiqs9", label: "What do you need help with?", kind: "select", required: true, options: ["Sales", "Support"] }],
    });
    const b = await t.req("POST", "/api/v1/public/bookings", book({ slug: "intro", answers: { qmwthiqs9: "Support" } }));
    expect(b.status).toBe(201);
    expect(b.body.booking.answerDetails).toEqual([{ id: "qmwthiqs9", label: "What do you need help with?", value: "Support" }]);
    const ev = (await t.req("GET", "/api/v1/dev/mock-calendar/events")).body.items.find((e: any) => e.source === "app");
    const raw = await t.db.first<any>("SELECT description FROM mock_calendar_events WHERE id = ?", [ev.id]);
    expect(raw.description).toContain("What do you need help with?: Support");
    expect(raw.description).not.toContain("qmwthiqs9");
    const owner = (await t.req("GET", `/api/v1/notifications?bookingId=${b.body.booking.id}`)).body.items.find((n: any) => n.audience === "owner");
    expect(owner.body).toContain("What do you need help with?: Support");
    // Renaming the question later does not rewrite history.
    await t.req("PATCH", `/api/v1/event-types/${et.body.eventType.id}`, {
      questions: [{ id: "qmwthiqs9", label: "Topic", kind: "select", required: true, options: ["Sales", "Support"] }],
    });
    const again = await t.req("GET", `/api/v1/bookings/${b.body.booking.id}`);
    expect(again.body.booking.answerDetails[0].label).toBe("What do you need help with?");
  });
  it("falls back to the current label for bookings made before snapshots existed", async () => {
    const t = makeApp();
    await t.signup();
    await t.req("POST", "/api/v1/event-types", { name: "Intro", slug: "intro", questions: [{ id: "q1", label: "Company", kind: "text", required: false }] });
    const b = await t.req("POST", "/api/v1/public/bookings", book({ slug: "intro", answers: { q1: "Acme" } }));
    await t.db.run("UPDATE bookings SET answer_labels = NULL WHERE id = ?", [b.body.booking.id]);
    expect((await t.req("GET", `/api/v1/bookings/${b.body.booking.id}`)).body.booking.answerDetails).toEqual([{ id: "q1", label: "Company", value: "Acme" }]);
  });
});

describe("calendar failures fail closed and alert the owner", () => {
  it("hides slots, refuses bookings with 503, alerts once, recovers", async () => {
    const t = makeApp();
    await t.signup();
    await connectMock(t);
    await t.req("POST", "/api/v1/dev/mock-calendar/fail", { fail: true });
    const s = await t.req("GET", slotsUrl());
    expect(s.body.days).toEqual([]);
    expect(s.body.warnings).toEqual(["calendar_unavailable"]);
    const b = await t.req("POST", "/api/v1/public/bookings", book());
    expect(b.status).toBe(503);
    expect(b.body.error.code).toBe("calendar_unavailable");
    await t.req("GET", slotsUrl());
    const alerts = (await t.req("GET", "/api/v1/me/alerts")).body.items;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/invalid_grant/);
    const conn = (await t.req("GET", "/api/v1/integrations")).body.connections[0];
    expect(conn.lastError).toMatch(/invalid_grant/);
    const mails = (await t.req("GET", "/api/v1/notifications")).body.items.filter((n: any) => n.kind === "calendar_error");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("owner@example.com");
    await t.req("POST", "/api/v1/dev/mock-calendar/fail", { fail: false });
    expect((await t.req("GET", slotsUrl())).body.days[0].slots.length).toBeGreaterThan(0);
    expect((await t.req("GET", "/api/v1/me/alerts")).body.items).toEqual([]);
    expect((await t.req("POST", "/api/v1/public/bookings", book())).status).toBe(201);
  });
});

describe("reschedule ignores the booking's own calendar event", () => {
  it("moves a 60 min booking by 30 min onto its own old slot (mock reports app events like Google)", async () => {
    const t = makeApp();
    await t.signup();
    await connectMock(t);
    await t.req("POST", "/api/v1/event-types", { name: "Hour", slug: "hour", durations: [60], slotInterval: 30 });
    const b = await t.req("POST", "/api/v1/public/bookings", book({ slug: "hour" }));
    expect(b.status).toBe(201);
    // The written event is busy for everyone else...
    const other = await t.req("GET", slotsUrl("hour"));
    expect(other.body.days[0].slots.map((x: any) => x.start)).not.toContain("2026-11-24T15:30:00.000Z");
    // ...but not for the booking being moved.
    const own = await t.req("GET", slotsUrl("hour", "2026-11-24", `&excludeBooking=${b.body.booking.id}&token=${encodeURIComponent(b.body.manageToken)}`));
    expect(own.body.days[0].slots.map((x: any) => x.start)).toContain("2026-11-24T15:30:00.000Z");
    const r = await t.req("POST", `/api/v1/public/bookings/${b.body.booking.id}/reschedule`, { token: b.body.manageToken, start: "2026-11-24T15:30:00Z" });
    expect(r.status).toBe(200);
    const ev = (await t.req("GET", "/api/v1/dev/mock-calendar/events")).body.items.find((e: any) => e.source === "app");
    expect(ev.start).toBe("2026-11-24T15:30:00.000Z");
    // Owner reschedule takes the same path.
    const o = await t.req("POST", `/api/v1/bookings/${b.body.booking.id}/reschedule`, { start: "2026-11-24T16:00:00Z" });
    expect(o.status).toBe(200);
    expect(o.body.booking.start).toBe("2026-11-24T16:00:00.000Z");
  });
});

describe("first-owner claim is atomic", () => {
  it("only one of many parallel signups on an empty closed instance wins", async () => {
    const t = makeApp();
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.req("POST", "/api/v1/auth/signup", { email: `r${i}@example.com`, password: "race password 123", name: "R", username: `race-${i}`, timezone: "UTC" }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 403)).toHaveLength(9);
    expect((await t.db.first<any>("SELECT COUNT(*) AS n FROM users")).n).toBe(1);
    expect((await t.db.first<any>("SELECT COUNT(*) AS n FROM availability")).n).toBe(1);
  });
  it("parallel signups with the same email (signup open) give one 201 and 409s, never 500", async () => {
    const t = makeApp({ env: { ALLOW_SIGNUP: "true" } });
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) => t.req("POST", "/api/v1/auth/signup", { email: "same@example.com", password: "race password 123", name: "R", username: `same-${i}`, timezone: "UTC" })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
  });
});

describe("password and email changes", () => {
  it("changes password, signs out other sessions, keeps the current one", async () => {
    const t = makeApp();
    await t.signup();
    const other = makeApp(); // separate cookie jar on the same db is not possible; use a raw second session instead
    void other;
    const second = await t.app.request("http://slotwise.test/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery" }),
    });
    const cookie2 = /sw_session=([^;]+)/.exec(second.headers.get("set-cookie")!)![0];
    expect((await t.req("POST", "/api/v1/me/password", { currentPassword: "nope", newPassword: "another password 1" })).status).toBe(403);
    expect((await t.req("POST", "/api/v1/me/password", { currentPassword: "correct horse battery", newPassword: "short" })).status).toBe(400);
    expect((await t.req("POST", "/api/v1/me/password", { currentPassword: "correct horse battery", newPassword: "another password 1" })).status).toBe(200);
    expect((await t.req("GET", "/api/v1/me")).status).toBe(200);
    const s2 = await t.app.request("http://slotwise.test/api/v1/me", { headers: { cookie: cookie2 } });
    expect(s2.status).toBe(401);
    t.clearSession();
    expect((await t.req("POST", "/api/v1/auth/login", { email: "owner@example.com", password: "correct horse battery" })).status).toBe(401);
    expect((await t.req("POST", "/api/v1/auth/login", { email: "owner@example.com", password: "another password 1" })).status).toBe(200);
  });
  it("changes email with the current password", async () => {
    const t = makeApp({ env: { ALLOW_SIGNUP: "true" } });
    await t.signup({ email: "taken@example.com", username: "taken" });
    t.clearSession();
    await t.signup();
    expect((await t.req("POST", "/api/v1/me/email", { email: "new@example.com", currentPassword: "wrong" })).status).toBe(403);
    expect((await t.req("POST", "/api/v1/me/email", { email: "taken@example.com", currentPassword: "correct horse battery" })).status).toBe(409);
    const ok = await t.req("POST", "/api/v1/me/email", { email: "New@Example.com", currentPassword: "correct horse battery" });
    expect(ok.body.user.email).toBe("new@example.com");
  });
  it("admin reset script resets the password on a SQLite database and revokes sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-reset-"));
    const dbPath = join(dir, "db.sqlite");
    const db = new SqliteDb(dbPath);
    db.migrate(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await db.run("INSERT INTO users (id, email, username, name, timezone, password_hash, created_at) VALUES ('usr_x', 'a@example.com', 'aaa', 'A', 'UTC', 'x', 'now')");
    await db.run("INSERT INTO sessions (token_hash, user_id, csrf, expires_at, created_at) VALUES ('h', 'usr_x', 'c', 9999999999999, 'now')");
    db.close();
    const script = fileURLToPath(new URL("../../scripts/admin-reset-password.mjs", import.meta.url));
    const bad = spawnSync(process.execPath, [script, "--email", "a@example.com", "--db", dbPath, "--password", "x"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    const r = spawnSync(process.execPath, [script, "--email", "a@example.com", "--db", dbPath], { input: "brand new password 9\n", encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, sessionsRevoked: 1, tokensRevoked: 0 });
    const db2 = new SqliteDb(dbPath);
    const { verifyPassword } = await import("../../src/core/crypto");
    const row = await db2.first<any>("SELECT password_hash FROM users WHERE id = 'usr_x'");
    expect(await verifyPassword("brand new password 9", row.password_hash)).toBe(true);
    db2.close();
  });
});

describe("admin reset on D1 picks the deployed Wrangler config", () => {
  // A copy of the script in a scratch root with a stub wrangler that records its arguments; nothing contacts Cloudflare.
  function scratch(withLocalConfig: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "sw-reset-d1-"));
    mkdirSync(join(dir, "scripts"));
    copyFileSync(fileURLToPath(new URL("../../scripts/admin-reset-password.mjs", import.meta.url)), join(dir, "scripts", "admin-reset-password.mjs"));
    if (withLocalConfig) writeFileSync(join(dir, "wrangler.local.toml"), 'name = "x"\n');
    const stub = join(dir, "wrangler-stub.mjs");
    const record = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));\n`;
    writeFileSync(stub, `#!/usr/bin/env node\n${record}console.log('[{"results":[]},{"results":[{"matched":1}]}]');\n`, { mode: 0o755 });
    return { dir, stub };
  }
  const reset = (dir: string, stub: string, args: string[]) =>
    spawnSync(process.execPath, [join(dir, "scripts", "admin-reset-password.mjs"), "--email", "a@example.com", "--d1", "slotwise", ...args], {
      input: "brand new password 9\n",
      encoding: "utf8",
      env: { ...process.env, WRANGLER: stub, CLOUDFLARE_API_TOKEN: "invalid-test-token" },
    });
  const argsOf = (dir: string) => JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];

  it("refuses --remote without wrangler.local.toml or --config", () => {
    const { dir, stub } = scratch(false);
    const r = reset(dir, stub, ["--remote"]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stderr).error.message).toMatch(/wrangler\.local\.toml/);
  });
  it("uses wrangler.local.toml for --remote, an explicit --config, and wrangler.toml for --local", () => {
    const { dir, stub } = scratch(true);
    const r = reset(dir, stub, ["--remote"]);
    expect(r.status, r.stderr).toBe(0);
    expect(argsOf(dir)).toEqual(expect.arrayContaining(["--remote", "--config", "wrangler.local.toml"]));
    expect(reset(dir, stub, ["--remote", "--config", "other.toml"]).status).toBe(0);
    expect(argsOf(dir)).toEqual(expect.arrayContaining(["--config", join(process.cwd(), "other.toml")]));
    expect(reset(dir, stub, ["--local"]).status).toBe(0);
    expect(argsOf(dir)).not.toContain("--config");
  });
});

describe("schedules, booking pagination and owner reschedule", () => {
  it("named schedules drive an event type's slots", async () => {
    const t = makeApp();
    await t.signup();
    const s = await t.req("POST", "/api/v1/schedules", { name: "Saturdays", timezone: "Europe/London", weekly: { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [{ start: "10:00", end: "11:00" }] } });
    expect(s.status).toBe(201);
    const list = (await t.req("GET", "/api/v1/schedules")).body.items;
    expect(list.map((x: any) => x.name)).toEqual(["Working hours", "Saturdays"]);
    const et = await t.req("POST", "/api/v1/event-types", { name: "Sat", slug: "sat", scheduleId: s.body.schedule.id });
    expect(et.body.eventType.scheduleId).toBe(s.body.schedule.id);
    expect((await t.req("GET", slotsUrl("sat"))).body.days).toEqual([]);
    const sat = await t.req("GET", slotsUrl("sat", "2026-11-28"));
    expect(sat.body.days[0].slots.map((x: any) => x.start)).toEqual(["2026-11-28T10:00:00.000Z", "2026-11-28T10:30:00.000Z"]);
    // default event type still uses the default schedule
    expect((await t.req("GET", slotsUrl("30min", "2026-11-28"))).body.days).toEqual([]);
    await t.req("PUT", `/api/v1/schedules/${s.body.schedule.id}/overrides/2026-11-28`, { intervals: [] });
    expect((await t.req("GET", slotsUrl("sat", "2026-11-28"))).body.days).toEqual([]);
    expect((await t.req("DELETE", `/api/v1/schedules/${s.body.schedule.id}`)).status).toBe(409);
    expect((await t.req("DELETE", "/api/v1/schedules/default")).status).toBe(409);
    expect((await t.req("PATCH", "/api/v1/schedules/default", { name: "Office hours" })).body.schedule.name).toBe("Office hours");
    expect((await t.req("DELETE", `/api/v1/schedules/${s.body.schedule.id}?force=true`)).status).toBe(200);
    expect((await t.req("GET", `/api/v1/event-types/${et.body.eventType.id}`)).body.eventType.scheduleId).toBe(null);
    expect((await t.req("POST", "/api/v1/event-types", { name: "Bad", scheduleId: "sch_missing" })).status).toBe(404);
  });

  it("paginates bookings with a cursor, filters by date range, exports CSV", async () => {
    const t = makeApp();
    await t.signup();
    const starts = ["15:00", "16:00", "17:00", "18:00", "19:00"].map((h) => `2026-11-24T${h}:00.000Z`);
    for (const [i, s] of starts.entries()) {
      expect((await t.req("POST", "/api/v1/public/bookings", book({ start: s, email: `p${i}@example.com`, name: i === 0 ? "=HYPERLINK(1)" : `P${i}` }))).status).toBe(201);
    }
    const seen: string[] = [];
    let cursor = "";
    for (let i = 0; i < 5; i++) {
      const r = await t.req("GET", `/api/v1/bookings?status=upcoming&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.body.items.map((b: any) => b.start));
      if (!r.body.nextCursor) break;
      cursor = r.body.nextCursor;
    }
    expect(seen).toEqual(starts);
    const range = await t.req("GET", `/api/v1/bookings?status=range&from=2026-11-24T16:00:00Z&to=2026-11-24T18:00:00Z`);
    expect(range.body.items.map((b: any) => b.start)).toEqual(starts.slice(1, 3));
    const csv = await t.req("GET", "/api/v1/bookings/export?status=upcoming");
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    const lines = (csv.body as string).trim().split("\r\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^Booking ID,Status,Event type/);
    expect(lines[1]).toContain("'=HYPERLINK(1)");
  });

  it("owner reschedule slots and request reschedule", async () => {
    const t = makeApp();
    await t.signup();
    const b = await t.req("POST", "/api/v1/public/bookings", book({ guests: ["guest@example.com"] }));
    const slots = await t.req("GET", `/api/v1/bookings/${b.body.booking.id}/slots?from=2026-11-24&to=2026-11-24&timezone=UTC`);
    expect(slots.body.days[0].slots.map((x: any) => x.start)).toContain(TUE_10);
    const rr = await t.req("POST", `/api/v1/bookings/${b.body.booking.id}/request-reschedule`, { reason: "Travel" });
    expect(rr.body.booking.status).toBe("cancelled");
    const n = (await t.req("GET", `/api/v1/notifications?bookingId=${b.body.booking.id}`)).body.items.filter((x: any) => x.kind === "reschedule_requested");
    const inv = n.find((x: any) => x.audience === "invitee");
    expect(inv.body).toContain("Pick a new time: http://slotwise.test/olive/30min");
    expect(inv.body).toContain("Travel");
    expect(n.find((x: any) => x.audience === "guest").to).toBe("guest@example.com");
  });
});

describe("unknown API paths", () => {
  it("are 404 with or without auth", async () => {
    const t = makeApp();
    expect((await t.req("GET", "/api/v1/nope")).status).toBe(404);
    expect((await t.req("POST", "/api/v1/whatever/x", {})).status).toBe(404);
    expect((await t.req("GET", "/api/v1/public/nope")).status).toBe(404);
    await t.signup();
    expect((await t.req("GET", "/api/v1/nope")).status).toBe(404);
    t.clearSession();
    expect((await t.req("GET", "/api/v1/event-types")).status).toBe(401);
  });
});

describe("daily limit reports limit_reached", () => {
  it("on the pre-check and in the atomic insert", async () => {
    const t = makeApp();
    await t.signup();
    await t.req("PATCH", "/api/v1/availability", { maxPerDay: 1 });
    expect((await t.req("POST", "/api/v1/public/bookings", book())).status).toBe(201);
    const r = await t.req("POST", "/api/v1/public/bookings", book({ start: "2026-11-24T18:00:00Z", email: "b@example.org" }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("limit_reached");
    const taken = await t.req("POST", "/api/v1/public/bookings", book({ email: "c@example.org", start: "2026-11-25T15:00:00Z" }));
    expect(taken.status).toBe(201);
    const dup = await t.req("POST", "/api/v1/public/bookings", book({ email: "d@example.org", start: "2026-11-26T15:00:00Z" }));
    expect(dup.status).toBe(201);
    await t.req("PATCH", "/api/v1/availability", { maxPerDay: null });
    const clash = await t.req("POST", "/api/v1/public/bookings", book({ email: "e@example.org", start: "2026-11-26T15:00:00Z" }));
    expect(clash.body.error.code).toBe("slot_taken");
  });
});

describe("CLI on a fresh clone", () => {
  it("builds itself when dist/cli.mjs is missing and help says so", async () => {
    const { renameSync, existsSync } = await import("node:fs");
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const bundle = join(root, "dist", "cli.mjs");
    const aside = `${bundle}.bak-test`;
    if (existsSync(bundle)) renameSync(bundle, aside);
    try {
      const r = spawnSync(process.execPath, [join(root, "bin", "slotwise.mjs"), "help"], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("builds itself from source on first");
      expect(r.stdout).toContain("--password-stdin");
      expect(existsSync(bundle)).toBe(true);
    } finally {
      if (existsSync(aside)) renameSync(aside, bundle);
    }
  });
  it("refuses to read a password that is missing on stdin", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const r = spawnSync(process.execPath, [join(root, "bin", "slotwise.mjs"), "login", "--email", "a@example.com", "--password-stdin", "--url", "http://127.0.0.1:9"], { input: "", encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe("usage");
  });
  it("without a terminal and without --password-stdin, says to use --password-stdin", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const r = spawnSync(process.execPath, [join(root, "bin", "slotwise.mjs"), "login", "--email", "a@example.com", "--url", "http://127.0.0.1:9"], { input: "", encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stderr).error.message).toContain("no terminal: use --password-stdin");
  });
});
