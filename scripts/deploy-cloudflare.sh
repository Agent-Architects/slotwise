#!/usr/bin/env bash
# Deploy Slotwise to Cloudflare Workers + D1. See docs/DEPLOY-CLOUDFLARE.md.
#
#   bash scripts/deploy-cloudflare.sh [--domain book.example.com] [--yes] [--dry-run]
#
# Account-specific values (D1 database id, custom domain, plain vars) are kept out of tracked files: the script
# copies wrangler.toml to wrangler.local.toml (gitignored), fills them in there, and runs every wrangler command
# with `--config wrangler.local.toml`. Settings given once are remembered in .deploy/state.json (gitignored), so a
# plain re-run redeploys the same way.
#
# Auth, in this order:
#   1. CF_TOKEN_FILE=/path/to/token  -> the API token is read from that file into CLOUDFLARE_API_TOKEN (never printed)
#   2. CLOUDFLARE_API_TOKEN already exported in the environment
#   3. an existing `npx wrangler login` session on this machine
# Options (flag or env; remembered in .deploy/state.json):
#   --domain D | CUSTOM_DOMAIN=D  serve on https://D through a Workers custom domain (the zone must be on this
#                                 Cloudflare account). Implies APP_URL=https://D unless APP_URL is set.
#   APP_URL                       public origin used in emails and OAuth redirects (default: the workers.dev URL)
#   APP_NAME                      product name shown in emails and calendar events (default: brand.json)
#   GOOGLE_CLIENT_ID              Google OAuth client id (plain var)
#   EMAIL_FROM                    sender for Resend, e.g. "Bookings <bookings@example.com>"
# One-time secret inputs (stored as Worker secrets, never remembered locally):
#   GOOGLE_CLIENT_SECRET_FILE     file holding the Google OAuth client secret
#   RESEND_API_KEY_FILE           file holding a Resend API key (needs EMAIL_FROM; switches EMAIL_PROVIDER to resend)
# Other env:
#   CLOUDFLARE_ACCOUNT_ID         pick the account when the token or login can see several (required then)
#   SKIP_CHECKS=1                 skip typecheck + tests (not recommended)
#   WRANGLER                      wrangler binary to use (default: the local node_modules one)
#   --dry-run                     no account needed: build, generate a config with a placeholder id in
#                                 .deploy/dry-run/wrangler.toml (wrangler.local.toml is never touched), and run
#                                 `wrangler deploy --dry-run` to prove the Worker bundles (output in .deploy/dry-run/out)
#   --yes                         skip the confirmation; without it the script shows the Cloudflare account and
#                                 asks before changing anything (and refuses when there is no terminal to ask)
# Output: progress and errors go to stderr; on success stdout is only the public URL.
set -euo pipefail
set +x # never trace: secrets pass through variables below

DRY_RUN=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --domain) [ $# -ge 2 ] || { echo "--domain needs a value" >&2; exit 2; }; CUSTOM_DOMAIN="$2"; shift ;;
    --domain=*) CUSTOM_DOMAIN="${1#--domain=}" ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
WRANGLER="${WRANGLER:-$ROOT/node_modules/.bin/wrangler}"
DB_NAME="slotwise"
STATE_DIR="$ROOT/.deploy"
STATE_FILE="$STATE_DIR/state.json"
LOCAL_CONFIG="wrangler.local.toml"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

log() { printf '[deploy] %s\n' "$*" >&2; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
wr() { "$WRANGLER" "$@" --config "$LOCAL_CONFIG"; }

[ -x "$WRANGLER" ] || die "wrangler not installed locally; run npm ci"
export WRANGLER_SEND_METRICS=false

# Remembered settings: env/flags win, then .deploy/state.json.
state_get() {
  [ -f "$STATE_FILE" ] || return 0
  KEY="$1" FILE="$STATE_FILE" node -e '
    const o = JSON.parse(require("fs").readFileSync(process.env.FILE, "utf8"));
    const v = o[process.env.KEY]; if (typeof v === "string") process.stdout.write(v);'
}
state_set() { # key value (empty value removes the key)
  KEY="$1" VALUE="$2" FILE="$STATE_FILE" node -e '
    const fs = require("fs"); const f = process.env.FILE;
    const o = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    if (process.env.VALUE) o[process.env.KEY] = process.env.VALUE; else delete o[process.env.KEY];
    fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });'
}
for K in CUSTOM_DOMAIN APP_URL APP_NAME GOOGLE_CLIENT_ID EMAIL_FROM EMAIL_PROVIDER; do
  if [ -z "${!K:-}" ]; then printf -v "$K" '%s' "$(state_get "$K")"; fi
