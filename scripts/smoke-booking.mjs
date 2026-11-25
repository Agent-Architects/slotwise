#!/usr/bin/env node
// Booking smoke test against any running Slotwise (Cloudflare, Node, local), through the real CLI.
//
//   node scripts/smoke-booking.mjs --url <APP_URL> --token-file <file>
//   node scripts/smoke-booking.mjs --url <APP_URL> --email owner@example.com --password-file <file>
//   SLOTWISE_TOKEN=... node scripts/smoke-booking.mjs --url <APP_URL>
//   node scripts/smoke-booking.mjs --url <APP_URL>     (uses the token saved by `slotwise login --save` for that URL)
// Options:
//   --invitee-email E       invitee address (default: the owner's own email, so no stranger gets mail)
//   --invitee-name N        default "Slotwise smoke test"
//   --days N                how far ahead to look for a free slot (default 14, max 60)
//   --busy-start ISO --busy-end ISO
//                           also assert that no offered slot overlaps this window (a busy event you created in the
//                           connected calendar), proving the calendar connection hides busy time
//
// It creates a temporary event type (slug smoke-<random>), books its first free slot as an invitee, checks the owner
// sees it, cancels it as the owner, checks the cancellation, and deletes the temporary event type. The owner's
// availability and other event types are not changed. With a connected calendar the booking is written to it and
// removed again on cancel. Prints one JSON summary (no secrets); exit 0 only when every step passed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cli, flatSlots, isoDate, overlaps, parseFlags, recorder, waitHealthy } from "./setup-lib.mjs";

const f = parseFlags(process.argv.slice(2), ["password-stdin"]);
const url = String(f.url ?? process.env.APP_URL ?? process.env.SLOTWISE_URL ?? "").replace(/\/+$/, "");
const out = { ok: false, url };
const rec = recorder();
let token;
let etId;
let booking;
let cancelled = false;

const readSecretFile = (p) => readFileSync(p, "utf8").trim();
function savedLogin() {
  const p = process.env.SLOTWISE_CONFIG ?? join(homedir(), ".config", "slotwise", "config.json");
  if (!existsSync(p)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    return cfg.token && String(cfg.url ?? "").replace(/\/+$/, "") === url ? cfg.token : undefined;
  } catch {
    return undefined;
  }
}
async function stdinLine() {
  let s = "";
  for await (const ch of process.stdin) s += ch;
  return s.split(/\r?\n/)[0];
}

