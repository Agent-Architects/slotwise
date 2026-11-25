// Time zone math on top of Intl only, so it runs unchanged on Workers and Node.

const MINUTE = 60_000;
const DAY = 86_400_000;
export { MINUTE, DAY };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(utcMs))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday!]!,
  };
}

/** Offset of tz from UTC at the given instant, in ms (local = utc + offset). */
export function tzOffset(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Wall-clock time in tz to a UTC instant. Ambiguous times (fall back) resolve to the earlier instant;
 * nonexistent times (spring forward gap) move forward by the gap length.
 */
export function zonedToUtc(date: string, minutesOfDay: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const local = Date.UTC(y, m - 1, d) + minutesOfDay * MINUTE;
  const before = tzOffset(local - 14 * 3_600_000, tz);
  const after = tzOffset(local + 14 * 3_600_000, tz);
  const valid: number[] = [];
  for (const o of before === after ? [before] : [before, after]) {
    const t = local - o;
    if (tzOffset(t, tz) === o) valid.push(t);
  }
  if (valid.length) return Math.min(...valid);
  // Gap: interpret with the pre-transition offset, which lands just after the gap.
  return local - before;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function localDate(utcMs: number, tz: string): string {
  const p = localParts(utcMs, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dateDiffDays(a: string, b: string): number {
  const pa = a.split("-").map(Number) as [number, number, number];
  const pb = b.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / DAY);
}

export function isValidDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** "HH:MM" to minutes; "24:00" allowed as end of day. */
export function parseHm(s: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time ${s}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) throw new Error(`bad time ${s}`);
  return h * 60 + min;
}

export function isValidHm(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    parseHm(s);
    return true;
  } catch {
    return false;
  }
}
