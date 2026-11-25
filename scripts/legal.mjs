#!/usr/bin/env node
// Fill in the operator details of the public privacy policy and terms pages (public/static/privacy.html and
// terms.html). Google's OAuth consent screen links to them, so fill them before publishing an OAuth app.
//
//   node scripts/legal.mjs                                    show the current values and what is still missing
//   node scripts/legal.mjs --operator "Olive Owner" --contact owner@example.com --site https://book.example.com
//        --hosting cloudflare|node|"<free text>" --email none|resend|"<free text>" [--dry-run]
//
// Re-runnable: each value sits in a <span data-legal="..."> so a later run can change it. Flags you leave out keep
// their current value. Once nothing is missing, the "this is a template" notes are removed. Review the wording
// yourself before publishing; this fills in facts, it is not legal advice. Prints a JSON summary; exit 2 on bad input.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["privacy.html", "terms.html"].map((f) => join(ROOT, "public", "static", f));

// Placeholder text in the shipped templates -> field name.
const PLACEHOLDERS = {
  "[Operator name]": "operator",
  "[contact email]": "contact",
  "[site address]": "site",
  "[hosting provider and database, for example Cloudflare D1 or a SQLite file on our own server]": "hosting",
  '[email provider, or "no email provider: notifications are only logged"]': "email",
};
const HOSTING = { cloudflare: "Cloudflare (Workers with a D1 database)", node: "a SQLite database on our own server" };
// Shown after "Outgoing email:" in the privacy policy.
const EMAIL = { none: "none; notifications are only logged on our server", resend: "Resend (resend.com)" };
const TEMPLATE_COMMENT = /<!--\s*\n\s*TEMPLATE\.[\s\S]*?-->/;
const FILLED_COMMENT = "<!--\n  Operator details filled in by scripts/legal.mjs (re-run it to change them). Review the wording before publishing.\n  The product name is managed by scripts/brand.mjs.\n-->";

function fail(msg) {
  process.stderr.write(`legal: ${msg}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, "");
  if (k === "dry-run") args.dryRun = true;
  else if (["operator", "contact", "site", "hosting", "email"].includes(k) && argv[i].startsWith("--")) {
    if (argv[i + 1] === undefined) fail(`--${k} needs a value`);
    args[k] = String(argv[++i]).trim();
  } else fail(`unknown argument ${argv[i]}`);
}

const values = {};
if ("operator" in args) {
  if (!args.operator || args.operator.length > 120 || /[\u0000-\u001f]/.test(args.operator)) fail("--operator must be 1 to 120 printable characters");
  values.operator = args.operator;
}
if ("contact" in args) {
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(args.contact)) fail("--contact must be an email address");
  values.contact = args.contact;
}
if ("site" in args) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(args.site) ? args.site : `https://${args.site}`);
  } catch {
    fail("--site must be a URL like https://book.example.com");
  }
  values.site = u.origin;
}
if ("hosting" in args) {
  if (!args.hosting || args.hosting.length > 200) fail("--hosting must be cloudflare, node or a short description");
  values.hosting = HOSTING[args.hosting] ?? args.hosting;
}
if ("email" in args) {
  if (!args.email || args.email.length > 200) fail("--email must be none, resend or a short description");
  values.email = EMAIL[args.email] ?? args.email;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const span = (field, v) => `<span data-legal="${field}">${esc(v)}</span>`;

const current = {};
const missing = new Set();
const changed = [];
for (const file of FILES) {
  if (!existsSync(file)) fail(`missing ${file}`);
  const before = readFileSync(file, "utf8");
  let s = before;
  for (const [ph, field] of Object.entries(PLACEHOLDERS)) {
    if (field in values) s = s.split(ph).join(span(field, values[field]));
    else if (s.includes(ph)) missing.add(field);
  }
  s = s.replace(/<span data-legal="(\w+)">([^<]*)<\/span>/g, (m, field, text) => {
    if (field in values) return span(field, values[field]);
    current[field] = unesc(text);
    return m;
  });
  for (const [field, v] of Object.entries(values)) current[field] = v;
  // Every detail is filled in: drop the template notes.
  if (!Object.keys(PLACEHOLDERS).some((p) => s.includes(p))) {
    s = s.replace(/^[ \t]*<p class="template-note">.*<\/p>\r?\n/m, "").replace(TEMPLATE_COMMENT, FILLED_COMMENT);
  }
  if (s !== before) {
    changed.push(file.slice(ROOT.length + 1));
    if (!args.dryRun) writeFileSync(file, s);
  }
}

const summary = { ok: missing.size === 0, dryRun: Boolean(args.dryRun), values: current, missing: [...missing], [args.dryRun ? "wouldUpdate" : "updated"]: changed };
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
