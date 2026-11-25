import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { get, post, ApiFail } from "./api";
import brand from "../brand.json";
import {
  allTimeZones,
  browserTz,
  dateInTz,
  durationLabel,
  fmtDateKey,
  fmtDateLong,
  fmtDayHeader,
  fmtTime,
  Icon,
  initials,
  Link,
  LOCATION_LABEL,
  LocationIcon,
  navigate,
  plural,
  prefers24h,
  todayIn,
  tzLabel,
} from "./util";

interface PubEventType {
  id: string;
  slug: string;
  name: string;
  description: string;
  durations: number[];
  defaultDuration: number;
  location: { kind: string; value?: string };
  questions: { id: string; label: string; kind: string; required: boolean; options?: string[] }[];
  color: string;
  maxGuests?: number;
}
interface Owner {
  name: string;
  username: string;
  welcome: string;
}
interface Day {
  date: string;
  slots: { start: string; end: string }[];
}

function monthOf(date: string) {
  return date.slice(0, 7);
}
function addMonths(month: string, n: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthDays(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function OwnerLanding({ username }: { username: string }) {
  const [data, setData] = useState<{ owner: Owner; eventTypes: PubEventType[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    get(`/public/users/${encodeURIComponent(username)}`).then(setData, (e) => setErr(e.message));
  }, [username]);
  if (err) return <NotFound message={err} />;
  if (!data) return <div class="page-center"><div class="spinner" aria-label="Loading" /></div>;
  return (
    <div class="public-bg">
      <main class="landing card" aria-label={`${data.owner.name} booking page`}>
        <div class="landing-head">
          <div class="avatar avatar-lg" aria-hidden="true">{initials(data.owner.name)}</div>
          <h1>{data.owner.name}</h1>
          <p class="muted">{data.owner.welcome || "Choose a meeting type to see available times."}</p>
        </div>
        <ul class="landing-grid" aria-label="Event types">
          {data.eventTypes.map((e) => (
            <li key={e.id}>
              <Link href={`/${data.owner.username}/${e.slug}`} class="landing-item">
                <span class="dot" style={{ background: e.color }} />
                <span class="landing-name">{e.name}</span>
                <span class="muted small">{e.durations.map(durationLabel).join(" / ")}</span>
                <Icon.right />
              </Link>
            </li>
          ))}
          {data.eventTypes.length === 0 && <li class="muted">No event types are available right now.</li>}
        </ul>
      </main>
      <Brand />
    </div>
  );
}

// A plain line under the card, outside it, so a long product name never crowds the booking layout.
function Brand() {
  return (
    <footer class="brand-footer">
      <a href="/">Scheduling by {brand.name}</a>
    </footer>
  );
}

export function NotFound({ message }: { message?: string }) {
  return (
    <div class="public-bg">
      <main class="card notfound">
        <h1>This page is not available</h1>
        <p class="muted">{message ?? "Check the link and try again."}</p>
      </main>
    </div>
  );
}

export function BookingPage({ username, slug, query }: { username: string; slug: string; query: URLSearchParams }) {
  const [data, setData] = useState<{ owner: Owner; eventType: PubEventType } | null>(null);
  const [err, setErr] = useState("");
  const [tz, setTz] = useState(query.get("tz") || browserTz());
  const [h24, setH24] = useState(prefers24h());
  const [duration, setDuration] = useState<number | null>(null);
  const [month, setMonth] = useState(query.get("month") || monthOf(query.get("date") || todayIn(tz)));
  const [selDate, setSelDate] = useState<string | null>(query.get("date"));
  const [selSlot, setSelSlot] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "form">("pick");
  const [days, setDays] = useState<Day[] | null>(null);
  const [autoAdvanced, setAutoAdvanced] = useState(Boolean(query.get("month") || query.get("date")));
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotErr, setSlotErr] = useState("");
  const [calDown, setCalDown] = useState(false);
  const rescheduleId = query.get("reschedule");
  const token = query.get("token") ?? "";
  const [orig, setOrig] = useState<any>(null);

  useEffect(() => {
    get(`/public/users/${encodeURIComponent(username)}/event-types/${encodeURIComponent(slug)}`).then(
      (d) => {
        setData(d);
        document.title = `${d.eventType.name} | ${d.owner.name}`;
      },
      (e) => setErr(e.message),
    );
    if (rescheduleId) get(`/public/bookings/${rescheduleId}?token=${encodeURIComponent(token)}`).then((d) => setOrig(d.booking), (e) => setErr(e.message));
  }, [username, slug]);

  const et = data?.eventType;
  const dur = orig?.duration ?? duration ?? et?.defaultDuration ?? 30;
  const today = todayIn(tz);

  // Only the newest slots request may update the calendar: month, zone or duration can change while one is in flight.
  const slotsSeq = useRef(0);
  async function loadMonth(m: string) {
    if (!et) return;
    const reqId = ++slotsSeq.current;
    const isLatest = () => reqId === slotsSeq.current;
    const first = `${m}-01`;
    const last = `${m}-${String(monthDays(m)).padStart(2, "0")}`;
    const from = first < today ? today : first;
    if (from > last) {
      setDays([]);
      setLoadingSlots(false);
      return;
    }
    setLoadingSlots(true);
    setSlotErr("");
    try {
      const q = new URLSearchParams({ from, to: last, timezone: tz, duration: String(dur) });
      if (rescheduleId) {
        q.set("excludeBooking", rescheduleId);
        q.set("token", token);
      }
      const r = await get(`/public/users/${encodeURIComponent(username)}/event-types/${encodeURIComponent(slug)}/slots?${q}`);
      if (!isLatest()) return;
      setDays(r.days);
      setCalDown(Boolean(r.warnings?.includes("calendar_unavailable")));
      if (!autoAdvanced && r.days.length === 0 && !r.warnings) {
        setAutoAdvanced(true);
        setMonth(addMonths(m, 1));
      } else setAutoAdvanced(true);
    } catch (e) {
      if (!isLatest()) return;
      setSlotErr((e as Error).message);
      setDays([]);
    } finally {
      if (isLatest()) setLoadingSlots(false);
    }
  }

  useEffect(() => {
    loadMonth(month);
  }, [et?.id, month, tz, dur]);

  // Keep shareable state in the URL like ?month=2026-11&date=2026-11-24.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    q.set("month", month);
    if (selDate) q.set("date", selDate);
    else q.delete("date");
    history.replaceState(null, "", `${location.pathname}?${q}`);
  }, [month, selDate]);

  const byDate = useMemo(() => new Map((days ?? []).map((d) => [d.date, d.slots])), [days]);

  if (err) return <NotFound message={err} />;
  if (!data || !et) return <div class="page-center"><div class="spinner" aria-label="Loading" /></div>;

  const slots = selDate ? (byDate.get(selDate) ?? []) : [];
  const selSlotObj = slots.find((s) => s.start === selSlot);

  return (
    <div class="public-bg">
      <main class={`booking card ${selDate && step === "pick" ? "with-times" : ""} ${step === "form" ? "with-form" : ""}`} aria-label="Book a meeting">
        <section class="booking-info" aria-label="Event details">
          {step === "form" && (
            <button class="icon-btn back" aria-label="Back" onClick={() => setStep("pick")}>
              <Icon.left />
            </button>
          )}
          <div class="avatar" aria-hidden="true">{initials(data.owner.name)}</div>
          <p class="owner-name">{data.owner.name}</p>
          <h1 class="event-name">{et.name}</h1>
          <ul class="facts">
            <li>
              <Icon.clock /> <span>{durationLabel(dur)}</span>
            </li>
            <li>
              <LocationIcon kind={et.location.kind} />{" "}
              <span>{et.location.kind === "in_person" || et.location.kind === "custom" ? et.location.value : LOCATION_LABEL[et.location.kind]}</span>
            </li>
            {step === "form" && selSlotObj && (
              <>
                <li class="fact-strong">
                  <Icon.cal />{" "}
                  <span>
                    {fmtTime(selSlotObj.start, tz, h24)} - {fmtTime(selSlotObj.end, tz, h24)}, {fmtDateLong(selSlotObj.start, tz)}
                  </span>
                </li>
                <li>
                  <Icon.globe /> <span>{tz.replace(/_/g, " ")}</span>
                </li>
              </>
            )}
          </ul>
          {et.durations.length > 1 && !orig && step === "pick" && (
            <div class="durations" role="group" aria-label="Duration">
              {et.durations.map((d) => (
                <button key={d} class={`chip ${d === dur ? "on" : ""}`} aria-pressed={d === dur} onClick={() => (setDuration(d), setSelSlot(null))}>
                  {durationLabel(d)}
                </button>
              ))}
            </div>
          )}
          {orig && (
            <div class="former" aria-label="Moving from">
              <p class="small muted">Moving from</p>
              <p class="strike">
                {fmtTime(orig.start, tz, h24)} - {fmtTime(orig.end, tz, h24)}, {fmtDateLong(orig.start, tz)}
              </p>
            </div>
          )}
          {et.description && step === "pick" && <p class="description">{et.description}</p>}
        </section>

        {step === "pick" && (
          <>
            <section class="booking-cal" aria-label="Pick a time">
              <h2>Pick a time</h2>
              <MonthCalendar
                month={month}
                today={today}
                available={byDate}
                selected={selDate}
                loading={loadingSlots}
                onMonth={(m) => {
                  setMonth(m);
                  setSelDate(null);
                  setSelSlot(null);
                }}
                onPick={(d) => {
                  setSelDate(d);
                  setSelSlot(null);
                }}
              />
              {slotErr && <p class="error" role="alert">{slotErr}</p>}
              {calDown && (
                <p class="error small" role="alert">
                  Times cannot be shown right now because the host's calendar is not reachable. Please try again later.
                </p>
              )}
              {!loadingSlots && days && days.length === 0 && !slotErr && !calDown && (
                <p class="muted small no-avail" role="status">
                  No times available in {fmtDateKey(`${month}-01`, { month: "long", year: "numeric" })}.{" "}
                  <button class="link-btn" onClick={() => setMonth(addMonths(month, 1))}>
                    Try next month
                  </button>
                </p>
              )}
              <div class="tz-row">
                <label for="tz-select" class="small strong">
                  Time zone
                </label>
                <div class="tz-select-wrap">
                  <Icon.globe />
                  <select id="tz-select" aria-label="Time zone" value={tz} onChange={(e) => (setTz((e.target as HTMLSelectElement).value), setSelSlot(null))}>
                    {[...new Set([tz, ...allTimeZones()])].map((z) => (
                      <option key={z} value={z}>
                        {tzLabel(z)}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="seg" role="group" aria-label="Time format">
                  <button class={!h24 ? "on" : ""} aria-pressed={!h24} onClick={() => setH24(false)}>
                    am/pm
                  </button>
                  <button class={h24 ? "on" : ""} aria-pressed={h24} onClick={() => setH24(true)}>
                    24h
                  </button>
                </div>
              </div>
            </section>
            {selDate && (
              <section class="booking-times" aria-label="Available times">
                <h3>{fmtDayHeader(selDate)}</h3>
                <ul class="times">
                  {slots.map((s) => (
                    <li key={s.start}>
                      {selSlot === s.start ? (
                        <div class="time-confirm">
                          <span class="time-picked">{fmtTime(s.start, tz, h24)}</span>
                          <button class="btn primary" aria-label={`Next: ${fmtTime(s.start, tz, h24)}`} onClick={() => setStep("form")}>
                            Next
                          </button>
                        </div>
                      ) : (
                        <button class="time-btn" data-start={s.start} onClick={() => setSelSlot(s.start)}>
                          {fmtTime(s.start, tz, h24)}
                        </button>
                      )}
                    </li>
                  ))}
                  {slots.length === 0 && <li class="muted">No times left on this day.</li>}
                </ul>
              </section>
            )}
          </>
        )}

        {step === "form" && selSlotObj && (
          <section class="booking-form" aria-label="Your details">
            {orig ? (
              <RescheduleConfirm id={rescheduleId!} token={token} start={selSlotObj.start} tz={tz} onTaken={() => (setStep("pick"), setSelSlot(null), loadMonth(month))} />
            ) : (
              <InviteeForm et={et} username={username} start={selSlotObj.start} duration={dur} tz={tz} onTaken={() => (setStep("pick"), setSelSlot(null), loadMonth(month))} />
            )}
          </section>
        )}
      </main>
      <Brand />
    </div>
  );
}

function MonthCalendar(p: {
  month: string;
  today: string;
  available: Map<string, unknown[]>;
  selected: string | null;
  loading: boolean;
  onMonth: (m: string) => void;
  onPick: (d: string) => void;
}) {
  const [y, m] = p.month.split("-").map(Number) as [number, number];
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const n = monthDays(p.month);
  const cells: (string | null)[] = [...Array(firstWeekday).fill(null)];
  for (let d = 1; d <= n; d++) cells.push(`${p.month}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  const canPrev = p.month > monthOf(p.today);
  return (
    <div class="month" aria-busy={p.loading}>
      <div class="month-nav">
        <button class="icon-btn round" aria-label="Previous month" disabled={!canPrev} onClick={() => p.onMonth(addMonths(p.month, -1))}>
          <Icon.left />
        </button>
        <span class="month-title" aria-live="polite">
          {fmtDateKey(`${p.month}-01`, { month: "long", year: "numeric" })}
        </span>
        <button class="icon-btn round" aria-label="Next month" onClick={() => p.onMonth(addMonths(p.month, 1))}>
          <Icon.right />
        </button>
      </div>
      <div class="weekdays" aria-hidden="true">
        {["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div class="days" role="grid" aria-label="Dates">
        {cells.map((d, i) => {
          if (!d) return <span key={i} class="day empty" />;
          const avail = (p.available.get(d)?.length ?? 0) > 0;
          const label = `${fmtDateKey(d, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${avail ? ", times available" : ", no times available"}`;
          return (
            <button
              key={d}
              class={`day ${avail ? "avail" : ""} ${p.selected === d ? "sel" : ""} ${p.today === d ? "today" : ""}`}
              disabled={!avail}
              aria-label={label}
              aria-pressed={p.selected === d}
              data-date={d}
              onClick={() => p.onPick(d)}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InviteeForm(p: { et: PubEventType; username: string; start: string; duration: number; tz: string; onTaken: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [guests, setGuests] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const needsPhone = p.et.location.kind === "phone" && !p.et.location.value;

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await post("/public/bookings", {
        username: p.username,
        slug: p.et.slug,
        start: p.start,
        duration: p.duration,
        timezone: p.tz,
        name,
        email,
        ...(needsPhone ? { phone } : {}),
        guests: guests
          .split(/[\s,;]+/)
          .map((g) => g.trim())
          .filter(Boolean),
        answers,
      });
      navigate(`/booking/${r.booking.id}?token=${encodeURIComponent(r.manageToken)}&confirmed=1`);
    } catch (e2) {
      const f = e2 as ApiFail;
      setErr(f.message);
      setBusy(false);
      if (f.code === "slot_taken" || f.code === "limit_reached") setTimeout(p.onTaken, 1800);
    }
  }

  const setA = (id: string, v: string) => setAnswers((a) => ({ ...a, [id]: v }));

  return (
    <form onSubmit={submit} aria-label="Invitee details" class="form">
      <h2>Your details</h2>
      <label class="field">
        <span>Name *</span>
        <input name="name" required autoComplete="name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <label class="field">
        <span>Email *</span>
        <input name="email" type="email" required autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
      </label>
      {(p.et.maxGuests ?? 3) === 0 ? null : !guestsOpen ? (
        <button type="button" class="btn outline small" onClick={() => setGuestsOpen(true)}>
          Add guests
        </button>
      ) : (
        <label class="field">
          <span>Guest emails</span>
          <textarea name="guests" rows={2} placeholder="Separate emails with commas" value={guests} onInput={(e) => setGuests((e.target as HTMLTextAreaElement).value)} />
          <small class="muted">Up to {plural(p.et.maxGuests ?? 3, "guest")}. They get the calendar invitation too.</small>
        </label>
      )}
      {needsPhone && (
        <label class="field">
          <span>Phone number *</span>
          <input name="phone" type="tel" required autoComplete="tel" value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} />
        </label>
      )}
      {p.et.questions.map((q) => (
        <Question key={q.id} q={q} value={answers[q.id] ?? ""} onChange={(v) => setA(q.id, v)} />
      ))}
      <p class="small muted">By continuing you agree that your details are shared with the host for this meeting.</p>
      {err && (
        <p class="error" role="alert">
          {err}
        </p>
      )}
      <button class="btn primary pill" type="submit" disabled={busy}>
        {busy ? "Booking..." : "Book meeting"}
      </button>
    </form>
  );
}

function Question({ q, value, onChange }: { q: PubEventType["questions"][number]; value: string; onChange: (v: string) => void }) {
  const label = `${q.label}${q.required ? " *" : ""}`;
  if (q.kind === "textarea")
    return (
      <label class="field">
        <span>{label}</span>
        <textarea name={`q-${q.id}`} rows={3} required={q.required} value={value} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} />
      </label>
    );
  if (q.kind === "select")
    return (
      <label class="field">
        <span>{label}</span>
        <select name={`q-${q.id}`} required={q.required} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          <option value="">Select...</option>
          {q.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  if (q.kind === "radio" || q.kind === "checkbox") {
    const picked = value ? value.split(/\s*,\s*/) : [];
    return (
      <fieldset class="field">
        <legend>{label}</legend>
        {q.options?.map((o) => (
          <label class="check" key={o}>
            <input
              type={q.kind as "radio" | "checkbox"}
              name={`q-${q.id}`}
              checked={picked.includes(o)}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                if (q.kind === "radio") onChange(o);
                else onChange((on ? [...picked, o] : picked.filter((x) => x !== o)).join(", "));
              }}
            />{" "}
            {o}
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <label class="field">
      <span>{label}</span>
      <input name={`q-${q.id}`} type={(q.kind === "phone" ? "tel" : "text") as "text"} required={q.required} value={value} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
    </label>
  );
}

function RescheduleConfirm(p: { id: string; token: string; start: string; tz: string; onTaken: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div class="form">
      <h2>Confirm new time</h2>
      <p>
        {fmtTime(p.start, p.tz)}, {fmtDateLong(p.start, p.tz)}
      </p>
      {err && (
        <p class="error" role="alert">
          {err}
        </p>
      )}
      <button
        class="btn primary pill"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await post(`/public/bookings/${p.id}/reschedule`, { token: p.token, start: p.start, timezone: p.tz });
            navigate(`/booking/${p.id}?token=${encodeURIComponent(p.token)}&rescheduled=1`);
          } catch (e) {
            setErr((e as Error).message);
            setBusy(false);
            if ((e as ApiFail).code === "slot_taken") setTimeout(p.onTaken, 1800);
          }
        }}
      >
        {busy ? "Saving..." : "Reschedule meeting"}
      </button>
    </div>
  );
}

export function ManageBooking({ id, query }: { id: string; query: URLSearchParams }) {
  const token = query.get("token") ?? "";
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [cancelOpen, setCancelOpen] = useState(query.get("action") === "cancel");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => get(`/public/bookings/${id}?token=${encodeURIComponent(token)}`).then(setData, (e) => setErr(e.message));
  useEffect(() => {
    load();
  }, [id]);
  if (err && !data) return <NotFound message={err} />;
  if (!data) return <div class="page-center"><div class="spinner" aria-label="Loading" /></div>;
  const b = data.booking;
  const tz = b.invitee.timezone;
  const cancelled = b.status === "cancelled";
  const loc = b.location;
  const isPast = Date.parse(b.end) < Date.now();
  const heading = cancelled ? "This meeting is canceled" : query.get("confirmed") ? "Booking confirmed" : query.get("rescheduled") ? "Your meeting has a new time" : "Your meeting";
  const gcal = `https://calendar.google.com/calendar/render?${new URLSearchParams({
    action: "TEMPLATE",
    text: `${b.eventTypeName} with ${data.owner.name}`,
    dates: `${b.start.replace(/[-:]|\.\d{3}/g, "")}/${b.end.replace(/[-:]|\.\d{3}/g, "")}`,
    details: `Manage: ${location.href.split("&")[0]}`,
  })}`;
  return (
    <div class="public-bg">
      <main class="card confirm" aria-label="Booking">
        <div class={`confirm-badge ${cancelled ? "off" : ""}`} aria-hidden="true">
          {cancelled ? <Icon.x size={22} /> : <Icon.check size={22} />}
        </div>
        <h1>{heading}</h1>
        {!cancelled && (query.get("confirmed") || query.get("rescheduled")) && <p class="muted">Save this page to view or manage your booking.</p>}
        <div class="confirm-box" aria-label="Meeting details">
          <h2>{b.eventTypeName}</h2>
          <ul class="facts">
            <li>
              <Icon.user /> <span>{data.owner.name}</span>
            </li>
            <li class={cancelled ? "strike" : ""}>
              <Icon.cal />{" "}
              <span data-testid="booking-time">
                {fmtTime(b.start, tz)} - {fmtTime(b.end, tz)}, {fmtDateLong(b.start, tz)}
              </span>
            </li>
            <li>
              <Icon.globe /> <span>{tz.replace(/_/g, " ")}</span>
            </li>
            <li>
              <LocationIcon kind={loc.kind} />{" "}
              <span>
                {loc.joinUrl ? (
                  <a href={loc.joinUrl} target="_blank" rel="noopener noreferrer">
                    {LOCATION_LABEL[loc.kind]}: join link
                  </a>
                ) : loc.kind === "zoom" && loc.value ? (
                  <a href={loc.value} target="_blank" rel="noopener noreferrer">
                    Zoom: join link
                  </a>
                ) : loc.kind === "phone" ? (
                  `Phone call: ${loc.value ?? ""}`
                ) : loc.kind === "google_meet" ? (
                  "Google Meet (link in the calendar invitation)"
                ) : (
                  loc.value
                )}
              </span>
            </li>
          </ul>
          {cancelled && b.cancelReason && <p class="small muted">Reason: {b.cancelReason}</p>}
        </div>
        {!cancelled && !isPast && (
          <div class="confirm-actions">
            <a class="btn outline" href={gcal} target="_blank" rel="noopener noreferrer">
              Add to Google Calendar
            </a>
            {data.eventType?.active && (
              <Link class="btn outline" href={`/${data.owner.username}/${data.eventType.slug}?reschedule=${b.id}&token=${encodeURIComponent(token)}&month=${dateInTz(b.start, tz).slice(0, 7)}`}>
                Reschedule
              </Link>
            )}
            <button class="btn outline danger" onClick={() => setCancelOpen(true)}>
              Cancel
            </button>
          </div>
        )}
        {cancelOpen && !cancelled && (
          <form
            class="form cancel-form"
            aria-label="Cancel meeting"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post(`/public/bookings/${id}/cancel`, { token, reason: reason || undefined });
                setCancelOpen(false);
                await load();
              } catch (e2) {
                setErr((e2 as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label class="field">
              <span>Why are you canceling? (optional)</span>
              <textarea name="reason" rows={3} value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
            </label>
            {err && (
              <p class="error" role="alert">
                {err}
              </p>
            )}
            <button class="btn danger-solid pill" disabled={busy} type="submit">
              {busy ? "Canceling..." : "Cancel meeting"}
            </button>
          </form>
        )}
        {cancelled && data.eventType?.active && (
          <p>
            <Link href={`/${data.owner.username}/${data.eventType.slug}`}>Book a new time</Link>
          </p>
        )}
      </main>
      <Brand />
    </div>
  );
}
