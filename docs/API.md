# Slotwise HTTP API v1

Base path: `/api/v1`. JSON in, JSON out (`Content-Type: application/json`). Instants are ISO 8601 UTC strings.
The web UI and the CLI use only this API. Breaking changes get a new prefix (`/api/v2`); v1 only gains
optional fields.

## Conventions

- Errors: `{ "error": { "code": "slot_taken", "message": "...", "details": {...}? } }` with a matching status.
  Codes: `bad_request` (400, `details.issues` lists invalid fields), `unauthorized` (401), `forbidden` (403,
  includes CSRF and scope failures), `not_found` (404), `conflict` (409), `slot_taken` (409),
  `limit_reached` (409), `rate_limited` (429, `Retry-After` header), `calendar_unavailable` (503: a checked calendar could not be read, so
  nothing can be booked), `internal` (500). Unknown `/api/v1` paths are 404 whether or not you are signed in.
- Owner auth, either:
  - `Authorization: Bearer sw_...` API token. Scope `read` for GET, `write` for anything else.
  - Session cookie `sw_session` from login. Non-GET requests must also send `X-CSRF-Token: <csrfToken>` from
    `GET /auth/session`.
- Public endpoints (`/public/...`) need no auth and are rate limited per client IP.
- Lists return `{ "items": [...] }`.
- Spelling: API values and fields use `cancelled`, `cancelledBy` and `cancelledAt` (double l, kept for compatibility);
  UI and email copy say "canceled".

## Health

`GET /healthz` -> `{ ok, name: "slotwise", version, adapter: "d1" | "sqlite", calendarProviders: [{ id, configured }], emailProvider, signupOpen, setupCodeRequired }` (`setupCodeRequired` is true only while signup is open and `SETUP_CODE` is set)

## Auth

| method | path | body | result |
|---|---|---|---|
| POST | `/auth/signup` | `{ email, password (>=10), name, username, timezone, setupCode? }` | `201 { user, csrfToken }` + cookie. Allowed when no user exists or `ALLOW_SIGNUP=true`; when the server has `SETUP_CODE`, `setupCode` must match (403 otherwise). |
| POST | `/auth/login` | `{ email, password }` | `{ user, csrfToken }` + cookie. Rate limited. |
| POST | `/auth/logout` | | `{ ok: true }`, clears session |
| GET | `/auth/session` | | `{ user, csrfToken }` or 401 |
| POST | `/auth/token` | `{ email, password, name, scopes: ["read","write"] }` | `201 { token, apiToken }`: password exchange for the CLI. Rate limited. |

## Profile and links

| method | path | body / query | result |
|---|---|---|---|
| GET | `/me` | | `{ user }` |
| PATCH | `/me` | `{ name?, username?, timezone?, welcome? }` | `{ user }` |
| GET | `/me/links` | | `{ profileUrl, eventTypes: [{ id, slug, name, active, url }] }` |
| POST | `/me/password` | `{ currentPassword, newPassword (>=10), revokeTokens? (default true) }` | `{ ok, revokedTokens }`; signs out every other browser session and, unless `revokeTokens: false`, revokes every API token (including the one making the call) |
| POST | `/me/email` | `{ email, currentPassword }` | `{ user }`; 409 if the email is taken |
| GET | `/me/alerts` | | `{ items: [{ kind: "calendar_error", connectionId, provider, accountEmail, message, since }] }` |

## API tokens

Creating a token needs a browser session (or the password exchange `POST /auth/token`); listing and revoking also accept an API token.

| method | path | body | result |
|---|---|---|---|
| GET | `/tokens` | | `{ items: ApiToken[] }` (no secrets) |
| POST | `/tokens` | `{ name, scopes }` | `201 { token, apiToken }`; `token` is shown only here |
| DELETE | `/tokens/:id` | | `{ ok: true }` (revokes) |

## Availability

| method | path | body | result |
|---|---|---|---|
| GET | `/availability` | | `{ availability }` |
| PATCH | `/availability` | any subset of `{ timezone, weekly, overrides, bufferBefore, bufferAfter, minNotice, maxDaysAhead, maxPerDay, maxGuests (0..10, default 3) }` | `{ availability }`. `weekly` replaces whole days that are present; `overrides` replaces the whole map. |
| PUT | `/availability/overrides/:date` | `{ intervals: Interval[] }` (`[]` = unavailable) | `{ availability }` |
| DELETE | `/availability/overrides/:date` | | `{ availability }` |

Example `weekly`: `{ "1": [{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}], "6": [] }`.

## Schedules

The availability document is the default schedule (id `default`). Named schedules add their own time zone,
weekly hours and date overrides; buffers, notice, horizon and the owner-wide daily cap stay in `/availability`.

| method | path | body | result |
|---|---|---|---|
| GET | `/schedules` | | `{ items: Schedule[] }`, default first (`{ id, name, timezone, weekly, overrides, isDefault }`) |
| POST | `/schedules` | `{ name, timezone?, weekly?, overrides? }` | `201 { schedule }` (weekly starts from Mon-Fri 09:00-17:00) |
| GET, PATCH | `/schedules/:id` | `{ name?, timezone?, weekly?, overrides? }` | `{ schedule }` |
| DELETE | `/schedules/:id` | `?force=true` moves event types using it back to default | `{ ok }`; 409 for `default` or when in use |
| PUT, DELETE | `/schedules/:id/overrides/:date` | `{ intervals }` | `{ schedule }` |

## Event types

