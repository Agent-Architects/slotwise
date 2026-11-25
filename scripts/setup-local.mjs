#!/usr/bin/env node
// Local end-to-end setup check for Slotwise (Node + SQLite), fully non-interactive.
//
//   node scripts/setup-local.mjs [--keep] [--port N] [--skip-build]
//   node scripts/setup-local.mjs --stop          stop a server left running by --keep
//
// It builds, keeps ENCRYPTION_KEY + SETUP_CODE in .setup/local.env (gitignored, mode 600, reused), starts the
// production Node server on a free port with a throwaway SQLite database (MOCK_CALENDAR=true), creates the first
// owner with the setup code, and then uses the CLI to create an event type, set availability, connect the mock
// calendar, add a busy block and confirm it hides a slot, book a slot as an invitee, confirm the owner sees it, cancel
// it with the invitee's manage token and confirm the slot is free again. It prints one JSON summary on stdout
// (no secrets) and exits 0 only when every step passed. --keep leaves the server and database running and writes
// the throwaway owner login to .setup/local-owner.json (mode 600).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, flatSlots, isoDate, overlaps, parseFlags, recorder, ROOT, waitHealthy } from "./setup-lib.mjs";

const flags = parseFlags(process.argv.slice(2), ["keep", "skip-build", "stop"]);
const SETUP = join(ROOT, ".setup");
const SERVER_FILE = join(SETUP, "local-server.json");
mkdirSync(SETUP, { recursive: true, mode: 0o700 });

if (flags.stop) {
  if (!existsSync(SERVER_FILE)) {
    console.log(JSON.stringify({ ok: true, stopped: false, reason: "no server recorded" }));
    process.exit(0);
  }
  const s = JSON.parse(readFileSync(SERVER_FILE, "utf8"));
  try {
    process.kill(s.pid, "SIGTERM");
  } catch {}
  rmSync(s.dataDir, { recursive: true, force: true });
  rmSync(SERVER_FILE, { force: true });
  rmSync(join(SETUP, "local-owner.json"), { force: true });
  console.log(JSON.stringify({ ok: true, stopped: true, pid: s.pid, url: s.url }));
  process.exit(0);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const nodeMinor = Number(process.versions.node.split(".")[1]);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.log(JSON.stringify({ ok: false, error: `Node ${process.versions.node} is too old; Slotwise needs 22.13 or newer` }));
  process.exit(1);
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || "").trim().slice(-800)}`);
}

function localSecrets() {
  const f = join(SETUP, "local.env");
  if (!existsSync(f)) {
    const body = [
      "# Local-only secrets for scripts/setup-local.mjs. Gitignored. Never paste these into chat.",
      `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
      `SETUP_CODE=${randomBytes(9).toString("base64url")}`,
      "",
    ].join("\n");
    writeFileSync(f, body, { mode: 0o600 });
  }
  const env = {};
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  if (!env.ENCRYPTION_KEY || !env.SETUP_CODE) throw new Error(".setup/local.env is missing ENCRYPTION_KEY or SETUP_CODE; delete it to regenerate");
  return env;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const rec = recorder();
const summary = { ok: false, adapter: "sqlite", mode: "NODE_ENV=production", secretsFile: ".setup/local.env" };
let server;
let dataDir;
let keep = Boolean(flags.keep);
const owner = { email: "owner@example.com", password: randomBytes(12).toString("base64url"), name: "Olive Owner", username: "olive", timezone: "UTC" };

