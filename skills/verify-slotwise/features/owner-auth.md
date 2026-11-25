# Owner sign up and sign in

An owner creates an account (name, username, email, password, time zone), lands on Scheduling with a default event
type, signs out, is redirected to sign in when opening a protected page, sees an error for a wrong password, and
signs back in. The CLI can exchange the password for an API token.

## Sub-features

- `auth-signup` creates the owner, default availability and the `30 minute meeting` event type.
- `auth-signout` ends the session from the account menu.
- `auth-guard` redirects `/app/*` to `/login` without a session.
- `auth-login` signs in; wrong password shows `Wrong email or password`.
- `auth-token` exchanges email and password for an `sw_` API token.

## How to get to it (user POV)

- Browser: `/signup` (only while no owner exists or `ALLOW_SIGNUP=true`), `/login`.
- CLI: `slotwise login --email E --password P [--save]`.

## Driving it with verify.mjs

Preconditions:

- Fresh instance (no owner yet). Run `verify.mjs --journeys owner-auth`.

- **Sign up.** Fill `Full name`, `Username`, `Email`, `Password`, choose `Time zone`, press `Create account`. URL ends `/app/event-types`; link `30 minute meeting` visible.
- **Sign out.** `Account menu` then menuitem `Sign out`. Heading `Sign in to <name>` (`name` from `brand.json`, default `Slotwise`).
- **Guard.** Open `/app/meetings`. Lands on `/login`.
- **Wrong password.** Alert `Wrong email or password`.
- **Sign in.** Lands on `/app/event-types` with heading exactly `Scheduling` (exact match: a branded product name can contain the same word).
- **Token.** `POST /api/v1/auth/token` returns 201 with a token starting `sw_`.
- **Proof.** `owner-auth/01-signup-filled`, `02-scheduling` screenshots and ARIA snapshots.

## Gotchas

- After the first owner exists, signup is closed unless `ALLOW_SIGNUP=true` (the verify launcher sets it).
- The username field has an HTML pattern; uppercase is rejected by the browser before the API sees it.
- Login is rate limited per IP (`RATE_LIMIT_AUTH`, 100/min in verification, 10/min by default).