done
CUSTOM_DOMAIN="${CUSTOM_DOMAIN#https://}"
CUSTOM_DOMAIN="${CUSTOM_DOMAIN%/}"
if [ -n "$CUSTOM_DOMAIN" ]; then
  printf '%s' "$CUSTOM_DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$' || die "--domain must be a bare hostname like book.example.com"
  [ -n "$APP_URL" ] || APP_URL="https://$CUSTOM_DOMAIN"
fi
if [ -n "${RESEND_API_KEY_FILE:-}" ]; then
  [ -n "$EMAIL_FROM" ] || die "EMAIL_FROM is required with RESEND_API_KEY_FILE"
  EMAIL_PROVIDER="resend"
fi

# Writes a config: wrangler.toml with the given database id and, when set, the custom domain route. With a custom
# domain the workers.dev URL and preview URLs are turned off, so the Worker answers only on that domain (one public
# origin for cookies, OAuth and emails). Wrangler resolves paths relative to the config file, so a config outside
# the repo root gets its paths rewritten to point back.
# shellcheck disable=SC2016 # the single-quoted JS uses template literals, not shell expansion
write_config() { # database_id output_file
  DB_ID_IN="$1" OUT="$2" DOMAIN="$CUSTOM_DOMAIN" node -e '
    const fs = require("fs"); const path = require("path");
    let s = fs.readFileSync("wrangler.toml", "utf8");
    s = s.replace(/database_id = "[^"]*"/, `database_id = "${process.env.DB_ID_IN}"`);
    const up = path.relative(path.dirname(path.resolve(process.env.OUT)), process.cwd()).split(path.sep).join("/");
    if (up) s = s.replace(/^(main|directory|migrations_dir) = "(?:\.\/)?([^"]*)"/gm, (m, k, p) => `${k} = "${up}/${p}"`);
    const head = "# GENERATED by scripts/deploy-cloudflare.sh from wrangler.toml. Account-specific; gitignored; do not commit.\n";
    let tail = "";
    if (process.env.DOMAIN) {
      s = s.replace(/^workers_dev = true$/m, "workers_dev = false").replace(/^preview_urls = true$/m, "preview_urls = false");
      tail = `\n[[routes]]\npattern = "${process.env.DOMAIN}"\ncustom_domain = true\n`;
    }
    fs.writeFileSync(process.env.OUT, head + s + tail);'
}

if [ "$DRY_RUN" = 1 ]; then
  log "dry run: no Cloudflare account is contacted"
  npm run --silent build:web >&2 || die "web build failed"
  DRY_DIR="$STATE_DIR/dry-run"
  rm -rf "$DRY_DIR"
  mkdir -p "$DRY_DIR"
  write_config "00000000-0000-0000-0000-000000000000" "$DRY_DIR/wrangler.toml"
  "$WRANGLER" deploy --dry-run --config "$DRY_DIR/wrangler.toml" --outdir "$DRY_DIR/out" >&2 || die "wrangler deploy --dry-run failed"
  log "dry run ok: bundle in .deploy/dry-run/out; config .deploy/dry-run/wrangler.toml (placeholder id${CUSTOM_DOMAIN:+, route $CUSTOM_DOMAIN}); $LOCAL_CONFIG untouched"
  exit 0
fi

