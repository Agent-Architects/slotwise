# Availability

The owner sets weekly hours per weekday (several intervals per day), the schedule time zone, date-specific hours
(override or day off), and booking limits (buffers, minimum notice, how many days ahead, max bookings per day).
Public slots follow immediately.

## Sub-features

- `av-weekly` edits weekday intervals and saves.
- `av-override` adds an exception (date-specific hours) via `Add date` and dialog `Add an exception`, then removes it.
- `av-limits` buffer, notice, horizon and daily limit fields.
- `av-cli` `slotwise availability set|override` (cli.md).

## How to get to it (user POV)

- Sidebar `Availability`, tab `Schedules`.
- CLI `slotwise availability get|set|override`.

## Driving it with verify.mjs

Preconditions:

- Owner signed in; default Monday to Friday 09:00-17:00 in `America/New_York`.

- **Remove Friday.** `Remove Friday interval 1`; Friday row shows `Unavailable`. Set `Buffer after (min)` = 10; `Save`; status `Availability saved`.
- **Second view.** `slotwise availability get`: `weekly["5"]` is `[]`, `bufferAfter` is 10.
- **Override.** `Add date`; dialog `Add an exception`; date = next Saturday at least 2 days out; `Override end 1` = 12:00; `Apply`. Button `Remove override <date>` appears.
- **Slots follow.** Public slots for that Saturday in `America/New_York` are exactly 9:00am..11:30am every 30 min.
- **Remove override.** Saturday has no slots again. The journey then restores Friday via CLI.
- **Proof.** `availability/01-override-dialog`, `02-saved`.

## Gotchas

- Minimum notice is shown in hours in the UI but stored in minutes.
- `24:00` is stored for end of day; the time input shows 23:59.
- Overrides more than 60 days in the past are pruned on the next override write.
