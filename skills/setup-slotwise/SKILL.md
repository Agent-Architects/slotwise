---
name: setup-slotwise
description: Set up Slotwise (self-hosted scheduling app) for your user from a fresh clone - interview, local build and check, hosting on Cloudflare or their own Node server, custom domain, Google Calendar OAuth, secrets, first owner, a real test booking, and optional branding. Use when the user asks to set up, install, deploy or host Slotwise, or runs /setup.
---

# Set up Slotwise for your user

You are the user's agent. Drive the whole setup yourself and hand the human only what truly needs a human.
Work phase by phase; each phase lists commands, the expected result, how to verify and how to recover. All
commands run from the repo root.

## Rules (read first, apply throughout)

1. **Secrets never appear in chat, logs, command arguments or tracked files.** Generate them with the commands
   here, keep them in files with mode 600 under `.setup/secrets/` (gitignored), and pass them by file path
   (`*_FILE` variables, `--password-file`, `--password-stdin`). Do not `cat` a secret. If the human must type a
   secret somewhere, tell them which file to open themselves.
2. **Human-only steps**: creating accounts and signing in (Cloudflare, Google, a server provider, Resend), 2FA,
   OAuth consent screens (`npx wrangler login`, Google "Allow"), payment and billing, buying a domain, changing
   nameservers at a registrar, choosing their own owner password. Ask for these one at a time, say exactly what
   to click, and wait.
3. **Use your browser or computer-use tools when you have them** for dashboard work (Cloudflare dashboard, Google
   Cloud console, DNS panels) once the human has signed in. If you have none, give the human the exact click path
   from this file and ask them to report back.
4. **Ask before touching the user's real accounts or calendar** (creating a test booking that lands on their
   calendar, creating a busy event). Clean up what you create.
5. **Keep state in `.setup/state.json`** so you or another agent can resume (format below). Update it at the end
   of every phase. On start, if it exists, read it, tell the user where you are, and continue from `phase`.
6. Never commit `.setup/`, `.deploy/`, `wrangler.local.toml`, `.env*`, `.dev.vars` or `data/`. They are in
   `.gitignore`; keep it that way.
7. Do not edit source code to get setup working. If something fails that this runbook does not cover, stop and
   report the command, the output and what you tried.

### State file

```bash
mkdir -p .setup/secrets && chmod 700 .setup .setup/secrets
```

`.setup/state.json` (create it in phase 0, update as you go):

```json
{
  "version": 2,
  "phase": "0",
  "target": "",
  "completed": [],
  "answers": {
    "targets": ["cloudflare"],
    "domain": "",
    "google": true,
    "email": "none",
    "owner": { "name": "", "email": "", "username": "", "timezone": "" }
  },
  "appUrls": {},
  "notes": []
}
```

`targets` is an ordered list of where it runs: any of `local` (this computer only), `cloudflare` and `node` (their
own server). A common answer is `["local", "cloudflare"]`: try it locally first, then put it online. `target` is the
one you are working on now; `completed` records finished phases per target (`"local:7"`, `"cloudflare:3"`, ...).
`email` is `none` or `resend`. `appUrls` maps each target to its origin once known; in this file `<appUrl>` means
`appUrls[target]`. Put anything a later phase needs (server address, chosen hostnames, which steps the human did)
in `notes`.

### Order of work

Phases 0 to 2 run once. Then, for each entry of `targets` in order: set `target`, run phases 3 to 8 for it (each
phase says what to skip for a target), and when phase 8 is done for that target go back to phase 3 for the next
one. Phase 9 (branding) and the final report run once, after the last target. Resuming: `target` and `completed`
say exactly where you are.

### CLI login file

`slotwise login --save` keeps the URL and API token in the file named by `SLOTWISE_CONFIG` (default
`~/.config/slotwise/config.json`, one per machine, outside the repo). Keep one per target inside the clone instead:
prefix every `node bin/slotwise.mjs` and `node scripts/smoke-booking.mjs` command for a target with
`SLOTWISE_CONFIG=.setup/cli-config.<target>.json` (or `export` it once if your shell keeps state between commands).
The examples below show the prefix as `SLOTWISE_CONFIG=.setup/cli-config.$T.json` with `T=<target>`.

## Phase 0: interview (short, with defaults)

