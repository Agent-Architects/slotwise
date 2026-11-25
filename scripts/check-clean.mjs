#!/usr/bin/env node
// Pre-publish scan for personal data, secrets and account identifiers in this repo.
//
//   node scripts/check-clean.mjs [--denylist <file>] [--allow <file>] [--root <dir>] [--all]
//
// Built-in rules are generic and always on: emails outside the reserved example domains (also quoted, %40, &#64;
// and [at]/(at) spellings), absolute home directories (/Users, /home, C:\Users, /mnt/c/Users, /Volumes, ~name/),
// tailnet hostnames, domains that are not reserved examples or well-known public services (URLs and bare
// hostnames, including real <name>.workers.dev subdomains), phone numbers (international, North American with
// dashes, dots or spaces, tel: links, national 0-prefixed), public IPv4 and global IPv6 addresses, custom domains in
// wrangler configs, Cloudflare account/zone ids, a real D1 database_id and other non-synthetic UUIDs, Google OAuth
// client ids, common secret shapes (Google, Resend, OpenAI-style, Stripe, Slack, GitHub, GitLab, npm, AWS, JWT,
// private keys, Cloudflare tokens, Tailscale keys, Telegram bot tokens, Slotwise API tokens, ENCRYPTION_KEY and
// SETUP_CODE values, passwords in config
// assignments), em dashes and emojis in any text file (also as HTML entities). Every rule also runs on each file
// path. Symlinks that point outside the repo are flagged. Binary files get the email, home-path, domain and secret
// rules on their printable strings and are listed for review by hand.
//
// An optional private deny-list (--denylist or env SLOTWISE_DENYLIST) adds one case-insensitive regular expression
// per line; blank lines and lines starting with # are ignored. Keep that file outside the repo: it names what must
// not appear here. An optional allow-list (--allow or env SLOTWISE_ALLOWLIST, same format) removes matching text
// before the rules run, for a known public value a rule flags, e.g. a line `noreply@github\.com` keeps that
// address. Allow the narrowest pattern you can.
//
// Local state is gitignored and skipped by default: the directories dist, data, .setup, .deploy, .verify, .vitest,
// .wrangler, artifacts, test-results and playwright-report at the repo root (a folder with one of those names deeper
// down is source and is scanned), plus public/assets/app.js(.map), .env* (except .env.example, which is published),
// .dev.vars, wrangler.local.toml and *.sqlite* files. A warning names the skipped directories that exist. --all scans
// all of it too (SQLite files by their printable strings). Tool caches inside node_modules (.vite, .vite-temp,
// .vitest-cache, .cache, .mf, and playwright-core/.local-browsers/.links, where a PLAYWRIGHT_BROWSERS_PATH=0 browser
// install records this checkout's absolute path) can hold copies of source, paths and test output: they get the same
// warning and --all scans them. The browser builds next to .links are vendor downloads and, like the rest of
// node_modules and .git, are never scanned.
//
// Prints `file:line: <rule>` per hit (never the matched text, so secrets do not end up in logs), then binary files
// to review by hand. Exit 0 clean, 1 hits found, 2 usage error.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isIPv6 } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`--${k} needs a value`);
  return v;
};
function usage(msg) {
  process.stderr.write(`check-clean: ${msg}\nusage: node scripts/check-clean.mjs [--denylist <file>] [--allow <file>] [--root <dir>] [--all]\n`);
  process.exit(2);
}
for (const a of argv) if (a.startsWith("--") && !["--denylist", "--allow", "--root", "--all"].includes(a)) usage(`unknown option ${a}`);
const ALL = argv.includes("--all");

