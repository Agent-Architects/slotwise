import { GoogleCalendarProvider } from "./adapters/google-calendar.js";
import { LogMailer, ResendMailer } from "./adapters/mailers.js";
import { MockCalendarProvider } from "./adapters/mock-calendar.js";
import { SecretBox } from "./core/crypto.js";
import type { CalendarProvider, Db, Mailer } from "./core/ports.js";
import type { Config, Deps } from "./core/service.js";
import brand from "../brand.json";

export const VERSION = "0.1.0";

/** Environment shared by both hosting adapters (Workers vars/secrets or process.env). */
export interface AppEnv {
  APP_URL?: string;
  ENCRYPTION_KEY?: string;
  ALLOW_SIGNUP?: string;
  SETUP_CODE?: string;
  MOCK_CALENDAR?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  RATE_LIMIT_PUBLIC_READ?: string;
  RATE_LIMIT_PUBLIC_WRITE?: string;
  RATE_LIMIT_AUTH?: string;
  GUEST_EMAILS_PER_HOUR?: string;
  LOG_EMAILS?: string;
  /** Product name in emails and calendar text; defaults to the name in brand.json at build time. */
  APP_NAME?: string;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);

const boxCache = new Map<string, SecretBox>();

export function buildDeps(env: AppEnv, db: Db, origin: string, now: () => number = Date.now): Deps {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set (32 random bytes, base64). See docs/DEPLOY-CLOUDFLARE.md");
  let box = boxCache.get(env.ENCRYPTION_KEY);
  if (!box) boxCache.set(env.ENCRYPTION_KEY, (box = new SecretBox(env.ENCRYPTION_KEY)));
  const config: Config = {
    appUrl: (env.APP_URL || origin).replace(/\/+$/, ""),
    appName: env.APP_NAME || brand.name,
    allowSignup: env.ALLOW_SIGNUP === "true",
    setupCode: env.SETUP_CODE || undefined,
    guestEmailsPerHour: num(env.GUEST_EMAILS_PER_HOUR, 20),
    mockCalendar: env.MOCK_CALENDAR === "true",
    rateLimits: {
      publicRead: num(env.RATE_LIMIT_PUBLIC_READ, 240),
      publicWrite: num(env.RATE_LIMIT_PUBLIC_WRITE, 20),
      auth: num(env.RATE_LIMIT_AUTH, 10),
    },
    version: VERSION,
  };
  const providers: CalendarProvider[] = [new GoogleCalendarProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)];
  if (config.mockCalendar) providers.push(new MockCalendarProvider(db));
  let mailer: Mailer = new LogMailer(env.LOG_EMAILS === "false");
  if (env.EMAIL_PROVIDER === "resend") {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("EMAIL_PROVIDER=resend needs RESEND_API_KEY and EMAIL_FROM");
    mailer = new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM);
  }
  return { db, mailer, providers, box, clock: { now }, config };
}
