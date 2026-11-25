import { zonedToUtc } from "../core/time.js";
import type {
  CalendarEventInput,
  CalendarEventResult,
  CalendarProvider,
  ConnectionContext,
  OAuthTokens,
  ProviderCalendar,
} from "../core/ports.js";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = "google";
  readonly name = "Google Calendar";
  constructor(
    private clientId: string | undefined,
    private clientSecret: string | undefined,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.clientId ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${q}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<{ tokens: OAuthTokens; accountEmail: string }> {
    const r = await this.tokenRequest({
      code,
      client_id: this.clientId ?? "",
      client_secret: this.clientSecret ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const tokens: OAuthTokens = {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
      scope: r.scope,
    };
    let accountEmail = "unknown";
    if (r.id_token) {
      try {
        const payload = JSON.parse(atob(r.id_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
        if (typeof payload.email === "string") accountEmail = payload.email;
      } catch {
        // id_token is informational here; the calendar calls do not depend on it.
      }
    }
    return { tokens, accountEmail };
  }

  private async tokenRequest(body: Record<string, string>): Promise<any> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`google token error ${res.status}: ${j.error ?? "unknown"}`);
    return j;
  }

  private async accessToken(ctx: ConnectionContext): Promise<string> {
    if (ctx.tokens.expiresAt - 60_000 > Date.now()) return ctx.tokens.accessToken;
    if (!ctx.tokens.refreshToken) throw new Error("google token expired and no refresh token");
    const r = await this.tokenRequest({
      client_id: this.clientId ?? "",
      client_secret: this.clientSecret ?? "",
      refresh_token: ctx.tokens.refreshToken,
      grant_type: "refresh_token",
    });
    const t: OAuthTokens = {
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? ctx.tokens.refreshToken,
      expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
      scope: r.scope ?? ctx.tokens.scope,
    };
    ctx.tokens = t;
    await ctx.saveTokens(t);
    return t.accessToken;
  }

  private async api(ctx: ConnectionContext, method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.accessToken(ctx);
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`google calendar ${method} ${path.split("?")[0]} ${res.status}: ${j?.error?.message ?? "error"}`);
    return j;
  }

  async listCalendars(ctx: ConnectionContext): Promise<ProviderCalendar[]> {
    const j = await this.api(ctx, "GET", "/users/me/calendarList?minAccessRole=reader&maxResults=250");
    return (j.items ?? []).map((c: any) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: Boolean(c.primary) }));
  }

  async freeBusy(ctx: ConnectionContext, calendarIds: string[], from: number, to: number) {
    if (!calendarIds.length) return [];
    const j = await this.api(ctx, "POST", "/freeBusy", {
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      items: calendarIds.map((id) => ({ id })),
    });
    const out: { start: number; end: number }[] = [];
    for (const cal of Object.values<any>(j.calendars ?? {})) {
      for (const b of cal.busy ?? []) out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
    }
    return out;
  }

  async busyEvents(ctx: ConnectionContext, calendarIds: string[], from: number, to: number) {
    const out: { id: string; calendarId: string; start: number; end: number }[] = [];
    for (const cal of calendarIds) {
      let pageToken: string | undefined;
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          singleEvents: "true",
          maxResults: "250",
          fields: "items(id,status,transparency,start,end,attendees(self,responseStatus)),nextPageToken,timeZone",
        });
        if (pageToken) q.set("pageToken", pageToken);
        const j = await this.api(ctx, "GET", `/calendars/${encodeURIComponent(cal)}/events?${q}`);
        const tz = typeof j.timeZone === "string" ? j.timeZone : "UTC";
        for (const e of j.items ?? []) {
          // Same rules as free/busy: transparent ("free"), canceled and declined events do not block.
          if (e.status === "cancelled" || e.transparency === "transparent") continue;
          if ((e.attendees ?? []).some((a: any) => a.self && a.responseStatus === "declined")) continue;
          const t = (x: any) => (x?.dateTime ? Date.parse(x.dateTime) : x?.date ? zonedToUtc(x.date, 0, tz) : Number.NaN);
          const start = t(e.start);
          const end = t(e.end);
          if (Number.isFinite(start) && Number.isFinite(end)) out.push({ id: e.id, calendarId: cal, start, end });
        }
        pageToken = j.nextPageToken;
        if (!pageToken) break;
      }
    }
    return out;
  }

  async createEvent(ctx: ConnectionContext, ev: CalendarEventInput): Promise<CalendarEventResult> {
    const body: any = {
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: new Date(ev.start).toISOString(), timeZone: ev.timezone },
      end: { dateTime: new Date(ev.end).toISOString(), timeZone: ev.timezone },
      attendees: ev.attendees.map((a) => ({ email: a.email, displayName: a.name })),
      location: ev.location,
      reminders: { useDefault: true },
    };
    if (ev.createMeet) {
      body.conferenceData = { createRequest: { requestId: ev.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
    }
    const q = `?sendUpdates=all${ev.createMeet ? "&conferenceDataVersion=1" : ""}`;
    const j = await this.api(ctx, "POST", `/calendars/${encodeURIComponent(ev.calendarId)}/events${q}`, body);
    const joinUrl = j.hangoutLink ?? j.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === "video")?.uri;
    return { eventId: j.id, joinUrl };
  }

  async updateEventTime(ctx: ConnectionContext, calendarId: string, eventId: string, start: number, end: number, timezone: string) {
    await this.api(ctx, "PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      start: { dateTime: new Date(start).toISOString(), timeZone: timezone },
      end: { dateTime: new Date(end).toISOString(), timeZone: timezone },
    });
  }

  async cancelEvent(ctx: ConnectionContext, calendarId: string, eventId: string) {
    await this.api(ctx, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`);
  }
}
