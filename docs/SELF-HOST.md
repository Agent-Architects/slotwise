# Self-hosting Slotwise on Node + SQLite

The Node adapter (`src/node.ts`) runs the same app as the Cloudflare Worker on any machine with Node 22.13 or newer.
Storage is the built-in `node:sqlite` (one file, no database server), and the web UI is served from `./public` by
the same process. Put a TLS reverse proxy in front of it. This guide uses Caddy (automatic HTTPS) and systemd,
but any proxy and process supervisor work.

What was tested: the production Node path below (`npm run build && npm start` with `NODE_ENV=production`,
`ENCRYPTION_KEY`, `SETUP_CODE`, `DB_PATH`, `TRUST_PROXY`), first-owner signup with the setup code, and a booking
create and cancel through the CLI (`npm run setup:local` and `scripts/smoke-booking.mjs`). The systemd unit and
Caddyfile below are standard examples and were not run on a real server.

## 1. Server and DNS

- Any Linux VPS or home server (1 vCPU, 512 MB RAM is plenty), Node 22.13+ installed system-wide (check with
  `node --version`). If it is missing or older, on Debian or Ubuntu install it from NodeSource:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
  Other systems: https://nodejs.org/en/download. `npm ci` stops with `EBADENGINE` on an older Node (the repo's
  `.npmrc` sets `engine-strict=true`).
- A DNS record for your booking hostname pointing at the server: `A book.example.com -> <server IPv4>` (and
  `AAAA` for IPv6). Ports 80 and 443 open to the internet for Caddy; keep the Node port closed (it listens on
  127.0.0.1).

## 2. Install and build

```bash
sudo useradd --system --create-home --home-dir /opt/slotwise --shell /usr/sbin/nologin slotwise
# <repo-url>: `git remote get-url origin` in your own clone (see below if there is none)
sudo -u slotwise git clone <repo-url> /opt/slotwise/app
# Build as the service user, inside its own home (web bundle, dist/node.mjs, dist/cli.mjs):
sudo -u slotwise sh -c 'cd /opt/slotwise/app && npm ci && npm run build'
sudo install -d -o slotwise -g slotwise -m 700 /var/lib/slotwise
```

No git remote (for example a downloaded copy): copy the folder from your machine instead, leaving out dependencies,
build output and local state, then run the build line above:

```bash
rsync -a --exclude node_modules --exclude .git --exclude .setup --exclude .deploy --exclude .verify --exclude .vitest \
  --exclude .wrangler --exclude /data --exclude /dist --exclude wrangler.local.toml --exclude '.env*' --exclude .dev.vars \
  ./ <user>@<server>:/tmp/slotwise-app/
# on the server
sudo install -d -o slotwise -g slotwise /opt/slotwise/app && sudo cp -a /tmp/slotwise-app/. /opt/slotwise/app/ \
  && sudo chown -R slotwise:slotwise /opt/slotwise/app && rm -rf /tmp/slotwise-app
```

A copied folder has no git history: upgrade it by copying again instead of `git pull` (the upgrade line below).

Run every later command that changes `/opt/slotwise/app` the same way (`sudo -u slotwise sh -c 'cd /opt/slotwise/app && ...'`),
so the files stay owned by `slotwise` and nothing runs with your admin user's npm cache or environment.

## 3. Environment file (secrets never echoed)

```bash
sudo install -d -m 750 -o root -g slotwise /etc/slotwise
sudo sh -c 'umask 077; {
  echo NODE_ENV=production
  echo "ENCRYPTION_KEY=$(node -e "process.stdout.write(require(\"crypto\").randomBytes(32).toString(\"base64\"))")"
  echo "SETUP_CODE=$(node -e "process.stdout.write(require(\"crypto\").randomBytes(9).toString(\"base64url\"))")"
  echo APP_URL=https://book.example.com
  echo DB_PATH=/var/lib/slotwise/slotwise.sqlite
  echo HOST=127.0.0.1
  echo PORT=8787
  echo TRUST_PROXY=x-forwarded-for
} > /etc/slotwise/slotwise.env'
sudo chown root:slotwise /etc/slotwise/slotwise.env && sudo chmod 640 /etc/slotwise/slotwise.env
```

`NODE_ENV=production` also makes the server answer 404 for source maps (`*.map`), so the original web UI source is
not published.

Read the setup code once when you create the owner: `sudo grep ^SETUP_CODE= /etc/slotwise/slotwise.env`.
Back up `ENCRYPTION_KEY` somewhere safe: losing or changing it makes stored calendar connections unreadable
(owners then reconnect their calendars; bookings are not affected).

