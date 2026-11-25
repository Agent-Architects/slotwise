#!/usr/bin/env node
// control.mjs: launch, doctor, cli and stop for an isolated Slotwise instance used by verification.
//
//   node skills/verify-slotwise/scripts/control.mjs launch --adapter node|worker [--port 8899] [--run-id ID]
//   node skills/verify-slotwise/scripts/control.mjs doctor [--run-id ID]
//   node skills/verify-slotwise/scripts/control.mjs cli [--run-id ID] -- <slotwise args...>
//   node skills/verify-slotwise/scripts/control.mjs stop [--run-id ID]
//
// State for a run lives in .verify/runs/<run-id>/ (instance.json, data, logs, evidence). `stop` kills only the
// process group this script started and deletes the run's data, never the evidence directory.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const RUNS = join(ROOT, ".verify", "runs");

export function runDir(runId) {
  return join(RUNS, runId);
}

export function latestRunId() {
  if (!existsSync(RUNS)) return null;
  const dirs = readdirSync(RUNS)
    .filter((d) => existsSync(join(RUNS, d, "instance.json")))
    .sort((a, b) => statSync(join(RUNS, b)).mtimeMs - statSync(join(RUNS, a)).mtimeMs);
  return dirs[0] ?? null;
}

export function readInstance(runId) {
  const id = runId ?? latestRunId();
  if (!id) throw new Error("no instance: run `control.mjs launch` first");
  return JSON.parse(readFileSync(join(runDir(id), "instance.json"), "utf8"));
}

async function freePort(preferred) {
  const tryPort = (p) =>
    new Promise((res) => {
      const s = createServer();
      s.once("error", () => res(null));
      s.listen(p, "127.0.0.1", () => s.close(() => res(p)));
    });
  if (preferred && (await tryPort(preferred))) return preferred;
  for (let p = 8800 + Math.floor(Math.random() * 600); p < 9500; p++) if (await tryPort(p)) return p;
  throw new Error("no free port");
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

async function waitReady(url, ms, logFile) {
  const until = Date.now() + ms;
  let last = "";
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) {
        const h = await r.json();
        // Ready means the database answers and the UI shell is served, not only that a port is open.
        const shell = await fetch(`${url}/app/event-types`).then((x) => x.text());
        if (h.ok && shell.includes('id="app"')) return h;
      }
      last = `status ${r.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`instance not ready after ${ms}ms (${last}). Log: ${logFile}`);
}

export async function launch({ adapter = "node", port, runId } = {}) {
  runId ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${adapter}`;
  const dir = runDir(runId);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  port = await freePort(port ? Number(port) : undefined);
  const url = `http://127.0.0.1:${port}`;
  const key = randomBytes(32).toString("base64");
  const vars = {
    ENCRYPTION_KEY: key,
    ALLOW_SIGNUP: "true",
    MOCK_CALENDAR: "true",
    APP_URL: url,
    RATE_LIMIT_PUBLIC_WRITE: "200",
    RATE_LIMIT_PUBLIC_READ: "2000",
    RATE_LIMIT_AUTH: "100",
  };
  // Build once so the instance serves the current source.
  run("npm", ["run", "build"], { stdio: "pipe" });
  const logFile = join(dir, "server.log");
  const log = openSync(logFile, "a");
  let child;
  if (adapter === "node") {
    child = spawn(process.execPath, ["dist/node.mjs"], {
      cwd: ROOT,
      env: { ...process.env, ...vars, PORT: String(port), HOST: "127.0.0.1", DB_PATH: join(dir, "data", "slotwise.sqlite") },
      stdio: ["ignore", log, log],
      detached: true,
    });
  } else if (adapter === "worker") {
    const persist = join(dir, "data", "wrangler");
    const wrangler = join(ROOT, "node_modules", ".bin", "wrangler");
    run(wrangler, ["d1", "migrations", "apply", "slotwise", "--local", "--persist-to", persist], { env: { ...process.env, CI: "1" } });
    const varArgs = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
    child = spawn(wrangler, ["dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--inspector-port", "0", ...varArgs], {
      cwd: ROOT,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", log, log],
      detached: true,
    });
  } else throw new Error(`unknown adapter ${adapter}`);
  child.unref();
  const inst = { runId, adapter, url, port, pid: child.pid, dir, evidence: join(dir, "evidence"), logFile, startedAt: new Date().toISOString() };
  writeFileSync(join(dir, "instance.json"), JSON.stringify(inst, null, 2));
  try {
    inst.health = await waitReady(url, adapter === "worker" ? 90_000 : 20_000, logFile);
  } catch (e) {
    stop(runId);
    throw e;
  }
  writeFileSync(join(dir, "instance.json"), JSON.stringify(inst, null, 2));
  return inst;
}

