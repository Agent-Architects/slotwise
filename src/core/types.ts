export interface Interval {
  start: string; // "HH:MM"
  end: string; // "HH:MM", "24:00" allowed
}

export type Weekly = Record<string, Interval[]>; // "0" (Sun) .. "6" (Sat)

export interface Availability {
  timezone: string;
  weekly: Weekly;
  overrides: Record<string, Interval[]>;
  bufferBefore: number;
  bufferAfter: number;
  minNotice: number;
  maxDaysAhead: number;
  maxPerDay: number | null;
  /** Name of the default schedule this document describes. */
  scheduleName?: string;
  /** Guests an invitee may add per booking (0 = none). */
  maxGuests?: number;
  updatedAt?: string;
}

/** A named availability schedule. id "default" is the Availability document itself. */
export interface Schedule {
  id: string;
  name: string;
  timezone: string;
  weekly: Weekly;
  overrides: Record<string, Interval[]>;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type LocationKind = "google_meet" | "zoom" | "phone" | "in_person" | "custom";
export interface Location {
  kind: LocationKind;
  value?: string;
}

export type QuestionKind = "text" | "textarea" | "phone" | "select" | "radio" | "checkbox";
export interface Question {
  id: string;
  label: string;
  kind: QuestionKind;
  required: boolean;
  options?: string[];
}

export interface EventType {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description: string;
  durations: number[];
  defaultDuration: number;
  slotInterval: number | null;
  location: Location;
  questions: Question[];
  color: string;
  active: boolean;
  bufferBefore: number | null;
  bufferAfter: number | null;
  minNotice: number | null;
  maxDaysAhead: number | null;
  maxPerDay: number | null;
  /** null = the default schedule. */
  scheduleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  username: string;
  name: string;
  timezone: string;
  welcome: string;
  createdAt: string;
}

export type BookingStatus = "confirmed" | "cancelled";

export interface Booking {
  id: string;
  userId: string;
  eventTypeId: string;
  eventTypeName: string;
  status: BookingStatus;
  start: string;
  end: string;
  blockStart: string;
  blockEnd: string;
  localDate: string;
  duration: number;
  invitee: { name: string; email: string; timezone: string; phone?: string };
  guests: string[];
  answers: Record<string, string>;
  /** Answers with the question label as it was when the invitee answered. */
  answerDetails: { id: string; label: string; value: string }[];
  location: Location & { joinUrl?: string };
  external: { connectionId: string; calendarId: string; eventId: string } | null;
  calendarError: string | null;
  cancelReason: string | null;
  cancelledBy: "owner" | "invitee" | null;
  cancelledAt: string | null;
  rescheduleCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BusyInterval {
  start: number; // ms
  end: number;
}

export interface ExistingBooking {
  start: number;
  end: number;
  blockStart: number;
  blockEnd: number;
  eventTypeId: string;
  localDate: string;
}
