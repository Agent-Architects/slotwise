import { hashPassword, newId, randomToken, SecretBox, sha256, timingSafeEqual, verifyPassword } from "./crypto.js";
import type { CalendarProvider, Clock, ConnectionContext, Db, Mailer, OAuthTokens, SqlValue } from "./ports.js";
import { computeSlots, groupByDate, resolveSettings } from "./slots.js";
import { addDays, dateDiffDays, DAY, localDate, MINUTE, zonedToUtc } from "./time.js";
import type { Availability, Booking, EventType, ExistingBooking, Location, Question, Schedule, User } from "./types.js";
import { ApiError } from "./validate.js";
import type * as V from "./validate.js";
import type { z } from "zod";
import brand from "../../brand.json";

export interface Config {
  appUrl: string; // origin used in links, no trailing slash
  appName: string; // product name in emails and calendar text
  allowSignup: boolean;
  /** When set, signup must present this code (protects a freshly deployed instance). */
  setupCode?: string;
  /** Guest notification emails per owner per rolling hour; beyond it they are recorded as suppressed. */
  guestEmailsPerHour: number;
  mockCalendar: boolean;
  rateLimits: { publicRead: number; publicWrite: number; auth: number };
  version: string;
}

export interface Deps {
  db: Db;
  mailer: Mailer;
  providers: CalendarProvider[];
  box: SecretBox;
  clock: Clock;
  config: Config;
}

const RESERVED = new Set(["app", "api", "booking", "oauth", "login", "signup", "logout", "assets", "healthz", "settings", "admin", "static", "public", "favicon-ico"]);
const SESSION_TTL = 30 * DAY;

const iso = (ms: number) => new Date(ms).toISOString();
const j = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

type Row = Record<string, any>;

function toUser(r: Row): User {
  return { id: r.id, email: r.email, username: r.username, name: r.name, timezone: r.timezone, welcome: r.welcome, createdAt: r.created_at };
}

function toAvailability(r: Row): Availability {
  return {
    timezone: r.timezone,
    weekly: j(r.weekly, {}),
    overrides: j(r.overrides, {}),
    bufferBefore: r.buffer_before,
    bufferAfter: r.buffer_after,
    minNotice: r.min_notice,
    maxDaysAhead: r.max_days_ahead,
    maxPerDay: r.max_per_day ?? null,
    scheduleName: r.schedule_name ?? "Working hours",
    maxGuests: r.max_guests ?? 3,
    updatedAt: r.updated_at,
  };
}

function toSchedule(r: Row): Schedule {
  return { id: r.id, name: r.name, timezone: r.timezone, weekly: j(r.weekly, {}), overrides: j(r.overrides, {}), isDefault: false, createdAt: r.created_at, updatedAt: r.updated_at };
}

