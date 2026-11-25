import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { del, get, patch, post, put, setCsrf } from "./api";
import brand from "../brand.json";
import {
  allTimeZones,
  browserTz,
  copyText,
  durationLabel,
  fmtDateKey,
  fmtDateTime,
  fmtTime,
  Icon,
  initials,
  Link,
  LOCATION_LABEL,
  LocationIcon,
  Logo,
  navigate,
  plural,
  toast,
  todayIn,
} from "./util";

export interface Me {
  id: string;
  email: string;
  username: string;
  name: string;
  timezone: string;
  welcome: string;
}

// ---------- auth pages ----------
export function AuthPage({ mode, onAuthed }: { mode: "login" | "signup"; onAuthed: (u: Me) => void }) {
  const [signupOpen, setSignupOpen] = useState<boolean | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [f, setF] = useState({ email: "", password: "", name: "", username: "", timezone: browserTz(), setupCode: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/healthz")
      .then((r) => r.json())
      .then((h: any) => (setSignupOpen(Boolean(h.signupOpen)), setNeedsCode(Boolean(h.setupCodeRequired))), () => setSignupOpen(false));
  }, []);
  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = mode === "login" ? await post("/auth/login", { email: f.email, password: f.password }) : await post("/auth/signup", { ...f, setupCode: f.setupCode || undefined });
      setCsrf(r.csrfToken);
      onAuthed(r.user);
      navigate("/app/event-types", true);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="auth-bg">
      <main class="card auth">
        <Logo size={34} />
        <h1>{mode === "login" ? `Sign in to ${brand.name}` : `Create your ${brand.name} account`}</h1>
        <form onSubmit={submit} class="form" aria-label={mode === "login" ? "Sign in" : "Sign up"}>
          {mode === "signup" && (
            <>
              <label class="field">
                <span>Full name</span>
                <input name="name" required value={f.name} onInput={set("name")} autoComplete="name" />
              </label>
              <label class="field">
                <span>Username (your link: /username)</span>
                <input name="username" required pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" value={f.username} onInput={set("username")} />
              </label>
            </>
          )}
          <label class="field">
            <span>Email</span>
            <input name="email" type="email" required value={f.email} onInput={set("email")} autoComplete="email" />
          </label>
          <label class="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={mode === "signup" ? 10 : 1}
              value={f.password}
              onInput={set("password")}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {mode === "signup" && needsCode && (
            <label class="field">
              <span>Setup code</span>
              <input name="setupCode" required value={f.setupCode} onInput={set("setupCode")} autoComplete="off" />
            </label>
          )}
          {mode === "signup" && (
            <label class="field">
              <span>Time zone</span>
              <TzSelect value={f.timezone} onChange={(v) => setF({ ...f, timezone: v })} />
            </label>
          )}
          {err && (
            <p class="error" role="alert">
              {err}
            </p>
          )}
          <button class="btn primary pill" disabled={busy} type="submit">
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        {mode === "login" && signupOpen && (
          <p class="small">
            New here? <Link href="/signup">Create an account</Link>
          </p>
        )}
        {mode === "signup" && (
          <p class="small">
            Already have an account? <Link href="/login">Sign in</Link>
          </p>
        )}
        {mode === "signup" && signupOpen === false && <p class="small muted">Signup is closed on this server.</p>}
        <nav class="policy-links" aria-label={`About ${brand.name}`}>
          <a href="/">Home</a>
          <a href="/static/privacy">Privacy policy</a>
          <a href="/static/terms">Terms of service</a>
        </nav>
      </main>
    </div>
  );
}

