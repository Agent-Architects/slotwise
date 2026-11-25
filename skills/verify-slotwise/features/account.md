# Account: password, email, operator reset

The owner changes their password and email in Settings > Account (current password required; other sessions are
signed out on a password change). The CLI does the same with secrets on stdin. A host operator can reset a
forgotten password directly in the database with `scripts/admin-reset-password.mjs`.

## Sub-features

- `acct-password` change password in Settings; old password stops working.
- `acct-email` change email with the current password.
- `acct-cli` `slotwise profile password --password-stdin` (current and new password on stdin lines 1 and 2).
- `acct-reset` operator reset against SQLite (`--db`) or D1 (`--d1 slotwise --local --persist-to ...` locally, `--remote` live); revokes all sessions.

## How to get to it (user POV)

- Sidebar `Settings`, section `Account`, forms `Change email` and `Change password`.
- Terminal on the host: `node scripts/admin-reset-password.mjs --email E --db PATH` with the password on stdin.

## Driving it with verify.mjs

Preconditions:

- Owner signed in; runs after `cli` (it changes the password that journey uses).

- **Password.** Form `Change password`: `Current password`, `New password`, `Repeat new password`, checkbox `Also revoke all API tokens` (on by default); status `Password changed`. Login with the old password is 401, the new one 200, and the journey's API token is now 401 (a new one is exchanged).
- **Email.** Form `Change email`: `New email`, `Current password`; status `Email changed`; `GET /api/v1/me` shows it.
- **CLI.** `profile password --password-stdin --keep-tokens` with two stdin lines exits 0, reports `revokedTokens: 0`, and the token still works.
- **Operator reset.** Script with the run's database exits 0; login with the reset password is 200; API tokens are revoked; the owner browser is back at `Sign in to <name>`.
- **Proof.** `account/01-settings-account`, `account/cli-transcript.json` (includes the reset script run).

## Gotchas

- The reset script refuses `--password` arguments on purpose (exit 2).
- On the worker adapter the script needs the same `--persist-to` directory that wrangler dev uses.
