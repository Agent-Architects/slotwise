# Slotwise verification map

This directory is the maintained source for verifying Slotwise's user-facing behavior. Read this index, then use
the matching feature file. Each file maps one-to-one to a `verify.mjs` journey of the same id.

## Baseline preconditions

- Launch with `control.mjs launch --adapter node|worker` from the repo root; it creates a disposable data dir in
  `.verify/runs/<run-id>/data` and enables the mock calendar and signup.
- `control.mjs doctor` exits 0 before driving.
- Owner: created by the `owner-auth` journey (or signup API) with zone `America/New_York`; default availability is
  Monday to Friday 09:00-17:00, minimum notice 4 hours, 60 days ahead; default event type `30min`.
- Owner browser context zone `America/New_York`; invitee context zone `Europe/Berlin`.
- Never drive an instance this run did not launch.

## Driving conventions

- Prefer ARIA roles and accessible names (listed in SKILL.md Drive) over CSS; `data-start` and `data-date` are the
  only data attributes, used where several buttons share a visible label.
- Pick slots from the live `slots` endpoint, never hard-coded dates: availability depends on today's date.
- CLI runs through `control.mjs cli -- ...` or `cli()` in `control.mjs`; output is JSON; exit 0 ok, 1 API error,
  2 usage error.
- Assertions wait for elements (async rendering); a fixed sleep is used only after the event type switch.

## Proof and skip reporting

- UI proof: screenshot plus ARIA snapshot at the action and at the result.
- Mutation proof: a second read through the owner API, CLI, or public slots endpoint.
- Side effects: notifications outbox rows, mock calendar events, slot disappearance.
- Report an unreachable path with the attempted step and the unmet precondition; never mark it verified through a
  different entry point.

## Feature entry contract

H1 title, one paragraph, then `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.mjs`,
`Gotchas`, in that order.

## Features

- [Owner sign up and sign in](./owner-auth.md)
- [Event types](./event-types.md)
- [Availability](./availability.md)
- [Schedules](./schedules.md)
- [Invitee booking](./invitee-booking.md)
- [Manage booking: reschedule and cancel](./manage-booking.md)
- [Meetings (owner)](./meetings.md)
- [Calendar integrations](./integrations.md)
- [CLI](./cli.md)
- [Account: password, email, operator reset](./account.md)
- [No double booking](./no-double-booking.md)
- [Security controls](./security.md)
