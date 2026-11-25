import { z } from "zod";
import { isValidDate, isValidHm, isValidTimeZone, parseHm } from "./time.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError(400, "bad_request", "Invalid input", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

export const tz = z.string().refine(isValidTimeZone, "unknown time zone");
export const dateStr = z.string().refine(isValidDate, "expected YYYY-MM-DD");
const hm = z.string().refine(isValidHm, "expected HH:MM");

// Refinements run even when a field already failed, so they must never throw on a bad value (25:00 etc).
const hmOrNaN = (s: string) => (isValidHm(s) ? parseHm(s) : Number.NaN);

export const interval = z
  .object({ start: hm, end: hm })
  .refine((i) => !(hmOrNaN(i.start) >= hmOrNaN(i.end)), "start must be before end")
  .refine((i) => !(hmOrNaN(i.start) >= 24 * 60), "start must be before 24:00");

export const intervals = z
  .array(interval)
  .max(12)
  .refine((arr) => {
    const s = [...arr].sort((a, b) => hmOrNaN(a.start) - hmOrNaN(b.start));
    return s.every((iv, i) => i === 0 || !(hmOrNaN(s[i - 1]!.end) > hmOrNaN(iv.start)));
  }, "intervals overlap");

const weekdayKey = z.enum(["0", "1", "2", "3", "4", "5", "6"]);
const minutes = (max: number) => z.number().int().min(0).max(max);

export const availabilityPatch = z.object({
  timezone: tz.optional(),
  weekly: z.partialRecord(weekdayKey, intervals).optional(),
  overrides: z.record(dateStr, intervals).optional(),
  bufferBefore: minutes(720).optional(),
  bufferAfter: minutes(720).optional(),
  minNotice: minutes(60 * 24 * 60).optional(),
  maxDaysAhead: z.number().int().min(0).max(730).optional(),
  maxPerDay: z.number().int().min(1).max(100).nullable().optional(),
  maxGuests: z.number().int().min(0).max(10).optional(),
});

export const scheduleCreate = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: tz.optional(),
  weekly: z.partialRecord(weekdayKey, intervals).optional(),
  overrides: z.record(dateStr, intervals).optional(),
});
export const schedulePatch = scheduleCreate.partial();

export const overridePut = z.object({ intervals });

const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, "lowercase letters, digits and dashes");
export const username = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3-40 lowercase letters, digits and dashes");

export const location = z
  .object({
    kind: z.enum(["google_meet", "zoom", "phone", "in_person", "custom"]),
    value: z.string().max(500).optional(),
  })
  .refine((l) => l.kind !== "zoom" || (l.value && /^https:\/\//.test(l.value)), "zoom needs an https meeting URL")
  .refine((l) => !["in_person", "custom"].includes(l.kind) || (l.value && l.value.trim().length > 0), "this location needs a value");

export const question = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    label: z.string().min(1).max(300),
    kind: z.enum(["text", "textarea", "phone", "select", "radio", "checkbox"]),
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(200)).max(30).optional(),
  })
  .refine((q) => !["select", "radio", "checkbox"].includes(q.kind) || (q.options && q.options.length > 0), "options required");

const duration = z.number().int().min(5).max(720);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const optMinutes = (max: number) => z.number().int().min(0).max(max).nullable().optional();

const eventTypeFields = {
  name: z.string().trim().min(1).max(120),
  slug: slug.optional(),
  description: z.string().max(5000).optional(),
  durations: z.array(duration).min(1).max(8).optional(),
  defaultDuration: duration.optional(),
  slotInterval: z.number().int().min(5).max(720).nullable().optional(),
  location: location.optional(),
  questions: z.array(question).max(20).optional(),
  color: color.optional(),
  active: z.boolean().optional(),
  bufferBefore: optMinutes(720),
  bufferAfter: optMinutes(720),
  minNotice: optMinutes(60 * 24 * 60),
  maxDaysAhead: z.number().int().min(0).max(730).nullable().optional(),
  maxPerDay: z.number().int().min(1).max(100).nullable().optional(),
  /** "default" or null = the default schedule. */
  scheduleId: z.string().min(1).max(40).nullable().optional(),
};
export const eventTypeCreate = z.object(eventTypeFields);
export const eventTypePatch = z.object({ ...eventTypeFields, name: eventTypeFields.name.optional() });

export const email = z.email().max(254).transform((s) => s.toLowerCase());
export const password = z.string().min(10).max(200);

export const signup = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(100),
  username,
  timezone: tz,
  setupCode: z.string().max(200).optional(),
});
export const passwordChange = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password, revokeTokens: z.boolean().default(true) });
export const emailChange = z.object({ email, currentPassword: z.string().min(1).max(200) });
export const login = z.object({ email, password: z.string().min(1).max(200) });
export const scopes = z.array(z.enum(["read", "write"])).min(1).max(2);
export const tokenCreate = z.object({ name: z.string().trim().min(1).max(80), scopes });
export const tokenExchange = login.extend({ name: z.string().trim().min(1).max(80).default("cli"), scopes: scopes.default(["read", "write"]) });

export const profilePatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  username: username.optional(),
  timezone: tz.optional(),
  welcome: z.string().max(1000).optional(),
});

export const isoInstant = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s)), "expected ISO 8601 instant");

export const bookingCreate = z.object({
  username,
  slug,
  start: isoInstant,
  duration: duration.optional(),
  timezone: tz,
  name: z.string().trim().min(1).max(120),
  email,
  phone: z.string().trim().max(40).optional(),
  guests: z.array(email).max(10).optional(),
  answers: z.record(z.string().max(40), z.string().max(5000)).optional(),
});

export const bookingCancel = z.object({ token: z.string().min(10).max(200), reason: z.string().max(1000).optional() });
export const ownerCancel = z.object({ reason: z.string().max(1000).optional() });
export const bookingReschedule = z.object({ token: z.string().min(10).max(200), start: isoInstant, timezone: tz.optional() });

export const connectionPatch = z.object({
  checkCalendarIds: z.array(z.string().min(1).max(300)).max(50).optional(),
  writeCalendarId: z.string().min(1).max(300).nullable().optional(),
});

export const mockEvent = z.object({
  start: isoInstant,
  end: isoInstant,
  summary: z.string().max(200).optional(),
  calendarId: z.string().max(100).optional(),
});