if [ -n "${CF_TOKEN_FILE:-}" ]; then
  [ -r "$CF_TOKEN_FILE" ] || die "CF_TOKEN_FILE is set but not readable"
  CLOUDFLARE_API_TOKEN="$(tr -d '[:space:]' < "$CF_TOKEN_FILE")"
  [ -n "$CLOUDFLARE_API_TOKEN" ] || die "CF_TOKEN_FILE is empty"
  export CLOUDFLARE_API_TOKEN
  log "using API token from CF_TOKEN_FILE"
elif [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  log "using CLOUDFLARE_API_TOKEN from the environment"
else
  log "no API token set; using the existing wrangler login"
fi

# `wrangler whoami` exits 0 even when logged out; the JSON form fails instead and lists the accounts.
WHOAMI_JSON="$("$WRANGLER" whoami --json 2>/dev/null)" || die "wrangler is not authenticated (set CF_TOKEN_FILE or run: npx wrangler login)"
# shellcheck disable=SC2016 # the single-quoted JS uses template literals, not shell expansion
# Prints "<account id>\t<account name>\t<signed in as>"; exit 3 logged out, 4 unknown CLOUDFLARE_ACCOUNT_ID, 5 no or several accounts.
ACCOUNT="$(WHOAMI_JSON="$WHOAMI_JSON" node -e '
  const raw = process.env.WHOAMI_JSON; let w;
  try { w = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { process.exit(3); }
  if (!w || w.loggedIn !== true) process.exit(3);
  const accounts = Array.isArray(w.accounts) ? w.accounts : [];
  const want = process.env.CLOUDFLARE_ACCOUNT_ID;
  const list = () => accounts.map((a) => `  ${a.id}  ${a.name}`).join("\n");
  let a;
  if (want) { a = accounts.find((x) => x.id === want); if (!a) { console.error(`CLOUDFLARE_ACCOUNT_ID is not one of:\n${list()}`); process.exit(4); } }
  else if (accounts.length === 1) a = accounts[0];
  else { console.error(accounts.length ? `this login can see several accounts; set CLOUDFLARE_ACCOUNT_ID to one of:\n${list()}` : "no Cloudflare account visible to this login"); process.exit(5); }
  process.stdout.write(`${a.id}\t${a.name}\t${w.email || w.authType || "unknown"}`);')" || case $? in
  3) die "wrangler is not authenticated (set CF_TOKEN_FILE or run: npx wrangler login)" ;;
  *) die "pick the Cloudflare account first (see above)" ;;
esac
IFS=$'\t' read -r ACCOUNT_ID ACCOUNT_NAME SIGNED_IN_AS <<< "$ACCOUNT"
# Every wrangler call below targets exactly the confirmed account.
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
log "Cloudflare account: $ACCOUNT_NAME (id $ACCOUNT_ID), signed in as $SIGNED_IN_AS"
# Nothing below runs against an account the operator did not confirm.
if [ "$YES" != 1 ]; then
  [ -t 0 ] || die "about to create/update the D1 database and Worker on the account above; re-run with --yes to confirm"
  printf '[deploy] Deploy Slotwise to %s (id %s)? [y/N] ' "$ACCOUNT_NAME" "$ACCOUNT_ID" >&2
  read -r ANSWER
  case "$ANSWER" in y|Y|yes|YES) ;; *) die "canceled; nothing was changed" ;; esac
fi

if [ "${SKIP_CHECKS:-}" != "1" ]; then
  log "typecheck and tests"
  npm run --silent typecheck >&2 || die "typecheck failed; fix it before deploying (nothing was changed on Cloudflare)"
  npx vitest run --reporter=dot >&2 || die "tests failed; fix them before deploying (nothing was changed on Cloudflare)"
fi

log "building web assets"
npm run --silent build:web >&2 || die "web build failed"

# 1. D1 database: reuse by name or create. Its id goes only into the gitignored wrangler.local.toml.
DB_ID="$("$WRANGLER" d1 list --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { const db = JSON.parse(s).find(d => d.name === process.argv[1]); process.stdout.write(db ? (db.uuid || db.id || "") : ""); } catch {}
  });' "$DB_NAME")"