Add optional settings to the same file (see the configuration reference in README.md): `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `EMAIL_PROVIDER=resend`, `EMAIL_FROM`, `RESEND_API_KEY`, `APP_NAME`, `RATE_LIMIT_*`.

### TRUST_PROXY

Rate limits are per client IP. Set `TRUST_PROXY` to the header your proxy sets with the real client address:

| Setup | TRUST_PROXY |
|---|---|
| Caddy or nginx directly in front | `x-forwarded-for` (Slotwise uses the last entry, the one your proxy appended) |
| nginx with `proxy_set_header X-Real-IP $remote_addr` | `x-real-ip` |
| Cloudflare proxy (orange cloud) in front of your server | `cf-connecting-ip` |
| Node faces clients directly (no proxy) | leave unset; client-sent headers are ignored |

Set `TRUST_PROXY` only when a proxy in front overwrites or appends that header and clients cannot reach the Node port
directly. If Node is exposed directly with `TRUST_PROXY` set, any client can send its own `X-Forwarded-For` and
dodge the rate limits; unset it in that case. The server logs a warning at start when `TRUST_PROXY` is set and
`HOST` is not a loopback address.

The proxy must also set `X-Forwarded-Proto: https` (Caddy and most proxies do) so session cookies are `Secure`.

## 4. Run it

Plain, in the foreground (good for a first check):

```bash
sudo -u slotwise sh -c 'cd /opt/slotwise/app && node --env-file=/etc/slotwise/slotwise.env dist/node.mjs'
# slotwise ready on http://127.0.0.1:8787 (db /var/lib/slotwise/slotwise.sqlite)
curl -s http://127.0.0.1:8787/healthz     # {"ok":true,...,"adapter":"sqlite",...,"setupCodeRequired":true}
```

`npm start` runs the same `node dist/node.mjs` and reads settings from the environment. Migrations run at start
and are additive. In production the server refuses to start without `ENCRYPTION_KEY`.

### systemd unit (`/etc/systemd/system/slotwise.service`)

```ini
[Unit]
Description=Slotwise scheduling
After=network-online.target
Wants=network-online.target

[Service]
User=slotwise
Group=slotwise
WorkingDirectory=/opt/slotwise/app
EnvironmentFile=/etc/slotwise/slotwise.env
ExecStart=/usr/bin/node dist/node.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/slotwise
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now slotwise
systemctl status slotwise && journalctl -u slotwise -n 20
```

Use the path from `which node` in `ExecStart` if Node is installed elsewhere (nvm installs are per user; prefer a
system package or the NodeSource repository on servers).

## 5. Caddy reverse proxy with automatic HTTPS

`/etc/caddy/Caddyfile`:

```caddy
book.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
```

`sudo systemctl reload caddy`. Caddy obtains a certificate once DNS points at the server, and sets
`X-Forwarded-For` and `X-Forwarded-Proto` for you. Check: `curl -s https://book.example.com/healthz`.

nginx equivalent: `proxy_pass http://127.0.0.1:8787;` plus `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Host $host;` and a
certificate from certbot.

## 6. First owner and smoke test

1. Open `https://book.example.com/signup`, enter the setup code, create the owner account. Signup then closes
   (unless `ALLOW_SIGNUP=true`).
2. From any machine with a clone: `node bin/slotwise.mjs --url https://book.example.com login --email you@example.com --save`.
3. `node scripts/smoke-booking.mjs --url https://book.example.com --email you@example.com --password-file <file>`
   creates a temporary event type, books and cancels one slot, deletes the event type, and prints a JSON summary.

## Backups, upgrades, password reset

- Back up `/var/lib/slotwise/` (the `.sqlite` file plus its `-wal`/`-shm` files) and the env file. The simplest
  consistent copy: `sudo systemctl stop slotwise`, copy the folder, start again. With the `sqlite3` tool installed:
  `sqlite3 /var/lib/slotwise/slotwise.sqlite ".backup /backup/slotwise-$(date +%F).sqlite"` while running.
- Upgrade (keeps what `npm run brand` and `npm run legal` changed in the clone):
  ```bash
  sudo -u slotwise sh -c 'cd /opt/slotwise/app && git -c user.name=slotwise -c user.email=slotwise@localhost pull --ff-only --autostash && npm run brand -- --apply && npm ci && npm run build'
  sudo systemctl restart slotwise
  ```
  `--autostash` sets your local changes aside, pulls, and puts them back (the `-c` options give git the identity it
  needs for that). `npm run brand -- --apply` then regenerates the brand from your `brand.json` with the new code. If
  git reports a conflict in a page you filled in, take the new page (`git checkout HEAD -- <file> && git stash drop`)
  and run your `npm run legal` command again. Keep a copy of its values before each upgrade:
  `sudo -u slotwise sh -c 'cd /opt/slotwise/app && npm run --silent legal > /opt/slotwise/legal-values.json'`.
- Owner password reset: `sudo -u slotwise sh -c 'cd /opt/slotwise/app && node scripts/admin-reset-password.mjs --email you@example.com --db /var/lib/slotwise/slotwise.sqlite'`.

## Without systemd

Any supervisor that restarts the process works (a container platform, a process manager, or a `@reboot` cron
entry for a home machine). The contract is just: Node 22.13+, `npm ci && npm run build`, the env above, a
persistent directory for `DB_PATH`, and a TLS proxy. See docs/HOSTING.md for platform notes.
