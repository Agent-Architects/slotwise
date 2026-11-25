// Slotwise CLI. Every command calls the v1 HTTP API and prints JSON on stdout.
// Errors print JSON on stderr; exit code 1 = API error, 2 = usage error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HELP = `slotwise <command> [options]   (JSON output)

Run it from a clone with \`node bin/slotwise.mjs\` or \`npm run cli --\`; it builds itself from source on first
use (npm install also builds it). Output is JSON on stdout; errors are JSON on stderr with exit 1 (API) or 2 (usage).

Global: --url <base> (or SLOTWISE_URL)  --token <sw_...> (or SLOTWISE_TOKEN)  --pretty
Saved login: \`login --save\` writes { url, token } (mode 600) to SLOTWISE_CONFIG, default
~/.config/slotwise/config.json; set SLOTWISE_CONFIG (e.g. .setup/cli-config.json) to keep one per instance.

Passwords are never needed on the command line: pipe them with --password-stdin, or omit the flag to be
prompted (hidden) in a terminal. --password P still works but leaks into shell history and process lists.

Auth and profile
  login --email E [--password-stdin] [--name N] [--scopes read,write] [--save]   exchange password for an API token
  health | whoami | links
  profile update [--name] [--username] [--timezone] [--welcome]
  profile password [--password-stdin] [--keep-tokens]
                                           current and new password: stdin lines 1 and 2, or prompts. Revokes all
                                           API tokens (this one too) unless --keep-tokens
  profile email --email NEW [--password-stdin]
Schedules (id "default" is the default schedule)
  schedules list | get <id> | delete <id> [--force]
  schedules create --name N [--timezone TZ] [--mon 09:00-17:00 ...]
  schedules update <id> [--name N] [--timezone TZ] [--mon 09:00-17:00 ...]
  schedules override set <id> <YYYY-MM-DD> <09:00-12:00|off> | schedules override remove <id> <YYYY-MM-DD>
Availability
  availability get
  availability set [--timezone TZ] [--mon 09:00-12:00,13:00-17:00] [--tue off] ... [--weekly JSON]
                   [--buffer-before M] [--buffer-after M] [--min-notice M] [--max-days D] [--max-per-day N|none]
  availability override set <YYYY-MM-DD> <09:00-12:00,13:00-15:00|off>
  availability override remove <YYYY-MM-DD>
Event types (<ref> = id or slug)
  event-types list | get <ref> | delete <ref> [--force] | enable <ref> | disable <ref>
  event-types create --name N [--slug S] [--duration 30[,60]] [--default-duration M] [--location kind[:value]]
                     [--description D] [--color #hex] [--questions JSON] [--slot-interval M]
                     [--buffer-before M] [--buffer-after M] [--min-notice M] [--max-days D] [--max-per-day N]
                     [--schedule <scheduleId|default>]
  event-types update <ref> [same options as create]
Bookings
  bookings list [--status upcoming|past|cancelled|all|range] [--from ISO] [--to ISO] [--event-type <ref>]
                [--limit N] [--cursor C | --all]
  bookings export [same filters]            CSV on stdout
  bookings get <id> | bookings cancel <id> [--reason R] | bookings request-reschedule <id> [--reason R]
  bookings slots <id> --from YYYY-MM-DD [--to YYYY-MM-DD] [--timezone TZ]
  bookings reschedule <id> --start ISO
  notifications [--booking <id>]
Integrations
  integrations list | connect <provider> | calendars <connectionId> | disconnect <connectionId>
  integrations set <connectionId> [--check id1,id2] [--write id|none]
Tokens
  tokens list | tokens revoke <id>
Invitee (public, no token needed)
  slots <username> <slug> --from YYYY-MM-DD [--to YYYY-MM-DD] [--timezone TZ] [--duration M]
  book <username> <slug> --start ISO --name N --email E [--timezone TZ] [--duration M] [--phone P]
       [--guest e]... [--answer id=value]...
  invitee show <bookingId> --manage-token T
  invitee cancel <bookingId> --manage-token T [--reason R]
  invitee reschedule <bookingId> --manage-token T --start ISO [--timezone TZ]
Dev (server started with MOCK_CALENDAR=true)
  mock events | mock busy --start ISO --end ISO [--summary S] [--calendar primary]
`;

