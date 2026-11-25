# Manage booking: reschedule and cancel

From the confirmation page or the link in their email, the invitee reschedules to another free time (shown with
the former time struck through) or cancels with an optional reason. The owner and invitee are notified and the
calendar event follows.

## Sub-features

- `manage-view` `/booking/<id>?token=` shows the booking; a wrong token shows `This page is not available`.
- `manage-reschedule` moves the same booking in place (rescheduleCount + 1); the old slot frees up.
- `manage-cancel` cancels with reason; status `cancelled`, `cancelledBy` invitee.

## How to get to it (user POV)

- Confirmation page buttons `Reschedule` and `Cancel`, or the manage link in the email.
- CLI `slotwise invitee show|reschedule|cancel <id> --manage-token T`.

## Driving it with verify.mjs

Preconditions:

- A confirmed booking from invitee-booking (the journey books one first if missing).

- **Open.** Manage URL without `confirmed=1`; heading `Your meeting`.
- **Reschedule.** `Reschedule`; text `Moving from`; pick the first available time different from the current start; `Next: ...`; `Reschedule meeting`; heading `Your meeting has a new time`. API start equals the chosen `data-start`, `rescheduleCount` 1.
- **Cancel.** `Cancel`; reason `Plans changed`; `Cancel meeting`; heading `This meeting is canceled`. API shows `cancelledBy: invitee` and the reason; outbox has 2 `rescheduled` and 2 `cancelled` rows.
- **Wrong token.** `/booking/<id>?token=not-the-token-123` shows `This page is not available`.
- **Proof.** `manage-booking/01-confirm-new-time`, `02-rescheduled`, `03-canceled`.

## Gotchas

- The manage token is only in the URL and email; it is stored hashed, so it cannot be recovered from the database.
- Past or canceled bookings cannot be rescheduled (409).
