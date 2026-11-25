import { addDays, dateDiffDays, localDate, MINUTE, parseHm, weekdayOf, zonedToUtc, DAY } from "./time.js";
import type { Availability, BusyInterval, EventType, ExistingBooking, Interval } from "./types.js";

export interface SlotSettings {
  duration: number;
  slotInterval: number;
  bufferBefore: number;
  bufferAfter: number;
  minNotice: number;
  maxDaysAhead: number;
  maxPerDayType: number | null;
  maxPerDayOwner: number | null;
}

export function resolveSettings(av: Availability, et: EventType, duration: number): SlotSettings {
  return {
    duration,
    slotInterval: et.slotInterval ?? duration,
    bufferBefore: et.bufferBefore ?? av.bufferBefore,
    bufferAfter: et.bufferAfter ?? av.bufferAfter,
    minNotice: et.minNotice ?? av.minNotice,
    maxDaysAhead: et.maxDaysAhead ?? av.maxDaysAhead,
    maxPerDayType: et.maxPerDay,
    maxPerDayOwner: av.maxPerDay,
  };
}

export function intervalsForDate(av: Availability, date: string): Interval[] {
  const o = av.overrides[date];
  if (o) return o;
  return av.weekly[String(weekdayOf(date))] ?? [];
}

export interface SlotInput {
  availability: Availability;
  settings: SlotSettings;
  eventTypeId: string;
  now: number;
  windowStart: number; // ms, inclusive
  windowEnd: number; // ms, exclusive
  busy: BusyInterval[];
  bookings: ExistingBooking[]; // confirmed bookings of the owner
}

export interface Slot {
  start: number;
  end: number;
}

/** All bookable slot starts whose start falls in [windowStart, windowEnd). Sorted ascending. */
export function computeSlots(input: SlotInput): Slot[] {
  const { availability: av, settings: s, now, windowStart, windowEnd } = input;
  const tz = av.timezone;
  const dur = s.duration * MINUTE;
  const step = Math.max(5, s.slotInterval) * MINUTE;
  const earliest = now + s.minNotice * MINUTE;
  const today = localDate(now, tz);
  const lastDate = addDays(today, s.maxDaysAhead);

  const perDayType = new Map<string, number>();
  const perDayOwner = new Map<string, number>();
  for (const b of input.bookings) {
    perDayOwner.set(b.localDate, (perDayOwner.get(b.localDate) ?? 0) + 1);
    if (b.eventTypeId === input.eventTypeId) perDayType.set(b.localDate, (perDayType.get(b.localDate) ?? 0) + 1);
  }

  const busy = [...input.busy].sort((a, b) => a.start - b.start);
  const bookings = input.bookings;
  const bb = s.bufferBefore * MINUTE;
  const ba = s.bufferAfter * MINUTE;

  const out: Slot[] = [];
  // Owner dates that can contain an instant in the window: widen by a day each side for zone offsets.
  let date = addDays(localDate(Math.max(windowStart, earliest - DAY), tz), -1);
  const endDate = addDays(localDate(windowEnd, tz), 1);
  for (; dateDiffDays(date, endDate) >= 0; date = addDays(date, 1)) {
    if (dateDiffDays(date, lastDate) < 0) break;
    if (dateDiffDays(today, date) < 0) continue;
    if (s.maxPerDayType != null && (perDayType.get(date) ?? 0) >= s.maxPerDayType) continue;
    if (s.maxPerDayOwner != null && (perDayOwner.get(date) ?? 0) >= s.maxPerDayOwner) continue;
    for (const iv of intervalsForDate(av, date)) {
      const ivStart = zonedToUtc(date, parseHm(iv.start), tz);
      const ivEnd = zonedToUtc(date, parseHm(iv.end), tz);
      for (let t = ivStart; t + dur <= ivEnd; t += step) {
        if (t < windowStart || t >= windowEnd || t < earliest) continue;
        const e = t + dur;
        if (overlapsAny(busy, t - bb, e + ba)) continue;
        if (bookings.some((b) => (t < b.blockEnd && e > b.blockStart) || (t - bb < b.end && e + ba > b.start))) continue;
        out.push({ start: t, end: e });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  // Overlapping intervals in different days cannot produce duplicates, but guard against duplicate starts.
  return out.filter((x, i) => i === 0 || out[i - 1]!.start !== x.start);
}

function overlapsAny(sorted: BusyInterval[], s: number, e: number): boolean {
  for (const b of sorted) {
    if (b.start >= e) return false;
    if (b.end > s) return true;
  }
  return false;
}

/** Group slots by local date in tz. */
export function groupByDate(slots: Slot[], tz: string): { date: string; slots: { start: string; end: string }[] }[] {
  const map = new Map<string, { start: string; end: string }[]>();
  for (const s of slots) {
    const d = localDate(s.start, tz);
    let arr = map.get(d);
    if (!arr) map.set(d, (arr = []));
    arr.push({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() });
  }
  return [...map.entries()].map(([date, slots]) => ({ date, slots }));
}
