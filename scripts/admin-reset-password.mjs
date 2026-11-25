#!/usr/bin/env node
// Host-operator password reset (there is no email reset flow yet). Runs directly against the database, so only
// someone with access to the server or the Cloudflare account can use it. Signs the owner out everywhere and
// revokes every API token (the CLI and agents need a new token afterwards).
//
//   Node + SQLite:  node scripts/admin-reset-password.mjs --email owner@example.com --db data/slotwise.sqlite
//   Cloudflare D1:  node scripts/admin-reset-password.mjs --email owner@example.com --d1 slotwise --remote
//                   (uses the local wrangler login or CLOUDFLARE_API_TOKEN; --local [--persist-to DIR] for wrangler dev)
//                   --config <file> picks the Wrangler config. Default for --remote: wrangler.local.toml, the file the
//                   deploy script writes with your real database id (wrangler.toml only has a placeholder id).
//                   Default for --local: wrangler.toml, like `npm run dev:worker`. WRANGLER overrides the binary.
//
// The new password is read from stdin when piped (printf '%s' "$PW" | node ...), otherwise prompted for without
// echo. It is never accepted as a command-line argument.
import { spawnSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (k) => argv.includes(`--${k}`);
const fail = (m) => {
  process.stderr.write(`${JSON.stringify({ error: { code: "usage", message: m } })}\n`);
  process.exit(2);
};

const email = flag("email")?.toLowerCase();
if (!email) fail("--email is required");
if (!flag("db") && !flag("d1")) fail("pass --db <sqlite path> or --d1 <database name> [--remote|--local]");
if (argv.includes("--password")) fail("passwords are not accepted as arguments; pipe it on stdin or type it at the prompt");
// Resolve the Wrangler config before asking for a password, so a wrong setup fails fast.
let wranglerConfig = [];
if (flag("d1")) {
  if (flag("config")) wranglerConfig = ["--config", resolve(flag("config"))];
  else if (!has("local")) {
    if (!existsSync(join(ROOT, "wrangler.local.toml"))) {
      fail("--remote needs the deployed config: wrangler.local.toml was not found (run the deploy script once, or pass --config <file>)");
    }
    wranglerConfig = ["--config", "wrangler.local.toml"];
  }
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const c of process.stdin) s += c;
    return s.replace(/\r?\n$/, "");
  }
  const ask = (q) =>
    new Promise((res) => {
      process.stderr.write(q);
      let s = "";
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const on = (b) => {
        for (const ch of b.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.off("data", on);
            process.stderr.write("\n");
            return res(s);
          }
          if (ch === "\u0003") process.exit(130);
          if (ch === "\u007f") s = s.slice(0, -1);
          else s += ch;
        }
      };
      process.stdin.on("data", on);
    });
  const a = await ask("New password: ");
  const b = await ask("Repeat new password: ");
  if (a !== b) fail("passwords do not match");
  return a;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function hashPassword(pw) {
  // Same format as src/core/crypto.ts: pbkdf2-sha256$<iterations>$<salt>$<hash>.
  const salt = randomBytes(16);
  return `pbkdf2-sha256$100000$${b64url(salt)}$${b64url(pbkdf2Sync(pw, salt, 100000, 32, "sha256"))}`;
}

const pw = await readPassword();
if (pw.length < 10 || pw.length > 200) fail("password must be 10 to 200 characters");
const hash = hashPassword(pw);

if (flag("db")) {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(resolve(flag("db")));
  const u = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!u) fail(`no user with email ${email}`);
  db.exec("BEGIN");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, u.id);
  const s = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  const t = db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(new Date().toISOString(), u.id);
  db.exec("COMMIT");
  db.close();
  process.stdout.write(`${JSON.stringify({ ok: true, email, sessionsRevoked: Number(s.changes), tokensRevoked: Number(t.changes) })}\n`);
} else {
  // Values are inlined as SQL string literals; both are restricted to safe characters first.
  if (!/^[A-Za-z0-9$_-]+$/.test(hash)) fail("unexpected hash format");
  const esc = (v) => `'${v.replace(/'/g, "''")}'`;
  const sql =
    `UPDATE users SET password_hash = ${esc(hash)} WHERE email = ${esc(email)}; ` +
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${esc(email)}); ` +
    `UPDATE api_tokens SET revoked_at = ${esc(new Date().toISOString())} WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE email = ${esc(email)}); ` +
    `SELECT COUNT(*) AS matched FROM users WHERE email = ${esc(email)};`;
  const where = has("local") ? "--local" : "--remote";
  const persist = flag("persist-to") ? ["--persist-to", resolve(flag("persist-to"))] : [];
  const wrangler = process.env.WRANGLER || join(ROOT, "node_modules", ".bin", "wrangler");
  const r = spawnSync(wrangler, ["d1", "execute", flag("d1"), where, ...wranglerConfig, ...persist, "--json", "--command", sql], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout);
    process.exit(1);
  }
  let matched = null;
  try {
    const out = JSON.parse(r.stdout);
    matched = out.at(-1)?.results?.[0]?.matched ?? null;
  } catch {}
  if (matched === 0) fail(`no user with email ${email}`);
  process.stdout.write(`${JSON.stringify({ ok: true, email, target: where.slice(2) })}\n`);
}