Ask in one message, offering the default in brackets, and accept "defaults" as an answer:

1. Where should it run? [Cloudflare: free, no server to maintain] / their own server (any Linux box with Node) /
   only on this computer for now. More than one is fine, in order, e.g. "on this computer first, then Cloudflare".
2. A custom domain or subdomain, e.g. `book.example.com`? [none: use the free `*.workers.dev` address]. If yes:
   do they own it, and where is its DNS managed?
3. Connect Google Calendar so busy times block slots and bookings land on their calendar? [yes]
4. Send real emails to invitees? [no: confirmations are only logged]. Yes needs a Resend account and a sending
   domain they control.
5. Owner profile: name, email, username for the booking link (`/<username>`), time zone
   [detect: `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"`].

Say branding comes at the end (phase 9). Write the answers to `.setup/state.json`.

## Phase 1: prerequisites

```bash
node --version      # need v22.13.0 or newer
npm --version
git --version       # only needed for updates
```

- Node too old or missing: tell the human to install the current LTS from https://nodejs.org (or their package
  manager); do not install anything globally yourself without asking.
- Self-host: you also need SSH access to the server (`ssh user@host true` succeeds) or the human runs the server
  commands you give them.
- Cloudflare: nothing global; wrangler is a local dev dependency.

Verify: all three print versions. Record in state, `phase: "2"`.

## Phase 2: local install, build and smoke test

```bash
npm ci
npm run typecheck
npm test
npm run --silent setup:local
```

`--silent` keeps npm's own banner out of stdout, so the output is exactly one JSON document. Expected: `npm test`
all green; `npm run --silent setup:local` prints a JSON summary with `"ok": true` and every step `"ok": true`
(owner signup with setup code, CLI login, event type, availability, mock calendar busy block hides a slot, invitee
booking, owner sees it, invitee cancel, slot free again). It uses a throwaway database and stops the server. The
same summary is saved to `.setup/local-result.json`; read that file instead of parsing console output if you prefer.

Recover:
- `npm ci` fails with `EBADENGINE`: Node is older than 22.13 (`.npmrc` sets `engine-strict=true`); see phase 1.
- Port in use: `npm run --silent setup:local -- --port 18787`.
- A step fails: read `error` in the summary and `serverLog` (kept on failure). Re-run once; if it fails the same
  way, stop and report it (do not patch code).

## Phase 3: hosting, database, deploy

Do the part for the current `target`: 3A `cloudflare`, 3B `node`, 3C `local`.

### 3A. Cloudflare (Workers + D1)

1. Validate without an account:
   ```bash
   npm run deploy:cloudflare:dry-run
   ```
   Expected: wrangler lists bindings `env.DB (slotwise)`, `env.ASSETS` and the vars, then
   `[deploy] dry run ok`.
2. Human: create a Cloudflare account at https://dash.cloudflare.com/sign-up and verify the email (free plan).
3. Human consent: run `npx wrangler login` yourself; it prints a URL and opens the browser. Ask the human to sign in
   and click **Allow**. Verify: `npx wrangler whoami` shows their account. (Alternative without a browser on this
   machine: the human creates an API token as in docs/DEPLOY-CLOUDFLARE.md and saves it to
   `.setup/secrets/cf-token`; then prefix deploy commands with `CF_TOKEN_FILE=.setup/secrets/cf-token`.)
4. Show the user the account from `npx wrangler whoami` and confirm it is the one to deploy to. The script refuses
   to touch an account without that confirmation: `--yes` (below) records it. Deploy (add `--domain <host>` now only if the domain's zone is already active on this Cloudflare account;
   otherwise do phase 4 first or add it later):
   ```bash
   npm run deploy:cloudflare -- --yes
   ```
   Expected: `[deploy] D1 database slotwise ready`, migrations applied, `secret ENCRYPTION_KEY will be set`,
   `secret SETUP_CODE will be set`, a health JSON with `"adapter":"d1"`, and the public URL as the last stdout line
   (`https://slotwise.<subdomain>.workers.dev`). Save it as `appUrl` in state.
   The script itself prints `Cloudflare account: <name> (id <id>)` before it changes anything and pins every later
   call to that account.
5. Verify: `curl -s <appUrl>/healthz` returns `"ok":true` and, until the first owner exists,
   `"setupCodeRequired":true` (it turns `false` once signup has closed).

