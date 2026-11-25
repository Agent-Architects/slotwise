import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../..");

// Stand-ins for every external command the deploy script runs. The real wrangler is never called and nothing
// leaves this machine: wrangler, npm, npx and curl are shell stubs that log their arguments.
const STUBS: Record<string, string> = {
  wrangler: `#!/usr/bin/env bash
echo "wrangler $*" >> "$STUB_LOG"
case "$1 $2" in
  "whoami --json") echo '{"loggedIn":true,"email":"owner@example.com","accounts":[{"id":"test-account","name":"Test account"}]}' ;;
  "d1 list") echo '[{"name":"slotwise","uuid":"00000000-0000-0000-0000-000000000001"}]' ;;
  "d1 migrations") echo "migrations applied (stub)" ;;
  "secret list")
    case "$STUB_SECRETS" in
      exists) echo '[{"name":"ENCRYPTION_KEY","type":"secret_text"}]' ;;
      notfound) printf 'X [ERROR] Worker "slotwise" not found.\\n\\nIf this is a new Worker, run wrangler deploy first.\\n' >&2; exit 1 ;;
      outage) printf 'X [ERROR] A request to the Cloudflare API failed.\\n  Internal Server Error [code: 10013]\\n' >&2; exit 1 ;;
      ratelimit) printf 'X [ERROR] A request to the Cloudflare API failed.\\n  Too many requests [code: 971]\\n' >&2; exit 1 ;;
    esac ;;
  *)
    if [ "$1" = deploy ]; then
      prev=""
      for a in "$@"; do
        if [ "$prev" = --secrets-file ]; then node -e 'console.log("secrets " + Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))).sort().join(","))' "$a" >> "$STUB_LOG"; fi
        prev="$a"
      done
      echo "Uploaded slotwise (stub)"
      echo "https://slotwise.\${STUB_SUB}.workers.dev"
    fi ;;
esac
`,
  npm: `#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
echo "npm output (stub)"
`,
  npx: `#!/usr/bin/env bash
echo "npx $*" >> "$STUB_LOG"
echo "test output (stub)"
exit "\${STUB_TESTS_EXIT:-0}"
`,
  curl: `#!/usr/bin/env bash
echo '{"ok":true}'
`,
};

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "sw-deploy-"));
  mkdirSync(join(dir, "scripts"));
  cpSync(join(repo, "scripts", "deploy-cloudflare.sh"), join(dir, "scripts", "deploy-cloudflare.sh"));
  cpSync(join(repo, "wrangler.toml"), join(dir, "wrangler.toml"));
  const bin = join(dir, "stub-bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return { dir, bin, log: join(dir, "stub.log") };
}

function deploy(sb: ReturnType<typeof sandbox>, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [join(sb.dir, "scripts", "deploy-cloudflare.sh"), ...args], {
    cwd: sb.dir,
    encoding: "utf8",
    env: {
      PATH: `${sb.bin}:${process.env.PATH}`,
      HOME: sb.dir,
      WRANGLER: join(sb.bin, "wrangler"),
      CLOUDFLARE_API_TOKEN: "invalid-test-token",
      STUB_LOG: sb.log,
      STUB_SUB: "stub-subdomain",
      ...env,
    },
  });
  const calls = existsSync(sb.log) ? readFileSync(sb.log, "utf8") : "";
  return { ...r, calls };
}

const URL_LINE = ["https://slotwise.", "stub-subdomain", ".workers.dev\n"].join("");

