# No double booking

Concurrent invitees cannot both book overlapping times. The insert is a single conditional SQL statement, so
exactly one request wins and the others get 409 `slot_taken`, on both SQLite and D1.

## Sub-features

- `ndb-same-slot` many concurrent POSTs for one start.
- `ndb-overlap` overlapping starts of different durations (API test suite).
- `ndb-reschedule` concurrent reschedules into one slot (API test suite).

## How to get to it (user POV)

- Two people pressing `Book meeting` for the same time at once; HTTP `POST /api/v1/public/bookings`.

## Driving it with verify.mjs

Preconditions:

- A free `30min` slot from the slots endpoint.

- **Race.** 25 parallel `POST /api/v1/public/bookings` for that start.
- **Result.** Exactly one 201, 24 x 409 with `slot_taken`; owner `bookings list` for that minute has exactly one booking.
- **Proof.** `no-double-booking/codes.json`.

## Gotchas

- Run before `security`, which exhausts the public write limit (verify.mjs orders journeys for you).
- The launcher raises `RATE_LIMIT_PUBLIC_WRITE` to 200; with the default 20 most racers get 429 instead.
