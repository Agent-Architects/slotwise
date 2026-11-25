import { fileURLToPath } from "node:url";
import { SqliteDb } from "../../src/adapters/sqlite-node";
import { buildDeps } from "../../src/config";
import { createApp, nodeClientIp } from "../../src/http/app";

export const KEY = Buffer.alloc(32, 7).toString("base64");

export function makeApp(opts: { now?: string; env?: Record<string, string>; fetchImpl?: typeof fetch } = {}) {
  const db = new SqliteDb(":memory:");
  db.migrate(fileURLToPath(new URL("../../migrations", import.meta.url)));
  const clock = { t: Date.parse(opts.now ?? "2026-11-23T12:00:00Z") };
  const env = {
    ENCRYPTION_KEY: KEY,
    MOCK_CALENDAR: "true",
    LOG_EMAILS: "false",
    RATE_LIMIT_PUBLIC_WRITE: "1000",
    RATE_LIMIT_PUBLIC_READ: "1000",
    RATE_LIMIT_AUTH: "1000",
    ...opts.env,
  };
  const app = createApp({ adapter: "sqlite", clientIp: nodeClientIp(opts.env?.TRUST_PROXY), deps: (c) => buildDeps(env, db, new URL(c.req.url).origin, () => clock.t) });
  const base = "http://slotwise.test";
  let cookie = "";
  let csrf = "";

  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (cookie && !h.authorization) h.cookie = cookie;
    if (csrf && method !== "GET" && !h.authorization && !("x-csrf-token" in h)) h["x-csrf-token"] = csrf;
    const res = await app.request(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie");
    if (sc) {
      const m = /sw_session=([^;]*)/.exec(sc);
      if (m) cookie = m[1] ? `sw_session=${m[1]}` : "";
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (json?.csrfToken) csrf = json.csrfToken;
    return { status: res.status, body: json, headers: res.headers };
  }

  async function signup(p: Partial<{ email: string; username: string; timezone: string; name: string }> = {}) {
    const r = await req("POST", "/api/v1/auth/signup", {
      email: p.email ?? "owner@example.com",
      password: "correct horse battery",
      name: p.name ?? "Olive Owner",
      username: p.username ?? "olive",
      timezone: p.timezone ?? "America/New_York",
    });
    if (r.status !== 201) throw new Error(`signup failed ${JSON.stringify(r.body)}`);
    return r.body.user;
  }

  function clearSession() {
    cookie = "";
    csrf = "";
  }

  return { app, db, clock, req, signup, clearSession, setNow: (iso: string) => (clock.t = Date.parse(iso)) };
}