| method | path | body | result |
|---|---|---|---|
| GET | `/event-types` | | `{ items: EventType[] }` |
| POST | `/event-types` | `{ name, slug?, description?, durations?, defaultDuration?, slotInterval?, location?, questions?, color?, active?, bufferBefore?, bufferAfter?, minNotice?, maxDaysAhead?, maxPerDay?, scheduleId? }` (`scheduleId` null or `"default"` = default schedule) | `201 { eventType }`; slug defaults from the name |
| GET | `/event-types/:id` | | `{ eventType }` |
| PATCH | `/event-types/:id` | any subset | `{ eventType }` |
| DELETE | `/event-types/:id` | | `{ ok: true }`. Fails with 409 when it has upcoming confirmed bookings unless `?force=true`. |

Every EventType in a response has `url` (its public booking link).

## Bookings (owner)

| method | path | query / body | result |
|---|---|---|---|
| GET | `/bookings` | `status=upcoming|past|cancelled|range|all` (default upcoming), `from`, `to` (ISO), `eventTypeId`, `limit` (<=200, default 100), `cursor` | `{ items: Booking[], nextCursor }`. Upcoming and range ascending, others descending. Pass `nextCursor` back as `cursor`; `null` means done. |
| GET | `/bookings/export` | same filters, no paging | `text/csv` attachment with every matching booking (cells starting with `= + - @` are prefixed with `'`) |
| GET | `/bookings/:id` | | `{ booking }` |
| POST | `/bookings/:id/cancel` | `{ reason? }` | `{ booking }` status `cancelled`, `cancelledBy: "owner"` |
| POST | `/bookings/:id/request-reschedule` | `{ reason? }` | `{ booking }` canceled; the invitee is emailed a link to pick a new time |
| GET | `/bookings/:id/slots` | `from`, `to` (YYYY-MM-DD), `timezone` | same shape as public slots, excluding the booking itself |
| POST | `/bookings/:id/reschedule` | `{ start }` | `{ booking }` moved in place (owner reschedule); the invitee's email carries their working manage link |

Every Booking has `answers` (`{ questionId: value }`) and `answerDetails` (`[{ id, label, value }]`, the label as it
was when the invitee answered).

## Integrations

| method | path | body | result |
|---|---|---|---|
| GET | `/integrations` | | `{ providers: [{ id, name, configured }], connections: CalendarConnection[], email: { provider }, appUrl }` |
| POST | `/integrations/:provider/connect` | | `{ url }`: open it in a browser to grant access |
| GET | `/integrations/connections/:id/calendars` | | `{ items: [{ id, name, primary }] }` |
| PATCH | `/integrations/connections/:id` | `{ checkCalendarIds?, writeCalendarId? }` | `{ connection }` |
| DELETE | `/integrations/connections/:id` | | `{ ok: true }` |
| GET | `/oauth/:provider/callback` (no `/api/v1` prefix) | `code`, `state` | 302 to `/app/integrations?connected=<provider>` |

## Notifications

`GET /notifications?bookingId=` -> `{ items: Notification[] }` (owner outbox, newest first, 100 max).

## Public (invitee)

| method | path | body / query | result |
|---|---|---|---|
| GET | `/public/users/:username` | | `{ owner: { name, username, welcome }, eventTypes: PublicEventType[] }` (active only) |
| GET | `/public/users/:username/event-types/:slug` | | `{ owner, eventType }` (`eventType.maxGuests`: guests an invitee may add) |
| GET | `/public/users/:username/event-types/:slug/slots` | `from=YYYY-MM-DD`, `to=YYYY-MM-DD` (<= 62 days), `timezone`, `duration?`, `excludeBooking?` + `token?` (reschedule) | `{ timezone, duration, days: [{ date, slots: [{ start, end }] }] }`; dates are in `timezone` |
| POST | `/public/bookings` | `{ username, slug, start, duration?, timezone, name, email, phone?, guests?, answers? }` | `201 { booking, manageToken, manageUrl }`, 409 `slot_taken` (time not offered or just taken) / `limit_reached` (day is full), 503 `calendar_unavailable` |
| GET | `/public/bookings/:id?token=` | | `{ booking, owner, eventType }` |
| POST | `/public/bookings/:id/cancel` | `{ token, reason? }` | `{ booking }` |
| POST | `/public/bookings/:id/reschedule` | `{ token, start, timezone? }` | `{ booking }` |

`manageUrl` is `<APP_URL>/booking/<id>?token=<manageToken>`; the confirmation email links there.

## Dev-only (when `MOCK_CALENDAR=true`)

| method | path | body | result |
|---|---|---|---|
| GET | `/dev/mock-calendar/events` | | `{ items }` events written to and busy blocks in the mock calendar (owner auth) |
| POST | `/dev/mock-calendar/events` | `{ start, end, summary?, calendarId? }` | `201 { event }` adds a busy block (owner auth) |
| POST | `/dev/mock-calendar/fail` | `{ fail: boolean }` | simulates the provider failing (fail-closed testing) |

## Rate limits (per client address, fixed 60 s window; env overrides)

The client address comes from the hosting adapter: on Cloudflare it is `CF-Connecting-IP` (set by Cloudflare's
edge); on Node it is the socket address unless `TRUST_PROXY` names the header your reverse proxy sets
(`x-forwarded-for` uses its last entry, `x-real-ip` / `cf-connecting-ip` the value). Client-sent headers are
otherwise ignored.

| bucket | default | env |
|---|---|---|
| public reads (`GET /public/*`) | 240/min | `RATE_LIMIT_PUBLIC_READ` |
| public writes (book, cancel, reschedule) | 20/min | `RATE_LIMIT_PUBLIC_WRITE` |
| guest notification emails, per owner per rolling hour (extra ones are recorded as `suppressed`, not sent) | 20 | `GUEST_EMAILS_PER_HOUR` |
| login, signup, token exchange | 10/min | `RATE_LIMIT_AUTH` |