const ROOT = resolve(flag("root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

// Never part of the published source: dependencies and git internals (always skipped), plus build output, local run
// state and gitignored secrets (skipped unless --all).
const ALWAYS_SKIP_DIRS = new Set(["node_modules", ".git"]);
const LOCAL_STATE_DIRS = new Set(["dist", ".wrangler", ".verify", ".vitest", ".deploy", "data", "test-results", "playwright-report", ".setup", "artifacts"]);
const NODE_MODULES_CACHES = [".cache", ".mf", ".vite", ".vite-temp", ".vitest-cache", "playwright-core/.local-browsers/.links"];
const SKIP_FILES = new Set(["public/assets/app.js", "public/assets/app.js.map", ".dev.vars", "wrangler.local.toml"]);
const skipFile = (rel) =>
  !ALL && (SKIP_FILES.has(rel) || (/^\.env(\..*)?$/.test(basename(rel)) && basename(rel) !== ".env.example") || /\.sqlite(-\w+|\.key)?$/.test(rel));
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".ttf", ".otf", ".woff", ".woff2", ".pdf", ".zip", ".gz", ".tgz", ".wasm", ".sqlite", ".db"]);

// ---------- built-in rules ----------
const RESERVED_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
// Well-known public services this project links to (a host matches the entry or any subdomain of it).
const PUBLIC_DOMAINS = [
  "google.com", "googleapis.com", "googleusercontent.com", "gstatic.com", "cloudflare.com", "resend.com", "nodejs.org",
  "npmjs.org", "npmjs.com", "nodesource.com", "github.com", "githubusercontent.com", "caddyserver.com", "zoom.us", "w3.org", "schema.org",
  "json-schema.org", "mozilla.org", "ietf.org", "iana.org", "rfc-editor.org", "playwright.dev", "vitest.dev",
  "hono.dev", "preactjs.com", "esbuild.github.io", "typescriptlang.org", "sqlite.org", "letsencrypt.org", "systemd.io",
  // Funding links in package-lock.json.
  "opencollective.com", "tidelift.com", "paypal.me",
];
// Only the bare platform name may appear; <name>.workers.dev is someone's account.
const PLATFORM_DOMAINS = new Set(["workers.dev", "pages.dev"]);
// Top-level domains a bare hostname (no scheme) must end in to count, so code like `logger.info`, `args.site` or
// `README.md` stays out. Any TLD counts after a scheme (https://...) or www.
const BARE_TLDS = new Set("com net org us uk de fr nl eu ca au ch se nz es biz xyz".split(" "));
// TLDs that are also common property names or file extensions (`obj.io`, `this.co`, `t.app`, `setup.sh`): a bare
// hostname with one of these counts only in a host-like place: after //, before a :port or /path, or after a
// host-ish key such as `domain:`, `host=`, `--site ` or `homepage:`.
const HOST_TLDS = new Set("io dev co me app sh in ai so to ly gg cc tv fm info site online tech cloud page link".split(" "));
const HOST_KEY_BEFORE = /(?:\b(?:host|hostname|domain|domains|server_name|zone|origin|site|url|homepage|website)\b["'`]?\s*[:=]?|--(?:domain|site|url|host)[= ]?)\s*["'`]?$/i;
// Generic stand-ins that are not anyone's account name.
const PLACEHOLDER_USERS = new Set(["user", "username", "you", "yourname", "your-name", "your_user", "me", "name", "example", "runner", "ubuntu", "node", "app", "root", "shared"]);
// Values that are clearly not a real secret: placeholders, variables, redactions.
const PLACEHOLDER_VALUE = /^(?:[$<{%*.]|\[|x{3,}|changeme|change-me|your[-_]|example|placeholder|redacted|secret$|password$|\.\.\.)/i;

function domainAllowed(host) {
  const h = host.toLowerCase();
  if (RESERVED_DOMAIN.test(h) || PLATFORM_DOMAINS.has(h)) return true;
  return PUBLIC_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

// Public IPv4: not private (RFC 1918), loopback, this-network, link-local, documentation, benchmarking or multicast.
function isPublicV4([a, b, c]) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

// A UUID nobody was issued: all zeros, the 12345678-1234-... pattern, or every group one repeated digit.
const syntheticUuid = (u) => {
  const s = u.toLowerCase();
  return /^0{8}-/.test(s) || s.startsWith("12345678-1234-") || s.split("-").every((g) => new Set(g).size === 1) || new Set(s.replace(/-/g, "")).size <= 2;
};

// &#64; &#x40; &commat; and friends, decoded so the email, em dash and emoji rules see the real character.
const NAMED = { commat: "@", mdash: "\u2014", period: ".", hearts: "\u2665" };
const decodeEntities = (s) =>
  s.replace(/&#x([0-9a-f]{1,6});|&#(\d{1,7});|&(commat|mdash|period|hearts);/gi, (m, hx, dec, name) => {
    const cp = hx ? parseInt(hx, 16) : dec ? Number(dec) : null;
    if (cp !== null) return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    return NAMED[name.toLowerCase()];
  });

// Pictographs that read as emoji even without U+FE0F (hearts, stars, weather, hands, faces...). Typographic symbols
// such as (c), (R), TM, arrows and the plain check mark pass.
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[\u2600-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]/u;
const emojiChar = (s) => {
  for (const m of s.matchAll(new RegExp(EMOJI_RE.source, "gu"))) {
    const c = m[0].codePointAt(0);
    if (c === 0x2713 && !m[0].includes("\uFE0F")) continue; // plain check mark
    if (/\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(m[0])) return true;
  }
  return false;
};

const RULE_EMAIL = "email outside reserved example domains";
/** @type {{ name: string, binary?: boolean, test: (line: string, ctx: { rel: string }) => boolean }[]} */
const RULES = [
  {
    name: RULE_EMAIL,
    binary: true,
    test: (line) => {
      for (const m of line.matchAll(/(?:"[^"@\n]{1,64}"|[A-Za-z0-9._%+${}-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g)) {
        if (!RESERVED_DOMAIN.test(m[1])) return true;
      }
      return false;
    },
  },
  {
    name: "obfuscated email outside reserved example domains",
    binary: true,
    test: (line) => {
      const decoded = decodeEntities(line);
      const domains = [
        ...[...line.matchAll(/[A-Za-z0-9._+-]+%40((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g)].map((m) => m[1]),
        // HTML entities: name&#64;example.com, name&#x40;example&#46;com, name&commat;example.com
        ...(decoded !== line ? [...decoded.matchAll(/[A-Za-z0-9._+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g)].map((m) => m[1]) : []),
        // name [at] example [dot] com, name(at)example.com, name {at} example . com
        ...[...line.matchAll(/[A-Za-z0-9._+-]+\s*[[({]at[\])}]\s*([A-Za-z0-9-]+(?:\s*(?:[[({]dot[\])}]|\.)\s*[A-Za-z0-9-]+)+)/gi)].map((m) => m[1]),
        // name at example dot com (spelled-out separators only, so prose like "served at example.com" stays out)
        ...[...line.matchAll(/[A-Za-z0-9._+-]+\s+at\s+([A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+)+)/gi)].map((m) => m[1]),
      ];
      return domains.some((d) => {
        const host = d.replace(/\s*(?:[[({]dot[\])}]|\bdot\b)\s*/gi, ".").replace(/\s*\.\s*/g, ".").toLowerCase();
        return /\.[a-z]{2,}$/.test(host) && !RESERVED_DOMAIN.test(host);
      });
    },
  },
  {
    name: "absolute home path",
    binary: true,
    test: (line) => {
      const users = [
        ...[...line.matchAll(/(?<![\w.~-])\/Users\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]),
        ...[...line.matchAll(/\/mnt\/[a-z]\/Users\/([A-Za-z0-9._ -]+?)(?=\/|["'\s]|$)/g)].map((m) => m[1]),
        ...[...line.matchAll(/(?<![\w.:~/-])\/home\/([a-z_][a-z0-9_.-]*)/g)].map((m) => m[1]),
        ...[...line.matchAll(/\b[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._ -]+?)(?=\\|["'\s]|$)/g)].map((m) => m[1]),
        // ~name/ (another user's home); ~/ and npm ranges like ~1.2.3 pass.
        ...[...line.matchAll(/(?<![\w~$])~([a-z_][a-z0-9_.-]*)\//gi)].map((m) => m[1]),
      ];
      if (users.some((u) => !PLACEHOLDER_USERS.has(u.toLowerCase()) && !/^(public|default|all users|shared)$/i.test(u))) return true;
      // External disks on macOS carry the owner's chosen volume name.
      return [...line.matchAll(/(?<![\w.~-])\/Volumes\/([A-Za-z0-9._ -]+)/g)].some((m) => !/^(your[-_ ]?\w*|name|disk|volume|<)/i.test(m[1]));
    },
  },
  { name: "tailnet hostname", binary: true, test: (line) => /\b[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.ts\.net\b/i.test(line) },
  {
    name: "domain that is not a reserved example or known public service",
    binary: true,
    test: (line) => {
      for (const m of line.matchAll(/(?<![\w.@%$-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+([A-Za-z]{2,24}))(?![\w-]|\.[A-Za-z0-9])/g)) {
        const [, host, tldRaw] = m;
        const tld = tldRaw.toLowerCase();
        const before = line.slice(0, m.index);
        const afterScheme = /[a-z][a-z0-9+.-]*:\/\/$/i.test(before) || /^www\./i.test(host);
        const hostLike = /\/\/$/.test(before) || /^(?::\d{2,5}(?!\d)|\/(?:[A-Za-z~%_-]|$|[\s"'`)]))/.test(line.slice(m.index + host.length)) || HOST_KEY_BEFORE.test(before);
        const platformSub = [...PLATFORM_DOMAINS].some((d) => host.toLowerCase().endsWith(`.${d}`));
        if (!afterScheme && !platformSub && !BARE_TLDS.has(tld) && !(HOST_TLDS.has(tld) && hostLike)) continue;
        if (!domainAllowed(host)) return true;
      }
      return false;
    },
  },
  {
    name: "phone number",
    test: (line) => {
      const candidates = [
        // International: +CC then groups. The + must not sit inside a base64/hash or an arithmetic expression.
        ...line.matchAll(/(?<![A-Za-z0-9/+=_.-])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![A-Za-z0-9/+=_]|[.-]\d)/g),
        // North American 3-3-4 digit groups with dashes or dots (required, so ids and timestamps pass).
        ...line.matchAll(/(?<![\w.:/+-])(?:\(\d{3}\) ?|\d{3}[.-])\d{3}[.-]\d{4}(?![\w.:-]?\d)/g),
        // North American with spaces: valid area code and exchange (first digit 2-9), so counters like 001 002 003 pass.
        ...line.matchAll(/(?<![\w.:/+-]|\d )[2-9]\d{2} [2-9]\d{2} \d{4}(?![\w.:-]?\d| \d)/g),
        // tel: links and phone-like keys with a plain run of digits.
        ...line.matchAll(/\btel:\+?[\d().-]{7,}/gi),
        ...line.matchAll(/\b(?:phone|tel|mobile|cell)["']?\s*[:=]\s*["']?\+?\d{10,15}(?!\d)/gi),
        // National format: a trunk 0, a non-zero digit, then separated groups (0xxx xxx xxx, 0xx xxxx xxxx).
        ...[...line.matchAll(/(?<![\w.:/+-]|\d )\(?0[1-9]\d{0,3}\)?(?:[ .-]\d{2,4}){2,4}(?![\w.:-]?\d| \d)/g)].filter((m) => {
          const n = m[0].replace(/\D/g, "").length;
          return n >= 10 && n <= 11;
        }),
      ];
      return candidates.some((m) => {
        const digits = m[0].replace(/\D/g, "");
        if (digits.length < 9 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return false;
        // 555-0100 to 555-0199 is the fictional range reserved for examples.
        return !/55501\d\d$/.test(digits);
      });
    },
  },
  {
    name: "public IPv4 address",
    binary: true,
    test: (line) => {
      for (const m of line.matchAll(/(?<![\w.~^-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w-]|\.\d)/g)) {
        const parts = m.slice(1, 5);
        if (parts.some((p) => p.length > 1 && p.startsWith("0"))) continue;
        const o = parts.map(Number);
        if (o.some((x) => x > 255)) continue;
        // Version-like and numbered-section strings: "version 1.2.3.4", "node 22.13.0.1", "section 4.2.1.3".
        const before = line.slice(0, m.index);
        if (/\b(v|ver|version|release|build|node|npm)\s*[:=]?\s*["']?$/i.test(before)) continue;
        if (/(\b(sections?|chapter|clause|step|item|figure|table|rule|part|appendix|oid)|\u00a7)\s*$/i.test(before)) continue;
        if (isPublicV4(o)) return true;
      }
      return false;
    },
  },
  {
    name: "global IPv6 address",
    binary: true,
    test: (line) => {
      for (const m of line.matchAll(/(?<![\w:.])[23][0-9a-f]{3}:[0-9a-f:]*[0-9a-f:](?![\w:])/gi)) {
        const ip = m[0];
        if (!isIPv6(ip) || (!ip.includes("::") && ip.split(":").length !== 8)) continue;
        // Documentation ranges: 2001:db8::/32 and 3fff::/20.
        if (/^2001:0?db8:/i.test(ip) || /^3fff:0?[0-9a-f]{0,2}[0-9a-f]?(:|$)/i.test(ip)) continue;
        return true;
      }
      return false;
    },
  },
  {
    name: "custom domain in wrangler config",
    test: (line, { rel }) => {
      if (!/(^|\/)wrangler[^/]*\.(toml|jsonc?)$/i.test(rel)) return false;
      for (const m of line.matchAll(/["']?\b(pattern|route|routes|custom_domain|zone_name)["']?\s*[:=]\s*\[?\s*["']([^"']+)["']/gi)) {
        if (/[<>{}$]/.test(m[2])) continue; // template placeholder
        const host = m[2].replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0].replace(/^\*\.?/, "").toLowerCase();
        if (host && !RESERVED_DOMAIN.test(host)) return true;
      }
      return false;
    },
  },
  {
    name: "cloudflare account or zone id",
    binary: true,
    test: (line) =>
      /(account|zone)[ _-]?id["']?\s*[:=]\s*["']?[0-9a-f]{32}(?![0-9a-f])/i.test(line) ||
      /dash\.cloudflare\.com\/[0-9a-f]{32}(?![0-9a-f])/i.test(line) ||
      /"account"\s*:\s*\{[^}]*"id"\s*:\s*"[0-9a-f]{32}"/i.test(line),
  },
  {
    name: "real D1 database_id",
    test: (line) => {
      const m = /database_id["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(line);
      return Boolean(m) && !syntheticUuid(m[1]);
    },
  },
  {
    name: "UUID that is not obviously synthetic",
    binary: true,
    test: (line) => [...line.matchAll(/(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi)].some((m) => !syntheticUuid(m[0])),
  },
  { name: "Google OAuth client id", binary: true, test: (line) => /\b\d{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com\b/i.test(line) },
  { name: "secret: Google OAuth client secret", binary: true, test: (line) => /GOCSPX-[A-Za-z0-9_-]{10,}/.test(line) },
  { name: "secret: Google API key", binary: true, test: (line) => /AIza[0-9A-Za-z_-]{35}/.test(line) },
  { name: "secret: Resend API key", binary: true, test: (line) => /\bre_(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{20,}/.test(line) },
  { name: "secret: sk- API key", binary: true, test: (line) => /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/.test(line) },
  { name: "secret: Stripe key", binary: true, test: (line) => /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/.test(line) },
  { name: "secret: Slack token", binary: true, test: (line) => /\bxox[abpr]-[A-Za-z0-9-]{10,}/.test(line) },
  { name: "secret: JWT", binary: true, test: (line) => /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(line) },
  { name: "secret: private key block", binary: true, test: (line) => /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----/.test(line) },
  {
    name: "secret: Cloudflare API token",
    binary: true,
    test: (line) => /(CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_KEY|api[_-]?token)["']?\s*[:=]\s*["']?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/i.test(line),
  },
  { name: "secret: GitHub token", binary: true, test: (line) => /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/.test(line) },
  { name: "secret: GitLab token", binary: true, test: (line) => /\bglpat-[A-Za-z0-9_-]{20,}/.test(line) },
  { name: "secret: npm token", binary: true, test: (line) => /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/.test(line) },
  { name: "secret: AWS access key", binary: true, test: (line) => /\bAKIA[0-9A-Z]{16}\b/.test(line) },
  // tskey-auth-<id>-<secret>, tskey-api-..., tskey-client-... and the older tskey-<id>-<secret>.
  { name: "secret: Tailscale key", binary: true, test: (line) => /\btskey-(?:[a-z]+-)?(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]{6,}-[A-Za-z0-9]{10,}/.test(line) },
  { name: "secret: Telegram bot token", binary: true, test: (line) => /(?<![\w:])\d{8,10}:AA[\w-]{33}(?![\w-])/.test(line) },
  // Slotwise API tokens: "sw_" + 32 random bytes in base64url (src/core/service.ts).
  { name: "secret: Slotwise API token", binary: true, test: (line) => /\bsw_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/.test(line) },
  // 32 random bytes in base64, as the deploy and setup scripts generate it.
  { name: "secret: ENCRYPTION_KEY value", binary: true, test: (line) => /ENCRYPTION_KEY["']?\s*[:=]\s*["']?[A-Za-z0-9+/]{43}=/.test(line) },
  {
    name: "secret: SETUP_CODE value",
    binary: true,
    test: (line) => {
      const m = /(?:^|[\s"'`;])(?:export\s+)?SETUP_CODE(?:=|"\s*:\s*")["']?([^\s"'`]+)/.exec(line);
      return Boolean(m) && m[1].length >= 6 && !PLACEHOLDER_VALUE.test(m[1]);
    },
  },
  {
    name: "secret: password in a config assignment",
    binary: true,
    test: (line, { rel }) => {
      // Env-file style anywhere (DB_PASSWORD=..., export SMTP_PASS=...).
      const env = /(?:^|\s)(?:export\s+)?[A-Z0-9_]*PASS(?:WORD|WD)?[A-Z0-9_]*=(["']?)([^\s"']+)\1/.exec(line);
      if (env && env[2].length >= 6 && !PLACEHOLDER_VALUE.test(env[2])) return true;
      // password: value / "password": "value" in config files only (code and tests use made-up passwords).
      if (!/(^|\/)(\.env[^/]*|\.dev\.vars|[^/]+\.(toml|ya?ml|ini|conf|cfg|properties|json|jsonc))$/i.test(rel)) return false;
      const cfg = /["']?\b[\w.-]*pass(?:word|wd)?["']?\s*[:=]\s*["']?([^\s"',}]+)/i.exec(line);
      return Boolean(cfg) && cfg[1].length >= 6 && !PLACEHOLDER_VALUE.test(cfg[1]) && !/^(true|false|null|\d+)$/i.test(cfg[1]);
    },
  },
  { name: "em dash", test: (line) => line.includes("\u2014") || /&(?:mdash|#8212|#x0*2014);/i.test(line) },
  // Emoji-presentation characters, a pictograph forced to emoji style (U+FE0F), pictographs from the emoji blocks
  // (e.g. U+2764), also as HTML entities. Plain (c), (R), TM, arrows and the check mark pass.
  { name: "emoji", test: (line) => emojiChar(line.includes("&") ? decodeEntities(line) : line) },
];

// ---------- private deny-list and allow-list ----------
function patterns(file, what) {
  const path = resolve(file.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!existsSync(path)) usage(`${what} not found: ${file}`);
  const out = [];
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const pat = raw.trim();
      if (!pat || pat.startsWith("#")) return;
      try {
        out.push({ line: i + 1, re: new RegExp(pat, "gi") });
      } catch (e) {
        usage(`${what} line ${i + 1} is not a valid regular expression (${e.message})`);
      }
    });
  return out;
}
const denyFile = flag("denylist") ?? process.env.SLOTWISE_DENYLIST;
if (denyFile) {
  // Report the line number only, so the private pattern itself is not echoed into logs.
  for (const { line, re } of patterns(denyFile, "deny-list")) {
    const once = new RegExp(re.source, "i");
    RULES.push({ name: `deny-list line ${line}`, binary: true, test: (text) => once.test(text) });
  }
}
const allowFile = flag("allow") ?? process.env.SLOTWISE_ALLOWLIST;
const ALLOW = allowFile ? patterns(allowFile, "allow-list").map((p) => p.re) : [];
const allowed = (line) => ALLOW.reduce((s, re) => s.replace(re, " "), line);

// ---------- scan ----------
const hits = [];
const binaries = [];
const skippedState = [];

function isBinary(buf, rel) {
  if (BINARY_EXT.has(extname(rel).toLowerCase())) return true;
  return buf.subarray(0, 8192).includes(0);
}

function check(lines, rel, rules) {
  const ctx = { rel };
  lines.forEach((raw, i) => {
    const line = allowed(raw);
    for (const rule of rules) if (rule.test(line, ctx)) hits.push(`${rel}:${i + 1}: ${rule.name}`);
  });
}

function scanFile(abs, rel) {
  const buf = readFileSync(abs);
  if (isBinary(buf, rel)) {
    binaries.push(rel);
    // Printable runs of 6+ characters (like strings(1)); line numbers count those runs.
    const strings = buf.toString("latin1").match(/[\x20-\x7e]{6,}/g) ?? [];
    check(strings, rel, RULES.filter((r) => r.binary));
    return;
  }
  check(buf.toString("utf8").split(/\r?\n/), rel, RULES);
}

function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs).split(sep).join("/");
    // Dependencies and git internals, also when node_modules is a symlink (pnpm, shared installs).
    if (ALWAYS_SKIP_DIRS.has(name)) continue;
    const st = lstatSync(abs);
    // Every rule also runs on the path itself (a personal name, a domain or an email in a file name).
    const path = allowed(rel);
    for (const rule of RULES) if (rule.test(path, { rel })) hits.push(`${rel}:0: ${rule.name} (file path)`);
    if (st.isSymbolicLink()) {
      // Linked content is scanned where it lives inside the repo; a link out of the repo is flagged.
      const target = readlinkSync(abs);
      const to = relative(ROOT, resolve(dirname(abs), target));
      if (isAbsolute(target) || to.startsWith("..") || isAbsolute(to)) hits.push(`${rel}:0: symlink pointing outside the repo`);
      continue;
    }
    if (st.isDirectory()) {
      if (dir === ROOT && LOCAL_STATE_DIRS.has(name) && !ALL) {
        skippedState.push(name);
        continue;
      }
      walk(abs);
    } else if (st.isFile() && !skipFile(rel)) scanFile(abs, rel);
  }
}

if (!existsSync(ROOT)) usage(`root not found: ${ROOT}`);
walk(ROOT);
// Tool caches under node_modules (only a real node_modules directory, not a shared or linked one).
const nodeModules = join(ROOT, "node_modules");
if (existsSync(nodeModules) && lstatSync(nodeModules).isDirectory()) {
  for (const name of NODE_MODULES_CACHES) {
    const abs = join(nodeModules, name);
    if (!existsSync(abs) || !lstatSync(abs).isDirectory()) continue;
    if (ALL) walk(abs);
    else skippedState.push(`node_modules/${name}`);
  }
}

if (skippedState.length) {
  process.stderr.write(`check-clean: warning: skipped local state (gitignored, not published): ${skippedState.join(", ")}. Use --all to scan it too.\n`);
}
for (const h of hits) process.stdout.write(`${h}\n`);
if (binaries.length) process.stdout.write(`\nbinary files (review manually):\n${binaries.map((b) => `  ${b}`).join("\n")}\n`);
process.stdout.write(`\n${hits.length ? `${hits.length} hit(s)` : "clean: 0 hits"} (${RULES.length} rules${denyFile ? ", deny-list loaded" : ""}${ALLOW.length ? ", allow-list loaded" : ""})\n`);
process.exit(hits.length ? 1 : 0);
