// 0002 and 0003 must apply on top of a populated 0001 database (an existing instance) without touching existing rows.
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../../src/adapters/sqlite-node";
import { buildDeps } from "../../src/config";
import { createApp, nodeClientIp } from "../../src/http/app";
import { KEY } from "./helpers";

describe("migrations 0002 and 0003 on existing data", () => {
  it("keeps users, sessions, event types, bookings and connections usable", async () => {
    const mig = fileURLToPath(new URL("../../migrations", import.meta.url));
    const only1 = mkdtempSync(join(tmpdir(), "sw-mig1-"));
    copyFileSync(join(mig, "0001_init.sql"), join(only1, "0001_init.sql"));
    const dbFile = join(mkdtempSync(join(tmpdir(), "sw-migdb-")), "db.sqlite");
    let db = new SqliteDb(dbFile);
    db.migrate(only1);
    // Populate through the old schema with the app itself: run the v1 app's signup and a booking via SQL rows.
    const now = "2026-11-01T00:00:00.000Z";
    await db.run("INSERT INTO users (id, email, username, name, timezone, welcome, password_hash, created_at) VALUES ('usr_old', 'oscar@example.com', 'oscar', 'Oscar Owner', 'UTC', '', 'h', ?)", [now]);
    await db.run(`INSERT INTO availability (user_id, timezone, weekly, overrides, buffer_before, buffer_after, min_notice, max_days_ahead, max_per_day, updated_at)
      VALUES ('usr_old', 'UTC', '{"2":[{"start":"09:00","end":"17:00"}]}', '{}', 0, 0, 0, 60, NULL, ?)`, [now]);
    await db.run(`INSERT INTO event_types (id, user_id, slug, name, description, durations, default_duration, slot_interval, location, questions, color, active, created_at, updated_at)
      VALUES ('evt_old', 'usr_old', 'chat', 'Chat', '', '[30]', 30, NULL, '{"kind":"google_meet"}', '[{"id":"q1","label":"Topic","kind":"text","required":false}]', '#0f766e', 1, ?, ?)`, [now, now]);
    await db.run(`INSERT INTO bookings (id, user_id, event_type_id, event_type_name, status, start_ms, end_ms, block_start_ms, block_end_ms, local_date, duration,
      invitee_name, invitee_email, invitee_timezone, guests, answers, location, manage_token_hash, created_at, updated_at)
      VALUES ('bkg_old', 'usr_old', 'evt_old', 'Chat', 'confirmed', ?, ?, ?, ?, '2026-11-24', 30, 'Ivy', 'ivy@example.com', 'UTC', '[]', '{"q1":"Roadmap"}', '{"kind":"google_meet"}', 'x', ?, ?)`,
      [Date.parse("2026-11-24T10:00:00Z"), Date.parse("2026-11-24T10:30:00Z"), Date.parse("2026-11-24T10:00:00Z"), Date.parse("2026-11-24T10:30:00Z"), now, now]);
    const before = await db.all("SELECT * FROM bookings");
    db.close();

    db = new SqliteDb(dbFile);
    db.migrate(mig); // applies 0002 and 0003
    const applied = await db.all<any>("SELECT name FROM _migrations ORDER BY name");
    expect(applied.map((r) => r.name)).toEqual(["0001_init.sql", "0002_schedules_and_calendar_health.sql", "0003_manage_tokens_and_guest_limits.sql"]);
    const after = await db.all<any>("SELECT * FROM bookings");
    expect(after.map(({ answer_labels, manage_token_enc, ...r }) => r)).toEqual(before);
    expect(after[0].manage_token_enc).toBe(null);
    expect((await db.first<any>("SELECT max_guests FROM availability")).max_guests).toBe(3);
    expect((await db.first<any>("SELECT schedule_name FROM availability")).schedule_name).toBe("Working hours");
    expect((await db.first<any>("SELECT schedule_id FROM event_types")).schedule_id).toBe(null);

    const app = createApp({ adapter: "sqlite", clientIp: nodeClientIp(), deps: (c) => buildDeps({ ENCRYPTION_KEY: KEY, LOG_EMAILS: "false" }, db, new URL(c.req.url).origin, () => Date.parse("2026-11-23T12:00:00Z")) });
    const slots: any = await (await app.request("http://x/api/v1/public/users/oscar/event-types/chat/slots?from=2026-11-24&to=2026-11-24&timezone=UTC")).json();
    expect(slots.days[0].slots.map((s: any) => s.start)).not.toContain("2026-11-24T10:00:00.000Z");
    expect(slots.days[0].slots).toHaveLength(15);
  });
});
