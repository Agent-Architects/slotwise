# Slotwise canonical domain model

Slotwise is one domain model behind one versioned JSON API (`/api/v1`). The web UI, the CLI and any other client
only talk to that API. Hosting (Cloudflare Workers + D1, or Node + SQLite) and calendar providers (Google, mock)
are adapters behind small interfaces in `src/core/ports.ts`.

All instants are stored as UTC epoch milliseconds and exchanged as ISO 8601 UTC strings (`2026-11-24T15:00:00.000Z`).
Wall-clock values (`"09:00"`, `"2026-11-24"`) are always interpreted in a named IANA time zone that travels with them.

## Entities

### User (owner)
| field | type | notes |
|---|---|---|
| id | string | `usr_...` |
| email | string | unique, lowercased |
| username | string | unique, `[a-z0-9-]{3,40}`, used in public URLs `/<username>` |
| name | string | shown on booking pages |
| timezone | IANA zone | profile default; availability has its own zone |
| welcome | string | message on the owner landing page |
| passwordHash | string | PBKDF2-SHA256, 100k iterations, 16-byte salt (Workers caps PBKDF2 at 100k) |

### Session
Browser login. Cookie `sw_session` holds a random 32-byte token; only its SHA-256 is stored. Each session has a
CSRF token that must be sent as `X-CSRF-Token` on every non-GET request authenticated by cookie. Sessions expire
after 30 days.

### ApiToken
For the CLI and agents. Plaintext `sw_<43 chars>` is shown once; only the SHA-256 is stored, plus a display
prefix. `scopes` is a subset of `read`, `write`. `read` allows GET on owner endpoints, `write` allows mutations.
Revoked tokens (`revokedAt` set) are rejected. Token management itself requires a browser session or the
password exchange endpoint.

### Availability (one per user)
| field | type | notes |
|---|---|---|
| timezone | IANA zone | zone the weekly hours and overrides are written in |
| weekly | `{ "0".."6": Interval[] }` | 0 = Sunday. Missing or empty day = unavailable |
| overrides | `{ "YYYY-MM-DD": Interval[] }` | date-specific hours; replaces the weekly hours for that date; `[]` = day off |
| bufferBefore | minutes | default for event types |
| bufferAfter | minutes | default for event types |
| minNotice | minutes | default; earliest bookable instant is `now + minNotice` |
| maxDaysAhead | days | default; last bookable owner-local date is `today + maxDaysAhead` |
| maxPerDay | int or null | owner-wide cap of confirmed bookings per owner-local date, all event types |
| maxGuests | int 0..10 | guests an invitee may add per booking (default 3; 0 = none); duplicates and the invitee's own address are dropped |
| scheduleName | string | name of the default schedule |

`Interval = { start: "HH:MM", end: "HH:MM" }`, `start < end`, `end` may be `"24:00"`. Intervals of a day must
not overlap.

### Schedule
`{ id, name, timezone, weekly, overrides }`. The Availability document doubles as the default schedule (id
`default`, name in `scheduleName`). An event type with `scheduleId` uses that schedule's zone, weekly hours and
overrides, combined with the owner-wide buffers, notice, horizon and daily cap from Availability.

### EventType
| field | type | notes |
|---|---|---|
| id | string | `evt_...` |
| slug | string | unique per user, `[a-z0-9-]{1,60}` |
| name, description | string | |
| durations | int[] | minutes, 5..720, at least one; invitee picks one when there are several |
| defaultDuration | int | must be in `durations` |
| slotInterval | int or null | step between start times in minutes; null = the chosen duration |
| location | Location | |
| questions | Question[] | custom invitee questions |
| color | `#rrggbb` | |
| active | bool | inactive types are hidden publicly and refuse bookings |
| bufferBefore, bufferAfter, minNotice, maxDaysAhead, maxPerDay | int or null | null = inherit from Availability (maxPerDay: null = no per-type cap) |

`Location = { kind: "google_meet" | "zoom" | "phone" | "in_person" | "custom", value?: string }`.
- `google_meet`: a Meet link is created on the written calendar event when a Google connection exists.
- `zoom`: `value` is the owner's Zoom meeting URL.
- `phone`: `value` set = invitee calls that number; empty = owner calls the invitee, who must give a phone.
- `in_person`: `value` is the address. `custom`: free text.

`Question = { id, label, kind: "text" | "textarea" | "phone" | "select" | "radio" | "checkbox", required, options? }`.

### Booking
API values and fields are spelled `cancelled`, `cancelledBy` and `cancelledAt` (double l, kept for compatibility); UI
and email copy say "canceled".

| field | type | notes |
|---|---|---|
| id | string | `bkg_...`, also the public uid |
| eventTypeId | string | |
| status | `confirmed` or `cancelled` | |
| start, end | instant | the meeting itself |
| blockStart, blockEnd | instant | `start - bufferBefore`, `end + bufferAfter`, frozen at booking time |
| localDate | `YYYY-MM-DD` | owner-local date of `start`, used for daily limits |
| duration | minutes | |
| invitee | `{ name, email, timezone, phone? }` | |
| guests | string[] | extra emails |
| answers | `{ [questionId]: string }` | |
| answerLabels | `{ [questionId]: label }` | snapshot at booking time (column `answer_labels`); exposed as `answerDetails` |
| location | resolved Location + `joinUrl?` | |
| manageToken | secret | sent to the invitee in links; authenticated by its SHA-256. An AES-GCM encrypted copy (`manage_token_enc`) lets owner-triggered emails include the invitee's working link |
| external | `{ connectionId, eventId, calendarId }` or null | calendar event written for the booking |
| cancelReason, cancelledBy (`owner` or `invitee`), cancelledAt | | |
| rescheduleCount | int | reschedule moves the same booking in place |

