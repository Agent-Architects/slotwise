import { describe, expect, it } from "vitest";
import { computeSlots, groupByDate, type SlotSettings } from "../../src/core/slots";
import { localDate, zonedToUtc } from "../../src/core/time";
import type { Availability, ExistingBooking } from "../../src/core/types";

const H = 3_600_000;
const M = 60_000;
const at = (iso: string) => Date.parse(iso);
const isoList = (xs: { start: number }[]) => xs.map((x) => new Date(x.start).toISOString());

function av(p: Partial<Availability> = {}): Availability {
  const nine5 = [{ start: "09:00", end: "17:00" }];
  return {
    timezone: "America/New_York",
    weekly: { "0": [], "1": nine5, "2": nine5, "3": nine5, "4": nine5, "5": nine5, "6": [] },
    overrides: {},
    bufferBefore: 0,
    bufferAfter: 0,
    minNotice: 0,
    maxDaysAhead: 365,
    maxPerDay: null,
    ...p,
  };
}

function settings(p: Partial<SlotSettings> = {}): SlotSettings {
  return { duration: 30, slotInterval: 30, bufferBefore: 0, bufferAfter: 0, minNotice: 0, maxDaysAhead: 365, maxPerDayType: null, maxPerDayOwner: null, ...p };
}

function run(o: {
  a?: Availability;
  s?: Partial<SlotSettings>;
  now: string;
  from: string;
  to: string;
  busy?: { start: number; end: number }[];
  bookings?: ExistingBooking[];
}) {
  return computeSlots({
    availability: o.a ?? av(),
    settings: settings(o.s),
    eventTypeId: "evt_a",
    now: at(o.now),
    windowStart: at(o.from),
    windowEnd: at(o.to),
    busy: o.busy ?? [],
    bookings: o.bookings ?? [],
  });
}

function booking(startIso: string, mins: number, before = 0, after = 0, eventTypeId = "evt_a", tz = "America/New_York"): ExistingBooking {
  const s = at(startIso);
  const e = s + mins * M;
  return { start: s, end: e, blockStart: s - before * M, blockEnd: e + after * M, eventTypeId, localDate: localDate(s, tz) };
}

