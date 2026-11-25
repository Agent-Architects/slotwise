-- Additive only.

-- Encrypted copy of the invitee's manage token (AES-GCM with ENCRYPTION_KEY), so an owner-initiated reschedule can
-- email the invitee a working manage link. The hash column stays the only thing used to authenticate.
ALTER TABLE bookings ADD COLUMN manage_token_enc TEXT;

-- Owner-wide cap on guests an invitee may add (0 disables guests). Existing owners get 3.
ALTER TABLE availability ADD COLUMN max_guests INTEGER NOT NULL DEFAULT 3;
