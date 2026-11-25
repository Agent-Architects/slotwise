# Hosting Slotwise

Slotwise is one app with thin hosting adapters. Two are shipped and tested:

| Target | Adapter | Storage | Guide | Status |
|---|---|---|---|---|
| Cloudflare Workers | `src/worker.ts` + `src/adapters/d1.ts` | D1 | docs/DEPLOY-CLOUDFLARE.md | Reference path. Tested locally up to `wrangler deploy --dry-run`; a real deploy needs your account. |
| Node 22.13+ (any server) | `src/node.ts` + `src/adapters/sqlite-node.ts` | `node:sqlite` file | docs/SELF-HOST.md | Tested end to end (`npm run setup:local`, `scripts/smoke-booking.mjs`). |

## The adapter layer

```
src/core/        domain logic (Service), ports (Db, CalendarProvider, Mailer), validation, time and slot math
src/http/app.ts  createApp(options): the Hono app with every route; hosting-neutral
src/config.ts    buildDeps(env, db, origin): turns the environment into Service dependencies (shared by adapters)
src/worker.ts    Cloudflare entry: D1 + ASSETS binding + cf-connecting-ip
src/node.ts      Node entry: node:sqlite + ./public files + socket IP or TRUST_PROXY header
src/adapters/    d1.ts, sqlite-node.ts (Db); google-calendar.ts, mock-calendar.ts (CalendarProvider); mailers.ts (Mailer)
migrations/      plain SQL, applied in file-name order, additive only (shared by both Db adapters)
```

A hosting adapter is a small entry file that calls `createApp({ adapter, clientIp, deps, assets })` from
`src/http/app.ts` and exposes its `fetch` handler. It must provide:

1. **A `Db` port** (`src/core/ports.ts`): `all`, `first`, `run` with positional `?` parameters, and `batch` that runs
   its statements in one transaction. SQLite semantics are assumed (the SQL in `src/core/service.ts` is SQLite).
   Apply `migrations/*.sql` once each, in order, before serving (Node does it at start in
   `SqliteDb.migrate`; Cloudflare with `wrangler d1 migrations apply`).
2. **Assets**: an `assets(c)` function for every non-API GET. Serve files from `public/` as is; serve
   `public/static/home.html` for `/` and for `/static/home` (likewise `/static/privacy` and `/static/terms`); serve
   `public/index.html` (the single-page app shell) for any other path without a file. Build `public/assets/app.js`
   first with `npm run build:web`.
3. **Client IP**: a `clientIp(c)` function used for rate limits. Return only an address a proxy you control sets
   (see `nodeClientIp` and `cloudflareClientIp` in `src/http/app.ts`); never trust client-sent headers by default.
4. **Environment**: an object with the variables in `AppEnv` (`src/config.ts`), passed to
   `buildDeps(env, db, requestOrigin)` per request. `ENCRYPTION_KEY` is required; everything else is optional
   (see the configuration reference in README.md).
5. **Health**: nothing extra; `GET /healthz` comes from `createApp` and checks the database.

Calendar and email providers are adapters too: implement `CalendarProvider` or `Mailer` from `src/core/ports.ts`
and register it in `buildDeps`.

## Other targets (should work, not tested)

These run the Node adapter unchanged. They are listed so you know what to expect; none was tested by the
maintainers. The contract is the same everywhere: Node 22.13+, `npm ci && npm run build`, start with
`node dist/node.mjs`, set `NODE_ENV=production`, `ENCRYPTION_KEY`, `SETUP_CODE`, `APP_URL`, `HOST=0.0.0.0`,
`PORT` (the platform's), `DB_PATH` on a persistent volume, and `TRUST_PROXY` for the platform's proxy header
(usually `x-forwarded-for`). Health check path: `/healthz`. The server then logs a warning at start because
`TRUST_PROXY` is set while it listens on all addresses; that is fine only when the platform's router is the sole
way in (no public port straight to the app). Anywhere clients can reach Node directly, unset `TRUST_PROXY`.

| Target | Notes |
|---|---|
| Any VPS (DigitalOcean, Hetzner, Linode, a home server) | Follow docs/SELF-HOST.md exactly. |
| Fly.io | Node app with a Fly volume mounted for `DB_PATH` (for example `/data/slotwise.sqlite`); run one machine only, SQLite is single-writer. Secrets with `fly secrets set`. |
| Railway / Render | Build `npm ci && npm run build`, start `node dist/node.mjs`, attach a persistent disk for `DB_PATH`. Without a persistent disk every deploy starts empty. Keep one instance. |
| Docker / Podman | No Dockerfile ships in this repo. A contributor image would be: `node:22-slim` (or newer), `npm ci && npm run build`, run as a non-root user, a volume for `DB_PATH`, `EXPOSE` the port, health check on `/healthz`. Untested. |

Do not scale the Node adapter to several instances on one SQLite file; for multiple regions use Cloudflare.
