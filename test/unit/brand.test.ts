import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import brandJson from "../../brand.json";
import { buildDeps } from "../../src/config";
import type { Db } from "../../src/core/ports";

const repo = resolve(__dirname, "../..");
// Tests must pass whatever brand the repo currently has (operators apply their own name, colors and SVG or PNG logo
// before deploying), so they run on a temp copy that is first reset to this known brand with the generated logo.
const FIXTURE = "Fixture Brand";
const fixtureRe = new RegExp(FIXTURE, "i");

/** A throwaway copy of everything scripts/brand.mjs reads or writes, exactly as the repo has it now. */
function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "sw-brand-"));
  mkdirSync(join(dir, "scripts"));
  cpSync(join(repo, "scripts", "brand.mjs"), join(dir, "scripts", "brand.mjs"));
  cpSync(join(repo, "brand.json"), join(dir, "brand.json"));
  // Build output is not the brand script's business.
  cpSync(join(repo, "public"), join(dir, "public"), { recursive: true, filter: (src) => !/app\.js(\.map)?$/.test(src) });
  return dir;
}

/** A copy reset to the fixture brand: light theme, default colors and the generated logo. */
function sandbox() {
  const dir = copyRepo();
  const r = run(dir, ["--name", FIXTURE, "--primary", "#0f766e", "--accent", "#f59e0b", "--theme", "light", "--logo", "default"]);
  if (r.status !== 0) throw new Error(`could not reset the brand fixture: ${r.stderr}`);
  return dir;
}

const run = (dir: string, args: string[]) =>
  spawnSync(process.execPath, [join(dir, "scripts", "brand.mjs"), ...args], { cwd: dir, encoding: "utf8" });

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length + 1)] = readFileSync(p, "latin1");
    }
  };
  walk(join(dir, "public"));
  out["brand.json"] = readFileSync(join(dir, "brand.json"), "utf8");
  return out;
}

describe("scripts/brand.mjs", () => {
  it("the committed files are exactly what brand.json produces", () => {
    const dir = copyRepo();
    const before = snapshot(dir);
    const r = run(dir, ["--apply"]);
    expect(r.status, r.stderr).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  it("prints the current brand with no flags and changes nothing", () => {
    const dir = copyRepo();
    const before = snapshot(dir);
    const r = run(dir, []);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).name).toBe(brandJson.name);
    expect(snapshot(dir)).toEqual(before);
  });

  it("renames everywhere, is idempotent, and leaves no old name behind", () => {
    const dir = sandbox();
    const args = ["--name", "Zephyr Calendar", "--primary", "#2563EB", "--accent", "#f97316", "--theme", "auto", "--font", "Georgia, serif"];
    expect(run(dir, args).status).toBe(0);
    const once = snapshot(dir);
    const r2 = run(dir, args);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("updated 0 file(s)");
    expect(snapshot(dir)).toEqual(once);

    for (const [f, text] of Object.entries(once)) expect(text, f).not.toMatch(fixtureRe);
    const brand = JSON.parse(once["brand.json"]!);
    expect(brand).toMatchObject({ name: "Zephyr Calendar", primary: "#2563eb", accent: "#f97316", theme: "auto", font: "Georgia, serif" });
    expect(once["public/index.html"]).toContain("<title>Zephyr Calendar</title>");
    expect(once["public/static/privacy.html"]).toContain("Privacy policy | Zephyr Calendar");
    expect(once["public/index.html"]).toContain('media="(prefers-color-scheme: dark)"');
    const css = once["public/assets/app.css"]!;
    expect(css).toContain("--brand: #2563eb;");
    expect(css).toContain("--font: Georgia, serif;");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css.match(/brand:start/g)).toHaveLength(1);
    expect(once["public/assets/logo.svg"]).toContain('fill="#2563eb"');
    expect(once["public/assets/logo.svg"]).toContain('aria-label="Zephyr Calendar"');
  });

  it("escapes names for HTML and can rename again from the escaped form", () => {
    const dir = sandbox();
    expect(run(dir, ["--name", "Bits & Bobs"]).status).toBe(0);
    expect(readFileSync(join(dir, "public", "index.html"), "utf8")).toContain("<title>Bits &amp; Bobs</title>");
    expect(run(dir, ["--name", "Plain"]).status).toBe(0);
    for (const [f, text] of Object.entries(snapshot(dir))) expect(text, f).not.toMatch(/Bobs/);
    for (const [f, text] of Object.entries(snapshot(dir))) expect(text, f).not.toMatch(fixtureRe);
  });

  it("copies a custom logo, repoints references, and restores the default", () => {
    const dir = sandbox();
    const png = join(dir, "my-logo.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    expect(run(dir, ["--logo", "my-logo.png"]).status).toBe(0);
    expect(existsSync(join(dir, "public", "assets", "logo.svg"))).toBe(false);
    expect(readFileSync(join(dir, "public", "assets", "logo.png"))).toEqual(readFileSync(png));
    const home = readFileSync(join(dir, "public", "static", "home.html"), "utf8");
    expect(home).toContain('href="/assets/logo.png" type="image/png"');
    expect(home).not.toContain("logo.svg");
    expect(JSON.parse(readFileSync(join(dir, "brand.json"), "utf8"))).toMatchObject({ logo: "/assets/logo.png", customLogo: true });
    // A color change keeps the custom logo untouched.
    expect(run(dir, ["--primary", "#111111"]).status).toBe(0);
    expect(readFileSync(join(dir, "public", "assets", "logo.png"))).toEqual(readFileSync(png));

    expect(run(dir, ["--logo", "default"]).status).toBe(0);
    expect(existsSync(join(dir, "public", "assets", "logo.png"))).toBe(false);
    expect(readFileSync(join(dir, "public", "assets", "logo.svg"), "utf8")).toContain('fill="#111111"');
  });

  it("dry run writes nothing; bad input exits 2 and writes nothing", () => {
    const dir = sandbox();
    const before = snapshot(dir);
    const dry = run(dir, ["--name", "Other", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("dry run: would update");
    for (const bad of [["--primary", "blue"], ["--theme", "neon"], ["--font", "x; } body { display: none"], ["--logo", "nope.gif"], ["--name", ""], ["--bogus", "1"]]) {
      expect(run(dir, bad).status, bad.join(" ")).toBe(2);
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it("server copy uses APP_NAME, falling back to brand.json", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const db = {} as Db;
    expect(buildDeps({ ENCRYPTION_KEY: key }, db, "http://localhost").config.appName).toBe(brandJson.name);
    expect(buildDeps({ ENCRYPTION_KEY: key, APP_NAME: "Acme Calendar" }, db, "http://localhost").config.appName).toBe("Acme Calendar");
  });
});