describe.skipIf(process.platform === "win32")("scripts/deploy-cloudflare.sh (stub wrangler)", () => {
  it("redeploy of an existing Worker: stdout is only the URL, existing secrets are kept", () => {
    const sb = sandbox();
    const r = deploy(sb, ["--yes"], { STUB_SECRETS: "exists" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(URL_LINE);
    expect(r.stderr).toContain("test output (stub)");
    expect(r.stderr).toContain("migrations applied (stub)");
    expect(r.calls).toContain("npx vitest run");
    expect(r.calls).toMatch(/^secrets $/m);
    expect(existsSync(join(sb.dir, ".deploy", "setup-code"))).toBe(false);
    const cfg = readFileSync(join(sb.dir, "wrangler.local.toml"), "utf8");
    expect(cfg).toMatch(/^workers_dev = true$/m);
    expect(cfg).toMatch(/^preview_urls = true$/m);
    expect(cfg).not.toContain("[[routes]]");
  });

  it("custom domain: the generated config turns off workers.dev and preview URLs and the domain is the URL", () => {
    const sb = sandbox();
    const r = deploy(sb, ["--domain", "book.example.com", "--yes"], { STUB_SECRETS: "exists" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("https://book.example.com\n");
    const cfg = readFileSync(join(sb.dir, "wrangler.local.toml"), "utf8");
    expect(cfg).toMatch(/^workers_dev = false$/m);
    expect(cfg).toMatch(/^preview_urls = false$/m);
    expect(cfg).toContain('[[routes]]\npattern = "book.example.com"\ncustom_domain = true');
    expect(r.calls).toContain("--var APP_URL:https://book.example.com");
    // The committed base config is never edited.
    expect(readFileSync(join(sb.dir, "wrangler.toml"), "utf8")).toBe(readFileSync(join(repo, "wrangler.toml"), "utf8"));
  });

  it("first deploy (wrangler says the Worker is not found) creates ENCRYPTION_KEY and SETUP_CODE", () => {
    const sb = sandbox();
    const r = deploy(sb, ["--yes"], { STUB_SECRETS: "notfound" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(URL_LINE);
    expect(r.calls).toContain("secrets ENCRYPTION_KEY,SETUP_CODE");
    expect(existsSync(join(sb.dir, ".deploy", "setup-code"))).toBe(true);
  });

  for (const mode of ["outage", "ratelimit"]) {
    it(`any other secret list failure (${mode}) stops before changing secrets or code`, () => {
      const sb = sandbox();
      const r = deploy(sb, ["--yes"], { STUB_SECRETS: mode });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("[deploy] ERROR: could not list the Worker's existing secrets");
      expect(r.calls).not.toMatch(/^wrangler deploy/m);
      expect(existsSync(join(sb.dir, ".deploy", "setup-code"))).toBe(false);
    });
  }

  it("failing tests print a deploy error and touch nothing on Cloudflare", () => {
    const sb = sandbox();
    const r = deploy(sb, ["--yes"], { STUB_SECRETS: "exists", STUB_TESTS_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("[deploy] ERROR: tests failed");
    expect(r.calls).not.toMatch(/^wrangler (d1|deploy|secret)/m);
  });

  it("dry run writes its own config and never touches wrangler.local.toml", () => {
    const sb = sandbox();
    const local = join(sb.dir, "wrangler.local.toml");
    writeFileSync(local, "# real deploy config\n");
    const r = deploy(sb, ["--dry-run", "--domain", "book.example.com"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(local, "utf8")).toBe("# real deploy config\n");
    const cfg = readFileSync(join(sb.dir, ".deploy", "dry-run", "wrangler.toml"), "utf8");
    expect(cfg).toContain('database_id = "00000000-0000-0000-0000-000000000000"');
    expect(cfg).toContain('main = "../../src/worker.ts"');
    expect(cfg).toContain('directory = "../../public"');
    expect(cfg).toContain('migrations_dir = "../../migrations"');
    expect(cfg).toContain('pattern = "book.example.com"');
    expect(cfg).toMatch(/^workers_dev = false$/m);
    expect(cfg).toMatch(/^preview_urls = false$/m);
    expect(r.calls).toMatch(/^wrangler deploy --dry-run --config .*\.deploy\/dry-run\/wrangler\.toml --outdir .*\.deploy\/dry-run\/out$/m);
    expect(r.calls).not.toMatch(/whoami|secret|d1 /);
  });
});
