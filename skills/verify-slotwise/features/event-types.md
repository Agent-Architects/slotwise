# Event types

The owner creates and edits event types (name, link slug, description, color, one or more durations, location,
custom invitee questions, limits and buffers), turns them on and off, and copies their booking link.

## Sub-features

- `et-create` creates from the editor with several durations, a location and a required question.
- `et-toggle` hides an event type from the public pages when switched off.
- `et-copy` copies the booking URL (toast `Link copied`).
- `et-cli` creates, updates, enables, disables and deletes from the CLI (covered in cli.md).

## How to get to it (user POV)

- Sidebar `Scheduling`, button `New event type` or sidebar `Create`; card gear or name opens the editor.
- CLI `slotwise event-types ...`.

## Driving it with verify.mjs

Preconditions:

- Owner signed in in the owner context.

- **Create.** `New event type`; fill `Event name *` = `Verify Consult`, `Description`; toggle chip `1 hr`; `Where the meeting happens` = in_person; `Address` = `Room 4, 1 Main St`; `Add question`, `Question 1 label`, check `Required`; `Create event type`. URL becomes `/app/event-types/evt_...`.
- **Second view.** `slotwise event-types get verify-consult` shows durations `[30,60]`, location in_person with the address, one required question.
- **Toggle.** On `/app/event-types` the `listitem` `Verify Consult` switch off makes `GET /api/v1/public/users/<u>/event-types/verify-consult` 404; on again makes it 200.
- **Copy link.** `Copy link for Verify Consult` shows status `Link copied`.
- **Proof.** `event-types/01-editor-filled`, `02-list`.

## Gotchas

- The slug is generated from the name (`verify-consult`); explicit duplicate slugs return 409.
- Zoom, phone and owner contact details are hidden on public pages and revealed after booking.
- Deleting an event type with upcoming bookings needs confirmation (API `?force=true`).