try {
  if (!/^https?:\/\//.test(url)) throw new Error("pass --url https://your-app (or set APP_URL)");
  if ((f["busy-start"] && !f["busy-end"]) || (!f["busy-start"] && f["busy-end"])) throw new Error("--busy-start and --busy-end go together");

  await rec.run("health", async () => {
    const h = await waitHealthy(url, 15000);
    return { adapter: h.adapter, version: h.version, calendarProviders: h.calendarProviders, emailProvider: h.emailProvider };
  });

  token = await rec.run(
    "owner token",
    async () => {
      if (f["token-file"]) return readSecretFile(f["token-file"]);
      if (process.env.SLOTWISE_TOKEN) return process.env.SLOTWISE_TOKEN;
      if (!f.email) {
        // Fall back to the token saved by `slotwise login --save` when it is for this URL.
        const saved = savedLogin();
        if (saved) return saved;
        throw new Error("no credentials: run `node bin/slotwise.mjs --url <APP_URL> login --email <you> --save`, or pass --token-file, set SLOTWISE_TOKEN, or pass --email with --password-file / --password-stdin");
      }
      const password = f["password-file"] ? readSecretFile(f["password-file"]) : f["password-stdin"] ? await stdinLine() : "";
      if (!password) throw new Error("--email needs --password-file or --password-stdin");
      return cli(["login", "--email", f.email, "--password-stdin", "--name", "smoke-test"], { url, input: `${password}\n` }).token;
    },
    () => ({ source: f["token-file"] ? "token file" : process.env.SLOTWISE_TOKEN ? "SLOTWISE_TOKEN" : f.email ? "password exchange" : "saved CLI login", printed: false }),
  );
  const c = (args) => cli(args, { url, token });

  const me = await rec.run("cli whoami", () => c(["whoami"]).user, (u) => ({ username: u.username, timezone: u.timezone }));
  const tz = me.timezone || "UTC";

  const et = await rec.run("cli event-types create (temporary)", () => {
    const slug = `smoke-${randomBytes(3).toString("hex")}`;
    const r = c(["event-types", "create", "--name", "Smoke test (safe to delete)", "--slug", slug, "--duration", "15"]);
    etId = r.eventType.id;
    return { id: r.eventType.id, slug: r.eventType.slug };
  });

  const days = Math.min(Math.max(Number(f.days) || 14, 1), 60);
  const from = isoDate(Date.now(), tz);
  let toMs = Date.now() + days * 86400000;
  if (f["busy-end"]) toMs = Math.max(toMs, Date.parse(f["busy-end"]));
  const to = isoDate(toMs, tz);
  const slots = () => {
    const r = c(["slots", me.username, et.slug, "--from", from, "--to", to, "--timezone", tz]);
    if (r.warnings?.includes("calendar_unavailable")) throw new Error("a connected calendar could not be read (calendar_unavailable); reconnect it under Integrations");
    return flatSlots(r);
  };

  const open = await rec.run("cli slots (public)", () => {
    const s = slots();
    if (!s.length) throw new Error(`no free slots between ${from} and ${to}; check availability (slotwise availability get)`);
    return s;
  }, (s) => ({ count: s.length, first: s[0].start, from, to, timezone: tz }));

  if (f["busy-start"]) {
    await rec.run("busy window hidden", () => {
      const hit = open.filter((s) => overlaps(s, f["busy-start"], f["busy-end"]));
      if (hit.length) throw new Error(`${hit.length} slot(s) overlap the busy window, first ${hit[0].start}; is the calendar connected and checked?`);
      return { busyStart: f["busy-start"], busyEnd: f["busy-end"], overlapping: 0 };
    });
  }

  booking = await rec.run("cli book (invitee)", () => {
    const r = c([
      "book", me.username, et.slug, "--start", open[0].start, "--timezone", tz,
      "--name", String(f["invitee-name"] ?? "Slotwise smoke test"), "--email", String(f["invitee-email"] ?? me.email),
    ]);
    if (r.booking.status !== "confirmed") throw new Error(`status ${r.booking.status}`);
    return r.booking;
  }, (b) => ({ id: b.id, start: b.start, status: b.status }));

  await rec.run("owner sees booking", () => {
    const b = c(["bookings", "get", booking.id]).booking;
    if (b.status !== "confirmed") throw new Error(`owner sees status ${b.status}`);
    if (b.calendarError) throw new Error(`calendar write failed: ${b.calendarError}`);
    return { status: b.status, calendarEvent: b.external ? "written" : "none (no calendar connected, or no write calendar chosen)" };
  });

  await rec.run("slot no longer offered", () => {
    if (slots().some((s) => s.start === booking.start)) throw new Error("booked slot still offered");
    return { start: booking.start };
  });

  await rec.run("cli bookings cancel (owner)", () => {
    const b = c(["bookings", "cancel", booking.id, "--reason", "smoke test"]).booking;
    if (b.status !== "cancelled") throw new Error(`status ${b.status}`);
    cancelled = true;
    return { status: b.status };
  });

  out.ok = true;
  out.booking = { id: booking.id, start: booking.start };
} catch (e) {
  out.error = e.message;
} finally {
  // Leave nothing behind, even after a failure.
  if (token && booking && !cancelled) {
    try {
      cli(["bookings", "cancel", booking.id, "--reason", "smoke test cleanup"], { url, token });
      rec.steps.push({ step: "cleanup: booking canceled", ok: true });
    } catch (e) {
      rec.steps.push({ step: "cleanup: booking cancel", ok: false, error: e.message });
    }
  }
  if (token && etId) {
    try {
      cli(["event-types", "delete", etId], { url, token });
      rec.steps.push({ step: "cleanup: temporary event type deleted", ok: true });
    } catch (e) {
      rec.steps.push({ step: "cleanup: event type delete", ok: false, error: e.message });
      out.ok = false;
    }
  }
  out.steps = rec.steps;
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
