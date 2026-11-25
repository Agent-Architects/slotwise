# CLI

`slotwise` gives agents every owner action and the invitee actions with JSON on stdout, JSON errors on stderr, exit
0 ok, 1 API error, 2 usage error.

## Sub-features

- `cli-login` password exchange, optional `--save` to `SLOTWISE_CONFIG`.
- `cli-owner` whoami, links, availability set and overrides, event types CRUD, bookings list and cancel, tokens list.
- `cli-invitee` slots, book, invitee show/cancel/reschedule.
- `cli-errors` slot taken exits 1 with `slot_taken`; usage error exits 2.

## How to get to it (user POV)

- `node bin/slotwise.mjs <command>` (or `npm run cli -- <command>`); `--url`, `--token` or `SLOTWISE_URL`, `SLOTWISE_TOKEN`. On a fresh clone the bin builds `dist/cli.mjs` itself (npm install also does via `prepare`).

## Driving it with verify.mjs

Preconditions:

- Owner exists; `SLOTWISE_CONFIG` points into the run dir (control.mjs does this).

- **Login.** `login --email E --password-stdin --name verify-cli --save` with the password on stdin exits 0 with `saved`.
- **Owner reads.** `whoami` returns the username; `links` returns `<url>/<username>`.
- **Availability.** `availability set --mon 08:00-12:00,13:00-18:00 --min-notice 120`; `override set <date> off`, `override remove <date>`.
- **Event types.** `event-types create --name "CLI Sync" --duration 15,45 --location zoom:https://zoom.us/j/123456 --max-per-day 3` gives slug `cli-sync`; `update cli-sync --default-duration 45 --description ...`; public view hides the Zoom URL.
- **Invitee.** `slots <u> cli-sync --from today --to +14d --timezone UTC --duration 15`; `book` the first; the booking location carries the Zoom URL; booking the same start again exits 1 with `slot_taken`.
- **Owner bookings.** `invitee show`, `bookings list --event-type cli-sync`, `bookings cancel <id> --reason`, `bookings list --status cancelled`, `event-types disable cli-sync`.
- **Errors.** `bookings frobnicate` exits 2 with `{"error":{"code":"usage"}}`.
- **Daily limit.** Event type `daily-one` with `--max-per-day 1`: the second booking that day exits 1 with `limit_reached`.
- **Paging and export.** `bookings list --limit 1` returns a `nextCursor`; `--all` follows it to the end; `bookings export` prints CSV.
- **Proof.** `cli/cli-transcript.json` with every command, exit code, stdout and stderr.

## Gotchas

- Creating new tokens needs a browser session or `login`; an API token can list and revoke but not mint tokens.
- Event type refs accept an id (`evt_...`) or a slug.
