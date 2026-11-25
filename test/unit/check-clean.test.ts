import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../../scripts/check-clean.mjs");

// Fixtures that must be flagged are assembled at runtime from harmless pieces, so this file itself scans clean.
const j = (...parts: string[]) => parts.join("");
const BAD: Record<string, string> = {
  "email outside reserved example domains": j("contact ", "olive", "@", "mail", "provider", ".com"),
  "absolute home path": j("open /", "Users", "/", "olive", "/notes.txt"),
  "tailnet hostname": j("http://box.tail0", "1234", ".ts", ".net:8080"),
  "phone number": j("call +44 20 ", "7946 ", "0958 today"),
  "public IPv4 address": j("ssh root@", "8.8", ".4.4 -p 22"),
  "custom domain in wrangler config": j('routes = [{ pattern = "book.', "acme-widgets", '.com", custom_domain = true }]'),
  "cloudflare account or zone id": j("account_id = ", '"', "0a".repeat(16), '"'),
  "real D1 database_id": j("database_id = ", '"', "9f1c2d3e", "-5a6b-4c7d-8e9f-", "0a1b2c3d4e5f", '"'),
  "secret: Google OAuth client secret": j("GOCSPX", "-", "Ab3".repeat(8)),
  "secret: Google API key": j("AI", "za", "Sy", "B3".repeat(17), "x"),
  "secret: Resend API key": j("RESEND_API_KEY=", "re", "_", "Ab12".repeat(6)),
  "secret: sk- API key": j("sk", "-", "proj", "Q7".repeat(12)),
  "secret: private key block": j("-----BEGIN ", "RSA ", "PRIVATE ", "KEY-----"),
  "secret: Stripe key": j("STRIPE_KEY=", "sk", "_live_", "Ab3".repeat(8)),
  "secret: Slack token": j("SLACK=", "xo", "xb-", "1234567890-", "Ab3".repeat(6)),
  "secret: JWT": j("Bearer ", "ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "c2lnbmF0dXJlX3NpZ25hdHVyZQ"),
  "secret: Cloudflare API token": j("CLOUDFLARE_API_TOKEN", "=", "x9".repeat(20)),
  "domain that is not a reserved example or known public service": j("APP_URL=https://book.", "olive-owner", ".com"),
  "global IPv6 address": j("listen [", "2a01:4f8", ":c17:1234::1]:443"),
  "UUID that is not obviously synthetic": j("user_id: ", "9f1c2d3e", "-5a6b-4c7d-8e9f-", "0a1b2c3d4e5f"),
  "Google OAuth client id": j("123456789012", "-", "abcdefghijklmnop0123456789abcdef", ".apps.", "googleusercontent", ".com"),
  "secret: GitLab token": j("glp", "at-", "Ab3x".repeat(5)),
  "secret: npm token": j("//registry.npmjs.org/:_authToken=", "np", "m_", "Ab3".repeat(12)),
  "secret: Slotwise API token": j("SLOTWISE_TOKEN=", "sw", "_", "Ab3d".repeat(10), "x_Z"),
  "secret: ENCRYPTION_KEY value": j("ENCRYPTION", "_KEY=", "q7Lm".repeat(10), "Zx9", "="),
  "secret: SETUP_CODE value": j("SETUP", "_CODE=", "Qm3x", "Tz8wKp"),
  "secret: password in a config assignment": j("DB_PASS", "WORD=", "Tr0ub4dor", "-x9"),
};
// Extra lines per rule, appended after BAD in this order: [rule, line].
const MORE: [string, string][] = [
  ["phone number", j("(123) ", "456-", "7890")],
  ["phone number", j("Mobile: ", "0912 ", "345 ", "678")],
  ["phone number", j("Office ", "020 ", "7946 ", "0958")],
  ["public IPv4 address", j("http://", "100.101", ".102.103:8787/healthz")],
  ["custom domain in wrangler config", j('route = "', "meet.", "acme-widgets", '.io/*"')],
  ["email outside reserved example domains", j('"olive', ' owner"@', "mailprovider", ".com")],
  ["obfuscated email outside reserved example domains", j("mailto:olive", "%40", "mailprovider", ".com")],
  ["obfuscated email outside reserved example domains", j("olive ", "[at] ", "mailprovider ", "[dot] com")],
  ["obfuscated email outside reserved example domains", j("olive", "(at)", "mailprovider", ".com")],
  ["obfuscated email outside reserved example domains", j("write to olive ", "at ", "mailprovider ", "dot com")],
  ["em dash", j("const title = 'Fast ", "\u2014", " simple';")],
  ["emoji", j("label: 'Booked ", String.fromCodePoint(0x2705), "'")],
  ["emoji", j("// done ", String.fromCodePoint(0x1f389))],
  ["domain that is not a reserved example or known public service", j("https://", "olive-owner", ".me/about")],
  ["domain that is not a reserved example or known public service", j("deployed to slotwise.", "olive", ".workers.dev")],
  ["domain that is not a reserved example or known public service", j("homepage: ", "acme-widgets", ".io")],
  ["public IPv4 address", j("HOST=", "8.8", ".8.8")],
  ["public IPv4 address", j("upstream:", "1.1", ".1.1")],
  // N11 codes (211 to 911) are never area codes, so these cannot be anyone's line. 555-0100 to 555-0199, the range
  // reserved for fiction, is exempt from the rule (see GOOD).
  ["phone number", j("call 311 ", "555 ", "0234")],
  ["phone number", j('<a href="tel:', "3115", "550234", '">')],
  ["absolute home path", j("/mnt/c/", "Users/", "olive/notes")],
  ["absolute home path", j("/Vol", "umes/", "Olive Backup/x")],
  ["absolute home path", j("cp ~", "olive", "/notes.txt .")],
  ["obfuscated email outside reserved example domains", j("olive", "&#64;", "mailprovider", ".com")],
  ["obfuscated email outside reserved example domains", j("olive", "&#x40;", "mailprovider&#46;com")],
  ["cloudflare account or zone id", j("https://dash.", "cloudflare.com/", "0a".repeat(16), "/workers")],
  ["cloudflare account or zone id", j('{"account": {"id": "', "0a".repeat(16), '", "name": "x"}}')],
  ["em dash", j("<p>Fast ", "&md", "ash;", " simple</p>")],
  ["em dash", j("Fast ", "&#", "8212;", " simple")],
  ["emoji", j("label: 'Love ", String.fromCodePoint(0x2764), "'")],
  ["emoji", j("<span>", "&#x", "1F389;", "</span>")],
  ["secret: Tailscale key", j("TS_AUTHKEY=", "tskey", "-auth-", "kAb12CdEf3", "-", "Gh45Ij67Kl89Mn01Op23")],
  ["secret: Telegram bot token", j("BOT_TOKEN=", "1234", "56789", ":AA", "Ab3_x".repeat(6), "Ab3")],
  ["domain that is not a reserved example or known public service", j("Visit ", "Olive-Owner", ".Com today")],
  ["domain that is not a reserved example or known public service", j("bash scripts/deploy-cloudflare.sh --domain book.", "olive", ".app")],
  ["domain that is not a reserved example or known public service", j('fetch("//book.', "olive", '.me/healthz")')],
  ["domain that is not a reserved example or known public service", j("open book.", "olive", ".io:8443 now")],
  ["domain that is not a reserved example or known public service", j("docs at ", "olive", ".sh/start")],
  ["domain that is not a reserved example or known public service", j("Host: ", "olive", ".IO")],
];

// Lines that look similar but must not be flagged.
const GOOD = [
  "owner@example.com Ivy@Example.COM guest@mail.example a@b.test x@host.invalid dev@localhost",
  '"integrity": "sha512-abc+12345678901234/xyzQ+987654321098765==",',
  "starts 2026-11-24T10:00:00+07:00 ends 2026-11-24T10:30:00.000Z",
  "esbuild@0.28.2 preact@11.2.0 version 1.2.3 build 20261124.1",
  "http://127.0.0.1:8787 and localhost:8788",
  "now = 1700000000000; id 123456789012345678",
  'phone: "+1 555 0100" or (212) 555-0123',
  "GET /api/v1/public/users/olive/event-types/30min and /users/me/calendarList",
  j("cd /home/user/app or /Us", "ers/you/slotwise or C:\\Users\\username\\slotwise"),
  'database_id = "00000000-0000-0000-0000-000000000000"',
  "@media (max-width: 900px) { .x { color: red } } @keyframes spin {}",
  "x = a +1000 * 60; y = b + 3_600_000; total +12.5%",
  "hash 0f766e1234abcd5678ef90aa11bb22cc and uuid 12345678-1234-4abc-8def-123456789abc in a log",
  "listen 0.0.0.0:8787, 127.0.0.1, 10.0.0.5, 172.16.4.2, 192.168.1.10, 169.254.1.1, 192.0.2.7, 198.51.100.9, 203.0.113.42",
  "netmask 255.255.255.0; version 1.2.3.4; v10.20.30.40; oid 1.3.6.1.4.1",
  "dates 2026-01-15 01.02.2026 09:00-17:00 time 00 00 00 00 00",
  'workers_dev = true\nroutes = [{ pattern = "book.example.com", custom_domain = true }]',
  'route = "<your-domain>/*" zone_name = "example.org"',
  "served at slotwise.<your-subdomain>.workers.dev or *.workers.dev; look at the code dot by dot; mailto:owner%40example.com; ivy [at] example [dot] com",
  "copyright (c) \u00a9 2026, \u2122, arrows \u2192 \u2194, check \u2713",
  "see section 4.2.1.3 and sections 8.8.4.4; codes 001 002 003 004; order 0123 4567 8901",
  "https://www.googleapis.com/calendar/v3 https://accounts.google.com https://dash.cloudflare.com/ https://github.com/x zoom.us nodejs.org",
  "logger.info(args.site); t.app.request(u.origin); README.md deploy-cloudflare.sh brand.json; the workers.dev URL",
  "cd ~/slotwise; npm i x@~1.2.3 y@^4.0.0; owner&#64;example.com; &copy; &rarr;",
  "docs 2001:db8::1 and 3fff::1, link-local fe80::1, loopback ::1, time 20:30:00, line 2026:12",
  "ids 00000000-0000-0000-0000-000000000000 aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "SETUP_CODE=<setup code> SETUP_CODE=$(node -e x) ENCRYPTION_KEY=$KEY sw_session sw_<token> npm_config_cache",
  "call 415 555 0142 or 415-555-0199; tskey-auth-XXXX; TS_AUTHKEY=tskey-<your key>; chat 12345:AAxyz",
  "const a = obj.io; this.co = 1; t.app.request(); bash setup.sh; x.in(y); props.me.name; data.info; Foo.Dev; rect.io / 2; s.link/2",
];

function repo(files: Record<string, string | Buffer>) {
  const dir = mkdtempSync(join(tmpdir(), "sw-clean-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
const scan = (dir: string, extra: string[] = [], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, "--root", dir, ...extra], { encoding: "utf8", env: { ...process.env, SLOTWISE_DENYLIST: "", ...env } });

describe("scripts/check-clean.mjs", () => {
  it("flags each built-in rule on the right line and never prints the matched text", () => {
    const lines = [...Object.values(BAD), ...MORE.map(([, l]) => l)];
    const rules = [...Object.keys(BAD), ...MORE.map(([r]) => r)];
    // The custom-domain rule only looks at wrangler configs, so scan the same lines under that name too.
    const dir = repo({ "src/fixture.ts": `${lines.join("\n")}\n`, "wrangler.toml": `${lines.join("\n")}\n` });
    const r = scan(dir);
    expect(r.status).toBe(1);
    rules.forEach((rule, i) => {
      const file = rule === "custom domain in wrangler config" ? "wrangler.toml" : "src/fixture.ts";
      expect(r.stdout, `${rule} (line ${i + 1})`).toContain(`${file}:${i + 1}: ${rule}`);
    });
    expect(r.stdout).not.toContain("src/fixture.ts:3: custom domain");
    for (const secret of lines) expect(r.stdout).not.toContain(secret.slice(-12));
  });

  it("passes look-alikes: reserved domains, hashes, dates, versions, ports, timestamps, fictional numbers", () => {
    const dir = repo({ "src/ok.ts": `${GOOD.join("\n")}\n`, "wrangler.toml": `${GOOD.join("\n")}\n`, "package-lock.json": `{\n  ${GOOD[1]}\n}\n` });
    const r = scan(dir);
    expect(r.stdout).toContain("clean: 0 hits");
    expect(r.status).toBe(0);
  });

  it("flags em dashes in every text file", () => {
    const dash = "Fast \u2014 and simple";
    const dir = repo({ "docs/a.md": dash, "public/b.html": dash, "web/c.tsx": dash, "src/d.ts": dash, "public/e.css": `/* ${dash} */`, "public/f.svg": `<title>${dash}</title>` });
    const r = scan(dir);
    for (const f of ["docs/a.md", "public/b.html", "web/c.tsx", "src/d.ts", "public/e.css", "public/f.svg"]) expect(r.stdout).toContain(`${f}:1: em dash`);
  });

  it("treats made-up passwords in code as fine but flags them in config files", () => {
    const pw = j('password: "', "Tr0ub4dor", '-x9"');
    const dir = repo({ "test/a.test.ts": `const owner = { ${pw} };\nconst other = { password: "correct horse battery staple" };\n`, "config/app.yaml": `${pw}\n` });
    const r = scan(dir);
    expect(r.stdout).toContain("config/app.yaml:1: secret: password in a config assignment");
    expect(r.stdout).not.toContain("test/a.test.ts");
  });

  it("checks file names, symlinks and the printable strings of binary files", () => {
    const email = j("olive", "@", "mailprovider", ".com");
    const home = j("/", "Users", "/", "olive", "/Desktop");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), Buffer.from(`Author ${email}`), Buffer.from([0, 0]), Buffer.from(home), Buffer.from([0])]);
    const dir = repo({ [`docs/${email}.md`]: "ok\n", "public/assets/logo.png": png, "src/real.ts": "ok\n" });
    symlinkSync("/etc/hosts", join(dir, "hosts-link"));
    symlinkSync("../../outside", join(dir, "src", "up-link"));
    symlinkSync("real.ts", join(dir, "src", "inside-link"));
    symlinkSync(tmpdir(), join(dir, "node_modules"));
    const r = scan(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`docs/${email}.md:0: email outside reserved example domains (file path)`);
    expect(r.stdout).toContain("public/assets/logo.png:1: email outside reserved example domains");
    expect(r.stdout).toContain("public/assets/logo.png:2: absolute home path");
    expect(r.stdout).toMatch(/binary files \(review manually\):\n {2}public\/assets\/logo\.png/);
    expect(r.stdout).toContain("hosts-link:0: symlink pointing outside the repo");
    expect(r.stdout).toContain("src/up-link:0: symlink pointing outside the repo");
    expect(r.stdout).not.toContain("src/inside-link");
    expect(r.stdout).not.toContain("node_modules");
  });

  it("an allow-list removes a known public value before the rules run", () => {
    const line = j("Co-authored by noreply", "@", "github", ".com");
    const dir = repo({ "docs/a.md": `${line}\n` });
    expect(scan(dir).stdout).toContain("docs/a.md:1: email outside reserved example domains");
    const allow = join(mkdtempSync(join(tmpdir(), "sw-allow-")), "allow.txt");
    writeFileSync(allow, "# public bot address\nnoreply@github\\.com\n");
    const r = scan(dir, ["--allow", allow]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("allow-list loaded");
    expect(scan(dir, [], { SLOTWISE_ALLOWLIST: allow }).status).toBe(0);
  });

  it("skips build output and local state, and lists binary files for manual review", () => {
    const bad = BAD["email outside reserved example domains"]!;
    const dir = repo({
      "node_modules/x/index.js": bad,
      "dist/node.mjs": bad,
      ".wrangler/state.json": bad,
      "data/notes.txt": bad,
      "public/assets/app.js": bad,
      "public/assets/app.js.map": bad,
      "public/assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
      ".env": bad,
      ".dev.vars": bad,
      "wrangler.local.toml": bad,
      "local.sqlite": Buffer.concat([Buffer.from("SQLite format 3"), Buffer.from([0]), Buffer.from(bad), Buffer.from([0])]),
      "README.md": "fine\n",
      "node_modules/.vite/deps/x.js": bad,
      "node_modules/.cache/y.txt": bad,
    });
    const r = scan(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/binary files \(review manually\):\n {2}public\/assets\/logo\.png/);
    expect(r.stderr).toContain("skipped local state (gitignored, not published): .wrangler, data, dist, node_modules/.cache, node_modules/.vite. Use --all");
    const all = scan(dir, ["--all"]);
    expect(all.status).toBe(1);
    for (const f of ["dist/node.mjs", ".wrangler/state.json", "data/notes.txt", ".env", ".dev.vars", "wrangler.local.toml"]) expect(all.stdout).toContain(`${f}:1: email`);
    expect(all.stdout).toContain("local.sqlite:2: email");
    // Tool caches inside node_modules are scanned with --all; the installed packages never are.
    for (const f of ["node_modules/.vite/deps/x.js", "node_modules/.cache/y.txt"]) expect(all.stdout).toContain(`${f}:1: email`);
    expect(all.stdout).not.toContain("node_modules/x/");
    expect(all.stderr).not.toContain("skipped local state");
  });

  it("skips local-state names only at the repo root, publishes .env.example, and scans Playwright's .links with --all", () => {
    const bad = BAD["email outside reserved example domains"]!;
    const dir = repo({
      "src/data/seed.ts": bad,
      "docs/dist/page.md": bad,
      "test/artifacts/x.txt": bad,
      ".env.example": bad,
      ".env.local": bad,
      "node_modules/playwright-core/.local-browsers/.links/abc123": bad,
      "node_modules/playwright-core/.local-browsers/chromium-1/strings.txt": bad,
      "node_modules/playwright-core/index.js": bad,
    });
    const r = scan(dir);
    expect(r.status).toBe(1);
    for (const f of ["src/data/seed.ts", "docs/dist/page.md", "test/artifacts/x.txt", ".env.example"]) expect(r.stdout).toContain(`${f}:1: email`);
    expect(r.stdout).not.toContain(".env.local");
    expect(r.stdout).not.toContain("node_modules/");
    expect(r.stderr).toContain("node_modules/playwright-core/.local-browsers/.links");
    const all = scan(dir, ["--all"]);
    expect(all.stdout).toContain("node_modules/playwright-core/.local-browsers/.links/abc123:1: email");
    expect(all.stdout).toContain(".env.local:1: email");
    // The vendor browser build and the package itself are never scanned.
    expect(all.stdout).not.toContain("chromium-1/");
    expect(all.stdout).not.toContain("node_modules/playwright-core/index.js");
  });

  it("applies a private deny-list case-insensitively, from --denylist or SLOTWISE_DENYLIST, to lines and file names", () => {
    const dir = repo({ "src/a.ts": "const team = 'Acme Widgets';\n", "docs/zebra-notes.md": "ok\n" });
    const deny = join(mkdtempSync(join(tmpdir(), "sw-deny-")), "deny.txt");
    writeFileSync(deny, "# private\n\nacme\\s+widgets\n^zz\\b\nzebra\n");
    const a = scan(dir, ["--denylist", deny]);
    expect(a.status).toBe(1);
    expect(a.stdout).toContain("src/a.ts:1: deny-list line 3");
    expect(a.stdout).toContain("docs/zebra-notes.md:0: deny-list line 5 (file path)");
    expect(a.stdout).not.toContain("Widgets");
    const b = scan(dir, [], { SLOTWISE_DENYLIST: deny });
    expect(b.stdout).toContain("src/a.ts:1: deny-list line 3");
    expect(scan(dir).status).toBe(0);
  });

  it("exits 2 on usage errors", () => {
    const dir = repo({ "a.txt": "x" });
    expect(scan(dir, ["--bogus"]).status).toBe(2);
    expect(scan(dir, ["--denylist", join(dir, "missing.txt")]).status).toBe(2);
    const deny = join(dir, "bad.txt");
    writeFileSync(deny, "(unclosed\n");
    expect(scan(dir, ["--denylist", deny]).status).toBe(2);
  });
});