export function TzSelect({ value, onChange, id, label }: { value: string; onChange: (v: string) => void; id?: string; label?: string }) {
  return (
    <select id={id} aria-label={label ?? "Time zone"} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {[...new Set([value, ...allTimeZones()])].map((z) => (
        <option key={z} value={z}>
          {z.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
}

// ---------- shell ----------
const NAV = [
  { href: "/app/event-types", label: "Scheduling", icon: Icon.link },
  { href: "/app/meetings", label: "Meetings", icon: Icon.cal },
  { href: "/app/availability", label: "Availability", icon: Icon.clock },
  { href: "/app/integrations", label: "Integrations", icon: Icon.plug },
  { href: "/app/settings", label: "Settings", icon: Icon.gear },
];

export function Shell({ me, path, title, children, actions }: { me: Me; path: string; title: string; children: ComponentChildren; actions?: ComponentChildren }) {
  const [menu, setMenu] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  useEffect(() => {
    get("/me/alerts").then((r) => setAlerts(r.items), () => {});
  }, [path]);
  return (
    <div class="shell">
      <aside class="sidebar" aria-label="Main navigation">
        <Link href="/app/event-types" class="side-logo">
          <Logo />
        </Link>
        <button class="btn primary pill create" onClick={() => navigate("/app/event-types/new")}>
          <Icon.plus /> Create
        </button>
        <nav>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} class={`nav-item ${path.startsWith(n.href) ? "active" : ""}`} aria-current={path.startsWith(n.href) ? "page" : undefined}>
              <n.icon /> <span>{n.label}</span>
            </Link>
          ))}
        </nav>
      </aside>
      <div class="main">
        <header class="topbar">
          <h1>{title}</h1>
          <div class="topbar-right">
            {actions}
            <div class="menu-wrap">
              <button class="avatar-btn" aria-label="Account menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <span class="avatar sm">{initials(me.name)}</span>
              </button>
              {menu && (
                <div class="menu" role="menu">
                  <div class="menu-head">
                    <strong>{me.name}</strong>
                    <span class="small muted">{me.email}</span>
                  </div>
                  <a role="menuitem" href={`/${me.username}`} target="_blank" rel="noopener">
                    View landing page
                  </a>
                  <button
                    role="menuitem"
                    onClick={async () => {
                      await post("/auth/logout");
                      location.href = "/login";
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        {alerts.map((a) => (
          <div class="banner" role="alert" key={a.connectionId}>
            <strong>
              {a.providerName ?? a.provider} ({a.accountEmail}) is not responding.
            </strong> Your booking pages show no times until it is fixed so nobody books over an existing
            meeting. <Link href="/app/integrations">Reconnect on Integrations</Link>
          </div>
        ))}
        <main class="content">{children}</main>
      </div>
    </div>
  );
}

/** Latest-request-wins guard: responses of superseded requests are dropped, so a slow old response can never
 * overwrite a newer one (out-of-order network replies). */
export function useLatest() {
  const seq = useRef(0);
  return () => {
    const id = ++seq.current;
    return () => id === seq.current;
  };
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const latest = useLatest();
  const reload = () => {
    const isLatest = latest();
    return fn().then(
      (d) => isLatest() && (setData(d), setErr("")),
      (e) => isLatest() && setErr(e.message),
    );
  };
  useEffect(() => {
    reload();
  }, deps);
  return { data, err, reload, setData };
}

const Loading = () => <div class="spinner" aria-label="Loading" />;

// ---------- event types ----------
export function EventTypesPage({ me, path }: { me: Me; path: string }) {
  const { data, err, reload } = useLoad(() => get("/event-types"));
  const [q, setQ] = useState("");
  const origin = location.origin;
  const items = (data?.items ?? []).filter((e: any) => e.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Shell me={me} path={path} title="Scheduling">
      <div class="tabs" role="tablist">
        <span class="tab active" role="tab" aria-selected="true">
          Event types
        </span>
      </div>
      <div class="toolbar">
        <input class="search" type="search" placeholder="Search event types" aria-label="Search event types" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button class="btn primary pill" onClick={() => navigate("/app/event-types/new")}>
          <Icon.plus /> New event type
        </button>
      </div>
      <div class="owner-row">
        <span class="avatar sm">{initials(me.name)}</span>
        <div>
          <strong>{me.name}</strong>
          <div>
            <a class="small" href={`/${me.username}`} target="_blank" rel="noopener">
              {origin.replace(/^https?:\/\//, "")}/{me.username}
            </a>
          </div>
        </div>
        <button
          class="btn outline small"
          onClick={async () => {
            await copyText(`${origin}/${me.username}`);
            toast("Landing page link copied");
          }}
        >
          <Icon.copy size={14} /> Copy link
        </button>
      </div>
      {err && <p class="error">{err}</p>}
      {!data ? (
        <Loading />
      ) : (
        <ul class="et-grid" aria-label="Event types">
          {items.map((e: any) => (
            <li key={e.id} class={`et-card ${e.active ? "" : "off"}`} style={{ borderTopColor: e.color }} aria-label={e.name}>
              <div class="et-top">
                <label class="switch" title={e.active ? "Turn off" : "Turn on"}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${e.name} active`}
                    checked={e.active}
                    onChange={async () => {
                      await patch(`/event-types/${e.id}`, { active: !e.active });
                      reload();
                    }}
                  />
                  <span />
                </label>
                <Link href={`/app/event-types/${e.id}`} class="icon-btn" aria-label={`Edit ${e.name}`}>
                  <Icon.gear />
                </Link>
              </div>
              <Link href={`/app/event-types/${e.id}`} class="et-name">
                {e.name}
              </Link>
              <p class="muted small">
                {e.durations.map(durationLabel).join(", ")}, single host
              </p>
              <a class="small" href={e.url} target="_blank" rel="noopener">
                View booking page
              </a>
              <div class="et-foot">
                <span class="small muted">/{me.username}/{e.slug}</span>
                <button
                  class="btn outline small"
                  aria-label={`Copy link for ${e.name}`}
                  onClick={async () => {
                    await copyText(e.url);
                    toast("Link copied");
                  }}
                >
                  <Icon.copy size={14} /> Copy link
                </button>
              </div>
              {!e.active && <span class="badge">Off</span>}
            </li>
          ))}
          {items.length === 0 && <li class="muted">No event types yet.</li>}
        </ul>
      )}
    </Shell>
  );
}

const DURATION_CHOICES = [15, 30, 45, 60, 90, 120];

export function EventTypeEditor({ me, path, id }: { me: Me; path: string; id: string | null }) {
  const isNew = !id;
  const [et, setEt] = useState<any>(
    isNew
      ? { name: "", slug: "", description: "", durations: [30], defaultDuration: 30, location: { kind: "google_meet" }, questions: [], color: brand.primary, active: true, slotInterval: null, bufferBefore: null, bufferAfter: null, minNotice: null, maxDaysAhead: null, maxPerDay: null }
      : null,
  );
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [schedules, setSchedules] = useState<any[]>([]);
  useEffect(() => {
    if (id) get(`/event-types/${id}`).then((r) => setEt(r.eventType), (e) => setErr(e.message));
    get("/schedules").then((r) => setSchedules(r.items), () => {});
  }, [id]);
  if (!et) return <Shell me={me} path={path} title="Event type">{err ? <p class="error">{err}</p> : <Loading />}</Shell>;
  const up = (p: any) => setEt({ ...et, ...p });
  const numOrNull = (v: string) => (v === "" ? null : Number(v));

  async function save(e: Event) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const body: any = {
      name: et.name,
      description: et.description,
      durations: et.durations,
      defaultDuration: et.defaultDuration,
      location: et.location.value ? et.location : { kind: et.location.kind },
      questions: et.questions,
      color: et.color,
      active: et.active,
      slotInterval: et.slotInterval,
      bufferBefore: et.bufferBefore,
      bufferAfter: et.bufferAfter,
      minNotice: et.minNotice,
      maxDaysAhead: et.maxDaysAhead,
      maxPerDay: et.maxPerDay,
      scheduleId: et.scheduleId ?? null,
    };
    if (et.slug) body.slug = et.slug;
    try {
      const r = isNew ? await post("/event-types", body) : await patch(`/event-types/${id}`, body);
      toast(isNew ? "Event type created" : "Changes saved");
      if (isNew) navigate(`/app/event-types/${r.eventType.id}`, true);
      else setEt(r.eventType);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell me={me} path={path} title={isNew ? "New event type" : "Edit event type"}>
      <div class="editor">
        <form class="form editor-form" onSubmit={save} aria-label="Event type settings">
          <Link href="/app/event-types" class="small">
            <Icon.left size={14} /> Back to event types
          </Link>
          <section class="panel">
            <h2>Event details</h2>
            <label class="field">
              <span>Event name *</span>
              <input name="name" required value={et.name} onInput={(e) => up({ name: (e.target as HTMLInputElement).value })} />
            </label>
            <label class="field">
              <span>Link</span>
              <div class="prefix-input">
                <span class="muted">/{me.username}/</span>
                <input name="slug" placeholder="generated from the name" value={et.slug} onInput={(e) => up({ slug: (e.target as HTMLInputElement).value })} />
              </div>
            </label>
            <label class="field">
              <span>Description</span>
              <textarea name="description" rows={3} value={et.description} onInput={(e) => up({ description: (e.target as HTMLTextAreaElement).value })} />
            </label>
            <label class="field inline">
              <span>Color</span>
              <input name="color" type="color" value={et.color} onInput={(e) => up({ color: (e.target as HTMLInputElement).value })} />
            </label>
          </section>
          <section class="panel">
            <h2>Duration</h2>
            <div class="chips" role="group" aria-label="Durations">
              {[...new Set([...DURATION_CHOICES, ...et.durations])].sort((a: number, b: number) => a - b).map((d: number) => {
                const on = et.durations.includes(d);
                return (
                  <button
                    type="button"
                    key={d}
                    class={`chip ${on ? "on" : ""}`}
                    aria-pressed={on}
                    onClick={() => {
                      const ds = on ? et.durations.filter((x: number) => x !== d) : [...et.durations, d].sort((a, b) => a - b);
                      if (!ds.length) return;
                      up({ durations: ds, defaultDuration: ds.includes(et.defaultDuration) ? et.defaultDuration : ds[0] });
                    }}
                  >
                    {durationLabel(d)}
                  </button>
                );
              })}
              <input
                class="chip-input"
                type="number"
                min={5}
                max={720}
                placeholder="Custom min"
                aria-label="Custom duration in minutes"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const v = Number((e.target as HTMLInputElement).value);
                  if (v >= 5 && v <= 720 && !et.durations.includes(v)) up({ durations: [...et.durations, v].sort((a: number, b: number) => a - b) });
                  (e.target as HTMLInputElement).value = "";
                }}
              />
            </div>
            {et.durations.length > 1 && (
              <label class="field">
                <span>Default duration</span>
                <select value={et.defaultDuration} onChange={(e) => up({ defaultDuration: Number((e.target as HTMLSelectElement).value) })}>
                  {et.durations.map((d: number) => (
                    <option key={d} value={d}>
                      {durationLabel(d)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
          <section class="panel">
            <h2>Location</h2>
            <label class="field">
              <span>Where the meeting happens</span>
              <select name="location" value={et.location.kind} onChange={(e) => up({ location: { kind: (e.target as HTMLSelectElement).value, value: "" } })}>
                {Object.entries(LOCATION_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            {et.location.kind !== "google_meet" && (
              <label class="field">
                <span>
                  {{ zoom: "Zoom meeting URL", phone: "Your phone number (leave empty to call the invitee)", in_person: "Address", custom: "Location details" }[et.location.kind as string]}
                </span>
                <input name="locationValue" value={et.location.value ?? ""} onInput={(e) => up({ location: { ...et.location, value: (e.target as HTMLInputElement).value } })} />
              </label>
            )}
            {et.location.kind === "google_meet" && <p class="small muted">A Meet link is added to the calendar event when Google Calendar is connected.</p>}
          </section>
          <section class="panel">
            <h2>Availability</h2>
            <label class="field">
              <span>Schedule</span>
              <select name="schedule" aria-label="Availability schedule" value={et.scheduleId ?? "default"} onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                up({ scheduleId: v === "default" ? null : v });
              }}>
                {schedules.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p class="small muted">
              Edit hours on the <Link href="/app/availability">Availability</Link> page.
            </p>
          </section>
          <section class="panel">
            <h2>Invitee questions</h2>
            <p class="small muted">Name and email are always asked.</p>
            {et.questions.map((q: any, i: number) => (
              <div class="question-row" key={i}>
                <input aria-label={`Question ${i + 1} label`} value={q.label} placeholder="Question" onInput={(e) => up({ questions: et.questions.map((x: any, j: number) => (j === i ? { ...x, label: (e.target as HTMLInputElement).value } : x)) })} />
                <select aria-label={`Question ${i + 1} type`} value={q.kind} onChange={(e) => up({ questions: et.questions.map((x: any, j: number) => (j === i ? { ...x, kind: (e.target as HTMLSelectElement).value } : x)) })}>
                  {["text", "textarea", "phone", "select", "radio", "checkbox"].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
                {["select", "radio", "checkbox"].includes(q.kind) && (
                  <input
                    aria-label={`Question ${i + 1} options`}
                    placeholder="Options, comma separated"
                    value={(q.options ?? []).join(", ")}
                    onInput={(e) =>
                      up({
                        questions: et.questions.map((x: any, j: number) =>
                          j === i ? { ...x, options: (e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean) } : x,
                        ),
                      })
                    }
                  />
                )}
                <label class="check small">
                  <input type="checkbox" checked={q.required} onChange={(e) => up({ questions: et.questions.map((x: any, j: number) => (j === i ? { ...x, required: (e.target as HTMLInputElement).checked } : x)) })} /> Required
                </label>
                <button type="button" class="icon-btn" aria-label={`Remove question ${i + 1}`} onClick={() => up({ questions: et.questions.filter((_: any, j: number) => j !== i) })}>
                  <Icon.x />
                </button>
              </div>
            ))}
            <button type="button" class="btn outline small" onClick={() => up({ questions: [...et.questions, { id: `q${Date.now().toString(36)}`, label: "", kind: "text", required: false }] })}>
              <Icon.plus size={14} /> Add question
            </button>
          </section>
          <section class="panel">
            <h2>Limits and buffers</h2>
            <p class="small muted">Leave empty to use the defaults from the Availability page.</p>
            <div class="grid2">
              {(
                [
                  ["bufferBefore", "Buffer before (min)"],
                  ["bufferAfter", "Buffer after (min)"],
                  ["minNotice", "Minimum notice (min)"],
                  ["maxDaysAhead", "Bookable days ahead"],
                  ["maxPerDay", "Max bookings per day"],
                  ["slotInterval", "Start times every (min)"],
                ] as const
              ).map(([k, label]) => (
                <label class="field" key={k}>
                  <span>{label}</span>
                  <input name={k} type="number" min={0} value={et[k] ?? ""} placeholder="default" onInput={(e) => up({ [k]: numOrNull((e.target as HTMLInputElement).value) })} />
                </label>
              ))}
            </div>
          </section>
          {err && (
            <p class="error" role="alert">
              {err}
            </p>
          )}
          <div class="editor-actions">
            {!isNew && (
              <button
                type="button"
                class="btn outline danger"
                onClick={async () => {
                  if (!confirm(`Delete ${et.name}? Existing bookings stay in Meetings.`)) return;
                  try {
                    await del(`/event-types/${id}`);
                    toast("Event type deleted");
                    navigate("/app/event-types");
                  } catch (e2) {
                    if (confirm(`${(e2 as Error).message}\n\nDelete anyway?`)) {
                      await del(`/event-types/${id}?force=true`);
                      navigate("/app/event-types");
                    }
                  }
                }}
              >
                Delete
              </button>
            )}
            <button class="btn primary pill" type="submit" disabled={busy}>
              {isNew ? "Create event type" : "Save changes"}
            </button>
          </div>
        </form>
        <aside class="preview card" aria-label="Preview">
          <p class="small muted">Preview</p>
          <div class="avatar">{initials(me.name)}</div>
          <p class="owner-name">{me.name}</p>
          <h3 class="event-name">{et.name || "Event name"}</h3>
          <ul class="facts">
            <li>
              <Icon.clock /> {et.durations.map(durationLabel).join(" / ")}
            </li>
            <li>
              <LocationIcon kind={et.location.kind} /> {LOCATION_LABEL[et.location.kind]}
            </li>
          </ul>
          {!isNew && (
            <a class="small" href={`/${me.username}/${et.slug}`} target="_blank" rel="noopener">
              Open booking page
            </a>
          )}
        </aside>
      </div>
    </Shell>
  );
}

// ---------- availability ----------
const DAYS = [
  ["0", "S", "Sunday"],
  ["1", "M", "Monday"],
  ["2", "T", "Tuesday"],
  ["3", "W", "Wednesday"],
  ["4", "T", "Thursday"],
  ["5", "F", "Friday"],
  ["6", "S", "Saturday"],
] as const;

function Intervals({ value, onChange, label }: { value: { start: string; end: string }[]; onChange: (v: { start: string; end: string }[]) => void; label: string }) {
  return (
    <div class="intervals">
      {value.length === 0 && <span class="muted unavailable">Unavailable</span>}
      {value.map((iv, i) => (
        <div class="interval" key={i}>
          <input type="time" aria-label={`${label} start ${i + 1}`} value={iv.start} step={300} onInput={(e) => onChange(value.map((x, j) => (j === i ? { ...x, start: (e.target as HTMLInputElement).value } : x)))} />
          <span>-</span>
          <input
            type="time"
            aria-label={`${label} end ${i + 1}`}
            value={iv.end === "24:00" ? "23:59" : iv.end}
            step={300}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              onChange(value.map((x, j) => (j === i ? { ...x, end: v === "23:59" ? "24:00" : v } : x)));
            }}
          />
          <button type="button" class="icon-btn" aria-label={`Remove ${label} interval ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Icon.x />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AvailabilityPage({ me, path, query }: { me: Me; path: string; query: URLSearchParams }) {
  const schedId = query.get("schedule") || "default";
  const { data, err, reload } = useLoad(() => Promise.all([get("/schedules"), get("/availability")]), [schedId]);
  const [sch, setSch] = useState<any>(null);
  const [lim, setLim] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [ovOpen, setOvOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const found = data[0].items.find((x: any) => x.id === schedId) ?? data[0].items[0];
    setSch(structuredClone(found));
    setLim(structuredClone(data[1].availability));
    setLoadedFor(schedId);
  }, [data]);
  // Only show the editor for the schedule in the URL: while another schedule loads, stale controls must not be
  // editable (an edit would land in the wrong schedule and be overwritten).
  const current = loadedFor === schedId;
  if (!sch || !lim || !data || !current) return <Shell me={me} path={path} title="Availability">{err ? <p class="error">{err}</p> : <Loading />}</Shell>;

  const schedules = data[0].items as any[];
  const setDay = (k: string, v: any) => setSch({ ...sch, weekly: { ...sch.weekly, [k]: v } });
  async function save() {
    setSaving(true);
    setSaveErr("");
    try {
      await patch(`/schedules/${sch.id}`, { name: sch.name, timezone: sch.timezone, weekly: sch.weekly });
      await patch("/availability", {
        bufferBefore: lim.bufferBefore,
        bufferAfter: lim.bufferAfter,
        minNotice: lim.minNotice,
        maxDaysAhead: lim.maxDaysAhead,
        maxPerDay: lim.maxPerDay,
        maxGuests: lim.maxGuests ?? 3,
      });
      await reload();
      toast("Availability saved");
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const overrides = Object.entries(sch.overrides as Record<string, any[]>).sort(([a], [b]) => a.localeCompare(b)).filter(([d]) => d >= todayIn(sch.timezone));
  return (
    <Shell me={me} path={path} title="Availability">
      <div class="tabs" role="tablist">
        <span class="tab active" role="tab" aria-selected="true">
          Schedules
        </span>
      </div>
      <section class="panel schedule" aria-label="Working hours">
        <h2 class="schedule-title">
          {sch.name}
          {sch.isDefault ? " (default)" : ""}
        </h2>
        <div class="schedule-head">
          <div class="schedule-pick">
            <label class="field">
              <span class="small muted">Schedule</span>
              <select aria-label="Schedule" value={sch.id} onChange={(e) => navigate(`/app/availability?schedule=${(e.target as HTMLSelectElement).value}`, true)}>
                {schedules.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button class="btn outline small" onClick={() => setNewOpen(true)}>
              <Icon.plus size={14} /> Create schedule
            </button>
          </div>
          <label class="field">
            <span>Schedule name</span>
            <input name="scheduleName" value={sch.name} onInput={(e) => setSch({ ...sch, name: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field tz-field">
            <span>Time zone</span>
            <TzSelect id="av-tz" value={sch.timezone} onChange={(v) => setSch({ ...sch, timezone: v })} />
          </label>
        </div>
        <div class="schedule-cols">
          <div class="weekly" aria-label="Regular availability">
            <h3>
              <Icon.list size={16} /> Regular availability
            </h3>
            <p class="small muted">The days and times people can book you</p>
            {DAYS.map(([k, letter, name]) => {
              const ivs = sch.weekly[k] ?? [];
              return (
                <div class="day-row" key={k} aria-label={name}>
                  <span class="day-letter" title={name}>
                    {letter}
                  </span>
                  <Intervals value={ivs} onChange={(v) => setDay(k, v)} label={name} />
                  <div class="day-actions">
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label={`Add ${name} interval`}
                      onClick={() => {
                        const last = ivs[ivs.length - 1];
                        const next = last ? { start: last.end === "24:00" ? "23:00" : last.end, end: last.end === "24:00" ? "24:00" : addHour(last.end) } : { start: "09:00", end: "17:00" };
                        setDay(k, [...ivs, next]);
                      }}
                    >
                      <Icon.plus />
                    </button>
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label={`Copy ${name} hours to all weekdays`}
                      title="Copy to Monday to Friday"
                      onClick={() => {
                        const w = { ...sch.weekly };
                        for (const d of ["1", "2", "3", "4", "5"]) w[d] = structuredClone(ivs);
                        setSch({ ...sch, weekly: w });
                      }}
                    >
                      <Icon.copy />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div class="date-specific" aria-label="Exceptions">
            <h3>
              <Icon.cal size={16} /> Exceptions
            </h3>
            <p class="small muted">Change your hours on particular dates</p>
            <button class="btn outline small" onClick={() => setOvOpen(true)}>
              <Icon.plus size={14} /> Add date
            </button>
            <ul class="overrides" aria-label="Exception dates">
              {overrides.map(([d, ivs]) => (
                <li key={d}>
                  <strong>{fmtDateKey(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</strong>
                  <span>{ivs.length ? ivs.map((iv: any) => `${iv.start} - ${iv.end}`).join(", ") : "Unavailable"}</span>
                  <button
                    class="icon-btn"
                    aria-label={`Remove override ${d}`}
                    onClick={async () => {
                      const r = await del(`/schedules/${sch.id}/overrides/${d}`);
                      setSch({ ...sch, overrides: r.schedule.overrides });
                    }}
                  >
                    <Icon.x />
                  </button>
                </li>
              ))}
              {overrides.length === 0 && <li class="muted small">No exceptions yet.</li>}
            </ul>
            {!sch.isDefault && (
              <button
                class="btn outline danger small delete-schedule"
                onClick={async () => {
                  try {
                    await del(`/schedules/${sch.id}`);
                    toast("Schedule deleted");
                    navigate("/app/availability", true);
                  } catch (e) {
                    setSaveErr((e as Error).message);
                  }
                }}
              >
                Delete schedule
              </button>
            )}
          </div>
        </div>
      </section>
      <section class="panel" aria-label="Booking limits">
        <h2>Booking limits</h2>
        <p class="small muted">Defaults for every event type and schedule. An event type can override them.</p>
        <div class="grid3">
          <label class="field">
            <span>Buffer before (min)</span>
            <input name="bufferBefore" type="number" min={0} value={lim.bufferBefore} onInput={(e) => setLim({ ...lim, bufferBefore: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="field">
            <span>Buffer after (min)</span>
            <input name="bufferAfter" type="number" min={0} value={lim.bufferAfter} onInput={(e) => setLim({ ...lim, bufferAfter: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="field">
            <span>Minimum notice (hours)</span>
            <input name="minNoticeHours" type="number" min={0} step="0.25" value={lim.minNotice / 60} onInput={(e) => setLim({ ...lim, minNotice: Math.round(Number((e.target as HTMLInputElement).value) * 60) })} />
          </label>
          <label class="field">
            <span>Bookable days ahead</span>
            <input name="maxDaysAhead" type="number" min={0} value={lim.maxDaysAhead} onInput={(e) => setLim({ ...lim, maxDaysAhead: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="field">
            <span>Max guests per booking</span>
            <input name="maxGuests" type="number" min={0} max={10} value={lim.maxGuests ?? 3} onInput={(e) => setLim({ ...lim, maxGuests: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="field">
            <span>Max bookings per day (all types)</span>
            <input
              name="maxPerDay"
              type="number"
              min={1}
              placeholder="no limit"
              value={lim.maxPerDay ?? ""}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setLim({ ...lim, maxPerDay: v === "" ? null : Number(v) });
              }}
            />
          </label>
        </div>
      </section>
      {saveErr && (
        <p class="error" role="alert">
          {saveErr}
        </p>
      )}
      <div class="sticky-actions">
        <button class="btn primary pill" disabled={saving} onClick={save}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      {ovOpen && (
        <OverrideDialog
          tz={sch.timezone}
          onClose={() => setOvOpen(false)}
          onApply={async (date, ivs) => {
            const r = await put(`/schedules/${sch.id}/overrides/${date}`, { intervals: ivs });
            setSch({ ...sch, overrides: r.schedule.overrides });
            setOvOpen(false);
            toast("Exception saved");
          }}
        />
      )}
      {newOpen && (
        <Modal label="Create schedule" onClose={() => setNewOpen(false)}>
          <form
            class="form"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = String(new FormData(e.target as HTMLFormElement).get("name") ?? "");
              try {
                const r = await post("/schedules", { name, timezone: sch.timezone });
                setNewOpen(false);
                toast("Schedule created");
                navigate(`/app/availability?schedule=${r.schedule.id}`, true);
              } catch (e2) {
                setSaveErr((e2 as Error).message);
              }
            }}
          >
            <h2>New schedule</h2>
            <label class="field">
              <span>Schedule name</span>
              <input name="name" required placeholder="Weekdays, Evenings, Summer..." />
            </label>
            <div class="modal-actions">
              <button type="button" class="btn outline" onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button class="btn primary" type="submit">
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Shell>
  );
}

export function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal card" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

function addHour(hm: string) {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return h >= 23 ? "24:00" : `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function OverrideDialog({ tz, onClose, onApply }: { tz: string; onClose: () => void; onApply: (date: string, ivs: any[]) => Promise<void> }) {
  const [date, setDate] = useState(todayIn(tz));
  const [ivs, setIvs] = useState([{ start: "09:00", end: "17:00" }]);
  const [err, setErr] = useState("");
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal card" role="dialog" aria-modal="true" aria-label="Add an exception">
        <h2>Pick a date and set its hours</h2>
        <label class="field">
          <span>Date</span>
          <input type="date" name="overrideDate" value={date} min={todayIn(tz)} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
        </label>
        <p class="small strong">Hours on this date</p>
        <Intervals value={ivs} onChange={setIvs} label="Override" />
        <button type="button" class="btn outline small" onClick={() => setIvs([...ivs, { start: "13:00", end: "17:00" }])}>
          <Icon.plus size={14} /> Add interval
        </button>
        <button type="button" class="link-btn small" onClick={() => setIvs([])}>
          Unavailable all day
        </button>
        {err && (
          <p class="error" role="alert">
            {err}
          </p>
        )}
        <div class="modal-actions">
          <button class="btn outline" onClick={onClose}>
            Cancel
          </button>
          <button
            class="btn primary"
            onClick={async () => {
              try {
                await onApply(date, ivs);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- meetings ----------
function zonedMidnightIso(date: string, tz: string) {
  // UTC instant of 00:00 on `date` in `tz` (two passes handle DST).
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t);
    const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
    const local = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    t -= local - Date.UTC(y, m - 1, d);
  }
  return new Date(t).toISOString();
}

export function MeetingsPage({ me, path, query }: { me: Me; path: string; query: URLSearchParams }) {
  const tab = (query.get("tab") as string) || "upcoming";
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const meta = useLoad(() => Promise.all([get("/availability"), get("/event-types")]), []);
  const tz = meta.data?.[0].availability.timezone ?? me.timezone;
  const listQs = () => {
    const q = new URLSearchParams({ status: tab === "range" ? "range" : tab, limit: "50" });
    if (tab === "range" && from) q.set("from", zonedMidnightIso(from, tz));
    if (tab === "range" && to) q.set("to", zonedMidnightIso(addDaysStr(to, 1), tz));
    return q;
  };
  const [items, setItems] = useState<any[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<any>(null);
  const [moveFor, setMoveFor] = useState<any>(null);
  const latestList = useLatest();
  const load = async (more = false) => {
    const isLatest = latestList();
    try {
      const q = listQs();
      if (more && cursor) q.set("cursor", cursor);
      const r = await get(`/bookings?${q}`);
      if (!isLatest()) return;
      setItems(more ? [...(items ?? []), ...r.items] : r.items);
      setCursor(r.nextCursor);
      setErr("");
    } catch (e) {
      if (isLatest()) setErr((e as Error).message);
    }
  };
  useEffect(() => {
    if (meta.data) load();
  }, [tab, from, to, meta.data]);
  const colors = new Map<string, string>((meta.data?.[1].items ?? []).map((e: any) => [e.id, e.color]));
  const groups = new Map<string, any[]>();
  for (const b of items ?? []) {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(b.start));
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(b);
  }
  const exportQs = listQs();
  exportQs.delete("limit");
  return (
    <Shell
      me={me}
      path={path}
      title="Meetings"
      actions={
        <a class="btn outline small" href={`/api/v1/bookings/export?${exportQs}`} download>
          Export CSV
        </a>
      }
    >
      <div class="tabs" role="tablist" aria-label="Meeting filter">
        {[
          ["upcoming", "Upcoming"],
          ["past", "Past"],
          ["cancelled", "Canceled"],
          ["range", "Date range"],
          ["all", "All"],
        ].map(([k, l]) => (
          <Link key={k} href={`/app/meetings?tab=${k}`} class={`tab ${tab === k ? "active" : ""}`} aria-current={tab === k ? "page" : undefined}>
            {l}
          </Link>
        ))}
      </div>
      {tab === "range" && (
        <form
          class="range-form"
          aria-label="Date range"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.target as HTMLFormElement);
            navigate(`/app/meetings?tab=range&from=${f.get("from")}&to=${f.get("to")}`, true);
          }}
        >
          <label class="field">
            <span>From</span>
            <input type="date" name="from" required defaultValue={from} />
          </label>
          <label class="field">
            <span>To</span>
            <input type="date" name="to" required defaultValue={to} />
          </label>
          <button class="btn primary small" type="submit">
            Apply
          </button>
        </form>
      )}
      <p class="small muted">Times shown in {tz.replace(/_/g, " ")}</p>
      {err && <p class="error">{err}</p>}
      {!items ? (
        tab === "range" && !from ? (
          <p class="muted">Pick a date range.</p>
        ) : (
          <Loading />
        )
      ) : groups.size === 0 ? (
        <div class="empty panel">
          <Icon.cal size={32} />
          <p>No {tab === "all" || tab === "range" ? "" : tab} meetings</p>
        </div>
      ) : (
        <div class="meetings" aria-label="Meetings list">
          {[...groups.entries()].map(([d, list]) => (
            <section key={d} class="meeting-group">
              <h3 class="group-head">{fmtDateKey(d, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</h3>
              <ul>
                {list.map((b) => (
                  <li key={b.id} class={`meeting ${b.status}`} aria-label={`${b.invitee.name} ${b.eventTypeName}`}>
                    <div class="meeting-row">
                      <span class="dot" style={{ background: colors.get(b.eventTypeId) ?? "#999" }} />
                      <span class="meeting-time">
                        {fmtTime(b.start, tz)} - {fmtTime(b.end, tz)}
                      </span>
                      <div class="meeting-who">
                        <strong>{b.invitee.name}</strong>
                        <span class="small muted">
                          Event type <b>{b.eventTypeName}</b>
                        </span>
                      </div>
                      {b.status === "cancelled" && <span class="badge danger">Canceled</span>}
                      <button class="link-btn" aria-expanded={open === b.id} onClick={() => setOpen(open === b.id ? null : b.id)}>
                        {open === b.id ? "Hide" : "Details"}
                      </button>
                    </div>
                    {open === b.id && (
                      <div class="meeting-details">
                        <dl>
                          <dt>Email</dt>
                          <dd>{b.invitee.email}</dd>
                          {b.guests.length > 0 && (
                            <>
                              <dt>Guests</dt>
                              <dd>{b.guests.join(", ")}</dd>
                            </>
                          )}
                          {b.invitee.phone && (
                            <>
                              <dt>Phone</dt>
                              <dd>{b.invitee.phone}</dd>
                            </>
                          )}
                          <dt>Location</dt>
                          <dd>{b.location.joinUrl ? <a href={b.location.joinUrl}>{b.location.joinUrl}</a> : (b.location.value ?? LOCATION_LABEL[b.location.kind])}</dd>
                          <dt>Invitee time zone</dt>
                          <dd>{b.invitee.timezone}</dd>
                          {(b.answerDetails ?? []).map((a: any) => (
                            <>
                              <dt>{a.label}</dt>
                              <dd>{a.value}</dd>
                            </>
                          ))}
                          {b.calendarError && (
                            <>
                              <dt>Calendar</dt>
                              <dd class="error">{b.calendarError}</dd>
                            </>
                          )}
                          {b.cancelReason && (
                            <>
                              <dt>Cancel reason</dt>
                              <dd>{b.cancelReason}</dd>
                            </>
                          )}
                          {b.rescheduleCount > 0 && (
                            <>
                              <dt>Rescheduled</dt>
                              <dd>{plural(b.rescheduleCount, "time")}</dd>
                            </>
                          )}
                          <dt>Booked</dt>
                          <dd>{fmtDateTime(b.createdAt, tz)}</dd>
                        </dl>
                        {b.status === "confirmed" && Date.parse(b.end) > Date.now() && (
                          <div class="meeting-actions">
                            <button class="btn outline small" onClick={() => setMoveFor(b)}>
                              Reschedule
                            </button>
                            <button class="btn outline danger small" onClick={() => setCancelFor(b)}>
                              Cancel meeting
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {cursor && (
            <button class="btn outline load-more" onClick={() => load(true)}>
              Load more
            </button>
          )}
        </div>
      )}
      {cancelFor && <CancelModal b={cancelFor} onClose={() => setCancelFor(null)} onDone={(msg) => (setCancelFor(null), toast(msg), load())} />}
      {moveFor && <OwnerRescheduleModal b={moveFor} tz={tz} onClose={() => setMoveFor(null)} onDone={() => (setMoveFor(null), toast("Meeting rescheduled"), load())} />}
    </Shell>
  );
}

function addDaysStr(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function CancelModal({ b, onClose, onDone }: { b: any; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (kind: "cancel" | "request-reschedule") => {
    setBusy(true);
    setErr("");
    try {
      await post(`/bookings/${b.id}/${kind}`, { reason: reason || undefined });
      onDone(kind === "cancel" ? "Meeting canceled" : "Reschedule requested");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal label="Cancel meeting" onClose={onClose}>
      <h2>Cancel meeting</h2>
      <p class="small">
        <strong>{b.eventTypeName}</strong> with {b.invitee.name}
      </p>
      <label class="field">
        <span>Message to the invitee (optional)</span>
        <textarea name="reason" rows={3} value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
      </label>
      <p class="small muted">The invitee is notified by email. "Request reschedule" also sends them a link to pick a new time.</p>
      {err && (
        <p class="error" role="alert">
          {err}
        </p>
      )}
      <div class="modal-actions">
        <button class="btn outline" onClick={onClose}>
          Keep meeting
        </button>
        <button class="btn outline" disabled={busy} onClick={() => act("request-reschedule")}>
          Request reschedule
        </button>
        <button class="btn danger-solid" disabled={busy} onClick={() => act("cancel")}>
          Cancel meeting
        </button>
      </div>
    </Modal>
  );
}

function OwnerRescheduleModal({ b, tz, onClose, onDone }: { b: any; tz: string; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(todayIn(tz));
  // Slots are tagged with the date they belong to, so times of a previous date are never shown or clickable
  // while the new date loads.
  const [loaded, setLoaded] = useState<{ date: string; slots: any[] } | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const slots = loaded?.date === date ? loaded.slots : null;
  useEffect(() => {
    setPick(null);
    // A reply for a date that is no longer selected is ignored (replies can arrive out of order).
    let current = true;
    get(`/bookings/${b.id}/slots?from=${date}&to=${date}&timezone=${encodeURIComponent(tz)}`).then(
      (r) => current && (setLoaded({ date, slots: r.days[0]?.slots ?? [] }), setErr(r.warnings ? "Your calendar could not be checked, so no times are offered." : "")),
      (e) => current && setErr(e.message),
    );
    return () => {
      current = false;
    };
  }, [date]);
  return (
    <Modal label="Reschedule meeting" onClose={onClose}>
      <h2>Reschedule meeting</h2>
      <p class="small">
        {b.eventTypeName} with {b.invitee.name}, now {fmtTime(b.start, tz)} {fmtDateKey(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(b.start)), { month: "short", day: "numeric" })}
      </p>
      <label class="field">
        <span>New date</span>
        <input type="date" name="newDate" value={date} min={todayIn(tz)} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </label>
      <div class="slot-grid" role="group" aria-label="Available times">
        {slots === null ? <Loading /> : slots.length === 0 ? <p class="muted small">No times available on this day.</p> : null}
        {slots?.map((s) => (
          <button key={s.start} class={`chip ${pick === s.start ? "on" : ""}`} aria-pressed={pick === s.start} data-start={s.start} onClick={() => setPick(s.start)}>
            {fmtTime(s.start, tz)}
          </button>
        ))}
      </div>
      {err && (
        <p class="error" role="alert">
          {err}
        </p>
      )}
      <div class="modal-actions">
        <button class="btn outline" onClick={onClose}>
          Close
        </button>
        <button
          class="btn primary"
          disabled={!pick || !slots?.some((s) => s.start === pick)}
          onClick={async () => {
            try {
              await post(`/bookings/${b.id}/reschedule`, { start: pick });
              onDone();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Confirm new time
        </button>
      </div>
    </Modal>
  );
}

// ---------- integrations ----------
export function IntegrationsPage({ me, path, query }: { me: Me; path: string; query: URLSearchParams }) {
  const { data, err, reload } = useLoad(() => get("/integrations"));
  const flashErr = query.get("error");
  const connected = query.get("connected");
  return (
    <Shell me={me} path={path} title="Integrations">
      {flashErr && (
        <p class="error" role="alert">
          {flashErr}
        </p>
      )}
      {connected && (
        <p class="ok" role="status">
          Connected {connected === "google" ? "Google Calendar" : connected}.
        </p>
      )}
      {err && <p class="error">{err}</p>}
      {!data ? (
        <Loading />
      ) : (
        <div class="int-grid">
          {data.providers.map((p: any) => (
            <CalendarCard key={p.id} provider={p} connections={data.connections.filter((c: any) => c.provider === p.id)} appUrl={data.appUrl} reload={reload} />
          ))}
          <section class="panel int-card" aria-label="Zoom">
            <div class="int-head">
              <Icon.video size={26} />
              <h2>Zoom</h2>
            </div>
            <p class="small muted">Choose Zoom as an event type location and paste your meeting URL. Invitees get it in the confirmation.</p>
          </section>
          <section class="panel int-card" aria-label="Email notifications">
            <div class="int-head">
              <Icon.globe size={26} />
              <h2>Email notifications</h2>
            </div>
            <p class="small">
              Provider: <strong>{data.email.provider}</strong>
            </p>
            <p class="small muted">
              {data.email.provider === "log" ? "Emails are recorded in the outbox and the server log but not delivered. Set EMAIL_PROVIDER=resend to send them." : "Emails are delivered by the configured provider."}
            </p>
          </section>
        </div>
      )}
    </Shell>
  );
}

function CalendarCard({ provider, connections, appUrl, reload }: { provider: any; connections: any[]; appUrl: string; reload: () => void }) {
  const [err, setErr] = useState("");
  const connectOnCanonicalHost = provider.id === "google" && provider.configured && appUrl !== location.origin;
  return (
    <section class="panel int-card" aria-label={provider.name}>
      <div class="int-head">
        <Icon.cal size={26} />
        <h2>{provider.name}</h2>
        {connections.length > 0 && <span class="badge ok">Connected</span>}
      </div>
      <p class="small muted">Check for conflicts so busy times are hidden, and add new bookings to your calendar.</p>
      {provider.id === "google" && <p class="small"><a href="/static/privacy">How {brand.name} uses Google Calendar data</a></p>}
      {!provider.configured && <p class="small warn">Not configured on this server. See docs/GOOGLE-OAUTH-SETUP.md.</p>}
      {connections.map((c) => (
        <ConnectionBox key={c.id} conn={c} reload={reload} />
      ))}
      {err && <p class="error">{err}</p>}
      {connectOnCanonicalHost ? (
        <a class="btn primary small" href={`${appUrl}/app/integrations`}>Open {brand.name} to connect</a>
      ) : (
        <button
          class="btn primary small"
          disabled={!provider.configured}
          onClick={async () => {
            try {
              const r = await post(`/integrations/${provider.id}/connect`);
              location.href = r.url;
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          {connections.length ? "Connect another account" : "Connect"}
        </button>
      )}
      {provider.id === "mock" && connections.length > 0 && <MockBusyForm />}
    </section>
  );
}

function ConnectionBox({ conn, reload }: { conn: any; reload: () => void }) {
  const [cals, setCals] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    get(`/integrations/connections/${conn.id}/calendars`).then((r) => setCals(r.items), (e) => setErr(e.message));
  }, [conn.id]);
  const update = async (p: any) => {
    await patch(`/integrations/connections/${conn.id}`, p);
    toast("Calendar settings saved");
    reload();
  };
  return (
    <div class="conn" aria-label={`Connection ${conn.accountEmail}`}>
      <p>
        <strong>{conn.accountEmail}</strong>
      </p>
      {err && <p class="error small">{err}</p>}
      {cals && (
        <>
          <p class="small strong">Check these calendars for conflicts</p>
          {cals.map((c) => (
            <label class="check small" key={c.id}>
              <input
                type="checkbox"
                aria-label={`Check ${c.name} for conflicts`}
                checked={conn.checkCalendarIds.includes(c.id)}
                onChange={(e) => {
                  const on = (e.target as HTMLInputElement).checked;
                  update({ checkCalendarIds: on ? [...conn.checkCalendarIds, c.id] : conn.checkCalendarIds.filter((x: string) => x !== c.id) });
                }}
              />{" "}
              {c.name}
              {c.primary ? " (primary)" : ""}
            </label>
          ))}
          <label class="field small">
            <span>Add new bookings to</span>
            <select aria-label="Add new bookings to" value={conn.writeCalendarId ?? ""} onChange={(e) => update({ writeCalendarId: (e.target as HTMLSelectElement).value || null })}>
              <option value="">Do not add events</option>
              {cals.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <button
        class="btn outline danger small"
        onClick={async () => {
          if (!confirm("Disconnect this calendar?")) return;
          await del(`/integrations/connections/${conn.id}`);
          reload();
        }}
      >
        Disconnect
      </button>
    </div>
  );
}

function MockBusyForm() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [events, setEvents] = useState<any[]>([]);
  const load = () => get("/dev/mock-calendar/events").then((r) => setEvents(r.items));
  useEffect(() => {
    load();
  }, []);
  return (
    <form
      class="form mock-form"
      aria-label="Add mock busy time"
      onSubmit={async (e) => {
        e.preventDefault();
        await post("/dev/mock-calendar/events", { start: new Date(start).toISOString(), end: new Date(end).toISOString(), summary: "Busy (mock)" });
        toast("Busy time added");
        load();
      }}
    >
      <p class="small strong">Mock calendar events</p>
      <div class="grid2">
        <label class="field small">
          <span>Busy from</span>
          <input type="datetime-local" required value={start} onInput={(e) => setStart((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field small">
          <span>Busy until</span>
          <input type="datetime-local" required value={end} onInput={(e) => setEnd((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <button class="btn outline small" type="submit">
        Add busy time
      </button>
      <ul class="small mock-list" aria-label="Mock calendar events list">
        {events.map((ev) => (
          <li key={ev.id}>
            {ev.status === "cancelled" ? "[canceled] " : ""}
            {ev.summary}: {fmtDateTime(ev.start)} ({ev.source})
          </li>
        ))}
      </ul>
    </form>
  );
}

// ---------- settings ----------
export function SettingsPage({ me, path, onMe }: { me: Me; path: string; onMe: (m: Me) => void }) {
  const [p, setP] = useState({ name: me.name, username: me.username, welcome: me.welcome, timezone: me.timezone });
  const [err, setErr] = useState("");
  const { data, reload } = useLoad(() => get("/tokens"));
  const [tName, setTName] = useState("cli");
  const [scopes, setScopes] = useState<string[]>(["read", "write"]);
  const [newToken, setNewToken] = useState("");
  return (
    <Shell me={me} path={path} title="Settings">
      <section class="panel" aria-label="Profile">
        <h2>Profile</h2>
        <form
          class="form grid2"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr("");
            try {
              const r = await patch("/me", p);
              onMe(r.user);
              toast("Profile saved");
            } catch (e2) {
              setErr((e2 as Error).message);
            }
          }}
        >
          <label class="field">
            <span>Name</span>
            <input name="name" value={p.name} onInput={(e) => setP({ ...p, name: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>Username</span>
            <input name="username" value={p.username} onInput={(e) => setP({ ...p, username: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field">
            <span>Time zone</span>
            <TzSelect value={p.timezone} onChange={(v) => setP({ ...p, timezone: v })} />
          </label>
          <label class="field">
            <span>Welcome message</span>
            <textarea name="welcome" rows={2} value={p.welcome} onInput={(e) => setP({ ...p, welcome: (e.target as HTMLTextAreaElement).value })} />
          </label>
          {err && (
            <p class="error" role="alert">
              {err}
            </p>
          )}
          <div>
            <button class="btn primary" type="submit">
              Save profile
            </button>
          </div>
        </form>
      </section>
      <AccountSection me={me} onMe={onMe} />
      <section class="panel" aria-label="API tokens">
        <h2>API tokens</h2>
        <p class="small muted">For the slotwise CLI and agents. A token is shown once; only a hash is stored.</p>
        <form
          class="form token-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post("/tokens", { name: tName, scopes });
            setNewToken(r.token);
            reload();
          }}
        >
          <label class="field">
            <span>Token name</span>
            <input name="tokenName" value={tName} onInput={(e) => setTName((e.target as HTMLInputElement).value)} required />
          </label>
          {["read", "write"].map((s) => (
            <label class="check" key={s}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((e.target as HTMLInputElement).checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {s}
            </label>
          ))}
          <button class="btn primary small" type="submit" disabled={!scopes.length}>
            Create token
          </button>
        </form>
        {newToken && (
          <div class="new-token" role="status">
            <p class="small strong">Copy this token now. It will not be shown again.</p>
            <code data-testid="new-token">{newToken}</code>
            <button class="btn outline small" onClick={() => copyText(newToken).then(() => toast("Token copied"))}>
              <Icon.copy size={14} /> Copy
            </button>
          </div>
        )}
        <table class="table" aria-label="Tokens">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((t: any) => (
              <tr key={t.id} class={t.revokedAt ? "revoked" : ""}>
                <td>{t.name}</td>
                <td>
                  <code>{t.prefix}...</code>
                </td>
                <td>{t.scopes.join(", ")}</td>
                <td>{t.lastUsedAt ? fmtDateTime(t.lastUsedAt) : "never"}</td>
                <td>
                  {t.revokedAt ? (
                    <span class="badge">Revoked</span>
                  ) : (
                    <button
                      class="btn outline danger small"
                      aria-label={`Revoke ${t.name}`}
                      onClick={async () => {
                        await del(`/tokens/${t.id}`);
                        reload();
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}

function AccountSection({ me, onMe }: { me: Me; onMe: (m: Me) => void }) {
  const [emailErr, setEmailErr] = useState("");
  const [pwErr, setPwErr] = useState("");
  return (
    <section class="panel" aria-label="Account">
      <h2>Account</h2>
      <div class="grid2">
        <form
          class="form"
          aria-label="Change email"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.target as HTMLFormElement);
            setEmailErr("");
            try {
              const r = await post("/me/email", { email: f.get("newEmail"), currentPassword: f.get("emailPassword") });
              onMe(r.user);
              (e.target as HTMLFormElement).reset();
              toast("Email changed");
            } catch (e2) {
              setEmailErr((e2 as Error).message);
            }
          }}
        >
          <h3>Email</h3>
          <p class="small muted">Currently {me.email}</p>
          <label class="field">
            <span>New email</span>
            <input name="newEmail" type="email" required autoComplete="email" />
          </label>
          <label class="field">
            <span>Current password</span>
            <input name="emailPassword" type="password" required autoComplete="current-password" />
          </label>
          {emailErr && (
            <p class="error" role="alert">
              {emailErr}
            </p>
          )}
          <div>
            <button class="btn primary small" type="submit">
              Change email
            </button>
          </div>
        </form>
        <form
          class="form"
          aria-label="Change password"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.target as HTMLFormElement;
            const f = new FormData(form);
            setPwErr("");
            if (f.get("newPassword") !== f.get("repeatPassword")) return setPwErr("The new passwords do not match");
            try {
              const r = await post("/me/password", { currentPassword: f.get("currentPassword"), newPassword: f.get("newPassword"), revokeTokens: f.get("revokeTokens") === "on" });
              form.reset();
              toast(`Password changed. Other sessions were signed out${r.revokedTokens ? ` and ${plural(r.revokedTokens, "API token")} revoked` : ""}.`);
            } catch (e2) {
              setPwErr((e2 as Error).message);
            }
          }}
        >
          <h3>Password</h3>
          <label class="field">
            <span>Current password</span>
            <input name="currentPassword" type="password" required autoComplete="current-password" />
          </label>
          <label class="field">
            <span>New password</span>
            <input name="newPassword" type="password" required minLength={10} autoComplete="new-password" />
          </label>
          <label class="field">
            <span>Repeat new password</span>
            <input name="repeatPassword" type="password" required minLength={10} autoComplete="new-password" />
          </label>
          <label class="check small">
            <input type="checkbox" name="revokeTokens" defaultChecked /> Also revoke all API tokens (CLI and agents need a new token)
          </label>
          {pwErr && (
            <p class="error" role="alert">
              {pwErr}
            </p>
          )}
          <div>
            <button class="btn primary small" type="submit">
              Change password
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