class Usage extends Error {}

interface Args {
  _: string[];
  [k: string]: string | string[] | boolean | undefined;
}
const MULTI = new Set(["guest", "answer"]);
function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (!s.startsWith("--")) {
      a._.push(s);
      continue;
    }
    const eq = s.indexOf("=");
    const key = (eq > 0 ? s.slice(2, eq) : s.slice(2)).trim();
    let val: string | boolean;
    if (eq > 0) val = s.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) val = argv[++i]!;
    else val = true;
    if (MULTI.has(key)) a[key] = [...((a[key] as string[]) ?? []), String(val)];
    else a[key] = val;
  }
  return a;
}

const str = (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
const need = (a: Args, k: string): string => {
  const v = str(a, k);
  if (!v) throw new Usage(`--${k} is required`);
  return v;
};
const int = (a: Args, k: string): number | undefined => {
  const v = str(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Usage(`--${k} must be an integer`);
  return n;
};
const pos = (a: Args, i: number, name: string) => {
  const v = a._[i];
  if (!v) throw new Usage(`missing <${name}>`);
  return v;
};

const configPath = () => process.env.SLOTWISE_CONFIG ?? join(homedir(), ".config", "slotwise", "config.json");
function loadConfig(): { url?: string; token?: string } {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

class ApiErr extends Error {
  constructor(
    public status: number,
    public body: any,
  ) {
    super(body?.error?.message ?? `HTTP ${status}`);
  }
}

function client(a: Args) {
  const cfg = loadConfig();
  const base = (str(a, "url") ?? process.env.SLOTWISE_URL ?? cfg.url ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const token = str(a, "token") ?? process.env.SLOTWISE_TOKEN ?? cfg.token;
  async function call(method: string, path: string, body?: unknown, auth = true, raw = false) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!token) throw new Usage("no API token: pass --token, set SLOTWISE_TOKEN, or run `slotwise login --save`");
      headers.authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw && res.ok) return { __raw: await res.text() };
    const data: any = await res.json().catch(() => ({ error: { code: "bad_response", message: `HTTP ${res.status}, non-JSON body` } }));
    if (!res.ok) throw new ApiErr(res.status, data);
    return data;
  }
  return { base, call };
}

function parseIntervals(s: string): { start: string; end: string }[] {
  if (s === "off" || s === "none" || s === "") return [];
  return s.split(",").map((p) => {
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(p.trim());
    if (!m) throw new Usage(`bad interval "${p}", expected HH:MM-HH:MM`);
    const f = (t: string) => t.padStart(5, "0");
    return { start: f(m[1]!), end: f(m[2]!) };
  });
}

const DAY_KEYS: Record<string, string> = { sun: "0", mon: "1", tue: "2", wed: "3", thu: "4", fri: "5", sat: "6" };

function eventTypeBody(a: Args) {
  const b: Record<string, unknown> = {};
  const s = (k: string, field = k) => {
    const v = str(a, k);
    if (v !== undefined) b[field] = v;
  };
  const n = (k: string, field: string) => {
    const v = str(a, k);
    if (v === undefined) return;
    b[field] = v === "none" || v === "default" ? null : int(a, k);
  };
  s("name");
  s("slug");
  s("description");
  s("color");
  const d = str(a, "duration") ?? str(a, "durations");
  if (d) b.durations = d.split(",").map((x) => Number(x.trim()));
  n("default-duration", "defaultDuration");
  n("slot-interval", "slotInterval");
  n("buffer-before", "bufferBefore");
  n("buffer-after", "bufferAfter");
  n("min-notice", "minNotice");
  n("max-days", "maxDaysAhead");
  n("max-per-day", "maxPerDay");
  const loc = str(a, "location");
  if (loc) {
    const i = loc.indexOf(":");
    b.location = i < 0 ? { kind: loc } : { kind: loc.slice(0, i), value: loc.slice(i + 1) };
  }
  const q = str(a, "questions");
  if (q) {
    try {
      b.questions = JSON.parse(q);
    } catch {
      throw new Usage("--questions must be JSON");
    }
  }
  const sch = str(a, "schedule");
  if (sch) b.scheduleId = sch === "default" ? null : sch;
  if (a.active === true) b.active = true;
  if (a.inactive === true) b.active = false;
  return b;
}

/**
 * Reads secrets without putting them in argv: --password-stdin reads one line per secret from stdin; a terminal
 * gets hidden prompts. --password still works for one secret (discouraged).
 */
async function secrets(a: Args, prompts: string[]): Promise<string[]> {
  if (typeof a.password === "string" && prompts.length === 1) {
    process.stderr.write('{"warning":"--password exposes the password in shell history; prefer --password-stdin"}\n');
    return [a.password];
  }
  if (a["password-stdin"] || !process.stdin.isTTY) {
    let s = "";
    for await (const c of process.stdin) s += c;
    const lines = s.split(/\r?\n/);
    const out = prompts.map((_, i) => lines[i] ?? "");
    if (out.some((x) => !x)) {
      // No terminal for a hidden prompt (an agent's or CI shell): say how to pass the password instead.
      if (!a["password-stdin"]) throw new Usage(`no terminal: use --password-stdin (${prompts.length === 1 ? "one line" : `${prompts.length} lines`} on stdin, e.g. < password-file)`);
      throw new Usage(`expected ${prompts.length === 1 ? "one line" : `${prompts.length} lines`} on stdin`);
    }
    return out;
  }
  const out: string[] = [];
  for (const q of prompts) out.push(await hiddenPrompt(q));
  return out;
}

function hiddenPrompt(q: string): Promise<string> {
  return new Promise((res) => {
    process.stderr.write(q);
    let s = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const on = (b: Buffer) => {
      for (const ch of b.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", on);
          process.stderr.write("\n");
          return res(s);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") s = s.slice(0, -1);
        else s += ch;
      }
    };
    process.stdin.on("data", on);
  });
}

async function main(argv: string[]) {
  const a = parseArgs(argv);
  const [cmd, sub] = a._;
  if (!cmd || cmd === "help" || a.help) {
    process.stdout.write(HELP);
    return undefined;
  }
  const { base, call } = client(a);

  async function etRef(ref: string): Promise<string> {
    if (ref.startsWith("evt_")) return ref;
    const r = await call("GET", "/api/v1/event-types");
    const e = r.items.find((x: any) => x.slug === ref);
    if (!e) throw new ApiErr(404, { error: { code: "not_found", message: `No event type with slug ${ref}` } });
    return e.id;
  }

  switch (cmd) {
    case "health":
      return call("GET", "/healthz", undefined, false);
    case "login": {
      const scopes = (str(a, "scopes") ?? "read,write").split(",");
      const email = need(a, "email");
      const [password] = await secrets(a, ["Password: "]);
      const r = await call("POST", "/api/v1/auth/token", { email, password, name: str(a, "name") ?? "cli", scopes }, false);
      if (a.save) {
        const p = configPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify({ url: base, token: r.token }, null, 2), { mode: 0o600 });
        return { saved: p, apiToken: r.apiToken };
      }
      return r;
    }
    case "whoami":
      return call("GET", "/api/v1/me");
    case "links":
      return call("GET", "/api/v1/me/links");
    case "profile": {
      if (sub === "password") {
        const [currentPassword, newPassword] = await secrets(a, ["Current password: ", "New password: "]);
        return call("POST", "/api/v1/me/password", { currentPassword, newPassword, revokeTokens: !a["keep-tokens"] });
      }
      if (sub === "email") {
        const email = need(a, "email");
        const [currentPassword] = await secrets(a, ["Current password: "]);
        return call("POST", "/api/v1/me/email", { email, currentPassword });
      }
      if (sub !== "update") throw new Usage("profile update|password|email");
      const b: Record<string, string> = {};
      for (const k of ["name", "username", "timezone", "welcome"]) if (str(a, k) !== undefined) b[k] = str(a, k)!;
      return call("PATCH", "/api/v1/me", b);
    }
    case "availability": {
      if (sub === "get" || !sub) return call("GET", "/api/v1/availability");
      if (sub === "set") {
        const b: Record<string, unknown> = {};
        if (str(a, "timezone")) b.timezone = str(a, "timezone");
        const weekly: Record<string, unknown> = {};
        if (str(a, "weekly")) {
          try {
            Object.assign(weekly, JSON.parse(str(a, "weekly")!));
          } catch {
            throw new Usage("--weekly must be JSON like {\"1\":[{\"start\":\"09:00\",\"end\":\"17:00\"}]}");
          }
        }
        for (const [name, k] of Object.entries(DAY_KEYS)) if (str(a, name) !== undefined) weekly[k] = parseIntervals(str(a, name)!);
        if (Object.keys(weekly).length) b.weekly = weekly;
        const map: [string, string][] = [
          ["buffer-before", "bufferBefore"],
          ["buffer-after", "bufferAfter"],
          ["min-notice", "minNotice"],
          ["max-days", "maxDaysAhead"],
        ];
        for (const [flag, field] of map) if (str(a, flag) !== undefined) b[field] = int(a, flag);
        if (str(a, "max-per-day") !== undefined) b.maxPerDay = str(a, "max-per-day") === "none" ? null : int(a, "max-per-day");
        if (!Object.keys(b).length) throw new Usage("availability set needs at least one option");
        return call("PATCH", "/api/v1/availability", b);
      }
      if (sub === "override") {
        const action = pos(a, 2, "set|remove");
        const date = pos(a, 3, "date");
        if (action === "set") return call("PUT", `/api/v1/availability/overrides/${date}`, { intervals: parseIntervals(pos(a, 4, "intervals|off")) });
        if (action === "remove") return call("DELETE", `/api/v1/availability/overrides/${date}`);
      }
      throw new Usage("availability get|set|override");
    }
    case "event-types": {
      if (sub === "list" || !sub) return call("GET", "/api/v1/event-types");
      if (sub === "create") {
        need(a, "name");
        return call("POST", "/api/v1/event-types", eventTypeBody(a));
      }
      const id = await etRef(pos(a, 2, "ref"));
      if (sub === "get") return call("GET", `/api/v1/event-types/${id}`);
      if (sub === "update") return call("PATCH", `/api/v1/event-types/${id}`, eventTypeBody(a));
      if (sub === "enable") return call("PATCH", `/api/v1/event-types/${id}`, { active: true });
      if (sub === "disable") return call("PATCH", `/api/v1/event-types/${id}`, { active: false });
      if (sub === "delete") return call("DELETE", `/api/v1/event-types/${id}${a.force ? "?force=true" : ""}`);
      throw new Usage("event-types list|get|create|update|enable|disable|delete");
    }
    case "bookings": {
      if (sub === "list" || sub === "export" || !sub) {
        const q = new URLSearchParams();
        for (const k of ["status", "from", "to", "limit", "cursor"]) if (str(a, k)) q.set(k, str(a, k)!);
        if (str(a, "event-type")) q.set("eventTypeId", await etRef(str(a, "event-type")!));
        if (sub === "export") {
          q.delete("limit");
          q.delete("cursor");
          const r = await call("GET", `/api/v1/bookings/export?${q}`, undefined, true, true);
          process.stdout.write(r.__raw);
          return undefined;
        }
        if (!a.all) return call("GET", `/api/v1/bookings?${q}`);
        q.set("limit", "200");
        const items: unknown[] = [];
        for (;;) {
          const r = await call("GET", `/api/v1/bookings?${q}`);
          items.push(...r.items);
          if (!r.nextCursor) break;
          q.set("cursor", r.nextCursor);
        }
        return { items, nextCursor: null };
      }
      const id = pos(a, 2, "id");
      const reason = str(a, "reason") ? { reason: str(a, "reason") } : {};
      if (sub === "get") return call("GET", `/api/v1/bookings/${id}`);
      if (sub === "cancel") return call("POST", `/api/v1/bookings/${id}/cancel`, reason);
      if (sub === "request-reschedule") return call("POST", `/api/v1/bookings/${id}/request-reschedule`, reason);
      if (sub === "reschedule") return call("POST", `/api/v1/bookings/${id}/reschedule`, { start: need(a, "start") });
      if (sub === "slots") {
        const from = need(a, "from");
        const q = new URLSearchParams({ from, to: str(a, "to") ?? from, timezone: str(a, "timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
        return call("GET", `/api/v1/bookings/${id}/slots?${q}`);
      }
      throw new Usage("bookings list|export|get|cancel|request-reschedule|slots|reschedule");
    }
    case "schedules": {
      if (sub === "list" || !sub) return call("GET", "/api/v1/schedules");
      if (sub === "override") {
        const action = pos(a, 2, "set|remove");
        const sid = pos(a, 3, "scheduleId");
        const date = pos(a, 4, "date");
        if (action === "set") return call("PUT", `/api/v1/schedules/${sid}/overrides/${date}`, { intervals: parseIntervals(pos(a, 5, "intervals|off")) });
        if (action === "remove") return call("DELETE", `/api/v1/schedules/${sid}/overrides/${date}`);
        throw new Usage("schedules override set|remove");
      }
      const body: Record<string, unknown> = {};
      if (str(a, "name")) body.name = str(a, "name");
      if (str(a, "timezone")) body.timezone = str(a, "timezone");
      const weekly: Record<string, unknown> = {};
      for (const [name, k] of Object.entries(DAY_KEYS)) if (str(a, name) !== undefined) weekly[k] = parseIntervals(str(a, name)!);
      if (Object.keys(weekly).length) body.weekly = weekly;
      if (sub === "create") {
        need(a, "name");
        return call("POST", "/api/v1/schedules", body);
      }
      const sid = pos(a, 2, "scheduleId");
      if (sub === "get") return call("GET", `/api/v1/schedules/${sid}`);
      if (sub === "update") return call("PATCH", `/api/v1/schedules/${sid}`, body);
      if (sub === "delete") return call("DELETE", `/api/v1/schedules/${sid}${a.force ? "?force=true" : ""}`);
      throw new Usage("schedules list|get|create|update|delete|override");
    }
    case "notifications":
      return call("GET", `/api/v1/notifications${str(a, "booking") ? `?bookingId=${encodeURIComponent(str(a, "booking")!)}` : ""}`);
    case "integrations": {
      if (sub === "list" || !sub) return call("GET", "/api/v1/integrations");
      if (sub === "connect") return call("POST", `/api/v1/integrations/${pos(a, 2, "provider")}/connect`, {});
      if (sub === "calendars") return call("GET", `/api/v1/integrations/connections/${pos(a, 2, "connectionId")}/calendars`);
      if (sub === "disconnect") return call("DELETE", `/api/v1/integrations/connections/${pos(a, 2, "connectionId")}`);
      if (sub === "set") {
        const b: Record<string, unknown> = {};
        if (str(a, "check") !== undefined) b.checkCalendarIds = str(a, "check")!.split(",").filter(Boolean);
        if (str(a, "write") !== undefined) b.writeCalendarId = str(a, "write") === "none" ? null : str(a, "write");
        return call("PATCH", `/api/v1/integrations/connections/${pos(a, 2, "connectionId")}`, b);
      }
      throw new Usage("integrations list|connect|calendars|set|disconnect");
    }
    case "tokens": {
      if (sub === "list" || !sub) return call("GET", "/api/v1/tokens");
      if (sub === "revoke") return call("DELETE", `/api/v1/tokens/${pos(a, 2, "id")}`);
      throw new Usage("tokens list|revoke (create tokens with `slotwise login` or in Settings)");
    }
    case "slots": {
      const user = pos(a, 1, "username");
      const slug = pos(a, 2, "slug");
      const from = need(a, "from");
      const q = new URLSearchParams({ from, to: str(a, "to") ?? from, timezone: str(a, "timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (str(a, "duration")) q.set("duration", str(a, "duration")!);
      return call("GET", `/api/v1/public/users/${user}/event-types/${slug}/slots?${q}`, undefined, false);
    }
    case "book": {
      const answers: Record<string, string> = {};
      for (const kv of (a.answer as string[]) ?? []) {
        const i = kv.indexOf("=");
        if (i < 1) throw new Usage("--answer must be id=value");
        answers[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return call(
        "POST",
        "/api/v1/public/bookings",
        {
          username: pos(a, 1, "username"),
          slug: pos(a, 2, "slug"),
          start: need(a, "start"),
          name: need(a, "name"),
          email: need(a, "email"),
          timezone: str(a, "timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(int(a, "duration") ? { duration: int(a, "duration") } : {}),
          ...(str(a, "phone") ? { phone: str(a, "phone") } : {}),
          guests: (a.guest as string[]) ?? [],
          answers,
        },
        false,
      );
    }
    case "invitee": {
      const id = pos(a, 2, "bookingId");
      const token = need(a, "manage-token");
      if (sub === "show") return call("GET", `/api/v1/public/bookings/${id}?token=${encodeURIComponent(token)}`, undefined, false);
      if (sub === "cancel") return call("POST", `/api/v1/public/bookings/${id}/cancel`, { token, ...(str(a, "reason") ? { reason: str(a, "reason") } : {}) }, false);
      if (sub === "reschedule")
        return call("POST", `/api/v1/public/bookings/${id}/reschedule`, { token, start: need(a, "start"), ...(str(a, "timezone") ? { timezone: str(a, "timezone") } : {}) }, false);
      throw new Usage("invitee show|cancel|reschedule");
    }
    case "mock": {
      if (sub === "events") return call("GET", "/api/v1/dev/mock-calendar/events");
      if (sub === "busy")
        return call("POST", "/api/v1/dev/mock-calendar/events", { start: need(a, "start"), end: need(a, "end"), summary: str(a, "summary"), calendarId: str(a, "calendar") });
      throw new Usage("mock events|busy");
    }
    default:
      throw new Usage(`unknown command ${cmd}`);
  }
}

const argv = process.argv.slice(2);
const pretty = argv.includes("--pretty");
main(argv.filter((x: string) => x !== "--pretty")).then(
  (out) => {
    if (out !== undefined) process.stdout.write(`${JSON.stringify(out, null, pretty ? 2 : 0)}\n`);
  },
  (e) => {
    if (e instanceof Usage) {
      process.stderr.write(`${JSON.stringify({ error: { code: "usage", message: e.message } })}\n`);
      process.exitCode = 2;
    } else if (e instanceof ApiErr) {
      process.stderr.write(`${JSON.stringify({ status: e.status, ...e.body })}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`${JSON.stringify({ error: { code: "client_error", message: String(e?.message ?? e) } })}\n`);
      process.exitCode = 1;
    }
  },
);
