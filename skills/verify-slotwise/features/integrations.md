# Calendar integrations

The owner connects a calendar account through OAuth, chooses which calendars are checked for conflicts and which
receives new bookings. Busy times are hidden from invitees; each booking is written as an event with the invitee
as attendee and a video link for Google Meet locations. Disconnect removes it.

## Sub-features

- `int-google-status` Google card states whether the server has an OAuth client.
- `int-connect` OAuth round trip (state bound to the signed-in owner, single use).
- `int-busy` busy blocks hide overlapping slots, including buffers.
- `int-write` booking creates a calendar event with attendee and join link; reschedule moves it; cancel cancels it.
- `int-own-event` rescheduling onto a time overlapping the booking's own calendar event works (mock reports app events as busy, like Google).
- `int-failclosed` when the calendar fails: no slots (`calendar_unavailable`), booking 503, invitee message, owner banner and one email; recovery clears it.

## How to get to it (user POV)

- Sidebar `Integrations`; region `Google Calendar` or `Mock Calendar (dev)`, button `Connect`.
- CLI `slotwise integrations list|connect|calendars|set|disconnect`, dev `slotwise mock busy|events`.

## Driving it with verify.mjs

Preconditions:

- Server started with `MOCK_CALENDAR=true` (the launcher does it). No Google client configured.

- **Google status.** Region `Google Calendar` contains `Not configured on this server`.
- **Connect.** Region `Mock Calendar (dev)`, `Connect`; URL gets `connected=mock`; status `Connected mock.`; `owner@mock.example` listed; `Check Mock primary for conflicts` checked.
- **No secrets.** `GET /api/v1/integrations` never contains `accessToken`.
- **Busy.** `slotwise mock busy --start S --end S+30m`; the booking page for that day has no `.time-btn[data-start=S]`.
- **Write.** Book another slot in the UI; confirmation shows a `join link`; `slotwise mock events` has an `app` event at that start with the invitee as attendee and a `meet.mock.invalid` link.
- **Own event.** CLI event type `hour-block` (60 min, 30 min increments); book a slot whose +30 min start is also free; `invitee reschedule` to +30 min exits 0.
- **External event in the old span.** A mock busy block covering the moved booking's time plus the next 30 min; rescheduling into it exits 1 with `slot_taken` (only the booking's own event is ignored).
- **Failure.** `POST /api/v1/dev/mock-calendar/fail {"fail":true}`; slots have no days and `warnings: ["calendar_unavailable"]`; public booking is 503 `calendar_unavailable`; the booking page shows an alert containing `calendar is not reachable`; owner pages show an alert containing `Mock Calendar (dev) (owner@mock.example) is not responding` (display name, not provider id); exactly one `calendar_error` email. Then `{"fail":false}` and one slots read clear the banner.
- **Proof.** `integrations/01-connected`, `02-confirm-with-link`, `03-calendar-down-invitee`, `04-calendar-down-owner`, `mock-events.json`.

## Gotchas

- The mock provider proves the app side of the `CalendarProvider` contract only. Real Google calls (consent
  screen, freeBusy, events insert with conferenceData) are unit tested against recorded request shapes and need a
  real OAuth client to verify (docs/GOOGLE-OAUTH-SETUP.md).
- Fail-closed state is cleared by the next successful calendar read, not by a timer.
