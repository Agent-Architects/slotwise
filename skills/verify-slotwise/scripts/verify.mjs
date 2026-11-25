#!/usr/bin/env node
// verify.mjs: drive Slotwise end to end the way owners and invitees do (browser + CLI + HTTP) and record evidence.
//
//   node skills/verify-slotwise/scripts/verify.mjs [--adapter node|worker] [--journeys a,b,...] [--keep] [--headed]
//   node skills/verify-slotwise/scripts/verify.mjs --url http://127.0.0.1:PORT --run-id ID   (reuse a launched instance)
//
// Journeys (feature ids in features/README.md): owner-auth, event-types, availability, invitee-booking,
// manage-booking, meetings, integrations, cli, no-double-booking, security.
// Evidence: .verify/runs/<run-id>/evidence/<journey>/ (screenshots, ARIA snapshots, CLI transcripts) plus
// results.json. Cleanup removes the instance and its data, never the evidence.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cli, launch, readInstance, ROOT, stop } from "./control.mjs";

// The browser lives in node_modules (installed with PLAYWRIGHT_BROWSERS_PATH=0), not in a per-user cache. Playwright
// reads this when it loads, so set it first and import it afterwards; works the same on every OS and shell.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
const { chromium } = await import("@playwright/test");

const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (k) => argv.includes(`--${k}`);
const ALL = ["owner-auth", "event-types", "availability", "schedules", "invitee-booking", "manage-booking", "meetings", "integrations", "cli", "account", "no-double-booking", "security"];
// Run in map order: security exhausts the public write rate limit, so it always runs last.
const selected = (flag("journeys") ?? ALL.join(",")).split(",").sort((x, y) => (ALL.indexOf(x) + 1 || 99) - (ALL.indexOf(y) + 1 || 99));

// Product name as set by scripts/brand.mjs (the web UI reads the same file at build time).
const APP_NAME = JSON.parse(readFileSync(join(ROOT, "brand.json"), "utf8")).name;
const SIGN_IN_HEADING = `Sign in to ${APP_NAME}`;
const OWNER_TZ = "America/New_York";
const INVITEE_TZ = "Europe/Berlin";
const results = [];
let current = "setup";

function check(name, ok, detail) {
  results.push({ journey: current, check: name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} [${current}] ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 400)}` : ""}\n`);
  return Boolean(ok);
}

// Waits briefly for a locator so assertions do not race async rendering.
const visible = (loc, timeout = 8000) => loc.first().waitFor({ state: "visible", timeout }).then(() => true, () => false);

