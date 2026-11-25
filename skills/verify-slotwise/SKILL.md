---
name: verify-slotwise
description: Drive Slotwise (this repo) end to end like its users - owner dashboard and invitee booking pages in a real browser via Playwright, the slotwise JSON CLI, and the v1 HTTP API - on either the Node + SQLite adapter or wrangler dev (Workers + D1), all on a throwaway local instance. Use to prove a change to scheduling, availability, booking, calendar sync, CLI or security behavior actually works, or to reproduce a reported bug.
---

# Verify Slotwise

Slotwise is a self-hosted scheduling app. Surfaces: web UI (owner at `/app/*`, invitee at `/<username>`,
`/<username>/<slug>`, `/booking/<id>?token=`), CLI `bin/slotwise.mjs` (JSON output), HTTP API `/api/v1`
(docs/API.md). Every command here runs from the repo root of your clone with local devDependencies only. It never
touches a real deployment, Cloudflare account or Google account. If the app was branded with `scripts/brand.mjs`,
the scripts read the product name from `brand.json`.

## Launch

One-time per checkout: `npm install` and `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium-headless-shell`
(the browser goes into `node_modules`, nothing global). `verify.mjs` sets `PLAYWRIGHT_BROWSERS_PATH=0` itself when it
is unset, so `npm run verify` finds that browser on any OS; set it yourself for your own Playwright scripts.

```bash
# Node + SQLite adapter (fast, about 2 s to ready)
node skills/verify-slotwise/scripts/control.mjs launch --adapter node
# Workers + D1 reference adapter through wrangler dev (about 10 s to ready)
node skills/verify-slotwise/scripts/control.mjs launch --adapter worker
```

`launch` builds (`npm run build`), picks a free port, creates `.verify/runs/<run-id>/` with an empty data dir
(SQLite file or `--persist-to` D1 state with migrations applied), and starts the server with
`MOCK_CALENDAR=true`, `ALLOW_SIGNUP=true`, a random `ENCRYPTION_KEY`, and raised rate limits (public writes 200/min).
It prints `instance.json` (url, pid, evidence dir). Ready means `/healthz` answers `ok:true` from the database AND the
SPA shell is served; launch waits for both and fails with the log path otherwise. Empty data dir means no owner yet:
the first journey (or `POST /api/v1/auth/signup`) creates one.

Teardown: `node skills/verify-slotwise/scripts/control.mjs stop [--run-id ID]`.

## Doctor

```bash
node skills/verify-slotwise/scripts/control.mjs doctor [--run-id ID]
```

