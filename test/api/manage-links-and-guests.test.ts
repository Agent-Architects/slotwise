// Manage links, reschedule against external events, token revocation, guest limits and calendar alerts.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../../src/adapters/sqlite-node";
import { safeName } from "../../src/core/service";
import { makeApp } from "./helpers";

const T = "2026-11-24T15:00:00.000Z"; // Tue 10:00 New York; clock is Mon 2026-11-23 12:00Z
const T15 = "2026-11-24T15:15:00.000Z";
const book = (p: Record<string, unknown> = {}) => ({ username: "olive", slug: "30min", start: T, timezone: "UTC", name: "Ivy", email: "ivy@example.com", ...p });

async function connectMock(t: ReturnType<typeof makeApp>) {
  const start = await t.req("POST", "/api/v1/integrations/mock/connect");
  const u = new URL(start.body.url);
  await t.req("GET", `${u.pathname}${u.search}`);
}

describe("reschedule ignores only the booking's own calendar event", () => {
  it("an external event at exactly the booking's time still blocks a reschedule into it", async () => {
    const t = makeApp();
    await t.signup();
    await connectMock(t);
    const et = (await t.req("GET", "/api/v1/event-types")).body.items[0];
    await t.req("PATCH", `/api/v1/event-types/${et.id}`, { slotInterval: 15 });
    const b = await t.req("POST", "/api/v1/public/bookings", book());
    expect(b.body.booking.external.eventId).toMatch(/^mev_/);
    await t.req("POST", "/api/v1/dev/mock-calendar/events", { start: T, end: "2026-11-24T15:30:00Z", summary: "Dentist" });
    const picker = await t.req(
      "GET",
      `/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=UTC&excludeBooking=${b.body.booking.id}&token=${encodeURIComponent(b.body.manageToken)}`,
    );
    expect(picker.body.days[0].slots.map((s: any) => s.start)).not.toContain(T15);
    const r = await t.req("POST", `/api/v1/public/bookings/${b.body.booking.id}/reschedule`, { token: b.body.manageToken, start: T15 });
    expect(r.status).toBe(409);
    expect((await t.req("POST", `/api/v1/bookings/${b.body.booking.id}/reschedule`, { start: T15 })).status).toBe(409);
    // Without the external event, moving inside its own span is fine.
    const ext = (await t.req("GET", "/api/v1/dev/mock-calendar/events")).body.items.find((e: any) => e.source === "external");
    await t.db.run("UPDATE mock_calendar_events SET status = 'cancelled' WHERE id = ?", [ext.id]);
    expect((await t.req("POST", `/api/v1/public/bookings/${b.body.booking.id}/reschedule`, { token: b.body.manageToken, start: T15 })).status).toBe(200);
  });
});

describe("owner reschedule emails the invitee a working manage link", () => {
  it("reuses the invitee's token", async () => {
    const t = makeApp();
    await t.signup();
    const b = await t.req("POST", "/api/v1/public/bookings", book());
    await t.req("POST", `/api/v1/bookings/${b.body.booking.id}/reschedule`, { start: "2026-11-24T16:00:00Z" });
    const mail = (await t.req("GET", `/api/v1/notifications?bookingId=${b.body.booking.id}`)).body.items.find((n: any) => n.kind === "rescheduled" && n.audience === "invitee");
    expect(mail.body).toContain(b.body.manageUrl);
    expect((await t.req("GET", `/api/v1/public/bookings/${b.body.booking.id}?token=${encodeURIComponent(b.body.manageToken)}`)).status).toBe(200);
  });
  it("rotates the token for bookings made before tokens were stored", async () => {
    const t = makeApp();
    await t.signup();
    const b = await t.req("POST", "/api/v1/public/bookings", book());
    await t.db.run("UPDATE bookings SET manage_token_enc = NULL WHERE id = ?", [b.body.booking.id]);
    await t.req("POST", `/api/v1/bookings/${b.body.booking.id}/reschedule`, { start: "2026-11-24T16:00:00Z" });
    const mail = (await t.req("GET", `/api/v1/notifications?bookingId=${b.body.booking.id}`)).body.items.find((n: any) => n.kind === "rescheduled" && n.audience === "invitee");
    const link = /\/booking\/\S+\?token=(\S+)/.exec(mail.body)!;
    const token = decodeURIComponent(link[1]!);
    expect(token).not.toBe(b.body.manageToken);
    expect((await t.req("GET", `/api/v1/public/bookings/${b.body.booking.id}?token=${encodeURIComponent(token)}`)).status).toBe(200);
  });
  it("stores the token encrypted, never in plain text", async () => {
    const t = makeApp();
    await t.signup();
    const b = await t.req("POST", "/api/v1/public/bookings", book());
    const row = await t.db.first<any>("SELECT manage_token_enc FROM bookings WHERE id = ?", [b.body.booking.id]);
    expect(row.manage_token_enc).toMatch(/^v1\./);
    expect(row.manage_token_enc).not.toContain(b.body.manageToken);
  });
});

