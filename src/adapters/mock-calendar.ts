import { newId } from "../core/crypto.js";
import type { CalendarEventInput, CalendarProvider, ConnectionContext, Db, ProviderCalendar } from "../core/ports.js";

/**
 * A calendar provider backed by a table in the app database. Same interface as Google, used for local
 * development and tests when no Google credentials exist. Enabled by MOCK_CALENDAR=true.
 */
export class MockCalendarProvider implements CalendarProvider {
  readonly id = "mock";
  readonly name = "Mock Calendar (dev)";
  constructor(private db: Db) {}
  configured(): boolean {
    return true;
  }
  authorizeUrl(state: string, redirectUri: string): string {
    return `${redirectUri}?code=mock-code&state=${encodeURIComponent(state)}`;
  }
  async exchangeCode(code: string) {
    if (code !== "mock-code") throw new Error("bad mock code");
    return { tokens: { accessToken: "mock", refreshToken: "mock", expiresAt: Date.now() + 3_600_000 }, accountEmail: "owner@mock.example" };
  }
  async listCalendars(): Promise<ProviderCalendar[]> {
    return [
      { id: "primary", name: "Mock primary", primary: true },
      { id: "work", name: "Mock work", primary: false },
    ];
  }
  async freeBusy(ctx: ConnectionContext, calendarIds: string[], from: number, to: number) {
    if (!calendarIds.length) return [];
    if (await this.db.first("SELECT 1 FROM mock_calendar_events WHERE user_id = ? AND source = 'failmode'", [ctx.userId])) {
      throw new Error("mock calendar: invalid_grant (simulated failure)");
    }
    // Like Google free/busy: every confirmed event on the checked calendars counts, including the events this app
    // wrote for its own bookings.
    const rows = await this.db.all<{ start_ms: number; end_ms: number }>(
      `SELECT start_ms, end_ms FROM mock_calendar_events WHERE user_id = ? AND status = 'confirmed' AND source IN ('external', 'app')
       AND start_ms < ? AND end_ms > ? AND calendar_id IN (${calendarIds.map(() => "?").join(",")})`,
      [ctx.userId, to, from, ...calendarIds],
    );
    return rows.map((r) => ({ start: r.start_ms, end: r.end_ms }));
  }
  async busyEvents(ctx: ConnectionContext, calendarIds: string[], from: number, to: number) {
    if (!calendarIds.length) return [];
    if (await this.db.first("SELECT 1 FROM mock_calendar_events WHERE user_id = ? AND source = 'failmode'", [ctx.userId])) {
      throw new Error("mock calendar: invalid_grant (simulated failure)");
    }
    const rows = await this.db.all<{ id: string; calendar_id: string; start_ms: number; end_ms: number }>(
      `SELECT id, calendar_id, start_ms, end_ms FROM mock_calendar_events WHERE user_id = ? AND status = 'confirmed' AND source IN ('external', 'app')
       AND start_ms < ? AND end_ms > ? AND calendar_id IN (${calendarIds.map(() => "?").join(",")})`,
      [ctx.userId, to, from, ...calendarIds],
    );
    return rows.map((r) => ({ id: r.id, calendarId: r.calendar_id, start: r.start_ms, end: r.end_ms }));
  }

  async createEvent(ctx: ConnectionContext, ev: CalendarEventInput) {
    const id = newId("mev");
    const joinUrl = ev.createMeet ? `https://meet.mock.invalid/${id.slice(4, 14)}` : undefined;
    await this.db.run(
      `INSERT INTO mock_calendar_events (id, user_id, calendar_id, summary, description, start_ms, end_ms, attendees, join_url, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'app', ?)`,
      [id, ctx.userId, ev.calendarId, ev.summary, ev.description, ev.start, ev.end, JSON.stringify(ev.attendees), joinUrl ?? null, new Date().toISOString()],
    );
    return { eventId: id, joinUrl };
  }
  async updateEventTime(ctx: ConnectionContext, _cal: string, eventId: string, start: number, end: number) {
    await this.db.run("UPDATE mock_calendar_events SET start_ms = ?, end_ms = ? WHERE id = ? AND user_id = ?", [start, end, eventId, ctx.userId]);
  }
  async cancelEvent(ctx: ConnectionContext, _cal: string, eventId: string) {
    await this.db.run("UPDATE mock_calendar_events SET status = 'cancelled' WHERE id = ? AND user_id = ?", [eventId, ctx.userId]);
  }
}