function toEventType(r: Row): EventType {
  return {
    id: r.id,
    userId: r.user_id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    durations: j(r.durations, [30]),
    defaultDuration: r.default_duration,
    slotInterval: r.slot_interval ?? null,
    location: j(r.location, { kind: "google_meet" }),
    questions: j(r.questions, []),
    color: r.color,
    active: Boolean(r.active),
    bufferBefore: r.buffer_before ?? null,
    bufferAfter: r.buffer_after ?? null,
    minNotice: r.min_notice ?? null,
    maxDaysAhead: r.max_days_ahead ?? null,
    maxPerDay: r.max_per_day ?? null,
    scheduleId: r.schedule_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** fallbackLabels: current question labels, used for bookings made before labels were snapshotted. */
function toBooking(r: Row, fallbackLabels: Record<string, string> = {}): Booking {
  const answers = j<Record<string, string>>(r.answers, {});
  const labels = j<Record<string, string>>(r.answer_labels, {});
  return {
    id: r.id,
    userId: r.user_id,
    eventTypeId: r.event_type_id,
    eventTypeName: r.event_type_name,
    status: r.status,
    start: iso(r.start_ms),
    end: iso(r.end_ms),
    blockStart: iso(r.block_start_ms),
    blockEnd: iso(r.block_end_ms),
    localDate: r.local_date,
    duration: r.duration,
    invitee: { name: r.invitee_name, email: r.invitee_email, timezone: r.invitee_timezone, ...(r.invitee_phone ? { phone: r.invitee_phone } : {}) },
    guests: j(r.guests, []),
    answers,
    answerDetails: Object.entries(answers).map(([id, value]) => ({ id, label: labels[id] ?? fallbackLabels[id] ?? id, value })),
    location: j(r.location, { kind: "custom" }),
    external: j(r.external, null),
    calendarError: r.calendar_error ?? null,
    cancelReason: r.cancel_reason ?? null,
    cancelledBy: r.cancelled_by ?? null,
    cancelledAt: r.cancelled_at ?? null,
    rescheduleCount: r.reschedule_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "event"
  );
}

const DEFAULT_WEEKLY = {
  "0": [],
  "1": [{ start: "09:00", end: "17:00" }],
  "2": [{ start: "09:00", end: "17:00" }],
  "3": [{ start: "09:00", end: "17:00" }],
  "4": [{ start: "09:00", end: "17:00" }],
  "5": [{ start: "09:00", end: "17:00" }],
  "6": [],
};

/** Default location for event types created without one while no calendar is connected. */
export const NO_CALENDAR_LOCATION = { kind: "custom", value: "The organizer will share meeting details" } as const;
// Event type colors: the brand primary first (the default event type), then a fixed palette for the next ones.
const COLORS = [brand.primary, "#b45309", "#7c3aed", "#be123c", "#0369a1", "#4d7c0f"];

/** Invitee-chosen name made safe for emails to third parties: one line, no links or markup, at most 60 chars. */
export function safeName(name: string): string {
  const s = name
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "")
    .replace(/\bwww\.\S*/gi, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const short = [...s].length > 60 ? `${[...s].slice(0, 59).join("")}...` : s;
  return short || "An invitee";
}

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Spreadsheet formula injection: neutralize cells that start with a formula character.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function publicLocation(l: Location): Location {
  // Links and phone numbers are revealed only to the invitee after booking.
  if (l.kind === "in_person" || l.kind === "custom") return l;
  return { kind: l.kind };
}

export class Service {
  constructor(private d: Deps) {}

  get db() {
    return this.d.db;
  }
  get config() {
    return this.d.config;
  }
  now() {
    return this.d.clock.now();
  }
  provider(id: string): CalendarProvider {
    const p = this.d.providers.find((p) => p.id === id);
    if (!p) throw new ApiError(404, "not_found", `Unknown calendar provider ${id}`);
    return p;
  }
  get providers() {
    return this.d.providers;
  }
  get mailer() {
    return this.d.mailer;
  }

  // ---------- rate limiting ----------
  async rateLimit(bucket: string, limit: number): Promise<void> {
    if (limit <= 0) return;
    const window = Math.floor(this.now() / 60_000) * 60_000;
    const r = await this.db.first<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
      [bucket, window],
    );
    if (Math.random() < 0.01) await this.db.run("DELETE FROM rate_limits WHERE window_start < ?", [window - 3_600_000]);
    if ((r?.count ?? 0) > limit) {
      throw new ApiError(429, "rate_limited", "Too many requests, try again shortly", { retryAfter: Math.ceil((window + 60_000 - this.now()) / 1000) });
    }
  }

  // ---------- auth ----------
  async userCount(): Promise<number> {
    return (await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM users"))?.n ?? 0;
  }

  async signup(input: z.infer<typeof V.signup>): Promise<User> {
    if (!this.config.allowSignup && (await this.userCount()) > 0) throw new ApiError(403, "forbidden", "Signup is closed");
    if (this.config.setupCode && !timingSafeEqual(input.setupCode ?? "", this.config.setupCode)) {
      throw new ApiError(403, "forbidden", "Setup code is missing or wrong", { issues: [{ path: "setupCode", message: "invalid" }] });
    }
    if (RESERVED.has(input.username)) throw new ApiError(409, "conflict", "That username is reserved");
    const exists = await this.db.first("SELECT 1 FROM users WHERE email = ? OR username = ?", [input.email, input.username]);
    if (exists) throw new ApiError(409, "conflict", "Email or username already in use");
    const id = newId("usr");
    const now = iso(this.now());
    const etId = newId("evt");
    const hash = await hashPassword(input.password);
    // One transaction. When signup is closed, the user insert only happens while the table is empty, so parallel
    // first signups cannot all win; the dependent inserts only run if this user row exists.
    const open = this.config.allowSignup ? 1 : 0;
    let res: { changes: number }[];
    try {
      res = await this.db.batch([
        {
          sql: `INSERT INTO users (id, email, username, name, timezone, welcome, password_hash, created_at)
                SELECT ?, ?, ?, ?, ?, '', ?, ? WHERE ? = 1 OR NOT EXISTS (SELECT 1 FROM users)`,
          params: [id, input.email, input.username, input.name, input.timezone, hash, now, open],
        },
        {
          sql: `INSERT INTO availability (user_id, timezone, weekly, overrides, buffer_before, buffer_after, min_notice, max_days_ahead, max_per_day, updated_at)
                SELECT ?, ?, ?, '{}', 0, 0, 240, 60, NULL, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
          params: [id, input.timezone, JSON.stringify(DEFAULT_WEEKLY), now, id],
        },
        {
          sql: `INSERT INTO event_types (id, user_id, slug, name, description, durations, default_duration, slot_interval, location, questions, color, active, created_at, updated_at)
                SELECT ?, ?, '30min', '30 minute meeting', '', '[30]', 30, NULL, '{"kind":"google_meet"}', '[]', ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
          params: [etId, id, COLORS[0]!, now, now, id],
        },
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) throw new ApiError(409, "conflict", "Email or username already in use");
      throw e;
    }
    if (!res[0]?.changes) throw new ApiError(403, "forbidden", "Signup is closed");
    return (await this.getUser(id))!;
  }

  async login(email: string, password: string): Promise<User> {
    const r = await this.db.first<Row>("SELECT * FROM users WHERE email = ?", [email]);
    // Hash even when the user is missing so response time does not reveal which emails exist.
    const ok = await verifyPassword(password, r?.password_hash ?? "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    if (!r || !ok) throw new ApiError(401, "unauthorized", "Wrong email or password");
    return toUser(r);
  }

  async createSession(userId: string): Promise<{ token: string; csrf: string }> {
    const token = randomToken();
    const csrf = randomToken(24);
    await this.db.run("INSERT INTO sessions (token_hash, user_id, csrf, expires_at, created_at) VALUES (?, ?, ?, ?, ?)", [
      await sha256(token),
      userId,
      csrf,
      this.now() + SESSION_TTL,
      iso(this.now()),
    ]);
    return { token, csrf };
  }

  async session(token: string): Promise<{ user: User; csrf: string } | null> {
    const r = await this.db.first<Row>(
      "SELECT u.*, s.csrf AS s_csrf, s.expires_at AS s_exp FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
      [await sha256(token)],
    );
    if (!r || r.s_exp < this.now()) return null;
    return { user: toUser(r), csrf: r.s_csrf };
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.run("DELETE FROM sessions WHERE token_hash = ?", [await sha256(token)]);
  }

  async tokenAuth(token: string): Promise<{ user: User; scopes: string[]; tokenId: string } | null> {
    if (!token.startsWith("sw_")) return null;
    const r = await this.db.first<Row>(
      "SELECT u.*, t.id AS t_id, t.scopes AS t_scopes FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL",
      [await sha256(token)],
    );
    if (!r) return null;
    await this.db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", [iso(this.now()), r.t_id]);
    return { user: toUser(r), scopes: j(r.t_scopes, []), tokenId: r.t_id };
  }

  async createApiToken(userId: string, name: string, scopes: string[]) {
    const token = `sw_${randomToken()}`;
    const id = newId("tok");
    await this.db.run("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      userId,
      name,
      await sha256(token),
      token.slice(0, 9),
      JSON.stringify(scopes),
      iso(this.now()),
    ]);
    return { token, apiToken: (await this.listTokens(userId)).find((t) => t.id === id)! };
  }

  async listTokens(userId: string) {
    const rows = await this.db.all<Row>("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC", [userId]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: j<string[]>(r.scopes, []),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? null,
      revokedAt: r.revoked_at ?? null,
    }));
  }

  async revokeToken(userId: string, id: string) {
    const r = await this.db.run("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL", [iso(this.now()), id, userId]);
    if (!r.changes) throw new ApiError(404, "not_found", "Token not found");
  }

  // ---------- profile ----------
  async getUser(id: string): Promise<User | null> {
    const r = await this.db.first<Row>("SELECT * FROM users WHERE id = ?", [id]);
    return r ? toUser(r) : null;
  }

  async userByUsername(username: string): Promise<User> {
    const r = await this.db.first<Row>("SELECT * FROM users WHERE username = ?", [username]);
    if (!r) throw new ApiError(404, "not_found", "Page not found");
    return toUser(r);
  }

  async patchUser(id: string, p: z.infer<typeof V.profilePatch>): Promise<User> {
    if (p.username) {
      if (RESERVED.has(p.username)) throw new ApiError(409, "conflict", "That username is reserved");
      const taken = await this.db.first("SELECT 1 FROM users WHERE username = ? AND id != ?", [p.username, id]);
      if (taken) throw new ApiError(409, "conflict", "Username already in use");
    }
    const sets: string[] = [];
    const vals: SqlValue[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v as string);
    }
    if (sets.length) await this.db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
    return (await this.getUser(id))!;
  }

  private async checkPassword(userId: string, password: string) {
    const r = await this.db.first<Row>("SELECT password_hash FROM users WHERE id = ?", [userId]);
    if (!r || !(await verifyPassword(password, r.password_hash))) {
      throw new ApiError(403, "forbidden", "Current password is wrong", { issues: [{ path: "currentPassword", message: "wrong password" }] });
    }
  }

  /**
   * Changes the password and signs out every other browser session (keepSessionToken stays signed in). API tokens
   * are revoked too unless revokeTokens is false, because a password change is usually a response to a leak.
   */
  async changePassword(userId: string, current: string, next: string, keepSessionToken?: string, revokeTokens = true) {
    await this.checkPassword(userId, current);
    await this.db.run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(next), userId]);
    const keep = keepSessionToken ? await sha256(keepSessionToken) : "";
    await this.db.run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", [userId, keep]);
    let revokedTokens = 0;
    if (revokeTokens) {
      revokedTokens = (await this.db.run("UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [iso(this.now()), userId])).changes;
    }
    return { revokedTokens };
  }

  async changeEmail(userId: string, current: string, email: string): Promise<User> {
    await this.checkPassword(userId, current);
    if (await this.db.first("SELECT 1 FROM users WHERE email = ? AND id != ?", [email, userId])) throw new ApiError(409, "conflict", "Email already in use");
    try {
      await this.db.run("UPDATE users SET email = ? WHERE id = ?", [email, userId]);
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) throw new ApiError(409, "conflict", "Email already in use");
      throw e;
    }
    return (await this.getUser(userId))!;
  }

  bookingUrl(username: string, slug?: string) {
    return `${this.config.appUrl}/${username}${slug ? `/${slug}` : ""}`;
  }

  async links(user: User) {
    const ets = await this.listEventTypes(user.id);
    return {
      profileUrl: this.bookingUrl(user.username),
      eventTypes: ets.map((e) => ({ id: e.id, slug: e.slug, name: e.name, active: e.active, url: this.bookingUrl(user.username, e.slug) })),
    };
  }

  // ---------- availability ----------
  async getAvailability(userId: string): Promise<Availability> {
    const r = await this.db.first<Row>("SELECT * FROM availability WHERE user_id = ?", [userId]);
    if (!r) throw new ApiError(404, "not_found", "No availability");
    return toAvailability(r);
  }

  async patchAvailability(userId: string, p: z.infer<typeof V.availabilityPatch>): Promise<Availability> {
    const cur = await this.getAvailability(userId);
    const next: Availability = {
      ...cur,
      ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
      weekly: { ...cur.weekly, ...(p.weekly ?? {}) },
      overrides: p.overrides ?? cur.overrides,
    } as Availability;
    await this.saveAvailability(userId, next);
    return this.getAvailability(userId);
  }

  async setOverride(userId: string, date: string, intervals: { start: string; end: string }[] | null) {
    const cur = await this.getAvailability(userId);
    const overrides = { ...cur.overrides };
    if (intervals === null) delete overrides[date];
    else overrides[date] = [...intervals].sort((a, b) => a.start.localeCompare(b.start));
    // Drop overrides that are long past to keep the document small.
    const cutoff = addDays(localDate(this.now(), cur.timezone), -60);
    for (const d of Object.keys(overrides)) if (d < cutoff) delete overrides[d];
    await this.saveAvailability(userId, { ...cur, overrides });
    return this.getAvailability(userId);
  }

  private async saveAvailability(userId: string, a: Availability) {
    await this.db.run(
      `UPDATE availability SET timezone = ?, weekly = ?, overrides = ?, buffer_before = ?, buffer_after = ?, min_notice = ?,
       max_days_ahead = ?, max_per_day = ?, schedule_name = ?, max_guests = ?, updated_at = ? WHERE user_id = ?`,
      [
        a.timezone,
        JSON.stringify(a.weekly),
        JSON.stringify(a.overrides),
        a.bufferBefore,
        a.bufferAfter,
        a.minNotice,
        a.maxDaysAhead,
        a.maxPerDay,
        a.scheduleName ?? "Working hours",
        a.maxGuests ?? 3,
        iso(this.now()),
        userId,
      ],
    );
  }

  // ---------- schedules ----------
  // The availability document is the default schedule (id "default"); extra named schedules live in `schedules`.
  // Buffers, notice, horizon and the owner-wide daily cap always come from the availability document.
  async listSchedules(userId: string): Promise<Schedule[]> {
    const av = await this.getAvailability(userId);
    const rows = await this.db.all<Row>("SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at", [userId]);
    return [
      { id: "default", name: av.scheduleName ?? "Working hours", timezone: av.timezone, weekly: av.weekly, overrides: av.overrides, isDefault: true, updatedAt: av.updatedAt },
      ...rows.map(toSchedule),
    ];
  }

  async getSchedule(userId: string, id: string): Promise<Schedule> {
    if (id === "default") return (await this.listSchedules(userId))[0]!;
    const r = await this.db.first<Row>("SELECT * FROM schedules WHERE id = ? AND user_id = ?", [id, userId]);
    if (!r) throw new ApiError(404, "not_found", "Schedule not found");
    return toSchedule(r);
  }

  async createSchedule(userId: string, p: z.infer<typeof V.scheduleCreate>): Promise<Schedule> {
    const def = await this.getAvailability(userId);
    const id = newId("sch");
    const now = iso(this.now());
    await this.db.run("INSERT INTO schedules (id, user_id, name, timezone, weekly, overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      userId,
      p.name,
      p.timezone ?? def.timezone,
      JSON.stringify({ ...DEFAULT_WEEKLY, ...(p.weekly ?? {}) }),
      JSON.stringify(p.overrides ?? {}),
      now,
      now,
    ]);
    return this.getSchedule(userId, id);
  }

  async patchSchedule(userId: string, id: string, p: z.infer<typeof V.schedulePatch>): Promise<Schedule> {
    if (id === "default") {
      const cur = await this.getAvailability(userId);
      await this.saveAvailability(userId, {
        ...cur,
        scheduleName: p.name ?? cur.scheduleName,
        timezone: p.timezone ?? cur.timezone,
        weekly: { ...cur.weekly, ...(p.weekly ?? {}) },
        overrides: p.overrides ?? cur.overrides,
      });
      return this.getSchedule(userId, id);
    }
    const cur = await this.getSchedule(userId, id);
    await this.db.run("UPDATE schedules SET name = ?, timezone = ?, weekly = ?, overrides = ?, updated_at = ? WHERE id = ? AND user_id = ?", [
      p.name ?? cur.name,
      p.timezone ?? cur.timezone,
      JSON.stringify({ ...cur.weekly, ...(p.weekly ?? {}) }),
      JSON.stringify(p.overrides ?? cur.overrides),
      iso(this.now()),
      id,
      userId,
    ]);
    return this.getSchedule(userId, id);
  }

  async setScheduleOverride(userId: string, id: string, date: string, intervals: { start: string; end: string }[] | null): Promise<Schedule> {
    if (id === "default") {
      await this.setOverride(userId, date, intervals);
      return this.getSchedule(userId, id);
    }
    const cur = await this.getSchedule(userId, id);
    const overrides = { ...cur.overrides };
    if (intervals === null) delete overrides[date];
    else overrides[date] = [...intervals].sort((a, b) => a.start.localeCompare(b.start));
    return this.patchSchedule(userId, id, { overrides });
  }

  async deleteSchedule(userId: string, id: string, force: boolean) {
    if (id === "default") throw new ApiError(409, "conflict", "The default schedule cannot be deleted");
    await this.getSchedule(userId, id);
    const used = await this.db.all<Row>("SELECT name FROM event_types WHERE user_id = ? AND schedule_id = ?", [userId, id]);
    if (used.length && !force) {
      throw new ApiError(409, "conflict", `Schedule is used by ${used.map((u) => u.name).join(", ")}; move them or pass force=true`);
    }
    await this.db.batch([
      { sql: "UPDATE event_types SET schedule_id = NULL WHERE user_id = ? AND schedule_id = ?", params: [userId, id] },
      { sql: "DELETE FROM schedules WHERE id = ? AND user_id = ?", params: [id, userId] },
    ]);
  }

  /** Availability used for an event type: its schedule's hours plus the owner-wide limits. */
  async resolveAvailability(userId: string, et?: EventType): Promise<Availability> {
    const base = await this.getAvailability(userId);
    if (!et?.scheduleId) return base;
    const r = await this.db.first<Row>("SELECT * FROM schedules WHERE id = ? AND user_id = ?", [et.scheduleId, userId]);
    if (!r) return base;
    const s = toSchedule(r);
    return { ...base, timezone: s.timezone, weekly: s.weekly, overrides: s.overrides, scheduleName: s.name };
  }

  private async checkScheduleRef(userId: string, scheduleId: string | null | undefined): Promise<string | null | undefined> {
    if (scheduleId === undefined) return undefined;
    if (scheduleId === null || scheduleId === "default") return null;
    await this.getSchedule(userId, scheduleId);
    return scheduleId;
  }

  // ---------- event types ----------
  withUrl(username: string, e: EventType) {
    return { ...e, url: this.bookingUrl(username, e.slug) };
  }

  async listEventTypes(userId: string): Promise<EventType[]> {
    const rows = await this.db.all<Row>("SELECT * FROM event_types WHERE user_id = ? ORDER BY created_at ASC", [userId]);
    return rows.map(toEventType);
  }

  async getEventType(userId: string, id: string): Promise<EventType> {
    const r = await this.db.first<Row>("SELECT * FROM event_types WHERE id = ? AND user_id = ?", [id, userId]);
    if (!r) throw new ApiError(404, "not_found", "Event type not found");
    return toEventType(r);
  }

  private normalizeDurations(durations: number[] | undefined, def: number | undefined, cur?: EventType) {
    const ds = [...new Set(durations ?? cur?.durations ?? (def ? [def] : [30]))].sort((a, b) => a - b);
    let dd = def ?? cur?.defaultDuration ?? ds[0]!;
    if (!ds.includes(dd)) {
      if (def !== undefined) throw new ApiError(400, "bad_request", "defaultDuration must be one of durations");
      dd = ds[0]!;
    }
    return { ds, dd };
  }

  async createEventType(userId: string, p: z.infer<typeof V.eventTypeCreate>): Promise<EventType> {
    this.checkQuestionIds(p.questions);
    const { ds, dd } = this.normalizeDurations(p.durations, p.defaultDuration);
    let slug = p.slug ?? slugify(p.name);
    if (p.slug) {
      if (await this.db.first("SELECT 1 FROM event_types WHERE user_id = ? AND slug = ?", [userId, slug])) throw new ApiError(409, "conflict", "Slug already in use");
    } else {
      const base = slug;
      for (let i = 2; await this.db.first("SELECT 1 FROM event_types WHERE user_id = ? AND slug = ?", [userId, slug]); i++) slug = `${base.slice(0, 55)}-${i}`;
    }
    const scheduleId = (await this.checkScheduleRef(userId, p.scheduleId)) ?? null;
    const count = (await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM event_types WHERE user_id = ?", [userId]))?.n ?? 0;
    // Without a connected calendar nothing can create a Meet link, so do not promise one.
    const location = p.location ?? ((await this.db.first("SELECT 1 FROM calendar_connections WHERE user_id = ?", [userId])) ? { kind: "google_meet" } : NO_CALENDAR_LOCATION);
    const id = newId("evt");
    const now = iso(this.now());
    await this.db.run(
      `INSERT INTO event_types (id, user_id, slug, name, description, durations, default_duration, slot_interval, location, questions, color, active,
        buffer_before, buffer_after, min_notice, max_days_ahead, max_per_day, schedule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        userId,
        slug,
        p.name,
        p.description ?? "",
        JSON.stringify(ds),
        dd,
        p.slotInterval ?? null,
        JSON.stringify(location),
        JSON.stringify(p.questions ?? []),
        p.color ?? COLORS[count % COLORS.length]!,
        p.active === false ? 0 : 1,
        p.bufferBefore ?? null,
        p.bufferAfter ?? null,
        p.minNotice ?? null,
        p.maxDaysAhead ?? null,
        p.maxPerDay ?? null,
        scheduleId,
        now,
        now,
      ],
    );
    return this.getEventType(userId, id);
  }

  private checkQuestionIds(qs?: Question[]) {
    if (qs && new Set(qs.map((q) => q.id)).size !== qs.length) throw new ApiError(400, "bad_request", "question ids must be unique");
  }

  async patchEventType(userId: string, id: string, p: z.infer<typeof V.eventTypePatch>): Promise<EventType> {
    const cur = await this.getEventType(userId, id);
    this.checkQuestionIds(p.questions);
    if (p.slug && p.slug !== cur.slug && (await this.db.first("SELECT 1 FROM event_types WHERE user_id = ? AND slug = ?", [userId, p.slug]))) {
      throw new ApiError(409, "conflict", "Slug already in use");
    }
    const { ds, dd } = this.normalizeDurations(p.durations, p.defaultDuration, cur);
    const scheduleId = await this.checkScheduleRef(userId, p.scheduleId);
    const n = {
      ...cur,
      ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
      durations: ds,
      defaultDuration: dd,
      scheduleId: scheduleId === undefined ? cur.scheduleId : scheduleId,
    } as EventType;
    await this.db.run(
      `UPDATE event_types SET slug = ?, name = ?, description = ?, durations = ?, default_duration = ?, slot_interval = ?, location = ?, questions = ?,
       color = ?, active = ?, buffer_before = ?, buffer_after = ?, min_notice = ?, max_days_ahead = ?, max_per_day = ?, schedule_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [
        n.slug,
        n.name,
        n.description,
        JSON.stringify(n.durations),
        n.defaultDuration,
        n.slotInterval,
        JSON.stringify(n.location),
        JSON.stringify(n.questions),
        n.color,
        n.active ? 1 : 0,
        n.bufferBefore,
        n.bufferAfter,
        n.minNotice,
        n.maxDaysAhead,
        n.maxPerDay,
        n.scheduleId,
        iso(this.now()),
        id,
        userId,
      ],
    );
    return this.getEventType(userId, id);
  }

  async deleteEventType(userId: string, id: string, force: boolean) {
    await this.getEventType(userId, id);
    const upcoming = await this.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM bookings WHERE event_type_id = ? AND status = 'confirmed' AND start_ms > ?",
      [id, this.now()],
    );
    if ((upcoming?.n ?? 0) > 0 && !force) {
      throw new ApiError(409, "conflict", `Event type has ${upcoming!.n} upcoming ${upcoming!.n === 1 ? "booking" : "bookings"}; cancel them or pass force=true`);
    }
    await this.db.run("DELETE FROM event_types WHERE id = ? AND user_id = ?", [id, userId]);
  }

  // ---------- public pages ----------
  async publicEventType(username: string, slug: string) {
    const owner = await this.userByUsername(username);
    const r = await this.db.first<Row>("SELECT * FROM event_types WHERE user_id = ? AND slug = ? AND active = 1", [owner.id, slug]);
    if (!r) throw new ApiError(404, "not_found", "Event type not found");
    return { owner, eventType: toEventType(r) };
  }

  publicOwner(u: User) {
    return { name: u.name, username: u.username, welcome: u.welcome };
  }

  publicEventTypeView(e: EventType) {
    return {
      id: e.id,
      slug: e.slug,
      name: e.name,
      description: e.description,
      durations: e.durations,
      defaultDuration: e.defaultDuration,
      location: publicLocation(e.location),
      questions: e.questions,
      color: e.color,
    };
  }

  // ---------- calendars ----------
  async connections(userId: string) {
    const rows = await this.db.all<Row>("SELECT * FROM calendar_connections WHERE user_id = ? ORDER BY created_at", [userId]);
    return rows;
  }

  connectionView(r: Row) {
    return {
      id: r.id,
      provider: r.provider,
      accountEmail: r.account_email,
      checkCalendarIds: j<string[]>(r.check_calendar_ids, []),
      writeCalendarId: r.write_calendar_id ?? null,
      lastError: r.last_error ?? null,
      lastErrorAt: r.last_error_at ?? null,
      createdAt: r.created_at,
    };
  }

  async connCtx(r: Row): Promise<ConnectionContext> {
    const tokens = JSON.parse(await this.d.box.open(r.enc_tokens)) as OAuthTokens;
    return {
      connectionId: r.id,
      userId: r.user_id,
      tokens,
      saveTokens: async (t) => {
        await this.db.run("UPDATE calendar_connections SET enc_tokens = ?, updated_at = ? WHERE id = ?", [await this.d.box.seal(JSON.stringify(t)), iso(this.now()), r.id]);
      },
    };
  }

  /**
   * Busy intervals from every checked calendar. `exclude` names one calendar event to ignore (the event written for
   * a booking that is being rescheduled). Only that event is dropped: another event at the same time still blocks,
   * so for that connection the event list is read instead of the merged free/busy blocks.
   * Connection health is recorded; the owner is notified when a calendar starts failing.
   */
  async busy(userId: string, from: number, to: number, exclude?: { connectionId: string; eventId: string } | null) {
    const busy: { start: number; end: number }[] = [];
    const errors: string[] = [];
    for (const c of await this.connections(userId)) {
      const ids = j<string[]>(c.check_calendar_ids, []);
      if (!ids.length) continue;
      try {
        const p = this.provider(c.provider);
        const ctx = await this.connCtx(c);
        if (exclude && exclude.connectionId === c.id) {
          for (const e of await p.busyEvents(ctx, ids, from, to)) if (e.id !== exclude.eventId) busy.push({ start: e.start, end: e.end });
        } else busy.push(...(await p.freeBusy(ctx, ids, from, to)));
        if (c.last_error) await this.db.run("UPDATE calendar_connections SET last_error = NULL, last_error_at = NULL WHERE id = ?", [c.id]);
      } catch (e) {
        const msg = `${c.provider}: ${String((e as Error).message).slice(0, 300)}`;
        errors.push(msg);
        await this.recordCalendarError(c, msg);
      }
    }
    return { busy, errors };
  }

  private async recordCalendarError(c: Row, msg: string) {
    // Only the transition from healthy to failing notifies, so a broken calendar does not flood the inbox.
    const r = await this.db.run("UPDATE calendar_connections SET last_error = ?, last_error_at = ? WHERE id = ? AND last_error IS NULL", [msg, iso(this.now()), c.id]);
    if (!r.changes) {
      await this.db.run("UPDATE calendar_connections SET last_error = ? WHERE id = ?", [msg, c.id]);
      return;
    }
    const owner = await this.getUser(c.user_id);
    if (!owner) return;
    const name = this.d.providers.find((p) => p.id === c.provider)?.name ?? c.provider;
    await this.sendAndRecord(owner.id, null, "calendar_error", "owner", owner.email, `Action needed: ${name} is not responding`,
      `${this.config.appName} could not read ${name} (${c.account_email}) to check your availability.\n\nUntil this is fixed, your booking pages show no available times so nobody can book over an existing meeting.\n\nError: ${msg}\n\nReconnect: ${this.config.appUrl}/app/integrations\n`);
  }

  async alerts(userId: string) {
    const rows = await this.db.all<Row>("SELECT * FROM calendar_connections WHERE user_id = ? AND last_error IS NOT NULL", [userId]);
    return rows.map((r) => ({
      kind: "calendar_error",
      connectionId: r.id,
      provider: r.provider,
      providerName: this.d.providers.find((p) => p.id === r.provider)?.name ?? r.provider,
      accountEmail: r.account_email,
      message: r.last_error,
      since: r.last_error_at,
    }));
  }

  redirectUri(provider: string) {
    return `${this.config.appUrl}/oauth/${provider}/callback`;
  }

  async startConnect(userId: string, providerId: string): Promise<string> {
    const p = this.provider(providerId);
    if (!p.configured()) throw new ApiError(400, "bad_request", `${p.name} is not configured on this server (missing OAuth client)`);
    const state = randomToken();
    await this.db.run("DELETE FROM oauth_states WHERE expires_at < ?", [this.now()]);
    await this.db.run("INSERT INTO oauth_states (state_hash, user_id, provider, expires_at) VALUES (?, ?, ?, ?)", [
      await sha256(state),
      userId,
      providerId,
      this.now() + 10 * MINUTE,
    ]);
    return p.authorizeUrl(state, this.redirectUri(providerId));
  }

  async finishConnect(providerId: string, code: string, state: string, sessionUserId: string | null) {
    const p = this.provider(providerId);
    const h = await sha256(state);
    const st = await this.db.first<Row>("SELECT * FROM oauth_states WHERE state_hash = ? AND provider = ?", [h, providerId]);
    await this.db.run("DELETE FROM oauth_states WHERE state_hash = ?", [h]);
    if (!st || st.expires_at < this.now()) throw new ApiError(400, "bad_request", "OAuth state expired or invalid; start again");
    // Bind the callback to the browser session that started it.
    if (sessionUserId !== st.user_id) throw new ApiError(403, "forbidden", "OAuth callback does not match the signed-in owner");
    const { tokens, accountEmail } = await p.exchangeCode(code, this.redirectUri(providerId));
    const sealed = await this.d.box.seal(JSON.stringify(tokens));
    const existing = await this.db.first<Row>("SELECT * FROM calendar_connections WHERE user_id = ? AND provider = ? AND account_email = ?", [
      st.user_id,
      providerId,
      accountEmail,
    ]);
    const now = iso(this.now());
    if (existing) {
      // Keep the old refresh token if Google did not send a new one.
      const old = JSON.parse(await this.d.box.open(existing.enc_tokens)) as OAuthTokens;
      const merged = { ...tokens, refreshToken: tokens.refreshToken ?? old.refreshToken };
      await this.db.run("UPDATE calendar_connections SET enc_tokens = ?, updated_at = ? WHERE id = ?", [await this.d.box.seal(JSON.stringify(merged)), now, existing.id]);
      return existing.id as string;
    }
    const id = newId("con");
    let check: string[] = [];
    let write: string | null = null;
    try {
      const ctx: ConnectionContext = { connectionId: id, userId: st.user_id, tokens, saveTokens: async () => {} };
      const cals = await p.listCalendars(ctx);
      const primary = cals.find((c) => c.primary) ?? cals[0];
      if (primary) {
        check = [primary.id];
        write = primary.id;
      }
    } catch {
      // Calendars can be chosen later on the integrations page.
    }
    await this.db.run(
      `INSERT INTO calendar_connections (id, user_id, provider, account_email, enc_tokens, check_calendar_ids, write_calendar_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, st.user_id, providerId, accountEmail, sealed, JSON.stringify(check), write, now, now],
    );
    return id;
  }

  async connection(userId: string, id: string): Promise<Row> {
    const r = await this.db.first<Row>("SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?", [id, userId]);
    if (!r) throw new ApiError(404, "not_found", "Connection not found");
    return r;
  }

  async listCalendars(userId: string, id: string) {
    const c = await this.connection(userId, id);
    try {
      return await this.provider(c.provider).listCalendars(await this.connCtx(c));
    } catch (e) {
      throw new ApiError(502, "provider_error", (e as Error).message);
    }
  }

  async patchConnection(userId: string, id: string, p: z.infer<typeof V.connectionPatch>) {
    const c = await this.connection(userId, id);
    await this.db.run("UPDATE calendar_connections SET check_calendar_ids = ?, write_calendar_id = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(p.checkCalendarIds ?? j(c.check_calendar_ids, [])),
      p.writeCalendarId === undefined ? c.write_calendar_id : p.writeCalendarId,
      iso(this.now()),
      id,
    ]);
    return this.connectionView(await this.connection(userId, id));
  }

  async deleteConnection(userId: string, id: string) {
    await this.connection(userId, id);
    await this.db.run("DELETE FROM calendar_connections WHERE id = ?", [id]);
  }

  // ---------- slots ----------
  private async ownerBookings(userId: string, from: number, to: number, excludeId?: string): Promise<ExistingBooking[]> {
    const rows = await this.db.all<Row>(
      `SELECT start_ms, end_ms, block_start_ms, block_end_ms, event_type_id, local_date FROM bookings
       WHERE user_id = ? AND status = 'confirmed' AND block_end_ms > ? AND block_start_ms < ? AND id != ?`,
      [userId, from, to, excludeId ?? ""],
    );
    return rows.map((r) => ({ start: r.start_ms, end: r.end_ms, blockStart: r.block_start_ms, blockEnd: r.block_end_ms, eventTypeId: r.event_type_id, localDate: r.local_date }));
  }

  /** exclude: the booking being rescheduled (its row and its calendar event do not block the new time). */
  async slotsFor(owner: User, et: EventType, duration: number, windowStart: number, windowEnd: number, exclude?: { id: string; external: Booking["external"] }) {
    if (!et.durations.includes(duration)) throw new ApiError(400, "bad_request", `duration must be one of ${et.durations.join(", ")}`);
    const av = await this.resolveAvailability(owner.id, et);
    const settings = resolveSettings(av, et, duration);
    const now = this.now();
    const lastInstant = zonedToUtc(addDays(localDate(now, av.timezone), settings.maxDaysAhead + 1), 0, av.timezone);
    const ws = Math.max(windowStart, now);
    const we = Math.min(windowEnd, lastInstant);
    if (we <= ws) return { slots: [], errors: [] as string[], settings, availability: av };
    // Wide enough to see neighbours' buffers and every booking on the owner-local dates in range (daily limits).
    const pad = 2 * DAY;
    const bookings = await this.ownerBookings(owner.id, ws - pad, we + pad, exclude?.id);
    const { busy, errors } = await this.busy(owner.id, ws - DAY, we + DAY, exclude?.external);
    // Fail closed: if a checked calendar cannot be read, offer nothing rather than risk a double booking.
    if (errors.length) return { slots: [], errors, settings, availability: av };
    const slots = computeSlots({ availability: av, settings, eventTypeId: et.id, now, windowStart: ws, windowEnd: we, busy, bookings });
    return { slots, errors, settings, availability: av };
  }

  async publicSlots(username: string, slug: string, q: { from: string; to: string; timezone: string; duration?: number; excludeBooking?: string; token?: string }) {
    const { owner, eventType } = await this.publicEventType(username, slug);
    if (dateDiffDays(q.from, q.to) < 0 || dateDiffDays(q.from, q.to) > 62) throw new ApiError(400, "bad_request", "from..to must be 0..62 days");
    let exclude: { id: string; external: Booking["external"] } | undefined;
    if (q.excludeBooking) {
      const b = await this.bookingWithToken(q.excludeBooking, q.token ?? "");
      if (b.status === "confirmed") exclude = { id: b.id, external: j(b.external, null) };
    }
    const duration = q.duration ?? eventType.defaultDuration;
    const ws = zonedToUtc(q.from, 0, q.timezone);
    const we = zonedToUtc(addDays(q.to, 1), 0, q.timezone);
    const { slots, errors } = await this.slotsFor(owner, eventType, duration, ws, we, exclude);
    return { timezone: q.timezone, duration, days: groupByDate(slots, q.timezone), ...(errors.length ? { warnings: ["calendar_unavailable"] } : {}) };
  }

  /** Slots for the owner to move a booking to (owner reschedule). */
  async ownerBookingSlots(userId: string, id: string, q: { from: string; to: string; timezone: string }) {
    const b = await this.ownerBooking(userId, id);
    const et = await this.getEventType(userId, b.eventTypeId);
    const owner = (await this.getUser(userId))!;
    if (dateDiffDays(q.from, q.to) < 0 || dateDiffDays(q.from, q.to) > 62) throw new ApiError(400, "bad_request", "from..to must be 0..62 days");
    const exclude = b.status === "confirmed" ? { id: b.id, external: b.external } : undefined;
    const ws = zonedToUtc(q.from, 0, q.timezone);
    const we = zonedToUtc(addDays(q.to, 1), 0, q.timezone);
    const duration = et.durations.includes(b.duration) ? b.duration : et.defaultDuration;
    const { slots, errors } = await this.slotsFor(owner, et, duration, ws, we, exclude);
    return { timezone: q.timezone, duration, days: groupByDate(slots, q.timezone), ...(errors.length ? { warnings: ["calendar_unavailable"] } : {}) };
  }

  // ---------- bookings ----------
  private async insertConflictFree(
    b: { id: string; userId: string; eventTypeId: string; start: number; end: number; blockStart: number; blockEnd: number; localDate: string },
    limits: { type: number | null; owner: number | null },
    insert: { sql: string; params: SqlValue[] },
  ): Promise<number> {
    const r = await this.db.run(
      `${insert.sql} NOT EXISTS (
         SELECT 1 FROM bookings x WHERE x.user_id = ? AND x.status = 'confirmed' AND x.id != ?
           AND ((x.start_ms < ? AND x.end_ms > ?) OR (x.block_start_ms < ? AND x.block_end_ms > ?)))
       AND (? IS NULL OR (SELECT COUNT(*) FROM bookings y WHERE y.user_id = ? AND y.event_type_id = ? AND y.status = 'confirmed' AND y.local_date = ? AND y.id != ?) < ?)
       AND (? IS NULL OR (SELECT COUNT(*) FROM bookings z WHERE z.user_id = ? AND z.status = 'confirmed' AND z.local_date = ? AND z.id != ?) < ?)`,
      [
        ...insert.params,
        b.userId,
        b.id,
        b.blockEnd,
        b.blockStart,
        b.end,
        b.start,
        limits.type,
        b.userId,
        b.eventTypeId,
        b.localDate,
        b.id,
        limits.type,
        limits.owner,
        b.userId,
        b.localDate,
        b.id,
        limits.owner,
      ],
    );
    return r.changes;
  }

  /** Why a start cannot be booked: the day is full (limit_reached) or the time is taken or not offered. */
  private async unavailableReason(userId: string, start: number, localDate_: string, eventTypeId: string, limits: { type: number | null; owner: number | null }, excludeId = "") {
    if (limits.type != null || limits.owner != null) {
      const n = await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'confirmed' AND local_date = ? AND id != ?", [userId, localDate_, excludeId]);
      const nt = await this.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND event_type_id = ? AND status = 'confirmed' AND local_date = ? AND id != ?",
        [userId, eventTypeId, localDate_, excludeId],
      );
      if ((limits.owner != null && (n?.n ?? 0) >= limits.owner) || (limits.type != null && (nt?.n ?? 0) >= limits.type)) {
        return new ApiError(409, "limit_reached", "No more bookings are available on that day. Please pick another day.");
      }
    }
    void start;
    return new ApiError(409, "slot_taken", "That time is no longer available. Please pick another time.");
  }

  validateAnswers(et: EventType, answers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    const issues: { path: string; message: string }[] = [];
    for (const q of et.questions) {
      const v = (answers[q.id] ?? "").trim();
      if (!v) {
        if (q.required) issues.push({ path: `answers.${q.id}`, message: "required" });
        continue;
      }
      if (q.kind === "select" || q.kind === "radio") {
        if (!q.options?.includes(v)) issues.push({ path: `answers.${q.id}`, message: "not one of the options" });
      } else if (q.kind === "checkbox") {
        const picked = v.split(/\s*,\s*/).filter(Boolean);
        if (picked.some((p) => !q.options?.includes(p))) issues.push({ path: `answers.${q.id}`, message: "not one of the options" });
      }
      out[q.id] = v;
    }
    if (issues.length) throw new ApiError(400, "bad_request", "Invalid answers", { issues });
    return out;
  }

  private calendarUnavailable() {
    return new ApiError(503, "calendar_unavailable", "The host's calendar cannot be checked right now, so no time can be booked. Please try again later.");
  }

  async createBooking(input: z.infer<typeof V.bookingCreate>) {
    const { owner, eventType: et } = await this.publicEventType(input.username, input.slug);
    const duration = input.duration ?? et.defaultDuration;
    const start = Date.parse(input.start);
    const answers = this.validateAnswers(et, input.answers ?? {});
    const labels = Object.fromEntries(et.questions.filter((q) => q.id in answers).map((q) => [q.id, q.label]));
    const needsPhone = et.location.kind === "phone" && !et.location.value;
    if (needsPhone && !input.phone) throw new ApiError(400, "bad_request", "Phone number is required", { issues: [{ path: "phone", message: "required" }] });
    const guests = [...new Set(input.guests ?? [])].filter((g) => g !== input.email && g !== owner.email);
    const maxGuests = (await this.getAvailability(owner.id)).maxGuests ?? 3;
    if (guests.length > maxGuests) {
      throw new ApiError(400, "bad_request", maxGuests ? `At most ${maxGuests} ${maxGuests === 1 ? "guest" : "guests"} can be added` : "Guests cannot be added to this booking", {
        issues: [{ path: "guests", message: `max ${maxGuests}` }],
      });
    }

    const { slots, errors, settings, availability } = await this.slotsFor(owner, et, duration, start, start + 1);
    if (errors.length) throw this.calendarUnavailable();
    const end = start + duration * MINUTE;
    const ld = localDate(start, availability.timezone);
    const limits = { type: et.maxPerDay, owner: availability.maxPerDay };
    if (!slots.some((s) => s.start === start)) throw await this.unavailableReason(owner.id, start, ld, et.id, limits);
    const id = newId("bkg");
    const token = randomToken();
    const now = iso(this.now());
    const blockStart = start - settings.bufferBefore * MINUTE;
    const blockEnd = end + settings.bufferAfter * MINUTE;
    const location: Location = needsPhone ? { kind: "phone", value: input.phone } : et.location;
    const changes = await this.insertConflictFree(
      { id, userId: owner.id, eventTypeId: et.id, start, end, blockStart, blockEnd, localDate: ld },
      limits,
      {
        sql: `INSERT INTO bookings (id, user_id, event_type_id, event_type_name, status, start_ms, end_ms, block_start_ms, block_end_ms, local_date, duration,
               invitee_name, invitee_email, invitee_timezone, invitee_phone, guests, answers, answer_labels, location, manage_token_hash, manage_token_enc, created_at, updated_at)
              SELECT ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE`,
        params: [
          id,
          owner.id,
          et.id,
          et.name,
          start,
          end,
          blockStart,
          blockEnd,
          ld,
          duration,
          input.name,
          input.email,
          input.timezone,
          input.phone ?? null,
          JSON.stringify(guests),
          JSON.stringify(answers),
          JSON.stringify(labels),
          JSON.stringify(location),
          await sha256(token),
          await this.d.box.seal(token),
          now,
          now,
        ],
      },
    );
    if (!changes) throw await this.unavailableReason(owner.id, start, ld, et.id, limits);

    await this.writeCalendarEvent(owner, et, id, availability.timezone);
    const booking = await this.bookingById(id);
    await this.notify(owner, booking, "booked", token);
    return { booking, manageToken: token, manageUrl: this.manageUrl(id, token) };
  }

  manageUrl(id: string, token: string) {
    return `${this.config.appUrl}/booking/${id}?token=${encodeURIComponent(token)}`;
  }

  private async writeCalendarEvent(owner: User, et: EventType, bookingId: string, timezone: string) {
    const conns = (await this.connections(owner.id)).filter((c) => c.write_calendar_id);
    const c = conns[0];
    if (!c) return;
    const b = await this.bookingById(bookingId);
    try {
      const p = this.provider(c.provider);
      const loc = b.location;
      const locText = loc.kind === "zoom" || loc.kind === "in_person" || loc.kind === "custom" ? loc.value : loc.kind === "phone" ? `Phone: ${loc.value ?? ""}` : undefined;
      const res = await p.createEvent(await this.connCtx(c), {
        calendarId: c.write_calendar_id,
        summary: `${et.name} with ${b.invitee.name}`,
        description: this.eventDescription(b),
        start: Date.parse(b.start),
        end: Date.parse(b.end),
        timezone,
        attendees: [{ email: b.invitee.email, name: b.invitee.name }, ...b.guests.map((g) => ({ email: g }))],
        location: locText,
        createMeet: loc.kind === "google_meet",
        requestId: b.id,
      });
      const newLoc = { ...b.location, ...(res.joinUrl ? { joinUrl: res.joinUrl } : {}) };
      await this.db.run("UPDATE bookings SET external = ?, location = ?, calendar_error = NULL WHERE id = ?", [
        JSON.stringify({ connectionId: c.id, calendarId: c.write_calendar_id, eventId: res.eventId }),
        JSON.stringify(newLoc),
        bookingId,
      ]);
    } catch (e) {
      await this.db.run("UPDATE bookings SET calendar_error = ? WHERE id = ?", [String((e as Error).message).slice(0, 500), bookingId]);
    }
  }

  eventDescription(b: Booking) {
    const lines = [`Booked with ${this.config.appName}.`, `Invitee: ${b.invitee.name} <${b.invitee.email}>`];
    if (b.invitee.phone) lines.push(`Phone: ${b.invitee.phone}`);
    if (b.guests.length) lines.push(`Guests: ${b.guests.join(", ")}`);
    for (const a of b.answerDetails) lines.push(`${a.label}: ${a.value}`);
    return lines.join("\n");
  }

  private async externalCall(b: Booking, fn: (p: CalendarProvider, ctx: ConnectionContext, calendarId: string, eventId: string) => Promise<void>) {
    if (!b.external) return;
    const c = await this.db.first<Row>("SELECT * FROM calendar_connections WHERE id = ?", [b.external.connectionId]);
    if (!c) return;
    try {
      await fn(this.provider(c.provider), await this.connCtx(c), b.external.calendarId, b.external.eventId);
    } catch (e) {
      await this.db.run("UPDATE bookings SET calendar_error = ? WHERE id = ?", [String((e as Error).message).slice(0, 500), b.id]);
    }
  }

  private async questionLabels(userId: string): Promise<Map<string, Record<string, string>>> {
    const rows = await this.db.all<Row>("SELECT id, questions FROM event_types WHERE user_id = ?", [userId]);
    return new Map(rows.map((r) => [r.id, Object.fromEntries(j<Question[]>(r.questions, []).map((q) => [q.id, q.label]))]));
  }

  async bookingById(id: string): Promise<Booking> {
    const r = await this.db.first<Row>("SELECT * FROM bookings WHERE id = ?", [id]);
    if (!r) throw new ApiError(404, "not_found", "Booking not found");
    return toBooking(r, (await this.questionLabels(r.user_id)).get(r.event_type_id));
  }

  async bookingWithToken(id: string, token: string): Promise<Row> {
    const r = await this.db.first<Row>("SELECT * FROM bookings WHERE id = ?", [id]);
    if (!r || !token || r.manage_token_hash !== (await sha256(token))) throw new ApiError(404, "not_found", "Booking not found");
    return r;
  }

  async publicBooking(id: string, token: string) {
    const r = await this.bookingWithToken(id, token);
    const owner = (await this.getUser(r.user_id))!;
    const et = await this.db.first<Row>("SELECT * FROM event_types WHERE id = ?", [r.event_type_id]);
    return {
      booking: await this.bookingById(id),
      owner: this.publicOwner(owner),
      eventType: et ? { ...this.publicEventTypeView(toEventType(et)), active: Boolean(et.active) } : null,
    };
  }

  async cancel(b: Booking, by: "owner" | "invitee", reason?: string, kind: "cancelled" | "reschedule_requested" = "cancelled") {
    if (b.status === "cancelled") throw new ApiError(409, "conflict", "Booking is already canceled");
    const r = await this.db.run(
      "UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancel_reason = ?, cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'",
      [by, reason ?? null, iso(this.now()), iso(this.now()), b.id],
    );
    if (!r.changes) throw new ApiError(409, "conflict", "Booking is already canceled");
    await this.externalCall(b, (p, ctx, cal, ev) => p.cancelEvent(ctx, cal, ev));
    const nb = await this.bookingById(b.id);
    await this.notify((await this.getUser(b.userId))!, nb, kind);
    return nb;
  }

  async cancelByInvitee(id: string, token: string, reason?: string) {
    const r = await this.bookingWithToken(id, token);
    return this.cancel(await this.bookingById(r.id), "invitee", reason);
  }

  async cancelByOwner(userId: string, id: string, reason?: string) {
    const b = await this.ownerBooking(userId, id);
    return this.cancel(b, "owner", reason);
  }

  /** Request reschedule: cancels the meeting and emails the invitee a link to pick a new time. */
  async requestReschedule(userId: string, id: string, reason?: string) {
    const b = await this.ownerBooking(userId, id);
    return this.cancel(b, "owner", reason, "reschedule_requested");
  }

  async reschedule(id: string, token: string, startIso: string, timezone?: string) {
    const r = await this.bookingWithToken(id, token);
    return this.moveBooking(await this.bookingById(r.id), startIso, timezone, token);
  }

  async rescheduleByOwner(userId: string, id: string, startIso: string) {
    return this.moveBooking(await this.ownerBooking(userId, id), startIso, undefined, () => this.inviteeToken(id));
  }

  /**
   * The invitee's manage token for emails the owner triggers. Bookings made before tokens were stored encrypted
   * get a fresh token (their older links stop working, the new email carries the working one).
   */
  private async inviteeToken(id: string): Promise<string> {
    const r = await this.db.first<Row>("SELECT manage_token_enc FROM bookings WHERE id = ?", [id]);
    if (r?.manage_token_enc) {
      try {
        return await this.d.box.open(r.manage_token_enc);
      } catch {
        // Unreadable (key changed): fall through and rotate.
      }
    }
    const token = randomToken();
    await this.db.run("UPDATE bookings SET manage_token_hash = ?, manage_token_enc = ? WHERE id = ?", [await sha256(token), await this.d.box.seal(token), id]);
    return token;
  }

  private async moveBooking(b: Booking, startIso: string, timezone: string | undefined, token?: string | (() => Promise<string>)) {
    if (b.status !== "confirmed") throw new ApiError(409, "conflict", "Canceled bookings cannot be rescheduled");
    if (Date.parse(b.start) < this.now()) throw new ApiError(409, "conflict", "Past bookings cannot be rescheduled");
    const owner = (await this.getUser(b.userId))!;
    const etRow = await this.db.first<Row>("SELECT * FROM event_types WHERE id = ? AND active = 1", [b.eventTypeId]);
    if (!etRow) throw new ApiError(409, "conflict", "This event type is no longer available");
    const et = toEventType(etRow);
    const start = Date.parse(startIso);
    const duration = et.durations.includes(b.duration) ? b.duration : et.defaultDuration;
    const { slots, errors, settings, availability } = await this.slotsFor(owner, et, duration, start, start + 1, { id: b.id, external: b.external });
    if (errors.length) throw this.calendarUnavailable();
    const end = start + duration * MINUTE;
    const ld = localDate(start, availability.timezone);
    const limits = { type: et.maxPerDay, owner: availability.maxPerDay };
    if (!slots.some((s) => s.start === start)) throw await this.unavailableReason(owner.id, start, ld, et.id, limits, b.id);
    const blockStart = start - settings.bufferBefore * MINUTE;
    const blockEnd = end + settings.bufferAfter * MINUTE;
    const changes = await this.insertConflictFree(
      { id: b.id, userId: owner.id, eventTypeId: et.id, start, end, blockStart, blockEnd, localDate: ld },
      limits,
      {
        sql: `UPDATE bookings SET start_ms = ?, end_ms = ?, block_start_ms = ?, block_end_ms = ?, local_date = ?, duration = ?, invitee_timezone = ?,
              reschedule_count = reschedule_count + 1, updated_at = ? WHERE id = ? AND status = 'confirmed' AND`,
        params: [start, end, blockStart, blockEnd, ld, duration, timezone ?? b.invitee.timezone, iso(this.now()), b.id],
      },
    );
    if (!changes) throw await this.unavailableReason(owner.id, start, ld, et.id, limits, b.id);
    await this.externalCall(b, (p, ctx, cal, ev) => p.updateEventTime(ctx, cal, ev, start, end, availability.timezone));
    const nb = await this.bookingById(b.id);
    await this.notify(owner, nb, "rescheduled", typeof token === "function" ? await token() : token);
    return nb;
  }

  async ownerBooking(userId: string, id: string): Promise<Booking> {
    const r = await this.db.first<Row>("SELECT * FROM bookings WHERE id = ? AND user_id = ?", [id, userId]);
    if (!r) throw new ApiError(404, "not_found", "Booking not found");
    return toBooking(r, (await this.questionLabels(userId)).get(r.event_type_id));
  }

  /** Keyset pagination: cursor is "<start_ms>_<id>" of the last item of the previous page. */
  async listBookings(userId: string, q: { status: string; from?: string; to?: string; eventTypeId?: string; limit: number; cursor?: string }) {
    const where = ["user_id = ?"];
    const params: SqlValue[] = [userId];
    const now = this.now();
    let asc = true;
    if (q.status === "upcoming") {
      where.push("status = 'confirmed'", "end_ms > ?");
      params.push(now);
    } else if (q.status === "past") {
      where.push("status = 'confirmed'", "end_ms <= ?");
      params.push(now);
      asc = false;
    } else if (q.status === "cancelled") {
      where.push("status = 'cancelled'");
      asc = false;
    } else if (q.status === "range") {
      // Date range view: every status, chronological.
    } else asc = false;
    if (q.from) {
      where.push("start_ms >= ?");
      params.push(Date.parse(q.from));
    }
    if (q.to) {
      where.push("start_ms < ?");
      params.push(Date.parse(q.to));
    }
    if (q.eventTypeId) {
      where.push("event_type_id = ?");
      params.push(q.eventTypeId);
    }
    if (q.cursor) {
      const m = /^(-?\d+)_(bkg_[a-z0-9]+)$/.exec(q.cursor);
      if (!m) throw new ApiError(400, "bad_request", "Invalid cursor");
      where.push(asc ? "(start_ms > ? OR (start_ms = ? AND id > ?))" : "(start_ms < ? OR (start_ms = ? AND id < ?))");
      params.push(Number(m[1]), Number(m[1]), m[2]!);
    }
    const dir = asc ? "ASC" : "DESC";
    const rows = await this.db.all<Row>(`SELECT * FROM bookings WHERE ${where.join(" AND ")} ORDER BY start_ms ${dir}, id ${dir} LIMIT ?`, [...params, q.limit + 1]);
    const page = rows.slice(0, q.limit);
    const labels = await this.questionLabels(userId);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toBooking(r, labels.get(r.event_type_id))),
      nextCursor: rows.length > q.limit && last ? `${last.start_ms}_${last.id}` : null,
    };
  }

  async exportCsv(userId: string, q: { status: string; from?: string; to?: string; eventTypeId?: string }) {
    const head = ["Booking ID", "Status", "Event type", "Start (UTC)", "End (UTC)", "Duration (min)", "Invitee name", "Invitee email", "Invitee time zone", "Phone", "Guests", "Location", "Answers", "Canceled by", "Cancel reason", "Created (UTC)"];
    const lines = [head.map(csvCell).join(",")];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await this.listBookings(userId, { ...q, limit: 200, cursor });
      for (const b of page.items) {
        lines.push(
          [
            b.id,
            b.status,
            b.eventTypeName,
            b.start,
            b.end,
            b.duration,
            b.invitee.name,
            b.invitee.email,
            b.invitee.timezone,
            b.invitee.phone ?? "",
            b.guests.join("; "),
            b.location.joinUrl ?? b.location.value ?? b.location.kind,
            b.answerDetails.map((a) => `${a.label}: ${a.value}`).join("; "),
            b.cancelledBy ?? "",
            b.cancelReason ?? "",
            b.createdAt,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return `${lines.join("\r\n")}\r\n`;
  }

  // ---------- notifications ----------
  private fmtTime(ms: number, tz: string) {
    return `${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(ms)} (${tz})`;
  }

  async sendAndRecord(userId: string, bookingId: string | null, kind: string, audience: string, to: string, subject: string, text: string) {
    let status = "sent";
    let error: string | null = null;
    try {
      await this.d.mailer.send({ to, subject, text });
    } catch (e) {
      status = "failed";
      error = String((e as Error).message).slice(0, 300);
    }
    await this.db.run(
      `INSERT INTO notifications (id, user_id, booking_id, kind, audience, to_email, subject, body, provider, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("ntf"), userId, bookingId, kind, audience, to, subject, text, this.d.mailer.id, status, error, iso(this.now())],
    );
  }

  async notify(owner: User, b: Booking, kind: "booked" | "rescheduled" | "cancelled" | "reschedule_requested", token?: string) {
    const start = Date.parse(b.start);
    const av = await this.getAvailability(owner.id).catch(() => null);
    const ownerTz = av?.timezone ?? owner.timezone;
    const where = b.location.joinUrl ?? b.location.value ?? b.location.kind.replace("_", " ");
    const verb = { booked: "Confirmed", rescheduled: "Rescheduled", cancelled: "Canceled", reschedule_requested: "Please pick a new time" }[kind];
    const manage = token ? `\n\nNeed to make a change? Reschedule or cancel: ${this.manageUrl(b.id, token)}` : "";
    const reason = (kind === "cancelled" || kind === "reschedule_requested") && b.cancelReason ? `\nReason: ${b.cancelReason}` : "";
    const et = await this.db.first<Row>("SELECT slug, active FROM event_types WHERE id = ?", [b.eventTypeId]);
    const rebook = kind === "reschedule_requested" && et?.active ? `\n\nPick a new time: ${this.bookingUrl(owner.username, et.slug)}` : "";
    const answers = b.answerDetails.length ? `\n${b.answerDetails.map((a) => `${a.label}: ${a.value}`).join("\n")}` : "";
    const inviteeText = (name: string, tz: string) =>
      kind === "reschedule_requested"
        ? `Hi ${name},\n\n${owner.name} asked to move ${b.eventTypeName} (was ${this.fmtTime(start, tz)}). The original time is canceled.${reason}${rebook}\n`
        : `Hi ${name},\n\n${verb}: ${b.eventTypeName} with ${owner.name}\nWhen: ${this.fmtTime(start, tz)}\nWhere: ${where}${reason}`;
    const msgs: { audience: string; to: string; subject: string; text: string }[] = [
      {
        audience: "invitee",
        to: b.invitee.email,
        subject: `${verb}: ${b.eventTypeName} with ${owner.name}`,
        text: `${inviteeText(b.invitee.name, b.invitee.timezone)}${kind === "booked" || kind === "rescheduled" ? manage : ""}\n`,
      },
      // Guests get the same news without the invitee's manage link (only the invitee can change the booking).
      // The invitee chose these addresses, so nothing the invitee typed goes into these emails except a cleaned,
      // shortened name: no links, no line breaks, no reason text.
      ...b.guests.map((g) => ({
        audience: "guest",
        to: g,
        subject: `${verb}: ${b.eventTypeName} with ${owner.name}`,
        text: `Hi,\n\n${verb}: ${b.eventTypeName} with ${owner.name}\nWhen: ${this.fmtTime(start, b.invitee.timezone)}${kind === "cancelled" || kind === "reschedule_requested" ? "" : `\nWhere: ${where}`}\n\nYou were added as a guest by ${safeName(b.invitee.name)} <${b.invitee.email}>. If you do not know them, you can ignore this email.\n`,
      })),
      {
        audience: "owner",
        to: owner.email,
        subject: `${kind === "booked" ? "New booking" : kind === "reschedule_requested" ? "Reschedule requested" : verb}: ${b.invitee.name}, ${b.eventTypeName}`,
        text: `${b.invitee.name} <${b.invitee.email}>\n${b.eventTypeName}, ${b.duration} min\nWhen: ${this.fmtTime(start, ownerTz)}\nWhere: ${where}${answers}${reason}\n\nView: ${this.config.appUrl}/app/meetings\n`,
      },
    ];
    for (const m of msgs) {
      if (m.audience === "guest") await this.sendGuestEmail(owner.id, b.id, kind, m.to, m.subject, m.text);
      else await this.sendAndRecord(owner.id, b.id, kind, m.audience, m.to, m.subject, m.text);
    }
  }

  /**
   * Guest emails are capped per owner per rolling hour. The slot is reserved by one conditional INSERT (count and
   * insert in the same statement, which SQLite and D1 run atomically), so parallel bookings cannot overshoot; only
   * a reserved row is sent, then marked sent or failed.
   */
  private async sendGuestEmail(userId: string, bookingId: string, kind: string, to: string, subject: string, text: string) {
    const id = newId("ntf");
    const now = iso(this.now());
    const reserved = await this.db.run(
      `INSERT INTO notifications (id, user_id, booking_id, kind, audience, to_email, subject, body, provider, status, error, created_at)
       SELECT ?, ?, ?, ?, 'guest', ?, ?, ?, ?, 'sending', NULL, ?
       WHERE (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND audience = 'guest' AND status IN ('sent', 'sending') AND created_at > ?) < ?`,
      [id, userId, bookingId, kind, to, subject, text, this.d.mailer.id, now, userId, iso(this.now() - 3_600_000), this.config.guestEmailsPerHour],
    );
    if (!reserved.changes) {
      await this.recordOnly(userId, bookingId, kind, "guest", to, subject, text, "suppressed", "guest email limit per hour reached");
      return;
    }
    let status = "sent";
    let error: string | null = null;
    try {
      await this.d.mailer.send({ to, subject, text });
    } catch (e) {
      status = "failed";
      error = String((e as Error).message).slice(0, 300);
    }
    await this.db.run("UPDATE notifications SET status = ?, error = ? WHERE id = ?", [status, error, id]);
  }

  private async recordOnly(userId: string, bookingId: string | null, kind: string, audience: string, to: string, subject: string, text: string, status: string, error: string) {
    await this.db.run(
      `INSERT INTO notifications (id, user_id, booking_id, kind, audience, to_email, subject, body, provider, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("ntf"), userId, bookingId, kind, audience, to, subject, text, this.d.mailer.id, status, error, iso(this.now())],
    );
  }

  async listNotifications(userId: string, bookingId?: string) {
    const rows = await this.db.all<Row>(
      `SELECT * FROM notifications WHERE user_id = ? ${bookingId ? "AND booking_id = ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT 100`,
      bookingId ? [userId, bookingId] : [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      kind: r.kind,
      audience: r.audience,
      to: r.to_email,
      subject: r.subject,
      body: r.body,
      provider: r.provider,
      status: r.status,
      error: r.error ?? null,
      createdAt: r.created_at,
    }));
  }

  // ---------- dev mock calendar ----------
  async mockEvents(userId: string) {
    const rows = await this.db.all<Row>("SELECT * FROM mock_calendar_events WHERE user_id = ? AND source != 'failmode' ORDER BY start_ms", [userId]);
    return rows.map((r) => ({
      id: r.id,
      calendarId: r.calendar_id,
      summary: r.summary,
      start: iso(r.start_ms),
      end: iso(r.end_ms),
      attendees: j(r.attendees, []),
      joinUrl: r.join_url ?? null,
      status: r.status,
      source: r.source,
    }));
  }

  async setMockFailure(userId: string, fail: boolean) {
    await this.db.run("DELETE FROM mock_calendar_events WHERE user_id = ? AND source = 'failmode'", [userId]);
    if (fail) {
      await this.db.run(
        `INSERT INTO mock_calendar_events (id, user_id, calendar_id, summary, start_ms, end_ms, attendees, status, source, created_at)
         VALUES (?, ?, '-', 'failmode', 0, 0, '[]', 'confirmed', 'failmode', ?)`,
        [newId("mev"), userId, iso(this.now())],
      );
    }
  }

  async addMockBusy(userId: string, p: z.infer<typeof V.mockEvent>) {
    const s = Date.parse(p.start);
    const e = Date.parse(p.end);
    if (e <= s) throw new ApiError(400, "bad_request", "end must be after start");
    const id = newId("mev");
    await this.db.run(
      `INSERT INTO mock_calendar_events (id, user_id, calendar_id, summary, start_ms, end_ms, attendees, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'confirmed', 'external', ?)`,
      [id, userId, p.calendarId ?? "primary", p.summary ?? "Busy", s, e, iso(this.now())],
    );
    return (await this.mockEvents(userId)).find((x) => x.id === id);
  }
}
