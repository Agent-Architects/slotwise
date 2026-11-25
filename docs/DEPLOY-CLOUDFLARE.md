# Deploying Slotwise to Cloudflare (Workers + D1)

Cloudflare is the reference host: one Worker serves the API and the web UI (Workers Static Assets), and one D1
database stores everything. Rate limiting uses a D1 table, so no KV or Durable Objects are needed. The free
Workers plan is enough for a personal instance.

For a plain Node server instead, see docs/SELF-HOST.md. For how the hosting adapters fit together, docs/HOSTING.md.

## What you need

- A Cloudflare account (sign up at https://dash.cloudflare.com/sign-up; a human step).
- Either `npx wrangler login` on the machine that deploys (opens a browser consent page; a human step), or an API
  token in a file (below).
- Node 22.13 or newer and `npm ci` in the repo (wrangler is a local devDependency; nothing global).

### API token (instead of wrangler login)

Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom token with:

| Permission | Access |
|---|---|
| Account > Workers Scripts | Edit |
| Account > D1 | Edit |
| Account > Account Settings | Read |
| User > User Details | Read |
| Zone > Zone | Read (only for a custom domain; Zone Resources: the domain's zone) |
| Zone > Workers Routes | Edit (only for a custom domain) |
| Zone > DNS | Edit (only for a custom domain) |

Where these come from: Cloudflare's API reference lists Workers Scripts Edit for attaching a Worker to a custom
domain, and wrangler looks the zone up by name (Zone Read) before it adds the route. Cloudflare's custom domain guide
does not list token permissions, so DNS Edit is included to be safe, because Cloudflare creates the hostname's DNS
record (`npx wrangler login` does not ask for a DNS permission, so it may not be needed). If the deploy stops with an
authentication or permission error (often `[code: 10000]`) on the custom domain step, check that the token has
Zone > Zone Read, Zone > Workers Routes Edit and Zone > DNS Edit for that zone (add Zone > SSL and Certificates Edit
if the error names certificates), then re-run.

Save it to a file readable only by you (`chmod 600`). The deploy script reads it from the path in `CF_TOKEN_FILE`
and never prints it. Set `CLOUDFLARE_ACCOUNT_ID` too if the token can see several accounts.

## Where account-specific values live

`wrangler.toml` is committed and generic: its `database_id` is the placeholder
`00000000-0000-0000-0000-000000000000` and it has no routes. The deploy script never edits it. Instead it writes:

| File (all gitignored) | Contents |
|---|---|
| `wrangler.local.toml` | Copy of `wrangler.toml` with your real D1 `database_id` and, with `--domain`, the custom domain route plus `workers_dev = false` and `preview_urls = false` (the Worker then answers only on your domain). Every wrangler command in the script runs with `--config wrangler.local.toml`. |
| `.deploy/state.json` | Settings you passed once (`CUSTOM_DOMAIN`, `APP_URL`, `APP_NAME`, `GOOGLE_CLIENT_ID`, `EMAIL_FROM`, `EMAIL_PROVIDER`) and the workers.dev URL, so a plain re-run redeploys the same way. No secrets. |
| `.deploy/setup-code` | The first-owner setup code (mode 600), written once on the first deploy. |

To run wrangler by hand against your deployment, pass the same config:
`npx wrangler --config wrangler.local.toml <command>` (rollback, `d1 time-travel`, `tail`, ...).

## Check it without an account

```bash
npm run deploy:cloudflare:dry-run                # or: bash scripts/deploy-cloudflare.sh --dry-run --domain book.example.com
```

Builds the web bundle, generates its own config `.deploy/dry-run/wrangler.toml` with the placeholder id (your
real `wrangler.local.toml` is never touched), and runs `wrangler deploy --dry-run`, which bundles the Worker and
lists its bindings (`env.DB`, `env.ASSETS`, vars) without contacting Cloudflare. Expected last line:
`[deploy] dry run ok: ...`. The bundle lands in `.deploy/dry-run/out` (gitignored, replaced on every dry run).

Static assets are uploaded from `public/` except what `public/.assetsignore` lists: the web bundle's source map
(`*.map`) stays local, so the original UI source is not published.

## Deploy

```bash
npx wrangler login                                        # human: approve in the browser (skip with a token file)
npm run deploy:cloudflare                                 # workers.dev URL; asks before touching the account
bash scripts/deploy-cloudflare.sh --domain book.example.com   # custom domain (zone must be on this account)
CF_TOKEN_FILE=/secure/path/cf-token npm run deploy:cloudflare -- --yes   # API token file, no prompt
```

`scripts/deploy-cloudflare.sh` does, in order:

1. Authenticates (token file, an exported `CLOUDFLARE_API_TOKEN`, or wrangler login) and checks it with
   `wrangler whoami --json`, failing early when nobody is logged in. It prints the account name and id and pins every
   later wrangler call to that account (`CLOUDFLARE_ACCOUNT_ID`; required when the login can see several accounts,
   and checked against the list). It asks for confirmation before changing anything; without a terminal (scripts,
   agents) it refuses unless `--yes` is passed.
2. Runs `npm run typecheck` and the full test suite (`SKIP_CHECKS=1` skips them).
3. Builds the web bundle into `public/assets/app.js`.
4. Finds the D1 database `slotwise` or creates it, and writes `wrangler.local.toml` with its id (and route).
5. Applies `migrations/` to the remote database.
6. Creates missing Worker secrets and uploads them with the same `wrangler deploy` (`--secrets-file`), so new
   code is never live without them. `ENCRYPTION_KEY`, `SETUP_CODE`, `GOOGLE_CLIENT_SECRET` and `RESEND_API_KEY`
   are removed from the environment of that call, so an exported shell variable can never replace them. Existing secrets are never regenerated or overwritten. A Worker counts as
   new only when wrangler clearly answers that it does not exist; any other failure to read the secret list (an
   outage, a rate limit, an auth problem) stops the script without changing anything:
   - `ENCRYPTION_KEY`: 32 random bytes; encrypts calendar OAuth tokens at rest. Generated on first deploy and kept
     only in Cloudflare. Changing it later makes existing calendar connections unreadable (reconnect them).
   - `SETUP_CODE`: random code required on the signup page, so nobody else can claim a fresh instance. It is written
     to `.deploy/setup-code` (gitignored, mode 600) for you to use once.
   - `GOOGLE_CLIENT_SECRET` from `GOOGLE_CLIENT_SECRET_FILE`, `RESEND_API_KEY` from `RESEND_API_KEY_FILE` when given.
7. `wrangler deploy` prints the `https://slotwise.<your-subdomain>.workers.dev` URL, or with `--domain` attaches the
   custom domain instead (workers.dev and preview URLs are off then).
8. Polls `/healthz` (the custom domain when set, waiting up to about 3 minutes for its certificate), prints the URL and the Google redirect URI to register, and prints the public origin on stdout.
   Everything else (test, build and migration output, progress, errors as `[deploy] ERROR: ...`) goes to stderr,
   so `URL="$(npm run --silent deploy:cloudflare -- --yes)"` captures just the URL.

Re-running the script on an existing deployment is safe: it reuses the database, applies only migrations not yet
recorded (all migrations are additive; see docs/MODEL.md), keeps the remembered settings, and never changes
`ENCRYPTION_KEY` or `SETUP_CODE` once they exist. Never rotate `ENCRYPTION_KEY` by hand either.

### Options

| Flag or env for the script | Effect |
|---|---|
| `--domain book.example.com` (or `CUSTOM_DOMAIN`) | Adds a Workers custom domain route in `wrangler.local.toml` and sets `workers_dev` and `preview_urls` to `false` there, so the Worker answers only on your domain (one origin for sign-in cookies, OAuth and email links). Cloudflare creates the DNS record and certificate. Sets `APP_URL=https://book.example.com` unless `APP_URL` is given. The domain's zone must be active on the same Cloudflare account. Without `--domain` both stay on (the workers.dev URL is then the app's address). |
| `APP_URL=https://...` | Origin used in emails and OAuth redirects (default: the request origin) |
| `APP_NAME="Acme Bookings"` | Product name in emails and calendar events (default: the name in `brand.json`) |
| `GOOGLE_CLIENT_ID=...` + `GOOGLE_CLIENT_SECRET_FILE=/path` | Enables Google Calendar (docs/GOOGLE-OAUTH-SETUP.md) |
| `RESEND_API_KEY_FILE=/path` + `EMAIL_FROM="Bookings <bookings@example.com>"` | Delivers email through Resend instead of the log outbox |
| `--yes` | Confirm the account non-interactively (required when there is no terminal) |
| `--dry-run` | Bundle and validate only; no account needed |

Plain settings live in `wrangler.toml` `[vars]`: `ALLOW_SIGNUP` (default `false`: only the first owner can sign
up), `MOCK_CALENDAR` (keep `false` in production), `EMAIL_PROVIDER`, and the `RATE_LIMIT_*` overrides from
docs/API.md.

### Custom domain without moving DNS to Cloudflare

Workers custom domains need the zone on Cloudflare. If your DNS stays elsewhere, use the workers.dev URL, or move
the domain's nameservers to Cloudflare first (Cloudflare dashboard > Add a domain; a human step at your registrar),
or self-host with Node (docs/SELF-HOST.md), which works with any DNS provider.

## After the first deploy

1. Open `<APP_URL>/signup`, enter the code from `.deploy/setup-code`, create the owner account.
2. Get a CLI token: `node bin/slotwise.mjs --url <APP_URL> login --email you@example.com --save` (prompts for the
   password; pipe it with `--password-stdin` in scripts), or Settings > API tokens in the web UI.
3. Smoke test: `node scripts/smoke-booking.mjs --url <APP_URL> --email you@example.com --password-file <file>`
   books one real slot and cancels it.
4. Integrations > Google Calendar > Connect (after the OAuth client exists).

## Local development

```bash
npm ci
npm test                                   # unit + API + concurrency tests
npm run setup:local                        # full local check: owner, event type, booking, cancel (JSON summary)
npm run dev:node                           # Node + SQLite on http://localhost:8787, data in ./data
npm run dev:worker                         # wrangler dev (Workers + local D1) on http://localhost:8788
node bin/slotwise.mjs --url http://localhost:8787 health
```

Both run in the foreground; Ctrl+C stops them. `dev:worker` starts wrangler, which starts a `workerd` child, so a
copy started in the background (for example by an agent) must be stopped as a whole process group, or `workerd`
keeps the port:

```bash
mkdir -p .wrangler
bash -c 'set -m; npm run dev:worker > .wrangler/dev-worker.log 2>&1 & echo $! > .wrangler/dev-worker.pid'   # own process group
curl -s http://localhost:8788/healthz                                       # once the log shows "Ready"
kill -TERM -- "-$(cat .wrangler/dev-worker.pid)" && rm .wrangler/dev-worker.pid   # stops npm, wrangler and workerd
lsof -nP -iTCP:8788 -sTCP:LISTEN || echo "port 8788 free"
```

`dev:node` and `dev:worker` enable signup and the mock calendar. `dev:worker` writes `.dev.vars` with a random
local `ENCRYPTION_KEY` the first time (gitignored) and uses the placeholder database id, which is fine locally.

## Password reset (host operator)

There is no email reset flow yet. Whoever runs the server resets an owner password straight in the database; the
script signs the owner out everywhere and revokes every API token (CLI and agents need a new token afterwards). The
password is read from stdin or a hidden prompt, never from arguments.

```bash
node scripts/admin-reset-password.mjs --email owner@example.com --db /var/lib/slotwise/slotwise.sqlite   # Node
node scripts/admin-reset-password.mjs --email owner@example.com --d1 slotwise --remote                   # Cloudflare
```

On Cloudflare the script runs `wrangler d1 execute` with `--config wrangler.local.toml`, the gitignored config the
deploy script wrote with your real database id (`wrangler.toml` only holds a placeholder id). Run it from the clone
you deploy from; if that file lives elsewhere, pass `--config <file>`. Without either it refuses to run. Auth is the
same as for the deploy (wrangler login, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` for several accounts).

Signed-in owners change their own password and email under Settings > Account, or with `slotwise profile password`
and `slotwise profile email`. A password change revokes all API tokens by default (Settings checkbox
"Also revoke all API tokens", CLI `--keep-tokens` to opt out).

## Rollback

`npx wrangler --config wrangler.local.toml deployments list` and
`npx wrangler --config wrangler.local.toml rollback <version-id>` restore earlier code. D1 has point in time recovery:
`npx wrangler --config wrangler.local.toml d1 time-travel restore slotwise --timestamp <ISO>`.