describe("password changes revoke API tokens", () => {
  it("revokes by default and keeps them with revokeTokens:false", async () => {
    const t = makeApp();
    await t.signup();
    const tok = (await t.req("POST", "/api/v1/tokens", { name: "cli", scopes: ["read", "write"] })).body.token;
    const auth = { authorization: `Bearer ${tok}` };
    const keep = await t.req("POST", "/api/v1/me/password", { currentPassword: "correct horse battery", newPassword: "second password 22", revokeTokens: false });
    expect(keep.body.revokedTokens).toBe(0);
    expect((await t.req("GET", "/api/v1/me", undefined, auth)).status).toBe(200);
    const def = await t.req("POST", "/api/v1/me/password", { currentPassword: "second password 22", newPassword: "third password 333" });
    expect(def.body.revokedTokens).toBe(1);
    expect((await t.req("GET", "/api/v1/me", undefined, auth)).status).toBe(401);
  });
  it("admin reset revokes API tokens", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "sw-reset-tokens-")), "db.sqlite");
    const db = new SqliteDb(dbPath);
    db.migrate(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await db.run("INSERT INTO users (id, email, username, name, timezone, password_hash, created_at) VALUES ('usr_x', 'a@example.com', 'aaa', 'A', 'UTC', 'x', 'now')");
    await db.run("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, created_at) VALUES ('tok_1', 'usr_x', 'cli', 'h1', 'sw_', '[\"read\"]', 'now')");
    db.close();
    const script = fileURLToPath(new URL("../../scripts/admin-reset-password.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [script, "--email", "a@example.com", "--db", dbPath], { input: "brand new password 9\n", encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).tokensRevoked).toBe(1);
    const db2 = new SqliteDb(dbPath);
    expect((await db2.first<any>("SELECT revoked_at FROM api_tokens WHERE id = 'tok_1'")).revoked_at).toBeTruthy();
    db2.close();
  });
});

describe("guest email abuse limits", () => {
  it("caps guests per booking (default 3, owner setting, 0 disables)", async () => {
    const t = makeApp();
    await t.signup();
    expect((await t.req("GET", "/api/v1/public/users/olive/event-types/30min")).body.eventType.maxGuests).toBe(3);
    const four = ["a@example.org", "b@example.org", "c@example.org", "d@example.org"];
    expect((await t.req("POST", "/api/v1/public/bookings", book({ guests: four }))).status).toBe(400);
    // duplicates and the invitee's own address do not count
    const ok = await t.req("POST", "/api/v1/public/bookings", book({ guests: ["a@example.org", "A@example.org", "ivy@example.com", "b@example.org"] }));
    expect(ok.status).toBe(201);
    expect(ok.body.booking.guests).toEqual(["a@example.org", "b@example.org"]);
    await t.req("PATCH", "/api/v1/availability", { maxGuests: 0 });
    expect((await t.req("POST", "/api/v1/public/bookings", book({ start: "2026-11-24T17:00:00Z", guests: ["a@example.org"] }))).status).toBe(400);
    expect((await t.req("PATCH", "/api/v1/availability", { maxGuests: 11 })).status).toBe(400);
  });
  it("guest emails carry only a cleaned invitee name and stop at the hourly budget", async () => {
    const t = makeApp({ env: { GUEST_EMAILS_PER_HOUR: "2" } });
    await t.signup();
    const name = "Win a prize at https://evil.example/x\nClick www.evil.example now <b>";
    await t.req("POST", "/api/v1/public/bookings", book({ name, guests: ["g1@example.org", "g2@example.org", "g3@example.org"] }));
    const n = (await t.req("GET", "/api/v1/notifications")).body.items.filter((x: any) => x.audience === "guest");
    expect(n.filter((x: any) => x.status === "sent")).toHaveLength(2);
    expect(n.filter((x: any) => x.status === "suppressed")).toHaveLength(1);
    for (const m of n) {
      expect(m.body).not.toMatch(/evil\.example|https?:|<b>/);
      expect(m.subject).not.toMatch(/evil/);
    }
    // the next hour has a fresh budget
    t.setNow("2026-11-23T13:30:00Z");
    await t.req("POST", "/api/v1/public/bookings", book({ start: "2026-11-24T18:00:00Z", email: "z@example.com", guests: ["g4@example.org"] }));
    expect((await t.req("GET", "/api/v1/notifications")).body.items.find((x: any) => x.to === "g4@example.org").status).toBe("sent");
  });
  it("safeName", () => {
    expect(safeName("Ann\r\nBcc: x@example.com")).toBe("Ann Bcc: x@example.com");
    expect(safeName("http://a.b")).toBe("An invitee");
    expect(safeName("x".repeat(100))).toHaveLength(62);
  });
});

describe("calendar alert names the provider", () => {
  it("includes the display name", async () => {
    const t = makeApp();
    await t.signup();
    await connectMock(t);
    await t.req("POST", "/api/v1/dev/mock-calendar/fail", { fail: true });
    await t.req("GET", "/api/v1/public/users/olive/event-types/30min/slots?from=2026-11-24&to=2026-11-24&timezone=UTC");
    expect((await t.req("GET", "/api/v1/me/alerts")).body.items[0]).toMatchObject({ provider: "mock", providerName: "Mock Calendar (dev)" });
  });
});

describe("guest email cap holds under parallel bookings", () => {
  it("never sends more than GUEST_EMAILS_PER_HOUR guest emails", async () => {
    const t = makeApp({ env: { GUEST_EMAILS_PER_HOUR: "5" } });
    await t.signup();
    const starts = ["15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30"].map((h) => `2026-11-24T${h}:00.000Z`);
    const res = await Promise.all(
      starts.map((s, i) => t.req("POST", "/api/v1/public/bookings", book({ start: s, email: `p${i}@example.com`, guests: [`a${i}@example.org`, `b${i}@example.org`, `c${i}@example.org`] }))),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    const guest = (await t.db.all<any>("SELECT status FROM notifications WHERE audience = 'guest'")).map((r) => r.status);
    expect(guest).toHaveLength(24);
    expect(guest.filter((s) => s === "sent")).toHaveLength(5);
    expect(guest.filter((s) => s === "suppressed")).toHaveLength(19);
    expect(guest.filter((s) => s === "sending")).toHaveLength(0);
  });
});