Recover:
- `wrangler is not authenticated`: redo step 3.
- First deploy asks to register a workers.dev subdomain or fails about it: in the dashboard (Workers & Pages >
  your account's subdomain) pick one (browser tool, or ask the human), then re-run.
- Several accounts: set `CLOUDFLARE_ACCOUNT_ID=<id from wrangler whoami>` for the deploy.
- Tests fail inside the deploy: run `npm test` to see why; do not use `SKIP_CHECKS=1` to hide a real failure.
- Re-running is always safe: it reuses the database, keeps secrets, and remembers options in `.deploy/state.json`.

### 3B. Own server (Node + SQLite)

Follow docs/SELF-HOST.md sections 1 to 4 on the server (over SSH if you have it). Human-only: renting the server,
and adding your SSH key if needed. Summary:

```bash
# on the server
node --version      # need v22.13.0 or newer; if missing or older, install Node first (below)
sudo useradd --system --create-home --home-dir /opt/slotwise --shell /usr/sbin/nologin slotwise
sudo -u slotwise git clone <repo-url> /opt/slotwise/app      # <repo-url>: see below
sudo -u slotwise sh -c 'cd /opt/slotwise/app && npm ci && npm run build'
sudo install -d -o slotwise -g slotwise -m 700 /var/lib/slotwise
# write /etc/slotwise/slotwise.env exactly as in docs/SELF-HOST.md section 3 (secrets generated in place)
# install the systemd unit from section 4, then:
sudo systemctl daemon-reload && sudo systemctl enable --now slotwise
curl -s http://127.0.0.1:8787/healthz
```

`<repo-url>`: run `git remote get-url origin` in the user's clone here and use that URL (a private repo needs the
server to have read access, e.g. a deploy key, or use the copy below). No `.git` folder or no remote: copy this
folder instead, without dependencies, build output or local state, then build on the server as above:

```bash
rsync -a --exclude node_modules --exclude .git --exclude .setup --exclude .deploy --exclude .verify --exclude .vitest \
  --exclude .wrangler --exclude /data --exclude /dist --exclude wrangler.local.toml --exclude '.env*' --exclude .dev.vars \
  ./ <user>@<server>:/tmp/slotwise-app/
# on the server
sudo install -d -o slotwise -g slotwise /opt/slotwise/app && sudo cp -a /tmp/slotwise-app/. /opt/slotwise/app/ \
  && sudo chown -R slotwise:slotwise /opt/slotwise/app && rm -rf /tmp/slotwise-app
```

Without `rsync`: `tar` with the same `--exclude` options piped over `ssh`, or `scp -r` of a clean copy. A copied
folder has no git history, so upgrade it the same way (copy again, then `npm ci && npm run build`).

Node missing or older than 22.13 on the server: install a system-wide Node (the systemd unit runs `/usr/bin/node`;
per-user installs such as nvm do not work for the `slotwise` service user). Debian or Ubuntu, from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version      # v22.13.0 or newer
```

Other distributions: https://nodejs.org/en/download (package manager tab). `npm ci` refuses an older Node
(`.npmrc` sets `engine-strict=true`), so a failed `npm ci` with `EBADENGINE` means exactly this.

Expected: health JSON with `"adapter":"sqlite"` and `"setupCodeRequired":true` (until the first owner exists).
Recover: `journalctl -u slotwise -n 50`;
`ENCRYPTION_KEY is required in production` means the env file was not loaded; a port clash means change `PORT`.
`appUrl` is `https://<hostname>` once phase 4 is done. Until then the server listens only on 127.0.0.1, so
`http://<server-ip>:8787` does not answer: check it on the server (`curl` above) or through an SSH tunnel
(`ssh -N -L 8787:127.0.0.1:8787 <user>@<server>`, then `http://localhost:8787` here). Do not set `HOST=0.0.0.0` to
reach it: that serves plain HTTP to the internet, and with `TRUST_PROXY` set any client could fake its address in
`X-Forwarded-For` and get around the rate limits. `TRUST_PROXY` belongs only behind a proxy that sets that header.

### 3C. This computer only (`local`)