if [ -z "$DB_ID" ]; then
  log "creating D1 database $DB_NAME"
  OUT="$("$WRANGLER" d1 create "$DB_NAME" 2>&1)" || die "d1 create failed: $OUT"
  DB_ID="$(printf '%s' "$OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1)"
  [ -n "$DB_ID" ] || die "could not read the new database id"
fi
log "D1 database $DB_NAME ready (id kept in $LOCAL_CONFIG)"
write_config "$DB_ID" "$LOCAL_CONFIG"

# 2. Schema. Migrations are additive (new columns/tables only) and wrangler applies each file once.
log "applying migrations (remote)"
wr d1 migrations apply "$DB_NAME" --remote >&2 || die "applying migrations failed (secrets and code were not changed)"

# 3. Secrets that must exist before the code is live. On an existing deployment they are never regenerated:
#    rotating ENCRYPTION_KEY would make stored calendar tokens unreadable, and SETUP_CODE is only for first signup.
WORKER_EXISTS=0
SECRET_ERR="$STATE_DIR/secret-list.$$.err"
if EXISTING="$(wr secret list --format json 2>"$SECRET_ERR")"; then
  WORKER_EXISTS=1
  rm -f "$SECRET_ERR"
else
  # Only a clear "this Worker does not exist" answer means a first deploy. Any other failure (outage, rate limit,
  # auth) stops here, so a transient error can never regenerate ENCRYPTION_KEY or SETUP_CODE on a live Worker.
  ERR="$(cat "$SECRET_ERR" 2>/dev/null || true)"
  rm -f "$SECRET_ERR"
  if printf '%s' "$ERR" | grep -Eqi 'Worker "[^"]*"( \(env: [^)]*\))? not found|\[code: (10007|10090)\]|This Worker does not exist|workers\.api\.error\.script_not_found'; then
    log "Worker not deployed yet: first deploy"
    EXISTING="[]"
  else
    printf '%s\n' "$ERR" >&2
    die "could not list the Worker's existing secrets (see above); refusing to continue so no secret is regenerated (nothing was changed)"
  fi
fi
has_secret() { printf '%s' "$EXISTING" | grep -q "\"name\": *\"$1\""; }

SECRETS_FILE="$STATE_DIR/secrets.$$.json"
trap 'rm -f "$SECRETS_FILE"' EXIT
( umask 077; printf '{}' > "$SECRETS_FILE" )
add_secret() { # name value -> merged into the JSON file handed to wrangler deploy (never printed)
  NAME="$1" VALUE="$2" FILE="$SECRETS_FILE" node -e '
    const fs = require("fs"); const f = process.env.FILE;
    const o = JSON.parse(fs.readFileSync(f, "utf8")); o[process.env.NAME] = process.env.VALUE;
    fs.writeFileSync(f, JSON.stringify(o), { mode: 0o600 });'
  log "secret $1 will be set with this deploy"
}

if ! has_secret ENCRYPTION_KEY; then
  [ "$WORKER_EXISTS" = 1 ] && log "WARNING: deployed Worker has no ENCRYPTION_KEY; creating one (no calendars can be connected yet)"
  add_secret ENCRYPTION_KEY "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
fi
if ! has_secret SETUP_CODE; then
  if [ "$WORKER_EXISTS" = 1 ]; then
    log "SETUP_CODE not set on the existing Worker; leaving it unset (signup closes after the first owner anyway)"
  else
    CODE="$(node -e 'process.stdout.write(require("crypto").randomBytes(9).toString("base64url"))')"
    ( umask 077; printf '%s\n' "$CODE" > "$STATE_DIR/setup-code" )
    add_secret SETUP_CODE "$CODE"
    log "first-owner setup code written to .deploy/setup-code (needed once on the signup page)"
  fi
