// Shared helpers for scripts/setup-local.mjs and scripts/smoke-booking.mjs. Every owner/invitee action goes through
// the real CLI (bin/slotwise.mjs) so the CLI path is exercised; only signup and the OAuth browser hop use fetch.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function parseFlags(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) out[k] = a.slice(eq + 1);
    else if (booleans.includes(k)) out[k] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

/**
 * Runs `node bin/slotwise.mjs <args>` and returns parsed JSON. `input` goes to stdin (passwords). Throws with the
 * CLI's JSON error on a non-zero exit. The CLI config file is isolated so a user's saved login is never read.
 */
export function cli(args, { url, token, input, configPath } = {}) {
  const env = { ...process.env, SLOTWISE_CONFIG: configPath ?? join(ROOT, ".setup", "cli-config.json") };
  if (url) env.SLOTWISE_URL = url;
  if (token) env.SLOTWISE_TOKEN = token;
  else delete env.SLOTWISE_TOKEN;
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "slotwise.mjs"), ...args], { cwd: ROOT, env, input: input ?? "", encoding: "utf8" });
  if (r.status !== 0) {
    let err;
    try {
      err = JSON.parse(r.stderr.trim().split("\n").pop());
    } catch {
      err = { error: { message: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 500) } };
    }
    const e = new Error(`slotwise ${args.slice(0, 2).join(" ")}: ${err?.error?.message ?? JSON.stringify(err)}`);
    e.cli = err;
    throw e;
  }
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}

export const isoDate = (ms, tz = "UTC") =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

export const flatSlots = (r) => (r?.days ?? []).flatMap((d) => d.slots);

export const overlaps = (slot, start, end) => Date.parse(slot.start) < Date.parse(end) && Date.parse(slot.end) > Date.parse(start);

export async function waitHealthy(url, ms = 20000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`${url}/healthz did not answer (${last})`);
}

/**
 * Collects named checks; `run` records pass/fail and rethrows so the caller can stop and clean up. `view` picks what
 * goes into the printed summary, so secrets returned by a step are never recorded.
 */
export function recorder() {
  const steps = [];
  return {
    steps,
    async run(step, fn, view = (d) => d) {
      try {
        const value = await fn();
        const detail = view(value);
        steps.push({ step, ok: true, ...(detail !== undefined ? { detail } : {}) });
        return value;
      } catch (e) {
        steps.push({ step, ok: false, error: e.message });
        throw e;
      }
    },
  };
}
