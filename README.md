# Slotwise

Slotwise is a self-hostable scheduling app: you publish booking pages, invitees pick a free time, and the booking
lands on your calendar. It runs on Cloudflare Workers + D1 (free plan is enough) or on any server with Node and
SQLite. Everything goes through one versioned JSON API, which the web UI and a JSON CLI both use, so agents and
scripts can do anything the UI can.

## Features

- Booking pages per owner (`/<username>`) and per event type (`/<username>/<slug>`), in the invitee's time zone.
- Event types with one or more durations, slot interval, buffers, minimum notice, booking window, daily limit,
  custom questions, location (Google Meet, Zoom, phone, in person, custom), and color.
- Weekly availability, date overrides, and several named schedules.
- Google Calendar: busy times on the calendars you choose hide slots; bookings are written to the calendar you
  choose (with a Meet link if wanted) and moved or removed on reschedule and cancel. Minimal scopes; tokens are
  encrypted at rest.
- Invitees cancel or reschedule from a private manage link; owners cancel, reschedule or request a reschedule.
- No double booking, even under concurrent requests. Rate limits per client address.
- Email notifications through Resend, or a log outbox when no provider is set.
- Owner API tokens with read/write scopes, CSV export, and a CLI with JSON output for every action.
- Your own brand: name, colors, logo, theme and font from one command.

## Quick start (local, about two minutes)

Needs Node 22.13 or newer.

```bash
git clone https://github.com/Agent-Architects/slotwise.git slotwise && cd slotwise
npm ci
npm run --silent setup:local # builds, starts a throwaway server, creates an owner, books and cancels; prints JSON
npm run dev:node            # then try it yourself: http://localhost:8787 (signup open, mock calendar)
```

## Set it up with your agent

Clone the repo, open it in your coding agent, and ask it to set Slotwise up:

- **Claude Code**: run `/setup`.
- **Codex** and other agents: say "Set up Slotwise for me by following AGENTS.md". The instructions live in
  `AGENTS.md` and the full runbook in `skills/setup-slotwise/SKILL.md`, which any agent (or a human) can follow.

The agent asks where to host it, whether you want a domain, Google Calendar and email, then does the work:
local build and check, deploy, DNS, Google Cloud OAuth setup, first owner, a real test booking, and optional
branding (including copying the look of a site you point it at). You only do what needs a human: sign up and
sign in to accounts, approve consent screens, pay for anything you choose to buy. Secrets stay in files on
your machine and never go through the chat.

## Hosting options

| Option | Cost | You maintain | Guide |
|---|---|---|---|
| Cloudflare Workers + D1 | Free plan is enough | Nothing (serverless) | [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md) |
| Your own server (Node + SQLite, Caddy for HTTPS) | Any small VPS or home server | OS updates, backups | [docs/SELF-HOST.md](docs/SELF-HOST.md) |
| This computer only | Free | Nothing | `npm run dev:node`, or the local mode in the setup skill |
| Fly.io, Railway, Render, Docker | Varies | Varies | Should work with the Node adapter, not tested: [docs/HOSTING.md](docs/HOSTING.md) |

docs/HOSTING.md also explains the adapter layer, if you want to add another host.

## Configuration reference

Cloudflare: set by `scripts/deploy-cloudflare.sh` (secrets) and `wrangler.toml` `[vars]`. Node: environment
variables (for example an env file loaded by systemd or `node --env-file`).

