// Node entry: built-in node:sqlite for storage, serves ./public for the web UI.
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDb } from "./adapters/sqlite-node.js";
import { buildDeps, type AppEnv } from "./config.js";
import { createApp, nodeClientIp } from "./http/app.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env as AppEnv & { PORT?: string; HOST?: string; DB_PATH?: string; NODE_ENV?: string; TRUST_PROXY?: string };
const dbPath = resolve(env.DB_PATH ?? join(root, "data", "slotwise.sqlite"));
mkdirSync(dirname(dbPath), { recursive: true });

if (!env.ENCRYPTION_KEY) {
  if (env.NODE_ENV === "production") {
    // A config mistake, not a crash: one line an operator can act on, no stack trace.
    console.error("error: ENCRYPTION_KEY is required in production (set it in the server's environment file, see docs/SELF-HOST.md)");
    process.exit(1);
  }
  // Development convenience: a per-database key file next to the database (never committed).
  const keyFile = `${dbPath}.key`;
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  env.ENCRYPTION_KEY = readFileSync(keyFile, "utf8").trim();
}

const db = new SqliteDb(dbPath);
db.migrate(join(root, "migrations"));

const publicDir = join(root, "public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

const app = createApp({
  adapter: "sqlite",
  // Set TRUST_PROXY to the header your reverse proxy sets (x-forwarded-for, x-real-ip, cf-connecting-ip).
  clientIp: nodeClientIp(env.TRUST_PROXY),
  deps: (c) => buildDeps(env, db, new URL(c.req.url).origin),
  assets: async (c) => {
    const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
    // Source maps are for local debugging only; production does not publish the original source (as on Cloudflare).
    if (env.NODE_ENV === "production" && rel.endsWith(".map")) return new Response("Not found", { status: 404 });
    const publicPage = rel === "/" ? "/static/home" : rel;
    const assetPath = /^\/static\/(?:home|privacy|terms)$/.test(publicPage) ? `${publicPage}.html` : rel;
    let file = join(publicDir, assetPath);
    if (!file.startsWith(publicDir) || !existsSync(file) || !extname(file) || rel.endsWith("_headers")) file = join(publicDir, "index.html");
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const cache = file.includes(`${join(publicDir, "assets")}`) ? "public, max-age=300" : "no-cache";
    return new Response(readFileSync(file), { headers: { "content-type": type, "cache-control": cache } });
  },
});

const port = Number(env.PORT ?? 8787);
const hostname = env.HOST ?? "127.0.0.1";
// A forwarded-for header is only trustworthy when a proxy sets it; clients that reach Node directly can fake it.
if (env.TRUST_PROXY && !/^(127\.|::1$|localhost$|\[::1\]$)/i.test(hostname)) {
  console.warn(`warning: TRUST_PROXY=${env.TRUST_PROXY} while listening on ${hostname}: clients that reach this port directly can fake their address and dodge rate limits. Set TRUST_PROXY only behind a proxy that sets that header, and keep this port closed to everyone else.`);
}
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`slotwise ready on http://${hostname}:${info.port} (db ${dbPath})`);
});