fi
if [ -n "${GOOGLE_CLIENT_SECRET_FILE:-}" ]; then
  [ -r "$GOOGLE_CLIENT_SECRET_FILE" ] || die "GOOGLE_CLIENT_SECRET_FILE not readable"
  add_secret GOOGLE_CLIENT_SECRET "$(tr -d '[:space:]' < "$GOOGLE_CLIENT_SECRET_FILE")"
fi
if [ -n "${RESEND_API_KEY_FILE:-}" ]; then
  [ -r "$RESEND_API_KEY_FILE" ] || die "RESEND_API_KEY_FILE not readable"
  add_secret RESEND_API_KEY "$(tr -d '[:space:]' < "$RESEND_API_KEY_FILE")"
fi

# 4. Deploy code together with the new secrets (wrangler applies them to the same version, additively).
#    Plain vars are passed on every deploy because wrangler replaces the Worker's vars with what it is given.
VARS=()
[ -n "$APP_URL" ] && VARS+=(--var "APP_URL:$APP_URL")
[ -n "$APP_NAME" ] && VARS+=(--var "APP_NAME:$APP_NAME")
[ -n "$GOOGLE_CLIENT_ID" ] && VARS+=(--var "GOOGLE_CLIENT_ID:$GOOGLE_CLIENT_ID")
if [ "$EMAIL_PROVIDER" = "resend" ]; then
  [ -n "$EMAIL_FROM" ] || die "EMAIL_FROM is required when EMAIL_PROVIDER is resend"
  VARS+=(--var "EMAIL_PROVIDER:resend" --var "EMAIL_FROM:$EMAIL_FROM")
fi
log "deploying worker${CUSTOM_DOMAIN:+ (custom domain $CUSTOM_DOMAIN)}"
# Wrangler lets process env values override --secrets-file values (documented for dotenv files; this file is JSON),
# so make sure no exported secret of the same name can replace what this script generated or read from a file.
DEPLOY_OUT="$(env -u ENCRYPTION_KEY -u SETUP_CODE -u GOOGLE_CLIENT_SECRET -u RESEND_API_KEY \
  "$WRANGLER" deploy --config "$LOCAL_CONFIG" --secrets-file "$SECRETS_FILE" ${VARS[@]+"${VARS[@]}"} 2>&1)" || { printf '%s\n' "$DEPLOY_OUT" >&2; die "wrangler deploy failed"; }
rm -f "$SECRETS_FILE"
for K in CUSTOM_DOMAIN APP_URL APP_NAME GOOGLE_CLIENT_ID EMAIL_FROM EMAIL_PROVIDER; do state_set "$K" "${!K:-}"; done
URL="$(printf '%s' "$DEPLOY_OUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -n1 || true)"
[ -n "$URL" ] && state_set WORKERS_DEV_URL "$URL"

# 5. Smoke check. Without a custom domain the workers.dev URL answers. With one, workers.dev is off and a new custom
# domain can take a few minutes for its certificate, so wait longer.
CHECK_URL="${URL:-$APP_URL}"
TRIES=10
if [ -n "$CUSTOM_DOMAIN" ]; then CHECK_URL="https://$CUSTOM_DOMAIN"; TRIES=60; fi
if [ -n "$CHECK_URL" ]; then
  for _ in $(seq "$TRIES"); do
    if curl -fsS "$CHECK_URL/healthz" >/dev/null 2>&1; then break; fi
    sleep 3
  done
  curl -fsS "$CHECK_URL/healthz" >&2 || die "health check failed at $CHECK_URL/healthz${CUSTOM_DOMAIN:+ (the Worker is deployed; a new custom domain can need a few more minutes for its certificate: retry curl -s $CHECK_URL/healthz, re-running this script is safe)}"
  printf '\n' >&2
  log "deployed: $CHECK_URL${APP_URL:+ (public origin $APP_URL)}"
  log "Google OAuth redirect URI: ${APP_URL:-$URL}/oauth/google/callback"
  printf '%s\n' "${APP_URL:-$URL}"
else
  log "deployed, but the workers.dev URL was not found in wrangler output:"
  printf '%s\n' "$DEPLOY_OUT" >&2
fi
