import { describe, expect, it } from "vitest";
import { GOOGLE_SCOPES, GoogleCalendarProvider } from "../../src/adapters/google-calendar";
import type { ConnectionContext } from "../../src/core/ports";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeFetch(responses: ((c: Call) => unknown)[]) {
  const calls: Call[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? String(init.body) : "" };
    calls.push(c);
    const r = responses.shift();
    if (!r) throw new Error(`unexpected call ${c.method} ${c.url}`);
    const body = r(c);
    return new Response(body === null ? null : JSON.stringify(body), { status: body === null ? 204 : 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, impl };
}

function ctx(expiresAt = Date.now() + 3_600_000): ConnectionContext & { saved: unknown[] } {
  const saved: unknown[] = [];
  return { connectionId: "con_1", userId: "usr_1", tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt }, saveTokens: async (t) => void saved.push(t), saved };
}

describe("GoogleCalendarProvider", () => {
  it("builds the consent URL with offline access and least-privilege scopes", () => {
    const g = new GoogleCalendarProvider("cid", "secret");
    const u = new URL(g.authorizeUrl("state123", "https://app.example/oauth/google/callback"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("state123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example/oauth/google/callback");
    expect(u.searchParams.get("scope")!.split(" ")).toEqual(GOOGLE_SCOPES);
    expect(GOOGLE_SCOPES).not.toContain("https://www.googleapis.com/auth/calendar");
  });

  it("exchanges the code and reads the account email from the id_token", async () => {
    const payload = btoa(JSON.stringify({ email: "owner@example.com" })).replace(/=+$/, "");
    const f = fakeFetch([() => ({ access_token: "at", refresh_token: "rt", expires_in: 3599, id_token: `h.${payload}.s` })]);
    const g = new GoogleCalendarProvider("cid", "secret", f.impl);
    const r = await g.exchangeCode("code-1", "https://app.example/oauth/google/callback");
    expect(r.accountEmail).toBe("owner@example.com");
    expect(r.tokens.refreshToken).toBe("rt");
    const body = new URLSearchParams(f.calls[0]!.body);
    expect(f.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
  });

  it("queries freeBusy for the selected calendars and flattens busy blocks", async () => {
    const f = fakeFetch([
      () => ({
        calendars: {
          a: { busy: [{ start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" }] },
          b: { busy: [{ start: "2026-11-24T18:00:00Z", end: "2026-11-24T18:30:00Z" }] },
        },
      }),
    ]);
    const g = new GoogleCalendarProvider("cid", "secret", f.impl);
    const busy = await g.freeBusy(ctx(), ["a", "b"], Date.parse("2026-11-24T00:00:00Z"), Date.parse("2026-11-25T00:00:00Z"));
    expect(busy).toEqual([
      { start: Date.parse("2026-11-24T15:00:00Z"), end: Date.parse("2026-11-24T16:00:00Z") },
      { start: Date.parse("2026-11-24T18:00:00Z"), end: Date.parse("2026-11-24T18:30:00Z") },
    ]);
    const req = JSON.parse(f.calls[0]!.body);
    expect(f.calls[0]!.url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(req.items).toEqual([{ id: "a" }, { id: "b" }]);
    expect(f.calls[0]!.headers.authorization).toBe("Bearer at-1");
  });

  it("creates an event with attendee and Meet conference, returning the join link", async () => {
    const f = fakeFetch([() => ({ id: "gev_1", hangoutLink: "https://meet.google.com/abc-defg-hij" })]);
    const g = new GoogleCalendarProvider("cid", "secret", f.impl);
    const r = await g.createEvent(ctx(), {
      calendarId: "owner@example.com",
      summary: "Intro with Ivy",
      description: "d",
      start: Date.parse("2026-11-24T15:00:00Z"),
      end: Date.parse("2026-11-24T15:30:00Z"),
      timezone: "America/New_York",
      attendees: [{ email: "ivy@example.com", name: "Ivy" }],
      createMeet: true,
      requestId: "bkg_1",
    });
    expect(r).toEqual({ eventId: "gev_1", joinUrl: "https://meet.google.com/abc-defg-hij" });
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe("/calendar/v3/calendars/owner%40example.com/events");
    expect(u.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(u.searchParams.get("sendUpdates")).toBe("all");
    const body = JSON.parse(f.calls[0]!.body);
    expect(body.attendees).toEqual([{ email: "ivy@example.com", displayName: "Ivy" }]);
    expect(body.conferenceData.createRequest).toEqual({ requestId: "bkg_1", conferenceSolutionKey: { type: "hangoutsMeet" } });
    expect(body.start).toEqual({ dateTime: "2026-11-24T15:00:00.000Z", timeZone: "America/New_York" });
  });

  it("refreshes an expired access token and persists it", async () => {
    const f = fakeFetch([() => ({ access_token: "at-2", expires_in: 3600 }), () => ({ items: [{ id: "p", summary: "Primary", primary: true }] })]);
    const g = new GoogleCalendarProvider("cid", "secret", f.impl);
    const c = ctx(Date.now() - 1000);
    const cals = await g.listCalendars(c);
    expect(cals).toEqual([{ id: "p", name: "Primary", primary: true }]);
    expect(new URLSearchParams(f.calls[0]!.body).get("grant_type")).toBe("refresh_token");
    expect(f.calls[1]!.headers.authorization).toBe("Bearer at-2");
    expect((c.saved[0] as any).refreshToken).toBe("rt-1");
  });

  it("deletes and patches events", async () => {
    const f = fakeFetch([() => null, () => ({ id: "x" })]);
    const g = new GoogleCalendarProvider("cid", "secret", f.impl);
    await g.cancelEvent(ctx(), "primary", "ev1");
    await g.updateEventTime(ctx(), "primary", "ev1", 0, 1_800_000, "UTC");
    expect(f.calls.map((c) => c.method)).toEqual(["DELETE", "PATCH"]);
  });
});

describe("GoogleCalendarProvider.busyEvents", () => {
  it("lists blocking events with ids, like free/busy counts them", async () => {
    const f = fakeFetch([
      () => ({
        timeZone: "America/New_York",
        items: [
          { id: "a", status: "confirmed", start: { dateTime: "2026-11-24T15:00:00Z" }, end: { dateTime: "2026-11-24T15:30:00Z" } },
          { id: "free", status: "confirmed", transparency: "transparent", start: { dateTime: "2026-11-24T16:00:00Z" }, end: { dateTime: "2026-11-24T17:00:00Z" } },
          { id: "gone", status: "cancelled", start: { dateTime: "2026-11-24T16:00:00Z" }, end: { dateTime: "2026-11-24T17:00:00Z" } },
          { id: "no", status: "confirmed", attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2026-11-24T18:00:00Z" }, end: { dateTime: "2026-11-24T19:00:00Z" } },
          { id: "allday", status: "confirmed", start: { date: "2026-11-25" }, end: { date: "2026-11-26" } },
        ],
        nextPageToken: "p2",
      }),
      () => ({ items: [{ id: "b", status: "confirmed", start: { dateTime: "2026-11-24T20:00:00Z" }, end: { dateTime: "2026-11-24T20:30:00Z" } }] }),
    ]);
    const g = new GoogleCalendarProvider("cid", "secret", f.impl);
    const evs = await g.busyEvents(ctx(), ["primary"], Date.parse("2026-11-24T00:00:00Z"), Date.parse("2026-11-27T00:00:00Z"));
    expect(evs.map((e) => e.id)).toEqual(["a", "allday", "b"]);
    expect(new Date(evs[1]!.start).toISOString()).toBe("2026-11-25T05:00:00.000Z"); // midnight New York
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(u.searchParams.get("singleEvents")).toBe("true");
    expect(new URL(f.calls[1]!.url).searchParams.get("pageToken")).toBe("p2");
  });
});
