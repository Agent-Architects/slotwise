# AGENTS.md

Instructions for any coding agent (Claude Code, Codex, Cursor, Aider, or anything else) working in this repo.

## To set this up for your user

Follow `skills/setup-slotwise/SKILL.md` from top to bottom. It interviews the user, builds and checks Slotwise
locally, deploys it (Cloudflare Workers + D1, or their own Node server), wires up a domain, Google Calendar and
email, creates the first owner, runs a real test booking, and offers branding. It says exactly which steps need
the human (account sign-ups, logins, consent screens, payment) and keeps resumable state in `.setup/`.
Shortcuts: Claude Code `/setup`; Codex and other agents that load `.agents/skills/` see a `setup-slotwise` skill.

## What this repo is

Slotwise is a self-hostable scheduling app (booking pages, availability, Google Calendar sync, email
notifications) with one versioned JSON API (`/api/v1`), a web UI and a JSON CLI. MIT licensed.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install (Node 22.13+; no global tools needed) |
| `npm run build` | Web bundle (`public/assets/app.js`), Node server (`dist/node.mjs`), CLI (`dist/cli.mjs`) |
| `npm run typecheck` / `npm test` | TypeScript check / Vitest suite (unit + API) |
| `npm run --silent setup:local` | End-to-end local check on a throwaway database; prints a JSON summary, also saved to `.setup/local-result.json` (`--keep` leaves it running, `--stop` stops it) |
| `node scripts/smoke-booking.mjs --url <APP_URL>` | Book and cancel one slot on any running instance |
| `npm run dev:node` / `npm run dev:worker` | Local dev server (Node + SQLite on 8787 / wrangler dev on 8788), signup open, mock calendar |
| `npm run deploy:cloudflare` | Deploy to Cloudflare (`--dry-run` needs no account; `--domain <host>` for a custom domain) |
| `npm run brand -- --name ... [--primary #hex] [--accent #hex] [--logo file] [--theme light\|dark\|auto] [--font ...]` | Apply your own brand (then `npm run build`) |
| `npm run --silent legal -- --operator ... --contact ... --site ... --hosting ... --email ...` | Fill the operator details in the privacy policy and terms pages |
| `npm run check-clean` | Scan the repo for leaked personal data or secrets |
| `npm run verify` | Browser + CLI + API end-to-end verification (`skills/verify-slotwise/SKILL.md`). One-time browser install first: `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium-headless-shell` (into `node_modules`, nothing global) |
| `node bin/slotwise.mjs help` | CLI reference (JSON output) |

## Layout

```
src/core/       domain logic, ports (Db, CalendarProvider, Mailer), validation, slot math
src/http/app.ts every HTTP route (hosting-neutral)
src/config.ts   environment -> dependencies (shared by both hosts)
src/worker.ts   Cloudflare Workers entry      src/node.ts  Node entry
src/adapters/   D1, node:sqlite, Google Calendar, mock calendar, mailers
src/cli/        CLI source (bin/slotwise.mjs builds and runs it)
web/            Preact web UI                 public/      static files, HTML shells, CSS, logo
migrations/     SQL, additive only            test/        Vitest suites
scripts/        deploy, setup, smoke, brand, legal pages, check-clean, admin password reset
skills/         setup-slotwise (setup runbook), verify-slotwise (end-to-end verification)
docs/           API, MODEL, HOSTING, SELF-HOST, DEPLOY-CLOUDFLARE, GOOGLE-OAUTH-SETUP
```

## Rules

- Secrets never go in chat, command arguments, logs or tracked files. Use the file-based handoff in the setup
  skill (`.setup/secrets/`, `*_FILE` variables, `--password-stdin`).
- Never commit `.setup/`, `.deploy/`, `wrangler.local.toml`, `.env*`, `.dev.vars`, `data/` (all gitignored).
  `wrangler.toml` stays generic: the real D1 id and domain go only into `wrangler.local.toml`.
- Never rotate `ENCRYPTION_KEY` on a live instance; it would make stored calendar tokens unreadable.
- Migrations are additive only (new tables or columns), applied in file-name order by both hosts.
- The web UI and CLI only use the public `/api/v1`; keep `docs/API.md` in sync with `src/http/app.ts`.
- Before calling a change done: `npm run typecheck`, `npm test`, and `npm run setup:local` pass; for UI or flow
  changes also `npm run verify`.
- No em dashes or emojis in docs and UI copy.