A persistent instance on `http://localhost:8787` with its own database in `data/` (gitignored). The setup code and
encryption key come from `.setup/local.env`, which `setup:local` created (mode 600). Create the run settings with
mode 600 too, since the Google secret is appended to it later:

```bash
( umask 077; printf 'APP_URL=http://localhost:8787\nDB_PATH=data/slotwise.sqlite\nHOST=127.0.0.1\nPORT=8787\n' > .setup/local-run.env )
```

`APP_URL` must say `localhost` (Google OAuth accepts `http://localhost` redirect URIs, not `http://127.0.0.1`). The
server's start line prints `127.0.0.1`; always open and give out `http://localhost:8787`, or the sign-in cookie
and the OAuth callback end up on different hosts.

Start it in the background, and keep its process id to stop it later:

```bash
nohup node --env-file=.setup/local.env --env-file=.setup/local-run.env dist/node.mjs > .setup/local-run.log 2>&1 &
echo $! > .setup/local-run.pid
curl -s http://localhost:8787/healthz          # retry for a few seconds; expect "ok":true and "adapter":"sqlite"
```

Stop it: `kill "$(cat .setup/local-run.pid)" && rm .setup/local-run.pid`. Restart (after changing
`.setup/local-run.env`, after `npm run build`): stop, then start again with the same two lines. It does not survive
a reboot or logout; tell the user how to start it again: the two lines above, or in the foreground
`node --env-file=.setup/local.env --env-file=.setup/local-run.env dist/node.mjs` (`npm start` alone does not read
env files).
Recover: `cat .setup/local-run.log`; `EADDRINUSE` means port 8787 is taken (set `PORT` and `APP_URL` to another
port). Set `appUrls.local` to `http://localhost:8787`. Skip phase 4.

## Phase 4: custom domain and DNS (skip if no domain, and for `local`)

One hostname can point at only one target. With two public targets (`cloudflare` and `node`), give the custom domain
to the main one and keep the other on its own address: the free `*.workers.dev` URL for Cloudflare, or a separate
subdomain such as `book2.example.com` for the server. Each target has its own database; bookings are not shared.

### Cloudflare

1. The zone must be on the same Cloudflare account. If it is not: human adds the domain in the dashboard
   (Add a domain, free plan) and changes the nameservers at their registrar to the two Cloudflare shows. Wait
   until the dashboard shows the zone as Active (minutes to hours). Buying a domain is a human step.
2. Deploy with the domain (the script adds the custom domain route only in the gitignored `wrangler.local.toml`):
   ```bash
   bash scripts/deploy-cloudflare.sh --domain book.example.com --yes
   ```
   Cloudflare creates the DNS record and certificate. `APP_URL` becomes `https://book.example.com` and is
   remembered. With a domain the generated config turns off the workers.dev and preview URLs, so the old
   `*.workers.dev` address stops answering: use the domain everywhere (CLI login, Google redirect URI, links).
3. Verify: `curl -s https://book.example.com/healthz` (allow a few minutes for the certificate). Update `appUrl`.

Recover: "zone not found" or route errors mean the zone is not active on this account, or an existing DNS record
for that hostname conflicts (delete the old record in the dashboard, then re-run).

### Own server

1. Human or you (with their DNS panel open in the browser): create `A book.example.com -> <server IPv4>` (and `AAAA`
   for IPv6). Verify: `nslookup book.example.com` returns the server IP.
   If the domain's DNS is on Cloudflare, set the record to **DNS only (grey cloud)**: Caddy then gets its own
   certificate and the settings below are right. Only if the user wants Cloudflare's proxy (orange cloud): set
   SSL/TLS mode **Full (strict)**, use `TRUST_PROXY=cf-connecting-ip` instead of `x-forwarded-for` in step 3, and
   allow ports 80 and 443 only from Cloudflare's IP ranges (https://www.cloudflare.com/ips/), because anyone who
   reaches the server directly could send a fake `CF-Connecting-IP`.