export async function doctor(runId) {
  const inst = readInstance(runId);
  const out = { runId: inst.runId, adapter: inst.adapter, url: inst.url, pid: inst.pid, ok: false, checks: {} };
  try {
    process.kill(inst.pid, 0);
    out.checks.process = "alive";
  } catch {
    out.checks.process = "dead";
  }
  try {
    const h = await (await fetch(`${inst.url}/healthz`)).json();
    out.checks.health = h;
    out.checks.adapterMatches = h.adapter === (inst.adapter === "node" ? "sqlite" : "d1");
    out.checks.mockCalendar = h.calendarProviders?.some((p) => p.id === "mock");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    out.checks.versionMatches = h.version === pkg.version;
  } catch (e) {
    out.checks.health = `unreachable: ${e.message}`;
  }
  out.ok = out.checks.process === "alive" && out.checks.adapterMatches === true && out.checks.mockCalendar === true && out.checks.versionMatches === true;
  return out;
}

/** Run the real CLI (bin/slotwise.mjs) against the instance. Returns { args, code, stdout, stderr, json }. */
export function cli(inst, args, env = {}, input = "") {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "slotwise.mjs"), "--url", inst.url, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    input,
    env: { ...process.env, SLOTWISE_CONFIG: join(inst.dir, "cli-config.json"), ...env },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout || r.stderr);
  } catch {}
  return { args, code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

export function stop(runId) {
  const id = runId ?? latestRunId();
  if (!id) return { stopped: false, reason: "no run" };
  const dir = runDir(id);
  const f = join(dir, "instance.json");
  if (!existsSync(f)) return { stopped: false, reason: "no instance.json" };
  const inst = JSON.parse(readFileSync(f, "utf8"));
  let killed = false;
  try {
    process.kill(-inst.pid, "SIGTERM"); // the process group we started (wrangler spawns workerd children)
    killed = true;
  } catch {}
  rmSync(join(dir, "data"), { recursive: true, force: true });
  rmSync(join(dir, "cli-config.json"), { force: true }); // holds an API token for the dead instance
  rmSync(f, { force: true });
  writeFileSync(join(dir, "stopped.json"), JSON.stringify({ ...inst, stoppedAt: new Date().toISOString() }, null, 2));
  return { stopped: killed, runId: id, evidence: inst.evidence };
}

// ---------- CLI entry ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dd = argv.indexOf("--");
  const own = dd >= 0 ? argv.slice(1, dd) : argv.slice(1);
  const flag = (k) => {
    const i = own.indexOf(`--${k}`);
    return i >= 0 ? own[i + 1] : undefined;
  };
  const print = (x) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
  try {
    if (cmd === "launch") print(await launch({ adapter: flag("adapter"), port: flag("port"), runId: flag("run-id") }));
    else if (cmd === "doctor") {
      const d = await doctor(flag("run-id"));
      print(d);
      process.exitCode = d.ok ? 0 : 1;
    } else if (cmd === "cli") {
      const r = cli(readInstance(flag("run-id")), dd >= 0 ? argv.slice(dd + 1) : []);
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      process.exitCode = r.code ?? 1;
    } else if (cmd === "stop") print(stop(flag("run-id")));
    else {
      process.stderr.write("usage: control.mjs launch|doctor|cli|stop (see header)\n");
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`${e.stack ?? e}\n`);
    process.exitCode = 1;
  }
}
