// Adapter interfaces. Hosting adapters implement Db; calendar adapters implement CalendarProvider;
// email adapters implement Mailer.

export type SqlValue = string | number | null;

export interface Db {
  readonly kind: string; // "d1" | "sqlite"
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Runs all statements in one transaction. */
  batch(stmts: { sql: string; params?: SqlValue[] }[]): Promise<{ changes: number }[]>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // ms
  scope?: string;
}

export interface ProviderCalendar {
  id: string;
  name: string;
  primary: boolean;
}

export interface CalendarEventInput {
  calendarId: string;
  summary: string;
  description: string;
  start: number;
  end: number;
  timezone: string;
  attendees: { email: string; name?: string }[];
  location?: string;
  createMeet: boolean;
  requestId: string; // idempotency key
}

export interface CalendarEventResult {
  eventId: string;
  joinUrl?: string;
}

export interface ConnectionContext {
  connectionId: string;
  userId: string;
  tokens: OAuthTokens;
  /** Persist refreshed tokens. */
  saveTokens(t: OAuthTokens): Promise<void>;
}

export interface CalendarProvider {
  readonly id: string;
  readonly name: string;
  configured(): boolean;
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<{ tokens: OAuthTokens; accountEmail: string }>;
  listCalendars(ctx: ConnectionContext): Promise<ProviderCalendar[]>;
  freeBusy(ctx: ConnectionContext, calendarIds: string[], from: number, to: number): Promise<{ start: number; end: number }[]>;
  /**
   * Busy events with their ids, used instead of freeBusy when one known event (a booking being rescheduled)
   * must be ignored. Must count exactly what freeBusy counts (opaque, not canceled, not declined).
   */
  busyEvents(ctx: ConnectionContext, calendarIds: string[], from: number, to: number): Promise<{ id: string; calendarId: string; start: number; end: number }[]>;
  createEvent(ctx: ConnectionContext, ev: CalendarEventInput): Promise<CalendarEventResult>;
  updateEventTime(ctx: ConnectionContext, calendarId: string, eventId: string, start: number, end: number, timezone: string): Promise<void>;
  cancelEvent(ctx: ConnectionContext, calendarId: string, eventId: string): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly id: string;
  send(msg: EmailMessage): Promise<void>;
}

export interface Clock {
  now(): number;
}
