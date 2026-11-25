#!/usr/bin/env node
// Runs the CLI bundle, building it from src/cli on first use so a fresh clone works after `npm install`.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist", "cli.mjs");
if (!existsSync(bundle)) {
  const esbuild = join(root, "node_modules", ".bin", "esbuild");
  if (!existsSync(esbuild)) {
    process.stderr.write('{"error":{"code":"setup","message":"run npm install in the slotwise folder first"}}\n');
    process.exit(2);
  }
  const r = spawnSync(esbuild, ["src/cli/index.ts", "--bundle", "--platform=node", "--format=esm", "--target=node22", "--log-level=warning", "--outfile=dist/cli.mjs"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
await import(pathToFileURL(bundle).href);