2. Install Caddy on the server (https://caddyserver.com/docs/install) and use the Caddyfile from docs/SELF-HOST.md
   section 5; `sudo systemctl reload caddy`.
3. Make sure `/etc/slotwise/slotwise.env` has `APP_URL=https://book.example.com`, `HOST=127.0.0.1` and
   `TRUST_PROXY=x-forwarded-for` (right only because Caddy sits in front and sets that header), then
   `sudo systemctl restart slotwise`.
4. Verify: `curl -s https://book.example.com/healthz`. Update `appUrl`.

## Phase 5: Google Calendar (skip if `google` is false)

One Google OAuth client can serve every target: add one redirect URI per target in step 6. If an earlier target
already created the client, skip to step 6 and only add the new redirect URI (and, for a public target, the
homepage and policy links in step 3).

Read `GOOGLE_SCOPES` in `src/adapters/google-calendar.ts` and use exactly those scopes (today: `openid`, `email`,
`.../auth/calendar.calendarlist.readonly`, `.../auth/calendar.freebusy`, `.../auth/calendar.events`). Full
reference: docs/GOOGLE-OAUTH-SETUP.md. The human signs in to https://console.cloud.google.com/ (and accepts the
terms on first use); no billing account is needed for the Calendar API. Then, with your browser tool or by
guiding the human:

1. Create a project (name `slotwise` or the product name).
2. APIs & Services > Library > **Google Calendar API** > Enable.
3. Google Auth Platform > Branding > Get started: app name (the product name), user support email (the owner's),
   audience **External** (or Internal for a Workspace-only setup), developer contact email.
   - Only `local` so far: leave the App domain links and Authorized domains empty. An app in **Testing** status
     with the owner added as a test user does not need verification, a homepage or a privacy policy; Google only
     asks for those when you publish the app or submit it for verification. Authorized domains cannot be
     `localhost` anyway, and the `http://localhost:8787/oauth/google/callback` redirect URI does not need one.
   - A public target (`cloudflare`, `node`): the shipped privacy policy and terms are templates with
     `[Operator name]`-style placeholders. Fill them first (the owner's name or company, their contact email, the
     public origin, the hosting and the email setup), then ship the pages:
     ```bash
     npm run --silent legal -- --operator "<owner name or company>" --contact "<owner email>" --site <appUrl> --hosting cloudflare --email none
     ```
     (`--hosting node` for their own server, `--email resend` with Resend.) Expected JSON: `"ok": true` and
     `"missing": []`. Cloudflare: redeploy (`npm run deploy:cloudflare -- --yes`); own server: run the same command
     there as the service user, `sudo -u slotwise sh -c 'cd /opt/slotwise/app && npm run --silent legal -- <same flags>'`
     (the server reads the pages from disk; no restart needed). Save the flags in state `notes`. Ask the user to read
     both pages once; the script fills in facts, it does not give legal advice.
     Then enter the App domain links: homepage `<appUrl>/static/home`, privacy policy `<appUrl>/static/privacy`,
     terms `<appUrl>/static/terms`. Authorized domains: the registrable domain for a custom domain (e.g.
     `example.com`); leave empty for workers.dev. Open those three URLs first and confirm they load and show no
     `[` placeholders.
4. Data access > Add or remove scopes: add the five scopes above. Save.
5. Audience: add the owner's Google account as a Test user. Explain the trade-off and let the user choose:
   Testing mode disconnects the calendar every 7 days; **Publish app** keeps it connected and shows an
   "unverified app" warning on connect that the owner clicks through (fine for personal use, under 100 users).
6. Clients > Create client > **Web application**, name `<product> web`, Authorized redirect URI exactly
   `<appUrl>/oauth/google/callback` (add `http://localhost:8787/oauth/google/callback` too if they will develop
   locally). Create, then **Download JSON** into `.setup/secrets/google-client.json` (or ask the human to save it
   there). Extract without printing the secret:
   ```bash
   chmod 600 .setup/secrets/google-client.json
   node -e 'const fs=require("fs");const w=JSON.parse(fs.readFileSync(".setup/secrets/google-client.json","utf8")).web;fs.writeFileSync(".setup/secrets/google-client-secret",w.client_secret,{mode:0o600});console.log(w.client_id)'
   ```
   The printed client id is not secret; save it in state notes.
7. Give them to Slotwise:
   - Cloudflare: `GOOGLE_CLIENT_ID=<client id> GOOGLE_CLIENT_SECRET_FILE=.setup/secrets/google-client-secret npm run deploy:cloudflare -- --yes`
   - Own server: copy the secret file to the server (`scp`), then append without echoing:
     `sudo sh -c 'printf "GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n" "<client id>" "$(cat /tmp/google-client-secret)" >> /etc/slotwise/slotwise.env' && rm /tmp/google-client-secret && sudo systemctl restart slotwise`
   - Local: append both lines to `.setup/local-run.env` (mode 600) without echoing the secret, then restart (3C):
     `node -e 'const fs=require("fs");fs.appendFileSync(".setup/local-run.env","GOOGLE_CLIENT_ID="+process.argv[1]+"\nGOOGLE_CLIENT_SECRET="+fs.readFileSync(".setup/secrets/google-client-secret","utf8").trim()+"\n")' "<client id>"`
8. Verify: `curl -s <appUrl>/healthz` shows `{"id":"google","configured":true}`.

Recover: see the troubleshooting table in docs/GOOGLE-OAUTH-SETUP.md (`redirect_uri_mismatch` is almost always a
scheme, host or trailing slash difference).

### Email (only if `email` is `resend`)

Human: create a Resend account, add and verify their sending domain (DNS records Resend shows; you can add them
in the DNS panel with the browser tool), create an API key and save it to `.setup/secrets/resend-key`. Then:
- Cloudflare: `RESEND_API_KEY_FILE=.setup/secrets/resend-key EMAIL_FROM="Bookings <bookings@their-domain>" npm run deploy:cloudflare -- --yes`
- Own server: add `EMAIL_PROVIDER=resend`, `EMAIL_FROM=...` and `RESEND_API_KEY` (printf pattern above), restart.
- Local: append the three lines to `.setup/local-run.env` without echoing the key, then restart (3C):
  `node -e 'const fs=require("fs");fs.appendFileSync(".setup/local-run.env","EMAIL_PROVIDER=resend\nEMAIL_FROM="+process.argv[1]+"\nRESEND_API_KEY="+fs.readFileSync(".setup/secrets/resend-key","utf8").trim()+"\n")' "Bookings <bookings@their-domain>"`
Verify: `/healthz` shows `"emailProvider":"resend"`.

## Phase 6: secrets (reference; already handled above)

| Secret | Created by | Lives in | Never |
|---|---|---|---|
| `ENCRYPTION_KEY` (32 random bytes, base64) | deploy script (Cloudflare), env-file snippet (server), `setup:local` (local) | Worker secret / `/etc/slotwise/slotwise.env` / `.setup/local.env` | rotate it on a live instance (calendar tokens become unreadable) |
| `SETUP_CODE` | same | Worker secret + `.deploy/setup-code` / env file / `.setup/local.env` | reuse it after the first owner exists |
| Google client secret | Google console | `.setup/secrets/google-client-secret`, then Worker secret or env file | paste in chat |
| Resend API key | Resend | `.setup/secrets/resend-key`, then Worker secret or env file | paste in chat |
| Cloudflare API token (optional) | Cloudflare dashboard | `.setup/secrets/cf-token` | commit |
| Owner password | the human | only their head / password manager | ask for it in chat |
| CLI API token | `slotwise login --save` | `.setup/cli-config.<target>.json` via `SLOTWISE_CONFIG` (mode 600) | print it |

Generate a random value without printing it:
`node -e 'require("fs").writeFileSync(process.argv[1], require("crypto").randomBytes(32).toString("base64"), {mode: 0o600})' .setup/secrets/<name>`.
Before finishing, check nothing secret can be committed (only in a git checkout; a downloaded archive has no
`.git` and nothing to check):

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git status --short --untracked-files=all | grep -E '(^|/)(\.setup/|\.deploy/|wrangler\.local\.toml|\.env|\.dev\.vars|data/)' && echo "STOP: secret files visible to git" || echo "ok"
else
  echo "not a git checkout: skip"
fi
```

## Phase 7: first owner account

1. Where the setup code is: Cloudflare `.deploy/setup-code`; own server `sudo grep ^SETUP_CODE= /etc/slotwise/slotwise.env`;
   local `.setup/local.env` (the `SETUP_CODE=` line). Ask the human to open that file themselves (or, with a browser tool, fill only the
   setup code field for them).
2. Human: open `<appUrl>/signup`, enter the setup code, their name, email, username, time zone and **their own
   password** (at least 10 characters). Signup then closes for everyone else.
3. CLI login on this machine, saved per target. Your shell has no terminal, so the hidden password prompt cannot
   work there (the CLI answers `no terminal: use --password-stdin`). Pick one, in this order of preference:
   - **Preferred: the human runs the login in their own terminal**, in the repo folder, and types the password at
     the hidden prompt:
     ```bash
     SLOTWISE_CONFIG=.setup/cli-config.<target>.json node bin/slotwise.mjs --url <appUrl> login --email <owner email> --save
     ```
   - **Otherwise: a password file the human writes.** Ask them to create `.setup/secrets/owner-password` (one line,
     the password) in their own editor or terminal and `chmod 600` it. Then you run, and delete the file right after:
     ```bash
     SLOTWISE_CONFIG=.setup/cli-config.$T.json node bin/slotwise.mjs --url <appUrl> login --email <owner email> --save --password-stdin < .setup/secrets/owner-password
     rm -f .setup/secrets/owner-password
     ```
   Never ask for the password in chat. (Creating the owner yourself through the API with a generated password is
   acceptable only as a last resort, and then the human must change it right away in their own terminal:
   `SLOTWISE_CONFIG=.setup/cli-config.$T.json node bin/slotwise.mjs profile password --keep-tokens`, which prompts for
   the current and the new password; the generated one must not stay in use.)
   Then check:
   ```bash
   SLOTWISE_CONFIG=.setup/cli-config.$T.json node bin/slotwise.mjs whoami
   SLOTWISE_CONFIG=.setup/cli-config.$T.json node bin/slotwise.mjs links
   ```
   Expected: `login` reports `"saved": ".setup/cli-config.<target>.json"`; `whoami` shows their user; `links` shows
   their booking page URL.
4. Set their real availability and event types with them (ask). Signup already created a `30min` event type
   (30 minutes, Google Meet), so adjust that one and create others with new slugs, for example:
   ```bash
   SLOTWISE_CONFIG=.setup/cli-config.$T.json node bin/slotwise.mjs availability set --timezone <their time zone> --mon 09:00-17:00 --tue 09:00-17:00 --wed 09:00-17:00 --thu 09:00-17:00 --fri 09:00-17:00
   SLOTWISE_CONFIG=.setup/cli-config.$T.json node bin/slotwise.mjs event-types update 30min --name "30 minute meeting" --duration 30
   SLOTWISE_CONFIG=.setup/cli-config.$T.json node bin/slotwise.mjs event-types create --name "60 minute meeting" --slug 60min --duration 60
   ```
   Location: a Google Meet link is only created when Google Calendar is connected. Without Google, set another
   location on `30min`, e.g. `--location phone` or `--location "custom:Video link sent by email"`. Event types
   created without `--location` get Google Meet only while a calendar is connected.
   `node bin/slotwise.mjs help` lists every command; docs/API.md is the HTTP reference.

## Phase 8: real test booking, then calendar check (ask first)

1. Booking create and cancel on their instance (temporary event type, cleaned up afterwards; confirmation emails,
   if enabled, go to the owner's own address):
   ```bash
   SLOTWISE_CONFIG=.setup/cli-config.$T.json node scripts/smoke-booking.mjs --url <appUrl>
   ```
   Expected: JSON with `"ok": true`; steps health, whoami, temporary event type, slots, book, owner sees booking,
   slot no longer offered, owner cancel, cleanup.
2. Google (if enabled): the human opens `<appUrl>/app/integrations` signed in at `appUrl`, clicks **Connect** on
   Google Calendar, signs in and clicks **Allow** (in an unpublished or unverified app: Advanced > Go to app).
   Then picks the calendars to check and the calendar for new bookings. Verify: `node bin/slotwise.mjs integrations list`
   shows the connection (with the same `SLOTWISE_CONFIG` prefix).
3. With the user's consent, create a busy event in that Google Calendar inside their availability (for example
   tomorrow 10:00 to 11:00 in their time zone; you can do it with the browser tool), then:
   ```bash
   SLOTWISE_CONFIG=.setup/cli-config.$T.json node scripts/smoke-booking.mjs --url <appUrl> --busy-start <ISO start> --busy-end <ISO end>
   ```
   (the event's real start and end in ISO UTC, e.g. `2030-01-15T09:00:00Z`). Expected: step `busy window hidden` passes, and
   `owner sees booking` reports `calendarEvent: written` (the test booking appeared on the calendar and the cancel
   removed it). Delete the test busy event afterwards.

Recover: `busy window hidden` fails means the calendar is not connected or not checked (Integrations page), or the
times are wrong. `calendar_unavailable` means the token is broken: reconnect.

Target done: add `"<target>:8"` to `completed`. If `targets` has another entry, set `target` to it and go back to
phase 3. Otherwise continue with phase 9.

## Phase 9: branding (offer it)

Ask: "Do you want your own name, colors, logo or theme? You can also point me at a website whose look I should
copy." Defaults stay neutral Slotwise.

- From their answers: product name, primary color, accent color, theme (`light`, `dark`, `auto`), logo file
  (SVG or PNG, saved under `.setup/brand/`), optional CSS font stack.
- From a reference site: open it with your browser tool and read the computed styles of the main call-to-action
  button (background color = primary), links or highlights (accent), `body` font-family and background (dark or
  light theme), and the logo (header `img`/`svg`, or `link[rel~=icon]`). Download an `img` or icon logo into
  `.setup/brand/`. An inline `<svg>` is not a file yet: save `new XMLSerializer().serializeToString(svgElement)` (it
  adds the `xmlns` attribute a standalone `.svg` needs; `outerHTML` often lacks it) and check the saved file opens
  on its own. The brand script has no page background option: backgrounds come from the theme (light or dark) with a
  light tint of the primary color on booking pages, so tell the user if the reference site uses another background.
  Confirm the extracted values with the user before applying; only copy a logo the user has the right to use.

```bash
npm run brand -- --name "Acme Bookings" --primary "#1d4ed8" --accent "#f97316" --theme auto --logo .setup/brand/logo.svg --dry-run
npm run brand -- --name "Acme Bookings" --primary "#1d4ed8" --accent "#f97316" --theme auto --logo .setup/brand/logo.svg
npm run build && npm test
```

Then ship it to every target:
- Cloudflare: `npm run deploy:cloudflare -- --yes`.
- Own server: copy the logo over first (skip this if they kept the default logo; a `.png` works the same way), then
  run the same command there as the service user with the copied logo:
  ```bash
  scp .setup/brand/logo.svg <user>@<server>:/tmp/brand-logo.svg
  # on the server
  sudo install -o slotwise -g slotwise -m 644 /tmp/brand-logo.svg /opt/slotwise/brand-logo.svg && rm /tmp/brand-logo.svg
  sudo -u slotwise sh -c 'cd /opt/slotwise/app && npm run brand -- <same flags> --logo /opt/slotwise/brand-logo.svg && npm run build'
  sudo systemctl restart slotwise
  ```
  The brand and the filled-in legal pages are local changes in that clone. The upgrade line in docs/SELF-HOST.md
  keeps them (`git pull --autostash`, then `npm run brand -- --apply` rebuilds the brand from `brand.json`).
- Local: restart it (phase 3C).

Then, per target, give the signup-created `30min` event type the new primary color (event types keep the color they
were created with; only signups on the new build start with it). Use the same value as `--primary`, and skip it if
they deleted `30min` or picked its color themselves:

```bash
SLOTWISE_CONFIG=.setup/cli-config.$T.json node bin/slotwise.mjs event-types update 30min --color "#1d4ed8"
```

If the name changed, update the app name in the Google consent screen (Branding) too. Verify: open `<appUrl>` and
`<appUrl>/<username>` and check name, colors and logo (screenshot with the browser tool if you have one).
`npm run brand` with no flags prints the current brand.

## Done: report to the user

Tell them, per target: the booking page link (`node bin/slotwise.mjs links` with that target's `SLOTWISE_CONFIG`),
the admin URL (`<appUrl>/app`), where each secret lives (phase 6 table, file paths only), how to manage it from the
CLI (`SLOTWISE_CONFIG=.setup/cli-config.<target>.json`), how to redeploy (`npm run deploy:cloudflare -- --yes` or
the upgrade line in docs/SELF-HOST.md) or, for `local`, how to start and stop it (phase 3C), backups (Cloudflare D1
time travel, or the SQLite backup in docs/SELF-HOST.md), and anything left for them to do. Set `phase` to `"done"`
in `.setup/state.json`.
