// Cloudflare Workers entry: D1 for storage, static assets binding for the web UI.
import { D1Db } from "./adapters/d1.js";
import { buildDeps, type AppEnv } from "./config.js";
import { cloudflareClientIp, createApp } from "./http/app.js";

interface WorkerEnv extends AppEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}

const app = createApp({
  adapter: "d1",
  clientIp: cloudflareClientIp,
  deps: (c) => buildDeps(c.env as WorkerEnv, new D1Db((c.env as WorkerEnv).DB), new URL(c.req.url).origin),
  // Serve the public homepage on / and retain the SPA shell for any other asset fallback.
  assets: (c) => {
    const env = c.env as WorkerEnv;
    const url = new URL(c.req.url);
    url.pathname = url.pathname === "/" ? "/static/home" : "/index.html";
    return env.ASSETS.fetch(new Request(url, c.req.raw));
  },
});

export default app;