Read only. Exit 0 only if the process we started is alive, `/healthz` answers, the adapter matches what was
launched (`sqlite` for node, `d1` for worker), the mock calendar provider is enabled, and the version equals
`package.json`. Run it first whenever anything looks off. Never drive an instance this skill did not launch
(for example a developer's `npm run dev:node` on 8787); launch your own instead.

## Drive

Full scripted run (launch, all journeys, evidence, cleanup); `npm run verify -- --adapter node` is the same:

```bash
node skills/verify-slotwise/scripts/verify.mjs --adapter node
node skills/verify-slotwise/scripts/verify.mjs --adapter worker
# subset, keep the instance up afterwards for manual poking
node skills/verify-slotwise/scripts/verify.mjs --adapter node --journeys invitee-booking,manage-booking --keep
# against an instance you launched with control.mjs
node skills/verify-slotwise/scripts/verify.mjs --run-id <ID> --url http://127.0.0.1:<port>
```

Journeys always run in feature-map order; `security` runs last because it exhausts the public write rate limit.
Each journey and its exact steps are in `features/` (one file per feature). Browser contexts: owner in
`America/New_York`, invitee in `Europe/Berlin` (so time zone conversion is always exercised).

CLI by hand against a launched instance (the helper injects `--url` and an isolated `SLOTWISE_CONFIG`):

```bash
node skills/verify-slotwise/scripts/control.mjs cli -- login --email E --password P --save
node skills/verify-slotwise/scripts/control.mjs cli -- event-types list
node skills/verify-slotwise/scripts/control.mjs cli -- slots <username> 30min --from 2026-11-24 --to 2026-11-30 --timezone UTC
```

Stable handles used by the scripts (prefer these when writing new steps). Match headings with `exact: true`:
Playwright matches names by substring, and a branded product name can contain a page title word.
- Booking calendar day buttons: `aria-label` ends with `, times available` (enabled) or `, no times available`
  (disabled); also `data-date="YYYY-MM-DD"`. Time buttons: `.time-btn[data-start="<ISO UTC>"]`. Confirm button:
  role button named `Next: <time>`. Zone picker: combobox `Time zone`.
  Under the card (outside `main`): footer (`contentinfo`) link `Scheduling by <brand name>` to `/`.
- Invitee form: labels `Name *`, `Email *`, `Guest emails` (after `Add guests`), question label plus ` *` when
  required, button `Book meeting`. Confirmation heading `Booking confirmed`; time text `data-testid="booking-time"`.
- Manage page: headings `Your meeting`, `Your meeting has a new time`, `This meeting is canceled`; link
  `Reschedule`; button `Cancel` then textarea `Why are you canceling? (optional)` and button `Cancel meeting`.
- Owner shell: sidebar links `Scheduling`, `Meetings`, `Availability`, `Integrations`, `Settings`; account menu
  button `Account menu` with menuitem `Sign out`; calendar problems show an `alert` containing `is not responding`.
  Event type cards are `listitem` named by the event name, with a `switch` and button `Copy link for <name>`.
  Meetings rows are `listitem` named `<invitee> <event type>`; owner actions open dialogs `Reschedule meeting` and
  `Cancel meeting` (no native prompts); tabs include `Date range`; link `Export CSV`.
- Availability: combobox `Schedule`, button `Create schedule` (dialog of the same name), heading
  `<name> (default)`; day rows labeled by weekday name, buttons `Remove <Day> interval N`, `Add <Day> interval`;
  `Add date` (under heading `Exceptions`) opens dialog `Add an exception` (date input `overrideDate`, `Override start/end N`, `Apply`); `Save`.
  Event type editor: combobox `Availability schedule`.
- Settings: forms `Change email` and `Change password` (labels `Current password`, `New password`,
  `Repeat new password`).
- Integrations: regions `Google Calendar`, `Mock Calendar (dev)` with button `Connect`. Simulate a provider outage
  with `POST /api/v1/dev/mock-calendar/fail {"fail":true}` (owner token); `{"fail":false}` restores it.

## Evidence

Everything lands in `.verify/runs/<run-id>/evidence/` (gitignored) and survives `stop`:
- `<journey>/NN-step.png` full-page screenshots plus `NN-step.aria.txt` ARIA snapshots of the same moment.
- `<journey>/cli-transcript.json`: every CLI command with exit code, stdout, stderr.
- `<journey>/*.json` side-effect proofs: stored booking plus email outbox rows, mock calendar events written,
  concurrency status codes.
- `results.json`: every check with pass or fail and detail; the run prints `N passed, M failed`.

Proof standards: drive the user path (UI clicks or the real CLI binary), never internal setters. Every UI mutation
is confirmed from a second view: the owner API, the CLI, or the public slots endpoint. Side effects are checked
directly: email outbox rows (`GET /api/v1/notifications`), calendar writes (`slotwise mock events`), and booked
slots disappearing from `slots`. The mock calendar is the only mock and sits behind the same `CalendarProvider`
interface that Google uses; it does not prove the real Google API (see Gotchas in `features/integrations.md`).
The `log` email provider does not deliver mail; the outbox row is the proof.

## Cleanup

`verify.mjs` stops the instance it launched unless `--keep`. Otherwise run `control.mjs stop --run-id <ID>`. Stop
kills only the process group recorded in `instance.json` (wrangler's workerd children included), deletes the run's
`data/` and the CLI config holding a token, and writes `stopped.json`. It never deletes `evidence/`. Never kill by
process name. Remove old runs by deleting `.verify/runs/<run-id>` yourself once their evidence is no longer needed.

## Helpers

- `scripts/control.mjs` (executable): `launch | doctor | cli -- <args> | stop`, also importable
  (`launch`, `doctor`, `cli`, `stop`, `readInstance`).
- `scripts/verify.mjs` (executable): journey runner, flags `--adapter`, `--journeys`, `--keep`, `--headed`,
  `--url` + `--run-id`.

Keep `features/` honest as the app changes: when a user-visible behavior, label or route changes, update the
matching feature file and its journey in `scripts/verify.mjs` in the same change.
