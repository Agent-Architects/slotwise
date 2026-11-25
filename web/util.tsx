import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import brand from "../brand.json";

// ---------- routing ----------
const listeners = new Set<() => void>();
export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function useLocation() {
  const [, set] = useState(0);
  useEffect(() => {
    const l = () => set((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

export function Link(props: { href: string; class?: string; children: ComponentChildren; "aria-label"?: string; "aria-current"?: any }) {
  return (
    <a
      {...props}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

// ---------- time ----------
export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function allTimeZones(): string[] {
  try {
    return (Intl as any).supportedValuesOf("timeZone") as string[];
  } catch {
    return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];
  }
}

export function fmtTime(iso: string | number, tz: string, h24 = false) {
  return new Intl.DateTimeFormat(h24 ? "en-GB" : "en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: !h24 })
    .format(new Date(iso))
    .replace(" AM", "am")
    .replace(" PM", "pm");
}

export function fmtDateLong(iso: string | number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));
}

/** Short date and time in en-US, e.g. "Nov 24, 2026, 3:00pm", in the given zone (default: the browser's). */
export function fmtDateTime(iso: string | number, tz = browserTz()) {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
  return `${date}, ${fmtTime(iso, tz)}`;
}

/** "1 guest", "3 guests". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function fmtDayHeader(date: string) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(Date.UTC(y, m - 1, d));
}

export function fmtDateKey(date: string, opts: Intl.DateTimeFormatOptions) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(Date.UTC(y, m - 1, d));
}

export function todayIn(tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function dateInTz(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function tzLabel(tz: string) {
  return `${tz.replace(/_/g, " ")} (${fmtTime(Date.now(), tz)})`;
}

export const prefers24h = () => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle?.startsWith("h2") ?? false;
  } catch {
    return false;
  }
};

export function durationLabel(mins: number) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export const LOCATION_LABEL: Record<string, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  phone: "Phone call",
  in_person: "In-person meeting",
  custom: "Custom location",
};

export { initials } from "./text";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// ---------- toast ----------
let toastSet: ((m: string | null) => void) | null = null;
export function toast(m: string) {
  toastSet?.(m);
}
export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);
  toastSet = setMsg;
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2600);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? (
    <div class="toast" role="status" aria-live="polite">
      {msg}
    </div>
  ) : null;
}

// ---------- icons ----------
type IP = { size?: number };
const svg = (d: ComponentChildren, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {d}
  </svg>
);
export const Icon = {
  clock: ({ size }: IP) => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, size),
  pin: ({ size }: IP) => svg(<><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></>, size),
  video: ({ size }: IP) => svg(<><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /></>, size),
  phone: ({ size }: IP) => svg(<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />, size),
  globe: ({ size }: IP) => svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>, size),
  cal: ({ size }: IP) => svg(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>, size),
  left: ({ size }: IP) => svg(<path d="M15 6l-6 6 6 6" />, size),
  right: ({ size }: IP) => svg(<path d="M9 6l6 6-6 6" />, size),
  check: ({ size }: IP) => svg(<path d="M5 12l5 5 9-10" />, size),
  x: ({ size }: IP) => svg(<path d="M6 6l12 12M18 6L6 18" />, size),
  plus: ({ size }: IP) => svg(<path d="M12 5v14M5 12h14" />, size),
  copy: ({ size }: IP) => svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>, size),
  link: ({ size }: IP) => svg(<><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" /><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" /></>, size),
  grid: ({ size }: IP) => svg(<><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>, size),
  list: ({ size }: IP) => svg(<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />, size),
  plug: ({ size }: IP) => svg(<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />, size),
  gear: ({ size }: IP) => svg(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>, size),
  user: ({ size }: IP) => svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>, size),
};

export function LocationIcon({ kind, size }: { kind: string; size?: number }) {
  if (kind === "google_meet" || kind === "zoom") return <Icon.video size={size} />;
  if (kind === "phone") return <Icon.phone size={size} />;
  return <Icon.pin size={size} />;
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span class="logo" aria-label={brand.name}>
      <img src={brand.logo} width={size} height={size} alt="" />
      <span class="logo-word">{brand.name}</span>
    </span>
  );
}
