# Schedules

The owner keeps several named availability schedules: the default one plus extras such as
weekend hours, each with its own time zone, weekly hours and date-specific hours. Each event type picks a schedule.

## Sub-features

- `sch-create` `Create schedule` dialog names a new schedule and selects it.
- `sch-edit` weekly hours of the selected schedule saved with `Save`.
- `sch-assign` event type editor `Availability schedule` select.
- `sch-slots` public slots follow the event type's schedule; other event types keep theirs.
- `sch-cli` `slotwise schedules list|get|create|update|delete|override`.

## How to get to it (user POV)

- Sidebar `Availability`, combobox `Schedule`, button `Create schedule`; heading shows `<name> (default)` for the default.
- Event type editor, panel `Availability`, combobox `Availability schedule`.

## Driving it with verify.mjs

Preconditions:

- Owner signed in.

- **Create.** `Create schedule`; dialog `Create schedule`; `Schedule name` = `Weekend hours`; `Create`. URL gets `schedule=sch_...`; the old `Working hours (default)` editor is gone at once (no stale controls) and heading `Weekend hours` appears.
- **Hours.** `Remove Monday interval 1` .. `Remove Friday interval 1`; `Add Saturday interval`; `Saturday end 1` = 12:00; `Save`; status `Availability saved`. `slotwise schedules get <id>` shows Monday empty and Saturday ending 12:00.
- **Assign.** CLI creates `weekend-call`; editor `Availability schedule` = Weekend hours; `Save changes`; `slotwise event-types get weekend-call` has the scheduleId.
- **Slots.** Public slots for `weekend-call` over 15 days are only on Saturdays; `30min` still has weekday slots.
- **Proof.** `schedules/01-weekend-schedule`, `02-editor-schedule`.

## Gotchas

- Buffers, minimum notice, days ahead and the daily cap are owner-wide (Booking limits panel), not per schedule.
- The default schedule cannot be deleted; deleting a schedule in use needs `?force=true` and moves its event types to default.
- New schedules start from Monday to Friday 09:00-17:00.