### CalendarConnection
`{ id, provider: "google" | "mock", accountEmail, checkCalendarIds: string[], writeCalendarId: string | null, lastError, lastErrorAt }`.
OAuth tokens are AES-256-GCM encrypted with `ENCRYPTION_KEY` before they are stored and never returned by the API.

### Notification
Outbox row for every email the app sends: `{ id, bookingId, kind: booked | rescheduled | cancelled | reschedule_requested | calendar_error, audience: invitee | guest | owner, to, subject, body, provider, status: sent | failed, error? }`.
The default provider is `log` (writes the row and logs it). `resend` sends through the Resend HTTP API.

## Slot computation (`src/core/slots.ts`, pure)

Input: availability, resolved event type settings, chosen duration, `now`, a UTC window, busy intervals from
calendars, and confirmed bookings of the owner.

1. Resolve the event type's schedule. For every owner-local date that can touch the window, take `overrides[date]` if present, else `weekly[weekday]`.
2. Convert each wall-clock interval to UTC with the availability zone. DST is handled per instant: an interval
   that spans a spring-forward gap is one hour shorter, a fall-back interval is one hour longer. A wall time that
   does not exist (inside a gap) maps forward to the first valid instant.
3. Candidate starts begin at each interval start and advance by `slotInterval` (or duration) in real minutes while
   `start + duration <= intervalEnd`.
4. Drop a candidate when any of these hold:
   - `start < now + minNotice`
   - owner-local date of `start` > `today(owner zone) + maxDaysAhead`
   - `[start - bufferBefore, end + bufferAfter)` overlaps a calendar busy interval
   - it overlaps a confirmed booking: `start < b.blockEnd && end > b.blockStart`, or
     `start - bufferBefore < b.end && end + bufferAfter > b.start` (each side's buffers are respected)
   - the owner-local date already has `maxPerDay` bookings of this type, or the owner-wide `maxPerDay`.
5. Results are grouped by the invitee's local date for the requested zone.

## Booking invariants

- No double booking. The insert is one SQL statement, `INSERT ... SELECT ... WHERE NOT EXISTS (overlap) AND
  (count of the day) < limit`. SQLite and D1 execute a statement atomically and serialize writers, so two
  concurrent requests for overlapping times cannot both succeed; the loser gets `409 slot_taken`. Reschedule is
  the same pattern as one `UPDATE ... WHERE NOT EXISTS (overlap excluding itself)`.
- Before the insert the server recomputes the slot list for that start, so only starts that the public slots
  endpoint would offer can be booked (grid, hours, notice, horizon, calendar busy).
- Calendar writes happen after the row is committed. A failed write keeps the booking and records the error.
- Calendars fail closed. If any checked calendar cannot be read, the slots endpoint returns no days with
  `warnings: ["calendar_unavailable"]` and booking or rescheduling returns 503. The connection's `lastError` is set,
  the owner gets one email on the transition to failing and a dashboard banner until a read succeeds.
- Rescheduling ignores exactly one calendar event: the one written for that booking (matched by connection and
  event id). For that connection the provider's event list (`busyEvents`, same blocking rules as free/busy) is read
  instead of merged free/busy blocks, so another event at the same time still blocks. The mock provider reports the
  app's own events as busy, like Google, so tests cover both sides.
- First owner: on a closed instance the user insert is conditional on the users table being empty, inside one
  transaction with the default availability and event type, so parallel first signups cannot both succeed.
- Guests get booked, rescheduled and canceled emails without the invitee's manage link. Because an anonymous
  invitee chooses guest addresses, guest emails contain no invitee-written text except a cleaned name (one line, no
  links or markup, 60 chars), and at most `GUEST_EMAILS_PER_HOUR` (default 20) are sent per owner per hour. Each
  guest email first reserves its outbox row with one conditional INSERT (count and insert in one statement), so
  parallel bookings cannot exceed the cap.
- Password changes sign out other sessions and, by default, revoke all API tokens; the operator reset script revokes
  all sessions and tokens.

## Migrations

`migrations/` files are applied once each (D1: `wrangler d1 migrations apply`; Node: on start). They are
additive only: new tables and `ALTER TABLE ... ADD COLUMN` with defaults. `0002_schedules_and_calendar_health.sql` adds
`bookings.answer_labels`, `calendar_connections.last_error(_at)`, `availability.schedule_name` (default
`Working hours`), `event_types.schedule_id` (NULL = default) and the `schedules` table; existing rows keep their
values and behave as before. `0003_manage_tokens_and_guest_limits.sql` adds `bookings.manage_token_enc` (NULL for older bookings; an
owner reschedule then issues a fresh token and emails it) and `availability.max_guests` (default 3).