describe("zonedToUtc", () => {
  it("converts standard time", () => {
    expect(new Date(zonedToUtc("2026-11-24", 9 * 60, "America/New_York")).toISOString()).toBe("2026-11-24T14:00:00.000Z");
    expect(new Date(zonedToUtc("2026-07-01", 9 * 60, "America/New_York")).toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });
  it("moves a nonexistent spring-forward time forward", () => {
    // 2026-03-08 02:30 does not exist in New York; it becomes 03:30 EDT.
    expect(new Date(zonedToUtc("2026-03-08", 2 * 60 + 30, "America/New_York")).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  it("resolves an ambiguous fall-back time to the earlier instant", () => {
    // 2026-11-01 01:30 happens twice; the first is EDT (UTC-4).
    expect(new Date(zonedToUtc("2026-11-01", 90, "America/New_York")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
  it("handles half-hour and southern-hemisphere zones", () => {
    expect(new Date(zonedToUtc("2026-11-24", 9 * 60, "Asia/Kolkata")).toISOString()).toBe("2026-11-24T03:30:00.000Z");
    expect(new Date(zonedToUtc("2026-11-24", 9 * 60, "Australia/Sydney")).toISOString()).toBe("2026-11-23T22:00:00.000Z"); // AEDT +11
    expect(new Date(zonedToUtc("2026-06-24", 9 * 60, "Australia/Sydney")).toISOString()).toBe("2026-06-23T23:00:00.000Z"); // AEST +10
  });
  it("supports 24:00 as end of day", () => {
    expect(new Date(zonedToUtc("2026-11-24", 24 * 60, "Europe/London")).toISOString()).toBe("2026-11-25T00:00:00.000Z");
  });
});

describe("computeSlots basics", () => {
  it("produces 16 half-hour slots for a 9-5 weekday", () => {
    const s = run({ now: "2026-11-20T00:00:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-25T00:00:00Z" });
    expect(s).toHaveLength(16);
    expect(new Date(s[0]!.start).toISOString()).toBe("2026-11-24T14:00:00.000Z");
    expect(new Date(s.at(-1)!.start).toISOString()).toBe("2026-11-24T21:30:00.000Z");
  });
  it("respects slot interval separate from duration", () => {
    const s = run({ s: { duration: 60, slotInterval: 15 }, now: "2026-11-20T00:00:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-25T00:00:00Z" });
    // 09:00..16:00 starts every 15 min = 29 slots
    expect(s).toHaveLength(29);
  });
  it("does not offer a slot that would run past the interval end", () => {
    const a = av({ weekly: { "2": [{ start: "09:00", end: "09:50" }] } });
    expect(run({ a, s: { duration: 30 }, now: "2026-11-20T00:00:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-25T00:00:00Z" })).toHaveLength(1);
  });
  it("supports several intervals per day", () => {
    const a = av({ weekly: { "2": [{ start: "09:00", end: "10:00" }, { start: "14:00", end: "15:00" }] } });
    const s = run({ a, now: "2026-11-20T00:00:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-25T00:00:00Z" });
    expect(isoList(s)).toEqual(["2026-11-24T14:00:00.000Z", "2026-11-24T14:30:00.000Z", "2026-11-24T19:00:00.000Z", "2026-11-24T19:30:00.000Z"]);
  });
  it("returns nothing on weekends", () => {
    expect(run({ now: "2026-11-20T00:00:00Z", from: "2026-11-28T00:00:00Z", to: "2026-11-30T05:00:00Z" })).toHaveLength(0);
  });
});

describe("DST", () => {
  it("keeps 09:00 wall clock across the spring-forward weekend", () => {
    const s = run({ now: "2026-03-01T00:00:00Z", from: "2026-03-06T00:00:00Z", to: "2026-03-10T00:00:00Z" });
    const firsts = groupByDate(s, "America/New_York").map((d) => d.slots[0]!.start);
    expect(firsts).toEqual(["2026-03-06T14:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
  });
  it("an interval across the spring-forward gap is one hour shorter", () => {
    const a = av({ weekly: { "0": [{ start: "00:00", end: "06:00" }] } });
    const s = run({ a, s: { duration: 60, slotInterval: 60 }, now: "2026-03-01T00:00:00Z", from: "2026-03-08T00:00:00Z", to: "2026-03-09T00:00:00Z" });
    expect(s).toHaveLength(5);
  });
  it("an interval across the fall-back overlap is one hour longer", () => {
    const a = av({ weekly: { "0": [{ start: "00:00", end: "06:00" }] } });
    const s = run({ a, s: { duration: 60, slotInterval: 60 }, now: "2026-10-25T00:00:00Z", from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" });
    expect(s).toHaveLength(7);
    // every slot is a distinct real hour
    expect(new Set(s.map((x) => x.start)).size).toBe(7);
  });
  it("invitee in another zone sees owner hours shifted by the changing offset (EU and US switch on different dates)", () => {
    // 2026-03-09..2026-03-27: US already on DST, London not yet. NY 09:00 = London 13:00 instead of 14:00.
    const s = run({ now: "2026-03-01T00:00:00Z", from: "2026-03-10T00:00:00Z", to: "2026-03-11T00:00:00Z" });
    const first = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(s[0]!.start);
    expect(first).toBe("13:00");
  });
});

describe("time zones for invitees", () => {
  it("groups by the invitee's local date", () => {
    const a = av({ timezone: "Asia/Tokyo", weekly: { "3": [{ start: "08:00", end: "10:00" }] } }); // Wed Tokyo
    const s = run({ a, now: "2026-11-01T00:00:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-27T00:00:00Z" });
    // Tokyo Wed 2026-11-25 08:00 = UTC Tue 23:00 = Los Angeles Tue 15:00
    const la = groupByDate(s, "America/Los_Angeles");
    expect(la.map((d) => d.date)).toEqual(["2026-11-24"]);
    const tokyo = groupByDate(s, "Asia/Tokyo");
    expect(tokyo.map((d) => d.date)).toEqual(["2026-11-25"]);
  });
});

describe("constraints", () => {
  const base = { now: "2026-11-20T00:00:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-25T00:00:00Z" };
  it("min notice hides slots that start too soon", () => {
    const s = run({ s: { minNotice: 60 }, now: "2026-11-24T13:50:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-25T00:00:00Z" });
    expect(new Date(s[0]!.start).toISOString()).toBe("2026-11-24T15:00:00.000Z");
  });
  it("max days ahead stops at the owner-local horizon", () => {
    const s = run({ s: { maxDaysAhead: 2 }, now: "2026-11-23T15:00:00Z", from: "2026-11-23T00:00:00Z", to: "2026-12-05T00:00:00Z" });
    expect(groupByDate(s, "America/New_York").map((d) => d.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25"]);
  });
  it("existing booking blocks overlapping slots", () => {
    const s = run({ ...base, bookings: [booking("2026-11-24T15:00:00Z", 30)] });
    expect(isoList(s)).not.toContain("2026-11-24T15:00:00.000Z");
    expect(isoList(s)).toContain("2026-11-24T15:30:00.000Z");
    expect(s).toHaveLength(15);
  });
  it("buffers of the existing booking protect it", () => {
    const s = run({ ...base, bookings: [booking("2026-11-24T15:00:00Z", 30, 0, 15)] });
    expect(isoList(s)).not.toContain("2026-11-24T15:30:00.000Z");
    expect(isoList(s)).toContain("2026-11-24T16:00:00.000Z");
  });
  it("buffers of the new event are respected", () => {
    const s = run({ ...base, s: { bufferAfter: 15, bufferBefore: 15 }, bookings: [booking("2026-11-24T15:00:00Z", 30)] });
    const l = isoList(s);
    expect(l).not.toContain("2026-11-24T14:30:00.000Z"); // its after-buffer would hit 15:00
    expect(l).not.toContain("2026-11-24T15:30:00.000Z"); // its before-buffer would hit 15:30
    expect(l).toContain("2026-11-24T16:00:00.000Z");
  });
  it("calendar busy time hides slots including buffer", () => {
    const busy = [{ start: at("2026-11-24T17:00:00Z"), end: at("2026-11-24T18:00:00Z") }];
    const l = isoList(run({ ...base, s: { bufferBefore: 10 }, busy }));
    expect(l).not.toContain("2026-11-24T17:00:00.000Z");
    expect(l).not.toContain("2026-11-24T17:30:00.000Z");
    expect(l).not.toContain("2026-11-24T18:00:00.000Z"); // 10 min before-buffer overlaps busy end
    expect(l).toContain("2026-11-24T18:30:00.000Z");
  });
  it("per-type daily limit closes the day", () => {
    const b = [booking("2026-11-24T15:00:00Z", 30), booking("2026-11-24T16:00:00Z", 30)];
    expect(run({ ...base, s: { maxPerDayType: 2 }, bookings: b })).toHaveLength(0);
    expect(run({ ...base, s: { maxPerDayType: 3 }, bookings: b }).length).toBeGreaterThan(0);
  });
  it("per-type limit ignores other event types but owner limit counts all", () => {
    const b = [booking("2026-11-24T15:00:00Z", 30, 0, 0, "evt_other")];
    expect(run({ ...base, s: { maxPerDayType: 1 }, bookings: b }).length).toBeGreaterThan(0);
    expect(run({ ...base, s: { maxPerDayOwner: 1 }, bookings: b })).toHaveLength(0);
  });
  it("date override replaces the weekly hours and [] marks a day off", () => {
    const a = av({ overrides: { "2026-11-24": [{ start: "12:00", end: "13:00" }], "2026-11-25": [] } });
    const s = run({ a, now: "2026-11-20T00:00:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-26T05:00:00Z" });
    expect(isoList(s)).toEqual(["2026-11-24T17:00:00.000Z", "2026-11-24T17:30:00.000Z"]);
  });
  it("override can open a weekend day", () => {
    const a = av({ overrides: { "2026-11-28": [{ start: "10:00", end: "11:00" }] } });
    expect(run({ a, now: "2026-11-20T00:00:00Z", from: "2026-11-28T00:00:00Z", to: "2026-11-29T05:00:00Z" })).toHaveLength(2);
  });
  it("never returns past slots", () => {
    const s = run({ now: "2026-11-24T18:10:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-25T00:00:00Z" });
    expect(s.every((x) => x.start >= at("2026-11-24T18:10:00Z"))).toBe(true);
    expect(new Date(s[0]!.start).toISOString()).toBe("2026-11-24T18:30:00.000Z");
  });
  it("availability ending at 24:00 allows a late slot", () => {
    const a = av({ timezone: "UTC", weekly: { "2": [{ start: "23:00", end: "24:00" }] } });
    expect(isoList(run({ a, now: "2026-11-20T00:00:00Z", from: "2026-11-24T00:00:00Z", to: "2026-11-25T01:00:00Z" }))).toEqual([
      "2026-11-24T23:00:00.000Z",
      "2026-11-24T23:30:00.000Z",
    ]);
  });
  it("window bounds are respected", () => {
    const s = run({ now: "2026-11-20T00:00:00Z", from: "2026-11-24T15:00:00Z", to: "2026-11-24T16:00:00Z" });
    expect(isoList(s)).toEqual(["2026-11-24T15:00:00.000Z", "2026-11-24T15:30:00.000Z"]);
    expect(H).toBe(3600000);
  });
});
