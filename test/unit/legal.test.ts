import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../..");

// The live pages may already be filled in by the operator, so the script is tested on template fixtures.
const placeholders = (extra: string) =>
  `This site is operated by [Operator name] at [site address]. Contact [Operator name] at [contact email].${extra}`;
const template = (title: string, body: string) => `<!doctype html>
<html lang="en">
<!--
  TEMPLATE. Replace every [bracketed] placeholder before publishing.
-->
<head><title>${title}</title></head>
<body>
  <article>
    <p class="template-note">This page is a template.</p>
    <p>${body}</p>
  </article>
</body>
</html>
`;

function sandbox(fromRepo = false) {
  const dir = mkdtempSync(join(tmpdir(), "sw-legal-"));
  mkdirSync(join(dir, "scripts"));
  cpSync(join(repo, "scripts", "legal.mjs"), join(dir, "scripts", "legal.mjs"));
  if (fromRepo) {
    cpSync(join(repo, "public", "static"), join(dir, "public", "static"), { recursive: true });
    return dir;
  }
  mkdirSync(join(dir, "public", "static"), { recursive: true });
  writeFileSync(
    join(dir, "public", "static", "privacy.html"),
    template(
      "Privacy policy",
      placeholders(
        ' Data is stored in [hosting provider and database, for example Cloudflare D1 or a SQLite file on our own server]. Outgoing email: [email provider, or "no email provider: notifications are only logged"].',
      ),
    ),
  );
  writeFileSync(join(dir, "public", "static", "terms.html"), template("Terms of service", placeholders("")));
  return dir;
}
const run = (dir: string, args: string[]) => spawnSync(process.execPath, [join(dir, "scripts", "legal.mjs"), ...args], { cwd: dir, encoding: "utf8" });
const page = (dir: string, f: string) => readFileSync(join(dir, "public", "static", f), "utf8");

describe("scripts/legal.mjs", () => {
  it("reports every missing detail of an unfilled template", () => {
    const r = run(sandbox(), []);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, missing: ["operator", "contact", "site", "hosting", "email"] });
  });

  it("reads the live pages, filled or not, without changing them", () => {
    const dir = sandbox(true);
    const before = page(dir, "privacy.html");
    const r = run(dir, []);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.updated).toEqual([]);
    // Either still a template (with its note) or completely filled in.
    if (out.ok) expect(before).not.toContain("template-note");
    else expect(before).toContain("template-note");
    expect(page(dir, "privacy.html")).toBe(before);
  });

  it("fills every placeholder, drops the template notes, escapes HTML, and can change a value later", () => {
    const dir = sandbox();
    const r = run(dir, ["--operator", "Olive & Co", "--contact", "owner@example.com", "--site", "book.example.com", "--hosting", "node", "--email", "none"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, missing: [], values: { site: "https://book.example.com" } });
    for (const f of ["privacy.html", "terms.html"]) {
      const html = page(dir, f);
      expect(html, f).not.toMatch(/\[[A-Za-z][^\]]*\]|template-note|TEMPLATE/);
      expect(html, f).toContain('<span data-legal="operator">Olive &amp; Co</span>');
    }
    expect(page(dir, "privacy.html")).toContain("a SQLite database on our own server");
    expect(page(dir, "privacy.html")).toContain('Outgoing email: <span data-legal="email">none; notifications are only logged on our server</span>.');
    expect(run(dir, ["--operator", "Ivy Invitee"]).status).toBe(0);
    expect(page(dir, "terms.html")).toContain('<span data-legal="operator">Ivy Invitee</span>');
    const again = run(dir, ["--operator", "Ivy Invitee"]);
    expect(JSON.parse(again.stdout).updated).toEqual([]);
  });

  it("dry run writes nothing; bad input exits 2", () => {
    const dir = sandbox();
    const before = page(dir, "privacy.html");
    expect(run(dir, ["--operator", "X", "--dry-run"]).status).toBe(0);
    expect(page(dir, "privacy.html")).toBe(before);
    for (const bad of [["--contact", "nope"], ["--site", "http://"], ["--operator", ""], ["--bogus", "1"]]) expect(run(dir, bad).status, bad.join(" ")).toBe(2);
  });
});