const todayIn = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const fmtUS = (iso, tz) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).replace(" AM", "am").replace(" PM", "pm");
const dateIn = (iso, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

async function main() {
  let inst;
  let launched = false;
  if (flag("url")) inst = { ...readInstance(flag("run-id")), url: flag("url") };
  else {
    inst = await launch({ adapter: flag("adapter") ?? "node" });
    launched = true;
  }
  console.log(`instance ${inst.adapter} ${inst.url} run ${inst.runId}`);
  const ev = (j) => {
    const d = join(inst.evidence, j);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const transcripts = {};
  const runCli = (args, env, input) => {
    const r = cli(inst, args, env, input);
    (transcripts[current] ??= []).push({ cmd: `slotwise ${args.join(" ")}${input ? " <stdin>" : ""}`, code: r.code, stdout: r.stdout, stderr: r.stderr });
    return r;
  };
  const api = async (method, path, body, token) => {
    const res = await fetch(`${inst.url}${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };

  const rid = Math.random().toString(36).slice(2, 8);
  const owner = { email: `owner-${rid}@verify.test`, password: "verify-password-123", name: "Vera Verify", username: `vera-${rid}` };

  let browser;
  try {
    browser = await chromium.launch({ headless: !has("headed") });
  } catch (e) {
    // Do not leave the instance running when the browser cannot start.
    if (launched) stop(inst.runId);
    const first = e.message.split("\n")[0];
    if (/Executable doesn't exist/i.test(e.message)) {
      const where = process.env.PLAYWRIGHT_BROWSERS_PATH === "0" ? "node_modules/playwright-core/.local-browsers" : `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`;
      throw new Error(`Chromium headless shell for this Playwright version is not installed in ${where}.\nInstall it once: PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium-headless-shell\n(${first})`);
    }
    throw new Error(`Chromium is installed but failed to start: ${first}`);
  }
  const ownerCtx = await browser.newContext({ timezoneId: OWNER_TZ, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const invCtx = await browser.newContext({ timezoneId: INVITEE_TZ, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const op = await ownerCtx.newPage();
  const ip = await invCtx.newPage();
  const pageErrors = [];
  for (const p of [op, ip]) p.on("pageerror", (e) => pageErrors.push(`${current}: ${e.message}`));
  const nativeDialogs = [];
  op.on("dialog", (d) => {
    nativeDialogs.push(`${current}:${d.type()}`);
    d.accept();
  });

  const shot = async (page, j, name) => {
    const d = ev(j);
    await page.screenshot({ path: join(d, `${name}.png`), fullPage: true, animations: "disabled" });
    writeFileSync(join(d, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  };

  // The owner account is needed by every journey; owner-auth proves it through the UI.
  let token = null;
  const ensureOwner = async () => {
    if (token) return;
    const r = await api("POST", "/api/v1/auth/signup", { ...owner, timezone: OWNER_TZ });
    if (r.status !== 201 && r.status !== 409) throw new Error(`signup failed ${JSON.stringify(r.body)}`);
    const t = await api("POST", "/api/v1/auth/token", { email: owner.email, password: owner.password, name: "verify" });
    token = t.body.token;
    // log the owner browser in too
    await op.goto(`${inst.url}/login`);
    await op.getByLabel("Email").fill(owner.email);
    await op.getByLabel("Password").fill(owner.password);
    await op.getByRole("button", { name: "Sign in" }).click();
    await op.getByRole("heading", { name: "Scheduling", exact: true }).waitFor();
  };

  const firstSlot = async (slug, skip = 0) => {
    const today = dateIn(new Date().toISOString(), OWNER_TZ);
    const to = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const r = await api("GET", `/api/v1/public/users/${owner.username}/event-types/${slug}/slots?from=${today}&to=${to}&timezone=UTC`);
    return r.body.days.flatMap((d) => d.slots)[skip]?.start;
  };

  const journeys = {
    async "owner-auth"() {
      const j = "owner-auth";
      const publicCtx = await browser.newContext({
        javaScriptEnabled: false,
        colorScheme: "dark",
        reducedMotion: "reduce",
        viewport: { width: 390, height: 844 },
      });
      try {
        const publicPage = await publicCtx.newPage();
        const homepage = await publicPage.goto(inst.url);
        check("public homepage loads without JavaScript or login", homepage?.ok() && await visible(publicPage.getByRole("heading", { name: "Let guests book time with you", exact: true })));
        await shot(publicPage, j, "00-public-home");
        await publicPage.getByRole("link", { name: "Privacy policy" }).click();
        check("privacy policy is public and describes Google Calendar access", await visible(publicPage.getByRole("heading", { name: "Google Calendar access", exact: true })));
        await publicPage.getByRole("link", { name: "Terms of service" }).click();
        check("terms of service are public", await visible(publicPage.getByRole("heading", { name: "Terms of service", exact: true })));
      } finally {
        await publicCtx.close();
      }
      await op.goto(`${inst.url}/signup`);
      await op.getByLabel("Full name").fill(owner.name);
      await op.getByLabel(/Username/).fill(owner.username);
      await op.getByLabel("Email").fill(owner.email);
      await op.getByLabel("Password").fill(owner.password);
      await op.getByRole("combobox", { name: "Time zone" }).selectOption(OWNER_TZ);
      await shot(op, j, "01-signup-filled");
      await op.getByRole("button", { name: "Create account" }).click();
      await op.getByRole("heading", { name: "Scheduling", exact: true }).waitFor();
      check("signup lands on Scheduling", op.url().endsWith("/app/event-types"), op.url());
      check("default event type card", await visible(op.getByRole("link", { name: "30 minute meeting" })));
      await shot(op, j, "02-scheduling");
      await op.getByRole("button", { name: "Account menu" }).click();
      await op.getByRole("menuitem", { name: "Sign out" }).click();
      await op.getByRole("heading", { name: SIGN_IN_HEADING, exact: true }).waitFor();
      check("sign out returns to login", op.url().endsWith("/login"));
      await op.goto(`${inst.url}/app/meetings`);
      await op.getByRole("heading", { name: SIGN_IN_HEADING, exact: true }).waitFor();
      check("protected page redirects to login", op.url().endsWith("/login"));
      await op.getByLabel("Email").fill(owner.email);
      await op.getByLabel("Password").fill("wrong-password-1");
      await op.getByRole("button", { name: "Sign in" }).click();
      check("wrong password shows error", await visible(op.getByRole("alert").filter({ hasText: "Wrong email or password" })));
      await op.getByLabel("Password").fill(owner.password);
      await op.getByRole("button", { name: "Sign in" }).click();
      await op.getByRole("heading", { name: "Scheduling", exact: true }).waitFor();
      check("sign in works", true);
      const t = await api("POST", "/api/v1/auth/token", { email: owner.email, password: owner.password, name: "verify" });
      token = t.body.token;
      check("token exchange", t.status === 201 && /^sw_/.test(token ?? ""), t.status);
    },

    async "event-types"() {
      const j = "event-types";
      await ensureOwner();
      await op.goto(`${inst.url}/app/event-types`);
      await op.getByRole("button", { name: "New event type" }).click();
      await op.getByLabel("Event name *").fill("Verify Consult");
      await op.getByLabel("Description").fill("A verification consult.");
      await op.getByRole("button", { name: "1 hr", exact: true }).click();
      await op.getByLabel("Where the meeting happens").selectOption("in_person");
      await op.getByLabel("Address").fill("Room 4, 1 Main St");
      await op.getByRole("button", { name: "Add question" }).click();
      await op.getByLabel("Question 1 label").fill("What should we cover?");
      await op.locator(".question-row").getByLabel("Required").check();
      await shot(op, j, "01-editor-filled");
      await op.getByRole("button", { name: "Create event type" }).click();
      await op.waitForURL(/\/app\/event-types\/evt_/);
      check("create redirects to editor", /\/app\/event-types\/evt_/.test(op.url()), op.url());
      const got = runCli(["event-types", "get", "verify-consult"], { SLOTWISE_TOKEN: token });
      const e = got.json?.eventType;
      check("stored via API: durations", JSON.stringify(e?.durations) === "[30,60]", e?.durations);
      check("stored via API: location", e?.location?.kind === "in_person" && e?.location?.value === "Room 4, 1 Main St", e?.location);
      check("stored via API: required question", e?.questions?.length === 1 && e.questions[0].required === true, e?.questions);
      await op.goto(`${inst.url}/app/event-types`);
      const card = op.getByRole("listitem", { name: "Verify Consult" });
      check("card listed", await visible(card));
      await card.getByRole("switch").click();
      await op.waitForTimeout(400);
      check("toggle off hides public page", (await api("GET", `/api/v1/public/users/${owner.username}/event-types/verify-consult`)).status === 404);
      await card.getByRole("switch").click();
      await op.waitForTimeout(400);
      check("toggle on restores public page", (await api("GET", `/api/v1/public/users/${owner.username}/event-types/verify-consult`)).status === 200);
      // Long unbroken names must wrap inside the event panel, and initials use letters only.
      const longName = "Supercalifragilisticexpialidocious".repeat(3); // 102 chars, no spaces
      runCli(["event-types", "create", "--name", longName, "--slug", "long-name"], { SLOTWISE_TOKEN: token });
      runCli(["profile", "update", "--name", "Dana 2 Dee"], { SLOTWISE_TOKEN: token });
      await ip.goto(`${inst.url}/${owner.username}/long-name`);
      await ip.getByRole("heading", { name: longName }).waitFor();
      const fits = await ip.locator(".booking-info").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      const nameBox = await ip.getByRole("heading", { name: longName }).boundingBox();
      const infoBox = await ip.locator(".booking-info").boundingBox();
      check("long event name wraps inside the info panel", fits && nameBox.x + nameBox.width <= infoBox.x + infoBox.width + 1, { nameBox, infoBox });
      check("avatar initials are letters only", (await ip.locator(".booking-info .avatar").textContent()) === "DD", await ip.locator(".booking-info .avatar").textContent());
      await shot(ip, j, "03-long-name");
      runCli(["profile", "update", "--name", owner.name], { SLOTWISE_TOKEN: token });
      runCli(["event-types", "delete", "long-name", "--force"], { SLOTWISE_TOKEN: token });
      await op.goto(`${inst.url}/app/event-types`);
      await card.getByRole("button", { name: "Copy link for Verify Consult" }).click();
      check("copy link toast", await visible(op.getByRole("status").filter({ hasText: "Link copied" })));
      await shot(op, j, "02-list");
    },

    async availability() {
      const j = "availability";
      await ensureOwner();
      await op.goto(`${inst.url}/app/availability`);
      await op.getByRole("combobox", { name: "Schedule" }).waitFor();
      await op.getByRole("button", { name: "Remove Friday interval 1" }).click();
      check("Friday shows Unavailable", await visible(op.getByLabel("Friday").getByText("Unavailable")));
      await op.getByLabel("Buffer after (min)").fill("10");
      await op.getByRole("button", { name: "Save", exact: true }).click();
      await op.getByRole("status").filter({ hasText: "Availability saved" }).waitFor();
      const av = runCli(["availability", "get"], { SLOTWISE_TOKEN: token }).json?.availability;
      check("Friday stored empty", Array.isArray(av?.weekly?.["5"]) && av.weekly["5"].length === 0, av?.weekly);
      check("buffer stored", av?.bufferAfter === 10, av?.bufferAfter);
      // Next Saturday at least 2 days out (owner zone)
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 2);
      while (new Date(`${dateIn(d.toISOString(), OWNER_TZ)}T12:00:00Z`).getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
      const sat = dateIn(d.toISOString(), OWNER_TZ);
      await op.getByRole("button", { name: "Add date", exact: true }).click();
      const dlg = op.getByRole("dialog", { name: "Add an exception" });
      await dlg.locator('input[name="overrideDate"]').fill(sat);
      await dlg.getByLabel("Override end 1").fill("12:00");
      await shot(op, j, "01-override-dialog");
      await dlg.getByRole("button", { name: "Apply" }).click();
      await op.getByRole("button", { name: `Remove override ${sat}` }).waitFor();
      check("override listed", true);
      const slots = await api("GET", `/api/v1/public/users/${owner.username}/event-types/30min/slots?from=${sat}&to=${sat}&timezone=${OWNER_TZ}`);
      const starts = slots.body.days[0]?.slots.map((s) => fmtUS(s.start, OWNER_TZ));
      // 30 min slots, 9-12 with 10 min after-buffer applying only against bookings: 6 starts
      check("Saturday override opens 9:00-12:00", JSON.stringify(starts) === JSON.stringify(["9:00am", "9:30am", "10:00am", "10:30am", "11:00am", "11:30am"]), starts);
      await shot(op, j, "02-saved");
      await op.getByRole("button", { name: `Remove override ${sat}` }).click();
      await op.waitForTimeout(300);
      const after = await api("GET", `/api/v1/public/users/${owner.username}/event-types/30min/slots?from=${sat}&to=${sat}&timezone=${OWNER_TZ}`);
      check("removing override closes Saturday", after.body.days.length === 0, after.body.days);
      // restore Friday for later journeys
      runCli(["availability", "set", "--fri", "09:00-17:00", "--buffer-after", "0"], { SLOTWISE_TOKEN: token });
    },

    async schedules() {
      const j = "schedules";
      await ensureOwner();
      await op.goto(`${inst.url}/app/availability`);
      await op.getByRole("button", { name: "Create schedule" }).click();
      const dlg = op.getByRole("dialog", { name: "Create schedule" });
      await dlg.getByLabel("Schedule name").fill("Weekend hours");
      await dlg.getByRole("button", { name: "Create" }).click();
      await op.waitForURL(/schedule=sch_/);
      check("previous schedule is not editable while the new one loads", !(await op.getByRole("heading", { name: "Working hours (default)", exact: true }).isVisible()));
      await op.getByRole("heading", { name: "Weekend hours", exact: true }).waitFor();
      const sid = new URL(op.url()).searchParams.get("schedule");
      await op.waitForFunction((id) => document.querySelector('select[aria-label="Schedule"]')?.value === id, sid, { timeout: 8000 }).catch(() => {});
      check("schedule created and selected", (await op.getByRole("combobox", { name: "Schedule" }).inputValue()) === sid, sid);
      for (const d of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) await op.getByRole("button", { name: `Remove ${d} interval 1` }).click();
      await op.getByRole("button", { name: "Add Saturday interval" }).click();
      await op.getByLabel("Saturday end 1").fill("12:00");
      await op.getByRole("button", { name: "Save", exact: true }).click();
      await op.getByRole("status").filter({ hasText: "Availability saved" }).waitFor();
      await shot(op, j, "01-weekend-schedule");
      const got = runCli(["schedules", "get", sid], { SLOTWISE_TOKEN: token }).json?.schedule;
      check("schedule stored", got?.name === "Weekend hours" && got.weekly["1"].length === 0 && got.weekly["6"][0]?.end === "12:00", got?.weekly);
      runCli(["event-types", "create", "--name", "Weekend Call", "--slug", "weekend-call"], { SLOTWISE_TOKEN: token });
      const etId = runCli(["event-types", "get", "weekend-call"], { SLOTWISE_TOKEN: token }).json?.eventType?.id;
      await op.goto(`${inst.url}/app/event-types/${etId}`);
      await op.getByRole("combobox", { name: "Availability schedule" }).selectOption(sid);
      await op.getByRole("button", { name: "Save changes" }).click();
      await op.getByRole("status").filter({ hasText: "Changes saved" }).waitFor();
      check("event type uses the schedule", runCli(["event-types", "get", "weekend-call"], { SLOTWISE_TOKEN: token }).json?.eventType?.scheduleId === sid);
      const today = dateIn(new Date().toISOString(), OWNER_TZ);
      const to = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
      const sl = await api("GET", `/api/v1/public/users/${owner.username}/event-types/weekend-call/slots?from=${today}&to=${to}&timezone=${OWNER_TZ}`);
      const wd = sl.body.days.map((d) => new Date(`${d.date}T12:00:00Z`).getUTCDay());
      check("weekend schedule offers only Saturdays", wd.length > 0 && wd.every((x) => x === 6), sl.body.days.map((d) => d.date));
      const def = await api("GET", `/api/v1/public/users/${owner.username}/event-types/30min/slots?from=${today}&to=${to}&timezone=${OWNER_TZ}`);
      check("default event type keeps weekday hours", def.body.days.some((d) => new Date(`${d.date}T12:00:00Z`).getUTCDay() !== 6));
      await shot(op, j, "02-editor-schedule");
    },

    async account() {
      const j = "account";
      await ensureOwner();
      const newPw = "changed-password-456";
      await op.goto(`${inst.url}/app/settings`);
      const pf = op.getByRole("form", { name: "Change password" });
      await pf.getByLabel("Current password").fill(owner.password);
      await pf.getByLabel("New password", { exact: true }).fill(newPw);
      await pf.getByLabel("Repeat new password").fill(newPw);
      await pf.getByRole("button", { name: "Change password" }).click();
      await op.getByRole("status").filter({ hasText: "Password changed" }).waitFor();
      check("old password rejected", (await api("POST", "/api/v1/auth/login", { email: owner.email, password: owner.password })).status === 401);
      check("new password works", (await api("POST", "/api/v1/auth/login", { email: owner.email, password: newPw })).status === 200);
      owner.password = newPw;
      check("password change revoked API tokens (checkbox on by default)", (await api("GET", "/api/v1/me", undefined, token)).status === 401);
      token = (await api("POST", "/api/v1/auth/token", { email: owner.email, password: newPw, name: "verify" })).body.token;
      const newEmail = `moved-${rid}@verify.test`;
      const ef = op.getByRole("form", { name: "Change email" });
      await ef.getByLabel("New email").fill(newEmail);
      await ef.getByLabel("Current password").fill(newPw);
      await ef.getByRole("button", { name: "Change email" }).click();
      await op.getByRole("status").filter({ hasText: "Email changed" }).waitFor();
      check("email changed", (await api("GET", "/api/v1/me", undefined, token)).body.user.email === newEmail);
      owner.email = newEmail;
      await shot(op, j, "01-settings-account");
      const cliPw = runCli(["profile", "password", "--password-stdin", "--keep-tokens"], { SLOTWISE_TOKEN: token }, `${newPw}\nstdin-password-789\n`);
      check("CLI password change via stdin (--keep-tokens keeps this token)", cliPw.code === 0 && cliPw.json?.revokedTokens === 0 && (await api("GET", "/api/v1/me", undefined, token)).status === 200, cliPw.stderr);
      owner.password = "stdin-password-789";
      // Host operator reset straight against the database.
      const resetPw = "operator-reset-000";
      const args = inst.adapter === "node"
        ? ["--db", join(inst.dir, "data", "slotwise.sqlite")]
        : ["--d1", "slotwise", "--local", "--persist-to", join(inst.dir, "data", "wrangler")];
      const r = spawnSync(process.execPath, [join(ROOT, "scripts", "admin-reset-password.mjs"), "--email", owner.email, ...args], { encoding: "utf8", input: `${resetPw}\n` });
      (transcripts[j] ??= []).push({ cmd: `admin-reset-password.mjs --email ${owner.email} ${args.join(" ")} <stdin>`, code: r.status, stdout: r.stdout, stderr: r.stderr });
      check("admin reset script", r.status === 0, r.stderr || r.stdout);
      check("reset password works", (await api("POST", "/api/v1/auth/login", { email: owner.email, password: resetPw })).status === 200);
      owner.password = resetPw;
      check("admin reset revoked API tokens", (await api("GET", "/api/v1/me", undefined, token)).status === 401);
      token = (await api("POST", "/api/v1/auth/token", { email: owner.email, password: resetPw, name: "verify" })).body.token;
      await op.goto(`${inst.url}/app/settings`);
      check("browser session revoked by reset", await visible(op.getByRole("heading", { name: SIGN_IN_HEADING, exact: true })));
      await op.getByLabel("Email").fill(owner.email);
      await op.getByLabel("Password").fill(resetPw);
      await op.getByRole("button", { name: "Sign in" }).click();
      await op.getByRole("heading", { name: "Scheduling", exact: true }).waitFor();
    },

    async "invitee-booking"() {
      const j = "invitee-booking";
      await ensureOwner();
      if (!(await api("GET", `/api/v1/public/users/${owner.username}/event-types/verify-consult`)).body?.eventType) {
        runCli(["event-types", "create", "--name", "Verify Consult", "--duration", "30,60", "--location", "in_person:Room 4, 1 Main St", "--questions", '[{"id":"q1","label":"What should we cover?","kind":"text","required":true}]'], { SLOTWISE_TOKEN: token });
      }
      await ip.goto(`${inst.url}/${owner.username}`);
      await ip.getByRole("link", { name: /Verify Consult/ }).waitFor();
      await shot(ip, j, "01-landing");
      await ip.getByRole("link", { name: /Verify Consult/ }).click();
      await ip.getByRole("heading", { name: "Pick a time", exact: true }).waitFor();
      // Product credit: one plain line under the card (not inside it), whole name visible, also on a phone.
      {
        const footerFits = async (page) => {
          const link = page.getByRole("contentinfo").getByRole("link", { name: `Scheduling by ${APP_NAME}`, exact: true });
          if (!(await visible(link))) return { ok: false, why: "footer link missing" };
          const r = await link.evaluate((a) => {
            const main = document.querySelector("main").getBoundingClientRect();
            const f = a.getBoundingClientRect();
            return { below: f.top >= main.bottom, inside: Boolean(a.closest("main")), href: a.getAttribute("href"), fits: a.scrollWidth <= a.clientWidth + 1 && f.right <= window.innerWidth && f.left >= 0 };
          });
          return { ok: r.below && !r.inside && r.href === "/" && r.fits, ...r };
        };
        const desk = await footerFits(ip);
        check(`"Scheduling by ${APP_NAME}" line under the booking card links to /`, desk.ok, desk);
        const phone = await invCtx.newPage();
        await phone.setViewportSize({ width: 390, height: 844 });
        await phone.goto(ip.url());
        await phone.getByRole("heading", { name: "Pick a time", exact: true }).waitFor();
        const small = await footerFits(phone);
        check("product credit fits on a 390 px screen", small.ok, small);
        await shot(phone, j, "01b-phone-footer");
        await phone.close();
      }
      // Out-of-order month replies: the next month's reply is slow; going back before it lands must leave the
      // current month's availability on screen (the late reply is ignored) and no loading state.
      {
        await ip.getByRole("button", { name: /, times available$/ }).first().waitFor();
        const cur = new URL(ip.url()).searchParams.get("month");
        const before = await ip.getByRole("button", { name: /, times available$/ }).count();
        let releaseReply;
        const holdReply = new Promise((resolve) => { releaseReply = resolve; });
        const nextMonthRequest = ip.waitForEvent("request", {
          predicate: (request) => request.url().includes("/event-types/verify-consult/slots?"),
        });
        await ip.route("**/event-types/verify-consult/slots?*", async (route) => {
          await holdReply;
          await route.continue();
        }, { times: 1 });
        try {
          await ip.getByRole("button", { name: "Next month" }).click();
          const late = await nextMonthRequest;
          await ip.getByRole("button", { name: "Previous month" }).click();
          await ip.locator('.month[aria-busy="false"]').waitFor();
          releaseReply();
          const response = await late.response();
          if (!response) throw new Error("The late availability request did not receive a response");
          await response.finished();
          await ip.locator('.month[aria-busy="false"]').waitFor();
          await ip.getByRole("button", { name: /, times available$/ }).first().waitFor();
        } finally {
          releaseReply();
        }
        const after = await ip.getByRole("button", { name: /, times available$/ }).count();
        const busy = await ip.locator(".month").getAttribute("aria-busy");
        check("booking calendar ignores a late reply for another month", new URL(ip.url()).searchParams.get("month") === cur && after === before && before > 0 && busy !== "true", { cur, before, after, busy });
      }
      const day = ip.getByRole("button", { name: /, times available$/ }).first();
      await day.waitFor();
      check("location shown before booking", await visible(ip.getByText("Room 4, 1 Main St")));
      check("time zone auto-detected", (await ip.getByRole("combobox", { name: "Time zone" }).inputValue()) === INVITEE_TZ);
      await day.click();
      const btn = ip.locator(".time-btn").first();
      await btn.waitFor();
      const start = await btn.getAttribute("data-start");
      const label = (await btn.textContent()).trim();
      check("time shown in invitee zone", label === fmtUS(start, INVITEE_TZ), { label, start });
      await shot(ip, j, "02-times");
      // switch zone and back
      await ip.getByRole("combobox", { name: "Time zone" }).selectOption("Asia/Tokyo");
      const tokyoDay = dateIn(start, "Asia/Tokyo");
      await ip.locator(`.day[data-date="${tokyoDay}"]`).click();
      const tokyoLabel = (await ip.locator(`.time-btn[data-start="${start}"]`).textContent())?.trim();
      check("switching zone re-labels the same instant", tokyoLabel === fmtUS(start, "Asia/Tokyo"), { tokyoLabel });
      await ip.getByRole("combobox", { name: "Time zone" }).selectOption(INVITEE_TZ);
      await ip.locator(`.day[data-date="${dateIn(start, INVITEE_TZ)}"]`).click();
      await ip.locator(`.time-btn[data-start="${start}"]`).click();
      await ip.getByRole("button", { name: /^Next: / }).click();
      await ip.getByRole("heading", { name: "Your details", exact: true }).waitFor();
      await ip.getByLabel("Name *").fill("Ina Invitee");
      await ip.getByLabel("Email *").fill(`ina-${rid}@verify.test`);
      await ip.getByRole("button", { name: "Add guests" }).click();
      await ip.getByLabel("Guest emails").fill(`guest-${rid}@verify.test`);
      await ip.getByRole("button", { name: "Book meeting" }).click();
      check("required question blocks submit", await ip.getByRole("heading", { name: "Your details", exact: true }).isVisible());
      // The browser scrolls the invalid field into view; the card must not shift sideways and cut off the left column.
      check("left column stays in view after the validation bubble", (await ip.locator("main.booking").evaluate((el) => el.scrollLeft)) === 0);
      await ip.getByLabel("What should we cover? *").fill("Roadmap");
      await shot(ip, j, "03-form");
      await ip.getByRole("button", { name: "Book meeting" }).click();
      await ip.getByRole("heading", { name: "Booking confirmed", exact: true }).waitFor();
      const url = new URL(ip.url());
      const bookingId = url.pathname.split("/")[2];
      check("confirmation shows time in invitee zone", (await ip.getByTestId("booking-time").textContent()).startsWith(fmtUS(start, INVITEE_TZ)));
      await shot(ip, j, "04-confirmation");
      const b = (await api("GET", `/api/v1/bookings/${bookingId}`, undefined, token)).body?.booking;
      check("owner API sees booking", b?.status === "confirmed" && b.start === start && b.invitee.timezone === INVITEE_TZ, b);
      check("answers and guests stored", b?.answers?.q1 === "Roadmap" || Object.values(b?.answers ?? {}).includes("Roadmap"), b?.answers);
      check("guest stored", b?.guests?.[0] === `guest-${rid}@verify.test`, b?.guests);
      const n = (await api("GET", `/api/v1/notifications?bookingId=${bookingId}`, undefined, token)).body?.items ?? [];
      check("booked emails for invitee, guest and owner", ["invitee", "guest", "owner"].every((a) => n.some((x) => x.kind === "booked" && x.audience === a)), n.map((x) => `${x.kind}:${x.audience}`));
      const pubEt = (await api("GET", `/api/v1/public/users/${owner.username}/event-types/verify-consult`)).body.eventType;
      const tooMany = await api("POST", "/api/v1/public/bookings", { username: owner.username, slug: "verify-consult", start, timezone: "UTC", name: "G", email: `g-${rid}@verify.test`, guests: ["a@x.test", "b@x.test", "c@x.test", "d@x.test"], answers: { [pubEt.questions[0].id]: "x" } });
      check("guests capped per booking (default 3)", pubEt.maxGuests === 3 && tooMany.status === 400 && tooMany.body?.error?.details?.issues?.[0]?.path === "guests", tooMany.body);
      check("guest email goes to the guest without the manage link", n.some((x) => x.audience === "guest" && x.to === `guest-${rid}@verify.test` && !x.body.includes("token=")));
      check("invitee email links to manage page", n.find((x) => x.audience === "invitee")?.body.includes(`/booking/${bookingId}?token=`));
      const again = await api("GET", `/api/v1/public/users/${owner.username}/event-types/verify-consult/slots?from=${dateIn(start, "UTC")}&to=${dateIn(start, "UTC")}&timezone=UTC`);
      check("booked slot no longer offered", !again.body.days.flatMap((d) => d.slots).some((s) => s.start === start));
      writeFileSync(join(ev(j), "booking.json"), JSON.stringify({ booking: b, notifications: n, manageUrl: ip.url() }, null, 2));
      check("API answer carries the question label", b?.answerDetails?.[0]?.label === "What should we cover?", b?.answerDetails);
      await op.goto(`${inst.url}/app/meetings`);
      const mrow = op.getByRole("listitem", { name: "Ina Invitee Verify Consult" });
      await mrow.getByRole("button", { name: "Details" }).click();
      const mtext = await mrow.textContent();
      check("owner Meetings shows the question label, not its id", mtext.includes("What should we cover?") && mtext.includes("Roadmap") && !/\bq[a-z0-9]{5,}\b/.test(mtext), mtext);
      await shot(op, j, "05-owner-details-label");
      journeys._lastManage = ip.url();
    },

    async "manage-booking"() {
      const j = "manage-booking";
      if (!journeys._lastManage) await journeys["invitee-booking"]();
      current = j;
      await ip.goto(journeys._lastManage.replace("&confirmed=1", ""));
      await ip.getByRole("heading", { name: "Your meeting", exact: true }).waitFor();
      const id = new URL(ip.url()).pathname.split("/")[2];
      const before = (await api("GET", `/api/v1/bookings/${id}`, undefined, token)).body.booking;
      await ip.getByRole("link", { name: "Reschedule" }).click();
      await ip.getByText("Moving from").waitFor();
      check("reschedule shows the current time as Moving from", true);
      const days = ip.getByRole("button", { name: /, times available$/ });
      await days.first().waitFor();
      let target = null;
      for (let i = 0; i < (await days.count()) && !target; i++) {
        await days.nth(i).click();
        const btns = ip.locator(".time-btn");
        await btns.first().waitFor();
        for (let k = 0; k < (await btns.count()); k++) {
          const s = await btns.nth(k).getAttribute("data-start");
          if (s !== before.start) {
            target = s;
            await btns.nth(k).click();
            break;
          }
        }
      }
      await ip.getByRole("button", { name: /^Next: / }).click();
      await shot(ip, j, "01-confirm-new-time");
      await ip.getByRole("button", { name: "Reschedule meeting" }).click();
      await ip.getByRole("heading", { name: "Your meeting has a new time", exact: true }).waitFor();
      const after = (await api("GET", `/api/v1/bookings/${id}`, undefined, token)).body.booking;
      check("API shows new start", after.start === target && after.rescheduleCount === 1, { target, got: after.start });
      await shot(ip, j, "02-rescheduled");
      await ip.getByRole("button", { name: "Cancel", exact: true }).click();
      await ip.getByLabel("Why are you canceling? (optional)").fill("Plans changed");
      await ip.getByRole("button", { name: "Cancel meeting" }).click();
      await ip.getByRole("heading", { name: "This meeting is canceled", exact: true }).waitFor();
      const c = (await api("GET", `/api/v1/bookings/${id}`, undefined, token)).body.booking;
      check("API shows canceled by invitee", c.status === "cancelled" && c.cancelledBy === "invitee" && c.cancelReason === "Plans changed", c);
      const kinds = ((await api("GET", `/api/v1/notifications?bookingId=${id}`, undefined, token)).body.items ?? []).map((x) => x.kind);
      check("reschedule and cancel emails recorded (invitee, guest, owner)", kinds.filter((k) => k === "rescheduled").length === 3 && kinds.filter((k) => k === "cancelled").length === 3, kinds);
      await shot(ip, j, "03-canceled");
      const bad = await ip.goto(`${inst.url}/booking/${id}?token=not-the-token-123`);
      await ip.getByRole("heading", { name: "This page is not available", exact: true }).waitFor();
      check("wrong token cannot open booking", bad.ok());
    },

    async meetings() {
      const j = "meetings";
      await ensureOwner();
      const start = await firstSlot("30min", 2);
      const booked = runCli(["book", owner.username, "30min", "--start", start, "--name", "Mo Meeting", "--email", `mo-${rid}@verify.test`, "--timezone", "Asia/Kolkata"]);
      check("invitee CLI booking", booked.code === 0, booked.stderr);
      const id = booked.json?.booking?.id;
      await op.goto(`${inst.url}/app/meetings`);
      const row = op.getByRole("listitem", { name: "Mo Meeting 30 minute meeting" });
      await row.waitFor();
      check("upcoming tab shows meeting", true);
      check("time in owner zone", (await row.locator(".meeting-time").textContent()).startsWith(fmtUS(start, OWNER_TZ)));
      await row.getByRole("button", { name: "Details" }).click();
      check("details show invitee email and zone", (await row.textContent()).includes(`mo-${rid}@verify.test`) && (await row.textContent()).includes("Asia/Kolkata"));
      await shot(op, j, "01-details");
      // Owner reschedule through the in-page dialog.
      const s2 = await firstSlot("30min", 3);
      await row.getByRole("button", { name: "Reschedule" }).click();
      const rd = op.getByRole("dialog", { name: "Reschedule meeting" });
      // Out-of-order replies: the reply for an earlier-picked date arrives last and must not replace the times of
      // the date that is selected now.
      const d2 = dateIn(s2, OWNER_TZ);
      const d1 = new Date(Date.parse(`${d2}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
      await op.route(`**/api/v1/bookings/*/slots?from=${d1}*`, async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      await rd.locator('input[name="newDate"]').fill(d1);
      await rd.locator('input[name="newDate"]').fill(d2);
      await op.waitForTimeout(2200);
      const afterRace = await rd.locator("button.chip").evaluateAll((els) => els.map((e) => e.getAttribute("data-start")));
      const spinning = await rd.getByLabel("Loading").isVisible();
      check("reschedule dialog ignores a late reply for a previous date", !spinning && afterRace.length > 0 && afterRace.every((x) => dateIn(x, OWNER_TZ) === d2), { spinning, afterRace });
      await op.unroute(`**/api/v1/bookings/*/slots?from=${d1}*`);
      await rd.locator('input[name="newDate"]').fill(todayIn(OWNER_TZ));
      // Open on today's times first, then switch date: no time of the previous date may stay visible.
      await rd.locator("button.chip").first().waitFor({ timeout: 5000 }).catch(() => {});
      await rd.locator('input[name="newDate"]').fill(dateIn(s2, OWNER_TZ));
      const shown = await rd.locator("button.chip").evaluateAll((els) => els.map((e) => e.getAttribute("data-start")));
      check("reschedule dialog never shows times of the previous date", shown.every((x) => x && new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(x)) === dateIn(s2, OWNER_TZ)), shown);
      await rd.locator(`button[data-start="${s2}"]`).click();
      await shot(op, j, "02-owner-reschedule");
      await rd.getByRole("button", { name: "Confirm new time" }).click();
      await op.getByRole("status").filter({ hasText: "Meeting rescheduled" }).waitFor();
      const moved = (await api("GET", `/api/v1/bookings/${id}`, undefined, token)).body.booking;
      check("owner reschedule stored", moved.start === s2 && moved.rescheduleCount === 1, moved.start);
      const rmail = ((await api("GET", `/api/v1/notifications?bookingId=${id}`, undefined, token)).body.items ?? []).find((x) => x.kind === "rescheduled" && x.audience === "invitee");
      const link = /\/booking\/[^\s?]+\?token=(\S+)/.exec(rmail?.body ?? "");
      check("owner reschedule email gives the invitee a working manage link", Boolean(link) && (await api("GET", `/api/v1/public/bookings/${id}?token=${link[1]}`)).status === 200, rmail?.body);
      const row2 = op.getByRole("listitem", { name: "Mo Meeting 30 minute meeting" });
      if (!(await visible(row2.getByRole("button", { name: "Cancel meeting" }), 1500))) await row2.getByRole("button", { name: "Details" }).click();
      await row2.getByRole("button", { name: "Cancel meeting" }).click();
      const cd = op.getByRole("dialog", { name: "Cancel meeting" });
      check("cancel uses an in-page dialog", await visible(cd));
      await cd.getByLabel("Message to the invitee (optional)").fill("Owner is unavailable");
      await shot(op, j, "03-cancel-dialog");
      await cd.getByRole("button", { name: "Cancel meeting" }).click();
      await op.getByRole("status").filter({ hasText: "Meeting canceled" }).waitFor();
      const b = (await api("GET", `/api/v1/bookings/${id}`, undefined, token)).body.booking;
      check("owner cancel stored", b.status === "cancelled" && b.cancelledBy === "owner" && b.cancelReason === "Owner is unavailable", b);
      await op.getByRole("link", { name: "Canceled" }).click();
      await op.getByRole("listitem", { name: "Mo Meeting 30 minute meeting" }).waitFor();
      check("canceled tab shows it", true);
      await shot(op, j, "04-canceled-tab");
      await op.getByRole("link", { name: "Date range" }).click();
      const day = dateIn(s2, OWNER_TZ);
      await op.getByLabel("From").fill(day);
      await op.getByLabel("To").fill(day);
      await op.getByRole("button", { name: "Apply" }).click();
      check("date range lists the meeting", await visible(op.getByRole("listitem", { name: "Mo Meeting 30 minute meeting" })));
      await shot(op, j, "05-date-range");
      const csvHref = await op.getByRole("link", { name: "Export CSV" }).getAttribute("href");
      const csv = await op.request.get(`${inst.url}${csvHref}`);
      const csvText = await csv.text();
      writeFileSync(join(ev(j), "export.csv"), csvText);
      check("CSV export of the range", (csv.headers()["content-type"] ?? "").includes("text/csv") && csvText.startsWith("Booking ID,") && csvText.includes("Mo Meeting"), csvText.slice(0, 200));
      const n = (await api("GET", `/api/v1/notifications?bookingId=${id}`, undefined, token)).body.items;
      check("invitee notified of owner cancel", n.some((x) => x.kind === "cancelled" && x.audience === "invitee" && x.body.includes("Owner is unavailable")));
    },

    async integrations() {
      const j = "integrations";
      await ensureOwner();
      await op.goto(`${inst.url}/app/integrations`);
      const g = op.getByRole("region", { name: "Google Calendar" });
      check("Google card says not configured", (await g.textContent()).includes("Not configured on this server"));
      const mock = op.getByRole("region", { name: "Mock Calendar (dev)" });
      await mock.getByRole("button", { name: "Connect" }).click();
      await op.waitForURL(/connected=mock/);
      await op.getByRole("status").filter({ hasText: "Connected mock" }).waitFor();
      check("mock OAuth round trip", true);
      await mock.getByText("owner@mock.example").waitFor();
      await mock.getByLabel("Check Mock primary for conflicts").waitFor();
      check("conflict calendar preselected", await mock.getByLabel("Check Mock primary for conflicts").isChecked());
      await shot(op, j, "01-connected");
      const raw = await api("GET", "/api/v1/integrations", undefined, token);
      check("API never returns tokens", !JSON.stringify(raw.body).includes("accessToken"));
      const s = await firstSlot("30min", 4);
      const busy = runCli(["mock", "busy", "--start", s, "--end", new Date(Date.parse(s) + 30 * 60000).toISOString(), "--summary", "Dentist"], { SLOTWISE_TOKEN: token });
      check("CLI adds busy block", busy.code === 0, busy.stderr);
      const day = dateIn(s, INVITEE_TZ);
      await ip.goto(`${inst.url}/${owner.username}/30min?date=${day}&month=${day.slice(0, 7)}`);
      await ip.locator(".time-btn").first().waitFor();
      check("busy slot hidden in booking UI", (await ip.locator(`.time-btn[data-start="${s}"]`).count()) === 0);
      const s2 = await firstSlot("30min", 6);
      await ip.goto(`${inst.url}/${owner.username}/30min?date=${dateIn(s2, INVITEE_TZ)}&month=${dateIn(s2, INVITEE_TZ).slice(0, 7)}`);
      await ip.locator(`.time-btn[data-start="${s2}"]`).click();
      await ip.getByRole("button", { name: /^Next: / }).click();
      await ip.getByLabel("Name *").fill("Cal Writer");
      await ip.getByLabel("Email *").fill(`cal-${rid}@verify.test`);
      await ip.getByRole("button", { name: "Book meeting" }).click();
      await ip.getByRole("heading", { name: "Booking confirmed", exact: true }).waitFor();
      check("confirmation shows Meet join link", await visible(ip.getByRole("link", { name: /join link/ })));
      await shot(ip, j, "02-confirm-with-link");
      const evs = runCli(["mock", "events"], { SLOTWISE_TOKEN: token }).json?.items ?? [];
      const w = evs.find((e) => e.source === "app" && e.start === s2);
      check("event written to calendar with attendee", w?.attendees?.[0]?.email === `cal-${rid}@verify.test` && /meet\.mock\.invalid/.test(w?.joinUrl ?? ""), w);
      writeFileSync(join(ev(j), "mock-events.json"), JSON.stringify(evs, null, 2));
      // Rescheduling onto a time that overlaps the booking's own calendar event must work (Google reports it busy).
      runCli(["event-types", "create", "--name", "Hour Block", "--slug", "hour-block", "--duration", "60", "--slot-interval", "30"], { SLOTWISE_TOKEN: token });
      const today = dateIn(new Date().toISOString(), OWNER_TZ);
      const hs = (await api("GET", `/api/v1/public/users/${owner.username}/event-types/hour-block/slots?from=${today}&to=${new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)}&timezone=UTC`)).body.days.flatMap((d) => d.slots.map((x) => x.start));
      const h1 = hs.find((x) => hs.includes(new Date(Date.parse(x) + 30 * 60000).toISOString()));
      const hb = runCli(["book", owner.username, "hour-block", "--start", h1, "--name", "Hour Person", "--email", `hour-${rid}@verify.test`, "--timezone", "UTC"]);
      const shifted = new Date(Date.parse(h1) + 30 * 60000).toISOString();
      const rs = runCli(["invitee", "reschedule", hb.json?.booking?.id ?? "x", "--manage-token", hb.json?.manageToken ?? "x", "--start", shifted]);
      check("reschedule onto own calendar event span", rs.code === 0 && rs.json?.booking?.start === shifted, rs.stderr || rs.stdout);
      // ...but a real external event in that span still blocks (only the booking's own event is ignored).
      const busyAt = new Date(Date.parse(shifted) + 30 * 60000).toISOString();
      runCli(["mock", "busy", "--start", shifted, "--end", new Date(Date.parse(shifted) + 60 * 60000).toISOString(), "--summary", "External at the same time"], { SLOTWISE_TOKEN: token });
      const blocked = runCli(["invitee", "reschedule", hb.json?.booking?.id ?? "x", "--manage-token", hb.json?.manageToken ?? "x", "--start", busyAt]);
      check("external event inside the booking's span still blocks a reschedule", blocked.code === 1 && blocked.json?.error?.code === "slot_taken", blocked.stderr || blocked.stdout);
      // Calendar failure: booking pages fail closed, owner sees a banner and an email.
      await api("POST", "/api/v1/dev/mock-calendar/fail", { fail: true }, token);
      const sx = await api("GET", `/api/v1/public/users/${owner.username}/event-types/30min/slots?from=${dateIn(s2, "UTC")}&to=${dateIn(s2, "UTC")}&timezone=UTC`);
      check("slots hidden while calendar is down", sx.body.days.length === 0 && sx.body.warnings?.[0] === "calendar_unavailable", sx.body);
      const bx = await api("POST", "/api/v1/public/bookings", { username: owner.username, slug: "30min", start: await firstSlot("30min", 7).catch(() => s2) ?? s2, timezone: "UTC", name: "X", email: `x-${rid}@verify.test` });
      check("booking refused with 503 calendar_unavailable", bx.status === 503 && bx.body?.error?.code === "calendar_unavailable", bx.status);
      await ip.goto(`${inst.url}/${owner.username}/30min`);
      check("invitee sees calendar unavailable message", await visible(ip.getByRole("alert").filter({ hasText: "calendar is not reachable" })));
      await shot(ip, j, "03-calendar-down-invitee");
      await op.goto(`${inst.url}/app/meetings`);
      check("owner banner about the calendar names the provider", await visible(op.getByRole("alert").filter({ hasText: "Mock Calendar (dev) (owner@mock.example) is not responding" })));
      await shot(op, j, "04-calendar-down-owner");
      const ce = ((await api("GET", "/api/v1/notifications", undefined, token)).body.items ?? []).filter((x) => x.kind === "calendar_error");
      check("owner emailed once about the calendar", ce.length === 1, ce.length);
      await api("POST", "/api/v1/dev/mock-calendar/fail", { fail: false }, token);
      await api("GET", `/api/v1/public/users/${owner.username}/event-types/30min/slots?from=${dateIn(s2, "UTC")}&to=${dateIn(s2, "UTC")}&timezone=UTC`);
      await op.goto(`${inst.url}/app/meetings`);
      await op.getByRole("heading", { name: "Meetings", exact: true }).waitFor();
      check("banner clears after recovery", !(await visible(op.getByRole("alert").filter({ hasText: "is not responding" }), 1500)));
    },

    async cli() {
      await ensureOwner();
      const login = runCli(["login", "--email", owner.email, "--password-stdin", "--name", "verify-cli", "--save"], {}, `${owner.password}\n`);
      check("login --password-stdin --save", login.code === 0 && login.json?.saved, login.stderr);
      const who = runCli(["whoami"]);
      check("whoami with saved config", who.code === 0 && who.json?.user?.username === owner.username, who.stderr);
      const links = runCli(["links"]);
      check("links include profile url", links.json?.profileUrl === `${inst.url}/${owner.username}`, links.json);
      const set = runCli(["availability", "set", "--mon", "08:00-12:00,13:00-18:00", "--min-notice", "120"]);
      check("availability set", set.code === 0 && set.json?.availability?.weekly?.["1"]?.length === 2 && set.json.availability.minNotice === 120, set.stderr);
      const od = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
      const ov = runCli(["availability", "override", "set", od, "off"]);
      check("override set off", ov.json?.availability?.overrides?.[od]?.length === 0, ov.stderr);
      check("override remove", runCli(["availability", "override", "remove", od]).json?.availability?.overrides?.[od] === undefined);
      const c = runCli(["event-types", "create", "--name", "CLI Sync", "--duration", "15,45", "--location", "zoom:https://zoom.us/j/123456", "--max-per-day", "3"]);
      check("event-types create", c.code === 0 && c.json?.eventType?.slug === "cli-sync" && c.json.eventType.maxPerDay === 3, c.stderr);
      const u = runCli(["event-types", "update", "cli-sync", "--description", "From the CLI", "--default-duration", "45"]);
      check("event-types update", u.json?.eventType?.defaultDuration === 45 && u.json.eventType.description === "From the CLI", u.stderr);
      check("event-types list", (runCli(["event-types", "list"]).json?.items ?? []).some((e) => e.slug === "cli-sync"));
      const pub = await api("GET", `/api/v1/public/users/${owner.username}/event-types/cli-sync`);
      check("zoom link hidden publicly", !JSON.stringify(pub.body).includes("zoom.us"));
      const today = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      const sl = runCli(["slots", owner.username, "cli-sync", "--from", today, "--to", to, "--timezone", "UTC", "--duration", "15"]);
      const start = sl.json?.days?.[0]?.slots?.[0]?.start;
      check("public slots via CLI", sl.code === 0 && Boolean(start), sl.stderr);
      const bk = runCli(["book", owner.username, "cli-sync", "--start", start, "--duration", "15", "--name", "Cli Invitee", "--email", `cli-${rid}@verify.test`, "--timezone", "UTC"]);
      check("book via CLI", bk.code === 0 && bk.json?.booking?.location?.value === "https://zoom.us/j/123456", bk.stderr);
      const dup = runCli(["book", owner.username, "cli-sync", "--start", start, "--duration", "15", "--name", "Dup", "--email", `dup-${rid}@verify.test`, "--timezone", "UTC"]);
      check("double booking refused with exit 1 and slot_taken", dup.code === 1 && dup.json?.error?.code === "slot_taken", { code: dup.code, err: dup.stderr });
      const id = bk.json?.booking?.id;
      const mt = bk.json?.manageToken;
      check("invitee show", runCli(["invitee", "show", id, "--manage-token", mt]).json?.booking?.id === id);
      const list = runCli(["bookings", "list", "--event-type", "cli-sync"]);
      check("bookings list filtered", list.json?.items?.length === 1 && list.json.items[0].id === id, list.json);
      const cancel = runCli(["bookings", "cancel", id, "--reason", "cli test"]);
      check("owner cancel via CLI", cancel.json?.booking?.status === "cancelled", cancel.stderr);
      check("canceled list", (runCli(["bookings", "list", "--status", "cancelled"]).json?.items ?? []).some((b) => b.id === id));
      check("disable event type", runCli(["event-types", "disable", "cli-sync"]).json?.eventType?.active === false);
      const usage = runCli(["bookings", "frobnicate"]);
      check("usage error exits 2 with JSON", usage.code === 2 && usage.json?.error?.code === "usage", usage);
      const tl = runCli(["tokens", "list"]);
      check("tokens list hides secrets", tl.code === 0 && !tl.stdout.includes(token) && tl.json.items.length >= 2, tl.stderr);
      check("health", runCli(["health"]).json?.ok === true);
      runCli(["event-types", "create", "--name", "Daily One", "--slug", "daily-one", "--max-per-day", "1"]);
      const d1 = runCli(["slots", owner.username, "daily-one", "--from", today, "--to", to, "--timezone", OWNER_TZ]).json?.days?.find((d) => d.slots.length > 1);
      const first = runCli(["book", owner.username, "daily-one", "--start", d1.slots[0].start, "--name", "One", "--email", `one-${rid}@verify.test`, "--timezone", "UTC"]);
      const second = runCli(["book", owner.username, "daily-one", "--start", d1.slots[1].start, "--name", "Two", "--email", `two-${rid}@verify.test`, "--timezone", "UTC"]);
      check("daily limit reports limit_reached", first.code === 0 && second.code === 1 && second.json?.error?.code === "limit_reached", second.stderr);
      const all = runCli(["bookings", "list", "--status", "all", "--limit", "2", "--all"]);
      check("bookings list --all follows the cursor", all.code === 0 && all.json.items.length > 2 && all.json.nextCursor === null, all.json?.items?.length);
      const page = runCli(["bookings", "list", "--status", "all", "--limit", "1"]);
      check("API page returns nextCursor", typeof page.json?.nextCursor === "string");
      const csv = runCli(["bookings", "export", "--status", "all"]);
      check("bookings export prints CSV", csv.code === 0 && csv.stdout.startsWith("Booking ID,"), csv.stderr);
    },

    async "no-double-booking"() {
      await ensureOwner();
      const start = await firstSlot("30min", 8);
      const N = 25;
      const res = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          api("POST", "/api/v1/public/bookings", { username: owner.username, slug: "30min", start, timezone: "UTC", name: `Racer ${i}`, email: `race${i}-${rid}@verify.test` }),
        ),
      );
      const codes = res.map((r) => r.status);
      check(`${N} concurrent requests: exactly one 201`, codes.filter((c) => c === 201).length === 1, codes);
      check("all others 409 slot_taken", res.filter((r) => r.status === 409 && r.body?.error?.code === "slot_taken").length === N - 1, codes);
      const list = (await api("GET", `/api/v1/bookings?status=upcoming&from=${encodeURIComponent(start)}&to=${encodeURIComponent(new Date(Date.parse(start) + 60000).toISOString())}`, undefined, token)).body.items;
      check("one stored booking at that start", list.length === 1, list.map((b) => b.invitee.email));
      writeFileSync(join(ev("no-double-booking"), "codes.json"), JSON.stringify({ start, codes }, null, 2));
    },

    async security() {
      await ensureOwner();
      const noCsrf = await op.request.patch(`${inst.url}/api/v1/me`, { data: { name: "Hacked" } });
      check("cookie mutation without CSRF token is 403", noCsrf.status() === 403, noCsrf.status());
      const t = await api("POST", "/api/v1/auth/token", { email: owner.email, password: owner.password, name: "to-revoke", scopes: ["read"] });
      check("read token cannot write", (await api("POST", "/api/v1/event-types", { name: "x" }, t.body.token)).status === 403);
      runCli(["tokens", "revoke", t.body.apiToken.id], { SLOTWISE_TOKEN: token });
      check("revoked token is 401", (await api("GET", "/api/v1/me", undefined, t.body.token)).status === 401);
      const h = await fetch(`${inst.url}/app/event-types`);
      check("CSP and frame headers on pages", (h.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"), h.headers.get("content-security-policy"));
      check("unknown API path is 404", (await api("GET", "/api/v1/definitely-not-here")).status === 404);
      const bt = await api("PATCH", "/api/v1/availability", { weekly: { "1": [{ start: "25:00", end: "26:00" }] } }, token);
      check("invalid time is 400", bt.status === 400 && bt.body?.error?.code === "bad_request", bt.status);
      let hit = 0;
      let retry = null;
      // On Node, a client-chosen cf-connecting-ip/x-real-ip must not reset the limit (no trusted proxy configured).
      const spoof = inst.adapter === "node";
      // The limit is a fixed 60 s window. Start the burst early in a window so it cannot straddle a boundary
      // (a straddling burst splits its count over two windows and may never reach the limit).
      const intoWindow = Date.now() % 60_000;
      if (intoWindow > 30_000) await new Promise((r) => setTimeout(r, 60_000 - intoWindow + 250));
      for (let i = 0; i < 260 && !hit; i++) {
        const r = await fetch(`${inst.url}/api/v1/public/bookings`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(spoof ? { "cf-connecting-ip": `203.0.113.${i % 250}`, "x-real-ip": `198.51.100.${i % 250}` } : {}) },
          body: "{}",
        }).then(async (x) => ({ status: x.status, headers: x.headers }));
        if (r.status === 429) {
          hit = i + 1;
          retry = r.headers.get("retry-after");
        }
      }
      check(`public writes rate limited (429 with Retry-After)${spoof ? " despite spoofed IP headers" : ""}`, hit > 0 && Boolean(retry), { hit, retry });
    },
  };

  try {
    for (const name of selected) {
      current = name;
      if (!journeys[name]) {
        check("journey exists", false, `unknown journey ${name}`);
        continue;
      }
      try {
        await journeys[name]();
      } catch (e) {
        check("journey completed", false, e.message.split("\n")[0]);
        const p = name.includes("invitee") || name.includes("manage") ? ip : op;
        await shot(p, name, "zz-failure").catch(() => {});
      }
    }
    current = "browser";
    check("no uncaught page errors", pageErrors.length === 0, pageErrors);
    check("no window.prompt dialogs", !nativeDialogs.some((d) => d.endsWith(":prompt")), nativeDialogs);
  } finally {
    await browser.close();
    for (const [j, t] of Object.entries(transcripts)) writeFileSync(join(ev(j), "cli-transcript.json"), JSON.stringify(t, null, 2));
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    const summary = { runId: inst.runId, adapter: inst.adapter, url: inst.url, journeys: selected, passed, failed, results, finishedAt: new Date().toISOString() };
    writeFileSync(join(inst.evidence, "results.json"), JSON.stringify(summary, null, 2));
    console.log(`\n${passed} passed, ${failed} failed. Evidence: ${inst.evidence}`);
    if (launched && !has("keep")) console.log(`cleanup: ${JSON.stringify(stop(inst.runId))}`);
    process.exitCode = failed ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
