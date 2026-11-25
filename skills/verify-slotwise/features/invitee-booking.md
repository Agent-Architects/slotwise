# Invitee booking

An invitee opens the owner's landing page or an event type link, sees a month calendar with bookable days, picks a
day and a time in their auto-detected (switchable) time zone, fills name, email, guests and custom questions, and
gets a confirmation page. The owner sees the booking; both get notification emails.

## Sub-features

- `book-landing` lists active event types at `/<username>`.
- `book-calendar` month view with available days, auto-advance to the next month when the current has none.
- `book-timezone` auto-detects and switches the display zone; the same instant re-labels.
- `book-form` validates required questions, accepts guests.
- `book-confirm` confirmation with time in the invitee zone; email outbox rows for invitee and owner.

## How to get to it (user POV)

- Browser `/<username>` then an event, or a shared link `/<username>/<slug>`.
- CLI (as an agent invitee) `slotwise slots ...` and `slotwise book ...`.

## Driving it with verify.mjs

Preconditions:

- Event type `verify-consult` active (created by event-types or by the journey through the CLI).

- **Landing.** `/<username>` shows link `Verify Consult`; click it. Heading `Pick a time`; address visible; combobox `Time zone` = `Europe/Berlin`.
- **Product credit.** Footer link `Scheduling by <brand name>` (to `/`) sits under the card, outside `main`, and shows the whole name at 1280 px and at 390 px (`01b-phone-footer`).
- **Late replies.** With the next month's slots reply delayed, `Next month` then `Previous month`: the current month keeps its available days and is not left loading.
- **Pick.** First button matching `, times available`; first `.time-btn`; its label equals the `data-start` instant formatted in Berlin.
- **Switch zone.** Select `Asia/Tokyo`, open that instant's Tokyo date, the same `data-start` button shows the Tokyo label. Switch back.
- **Form.** `Next: <time>`; heading `Your details`; fill `Name *`, `Email *`, `Add guests` then `Guest emails`; `Book meeting` without the required answer keeps the form and the card is not scrolled sideways (left column fully visible); fill `What should we cover? *`; `Book meeting`.
- **Confirm.** Heading `Booking confirmed`; `booking-time` starts with the Berlin label.
- **Guest cap.** Public event type has `maxGuests: 3`; a booking with 4 guests is 400 with issue path `guests`.
- **Side effects.** Owner API booking has the same start, invitee zone Berlin, answer `Roadmap`, guest stored; notifications show two `booked` rows and the invitee email links to `/booking/<id>?token=`; the slot is gone from public slots.
- **Proof.** `invitee-booking/01-landing` .. `04-confirmation`, `booking.json`.

## Gotchas

- Day buttons without times are disabled and their label ends `, no times available`; a regex on `times available` alone matches them too.
- Availability depends on today: always pick from what is rendered or from the slots endpoint.
- Required question validation is the browser's `required`; the API also returns 400 with `details.issues`.