try {
  if (!existsSync(join(ROOT, "node_modules"))) await rec.run("npm ci", () => sh("npm", ["ci"]));
  if (!flags["skip-build"]) await rec.run("build", () => sh("npm", ["run", "--silent", "build"]));
  else if (!existsSync(join(ROOT, "dist", "node.mjs"))) throw new Error("dist/node.mjs missing; run without --skip-build");

  const secrets = await rec.run("secrets", () => localSecrets(), () => ({ file: ".setup/local.env" }));

  const port = Number(flags.port) || (await freePort());
  const url = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "slotwise-local-"));
  const logFile = join(dataDir, "server.log");
  summary.url = url;

  await rec.run("start server", async () => {
    const out = openSync(logFile, "a");
    server = spawn(process.execPath, [join(ROOT, "dist", "node.mjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
        SETUP_CODE: secrets.SETUP_CODE,
        DB_PATH: join(dataDir, "slotwise.sqlite"),
        PORT: String(port),
        HOST: "127.0.0.1",
        APP_URL: url,
        MOCK_CALENDAR: "true",
        ALLOW_SIGNUP: "false",
      },
      stdio: ["ignore", out, out],
      detached: keep,
    });
    closeSync(out);
    server.once("exit", (code) => {
      if (code !== null && code !== 0) process.stderr.write(`server exited with ${code}; log: ${logFile}\n`);
    });
    const h = await waitHealthy(url);
    if (h.adapter !== "sqlite" || !h.setupCodeRequired || !h.signupOpen) throw new Error(`unexpected health: ${JSON.stringify(h)}`);
    return { url, adapter: h.adapter, version: h.version, setupCodeRequired: h.setupCodeRequired };
  });

  const signup = (extra) =>
    fetch(`${url}/api/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...owner, ...extra }) });

  await rec.run("signup refused without setup code", async () => {
    const r = await signup({});
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
    return { status: r.status };
  });

  const cookie = await rec.run("first owner signup with setup code", async () => {
    const r = await signup({ setupCode: secrets.SETUP_CODE });
    if (r.status !== 201) throw new Error(`signup failed: HTTP ${r.status} ${await r.text()}`);
    const c = (r.headers.get("set-cookie") ?? "").split(";")[0];
    if (!c) throw new Error("no session cookie");
    return c;
  }, () => ({ email: owner.email, username: owner.username }));

  await rec.run("second signup refused", async () => {
    const r = await signup({ email: "intruder@example.com", username: "intruder", setupCode: secrets.SETUP_CODE });
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
    return { status: r.status };
  });

  const token = await rec.run(
    "cli login (password on stdin)",
    () => cli(["login", "--email", owner.email, "--password-stdin", "--name", "setup-local"], { url, input: `${owner.password}\n` }).token,
    () => ({ apiToken: "issued (not printed)" }),
  );
  const c = (args, input) => cli(args, { url, token, input });

  await rec.run("cli whoami", () => ({ username: c(["whoami"]).user.username }));

  const et = await rec.run("cli event-types create", () => {
    const r = c(["event-types", "create", "--name", "Intro call", "--slug", "intro", "--duration", "30", "--min-notice", "60"]);
    return { id: r.eventType.id, slug: r.eventType.slug };
  });

  await rec.run("cli availability set", () => {
    const days = ["--mon", "--tue", "--wed", "--thu", "--fri", "--sat", "--sun"].flatMap((d) => [d, "09:00-17:00"]);
    const r = c(["availability", "set", "--timezone", "UTC", ...days, "--min-notice", "60", "--max-days", "30"]);
    return { timezone: r.availability.timezone };
  });

  const from = isoDate(Date.now());
  const to = isoDate(Date.now() + 7 * 86400000);
  const slots = () => flatSlots(c(["slots", owner.username, et.slug, "--from", from, "--to", to, "--timezone", "UTC"]));

  const initial = await rec.run("cli slots (public)", () => {
    const s = slots();
    if (s.length < 2) throw new Error(`expected at least 2 open slots, got ${s.length}`);
    return { count: s.length, first: s[0].start };
  });
  const all = slots();
  const busySlot = all[0];
  const bookSlot = all[1];

  await rec.run("connect mock calendar (cli + OAuth callback)", async () => {
    const { url: authUrl } = c(["integrations", "connect", "mock"]);
    const r = await fetch(authUrl, { headers: { cookie }, redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    if (r.status !== 302 || !loc.includes("connected=mock")) throw new Error(`callback: HTTP ${r.status} ${loc}`);
    const conns = c(["integrations", "list"]).connections;
    if (conns.length !== 1) throw new Error(`expected 1 connection, got ${conns.length}`);
    return { provider: "mock", checkCalendarIds: conns[0].checkCalendarIds, writeCalendarId: conns[0].writeCalendarId };
  });

  await rec.run("busy calendar block hides the slot", () => {
    c(["mock", "busy", "--start", busySlot.start, "--end", busySlot.end, "--summary", "Busy (setup check)"]);
    const s = slots();
    if (s.some((x) => overlaps(x, busySlot.start, busySlot.end))) throw new Error(`slot ${busySlot.start} still offered`);
    return { hidden: busySlot.start, openNow: s.length };
  });

  const { manageToken, ...booking } = await rec.run(
    "cli book (invitee, public API)",
    () => {
      const r = c(["book", owner.username, et.slug, "--start", bookSlot.start, "--name", "Ivy Invitee", "--email", "ivy@example.com", "--timezone", "UTC"]);
      if (r.booking.status !== "confirmed") throw new Error(`status ${r.booking.status}`);
      return { id: r.booking.id, start: r.booking.start, status: r.booking.status, manageToken: r.manageToken };
    },
    ({ manageToken: _, ...shown }) => shown,
  );

  await rec.run("booked slot no longer offered", () => {
    if (slots().some((x) => x.start === bookSlot.start)) throw new Error("booked slot still offered");
    return { start: bookSlot.start };
  });

  await rec.run("owner sees booking (cli bookings list)", () => {
    const items = c(["bookings", "list", "--status", "upcoming"]).items;
    if (!items.some((b) => b.id === booking.id)) throw new Error("booking not in owner's upcoming list");
    return { upcoming: items.length };
  });

  await rec.run("booking written to calendar", () => {
    const evs = c(["mock", "events"]).items;
    if (!evs.some((e) => e.source === "app" && e.status === "confirmed")) throw new Error("no calendar event for the booking");
    return { calendarEvents: evs.length };
  });

  await rec.run("cli invitee cancel (manage token)", () => {
    const r = c(["invitee", "cancel", booking.id, "--manage-token", manageToken, "--reason", "setup check"]);
    if (r.booking.status !== "cancelled") throw new Error(`status ${r.booking.status}`);
    return { status: r.booking.status };
  });

  await rec.run("owner sees cancellation; slot free again", () => {
    const b = c(["bookings", "get", booking.id]).booking;
    if (b.status !== "cancelled") throw new Error(`owner sees status ${b.status}`);
    if (!slots().some((x) => x.start === bookSlot.start)) throw new Error("canceled slot not offered again");
    return { status: b.status, reopened: bookSlot.start };
  });

  summary.ok = true;
  summary.booking = booking;
  summary.initialSlots = initial.count;
} catch (e) {
  summary.error = e.message;
  keep = false;
} finally {
  summary.steps = rec.steps;
  if (server && keep) {
    writeFileSync(join(SETUP, "local-owner.json"), JSON.stringify({ url: summary.url, email: owner.email, password: owner.password, note: "throwaway local login; gitignored" }, null, 2), { mode: 0o600 });
    writeFileSync(SERVER_FILE, JSON.stringify({ pid: server.pid, url: summary.url, dataDir }, null, 2), { mode: 0o600 });
    server.unref();
    summary.kept = { url: summary.url, dataDir, stop: "node scripts/setup-local.mjs --stop", login: ".setup/local-owner.json" };
  } else {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((res) => (server.exitCode !== null ? res() : server.once("exit", res)));
    }
    if (dataDir && summary.ok) rmSync(dataDir, { recursive: true, force: true });
    else if (dataDir) summary.serverLog = join(dataDir, "server.log");
  }
  writeFileSync(join(SETUP, "local-result.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}