| Variable | Default | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | required (Node dev creates a key file next to the database) | 32 random bytes, base64. Encrypts calendar tokens. Never rotate on a live instance. |
| `SETUP_CODE` | unset | Code required to create the first owner account. Set it before the server is reachable. |
| `APP_URL` | request origin | Public origin used in emails, booking links and OAuth redirects |
| `APP_NAME` | name in `brand.json` | Product name in emails and calendar events |
| `ALLOW_SIGNUP` | `false` | `true` lets more owners sign up after the first |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset | Enable Google Calendar ([docs/GOOGLE-OAUTH-SETUP.md](docs/GOOGLE-OAUTH-SETUP.md)) |
| `EMAIL_PROVIDER` | `log` | `resend` to send real email |
| `EMAIL_FROM`, `RESEND_API_KEY` | unset | Sender and key for Resend |
| `LOG_EMAILS` | `true` | `false` silences the log outbox |
| `MOCK_CALENDAR` | `false` | `true` adds a fake calendar provider for development and tests. Never in production. |
| `RATE_LIMIT_PUBLIC_READ`, `RATE_LIMIT_PUBLIC_WRITE`, `RATE_LIMIT_AUTH` | 240, 20, 10 per minute | Per-client-address limits (`0` disables) |
| `GUEST_EMAILS_PER_HOUR` | 20 | Cap on emails to invitee-added guests |
| Node only: `PORT`, `HOST` | `8787`, `127.0.0.1` | Listen address |
| Node only: `DB_PATH` | `data/slotwise.sqlite` | SQLite file (keep it on persistent storage) |
| Node only: `NODE_ENV` | unset | `production` makes `ENCRYPTION_KEY` mandatory |
| Node only: `TRUST_PROXY` | unset | Header your reverse proxy sets with the client address (`x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`) |

## Branding

```bash
npm run brand                                                    # print the current brand
npm run brand -- --name "Acme Bookings" --primary "#1d4ed8" --accent "#f97316" --theme auto --logo ./logo.svg
npm run build                                                    # then redeploy
```

`brand.json` is the source of truth; the command updates the CSS variables, logo, HTML shells and static pages.
`--dry-run` shows what would change. The default is the neutral Slotwise look.

## CLI

```bash
node bin/slotwise.mjs --url https://book.example.com login --email you@example.com --save   # hidden password prompt
node bin/slotwise.mjs event-types create --name "Intro call" --duration 30
node bin/slotwise.mjs availability set --timezone Europe/Berlin --mon 09:00-17:00 --tue 09:00-17:00
node bin/slotwise.mjs bookings list --status upcoming
node bin/slotwise.mjs help
```

Every command prints JSON. Errors are JSON on stderr with exit code 1 (API) or 2 (usage).

`login --save` stores the URL and API token (mode 600) in `~/.config/slotwise/config.json`, one per machine. Set
`SLOTWISE_CONFIG` to keep it elsewhere, for example one file per instance inside the clone:
`export SLOTWISE_CONFIG=.setup/cli-config.json` (`.setup/` is gitignored). `--url`/`--token` and
`SLOTWISE_URL`/`SLOTWISE_TOKEN` override the saved values.

## API

The HTTP API is documented in [docs/API.md](docs/API.md); the domain model in [docs/MODEL.md](docs/MODEL.md).
Owners authenticate with a session cookie (web UI) or a Bearer API token (`sw_...`).

## Security notes

- Signup is closed after the first owner unless `ALLOW_SIGNUP=true`; protect a fresh instance with `SETUP_CODE`.
- Passwords are hashed; calendar OAuth tokens are encrypted with AES-256-GCM using `ENCRYPTION_KEY`.
- Cookie sessions need a CSRF token for writes; API tokens are scoped `read` or `write` and revocable.
- Public endpoints are rate limited per client address. On Node, set `TRUST_PROXY` only to a header your own proxy
  sets; otherwise client-sent headers are ignored.
- Serve it over HTTPS (Cloudflare does this; on a server use Caddy or another TLS proxy setting `X-Forwarded-Proto`).
- Never commit `.setup/`, `.deploy/`, `wrangler.local.toml` or env files; they hold account-specific values.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Development

```bash
npm run typecheck && npm test     # TypeScript + Vitest
npm run setup:local               # end-to-end local check
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium-headless-shell   # once: browser for verify, into node_modules
npm run verify                    # browser + CLI + API verification (skills/verify-slotwise/SKILL.md)
```

See [AGENTS.md](AGENTS.md) for the layout and repo rules.

## License

MIT. See [LICENSE](LICENSE).
