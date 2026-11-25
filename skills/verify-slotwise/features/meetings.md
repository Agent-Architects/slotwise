# Meetings (owner)

The owner sees bookings grouped by date in Upcoming, Past, Canceled, Date range and All tabs (50 per page with
`Load more`), opens details (email, guests, phone, location or join link, invitee zone, answers with their question
labels, calendar sync state), reschedules or cancels in in-page dialogs (cancel can also request a reschedule), and
exports the current view as CSV.

## Sub-features

- `meet-list` upcoming list in the owner's availability zone; `Load more` pages with the API cursor.
- `meet-details` expandable details with question labels.
- `meet-reschedule` dialog `Reschedule meeting`: `New date`, a time button (`data-start`), `Confirm new time`.
- `meet-cancel` dialog `Cancel meeting`: `Message to the invitee (optional)`, buttons `Cancel meeting` or `Request reschedule`.
- `meet-range` tab `Date range` with `From`, `To`, `Apply`.
- `meet-csv` link `Export CSV` (current tab and range).

## How to get to it (user POV)

- Sidebar `Meetings`; tabs `Upcoming`, `Past`, `Canceled`, `Date range`, `All`; `Export CSV` top right.
- CLI `slotwise bookings list|export|get|cancel|request-reschedule|slots|reschedule`.

## Driving it with verify.mjs

Preconditions:

- A booking made through the invitee CLI for `Mo Meeting` in `Asia/Kolkata`.

- **List.** `/app/meetings`; `listitem` `Mo Meeting 30 minute meeting`; its time starts with the New York label.
- **Details.** `Details`; text contains the invitee email and `Asia/Kolkata`.
- **Late replies.** With the reply for an earlier-picked date delayed 1.5 s, the dialog ends on the selected date's times (no spinner, no other date).
- **Reschedule.** `Reschedule`; dialog `Reschedule meeting`; `newDate` = date of another free slot; right after the date change no time of the previous date is shown; its `data-start` button; `Confirm new time`; status `Meeting rescheduled`; API start moved and `rescheduleCount` 1; the invitee's `rescheduled` email has a manage link that opens the booking.
- **Cancel.** `Cancel meeting`; dialog `Cancel meeting`; message `Owner is unavailable`; dialog button `Cancel meeting`; status `Meeting canceled`. API `cancelledBy: owner` with that reason; invitee email contains it.
- **Canceled tab, date range, CSV.** `Canceled` lists it; `Date range` with the meeting's date lists it; `Export CSV` returns `text/csv` starting `Booking ID,` and containing `Mo Meeting`.
- **Proof.** `meetings/01-details` .. `05-date-range`, `export.csv`. The run also asserts no native `window.prompt` was shown.

## Gotchas

- Times use the schedule zone of the default schedule, not the browser zone.
- The details row stays open across reloads only if the booking is still in the list (it is for reschedule).
