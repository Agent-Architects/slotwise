# Google Calendar OAuth setup

Slotwise reads free/busy times from the calendars you pick and writes each booking as an event (invitee as
attendee, optional Google Meet link). It needs one OAuth 2.0 "Web application" client from Google Cloud, owned by
whoever runs the instance. Nothing here is shared between Slotwise instances.

## Scopes requested

These are exactly the scopes in `GOOGLE_SCOPES` in `src/adapters/google-calendar.ts`:

| Scope | Why |
|---|---|
| `openid`, `email` | Show which Google account is connected |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | List your calendars so you can pick which to check and which to write to |
| `https://www.googleapis.com/auth/calendar.freebusy` | Read busy times only (no event details) |
| `https://www.googleapis.com/auth/calendar.events` | Create, move and cancel booking events (and their Meet links). Read limited event details during rescheduling so a booking is not blocked by its own former time. |

Slotwise never asks for the full `https://www.googleapis.com/auth/calendar` scope. The consent request uses
`access_type=offline` and `prompt=consent` so Google returns a refresh token. Tokens are encrypted with
AES-256-GCM (`ENCRYPTION_KEY`) before they are stored.

## Redirect URIs

The callback path is always `/oauth/google/callback` on the app origin (`APP_URL`, or the request origin when
`APP_URL` is not set):

| Where | Authorized redirect URI |
|---|---|
| Cloudflare workers.dev | `https://slotwise.<your-subdomain>.workers.dev/oauth/google/callback` |
| Custom domain | `https://book.example.com/oauth/google/callback` (set `APP_URL` to `https://book.example.com`) |
| Self-hosted Node | `https://<your host>/oauth/google/callback` (set `APP_URL`) |
| Local Node dev | `http://localhost:8787/oauth/google/callback` (open the app at `http://localhost:8787`, not 127.0.0.1) |
| Local wrangler dev | `http://localhost:8788/oauth/google/callback` |

The Cloudflare deploy script prints the exact production URI at the end. When `APP_URL` is set, sign in at that
hostname before starting Connect, so the callback lands on the same session cookie.

## Public pages Google asks for

Every instance serves a generic homepage, privacy policy and terms page, templated with the product name:

| Page | URL |
|---|---|
| Homepage | `<APP_URL>/static/home` (also served at `<APP_URL>/`) |
| Privacy policy | `<APP_URL>/static/privacy` |
| Terms of service | `<APP_URL>/static/terms` |

Read them before you publish the consent screen and adjust the wording if your use differs (they are static
HTML under `public/static/`).

## Steps in Google Cloud Console

1. Go to https://console.cloud.google.com/ and create a project (for example `slotwise`), or pick an existing one.
2. APIs & Services > Library > search **Google Calendar API** > Enable.
3. Google Auth Platform > Branding (older consoles: APIs & Services > OAuth consent screen) > Get started:
   - App name: your product name (default `Slotwise`), user support email, developer contact email.
   - Audience: **External** (any Google account) or **Internal** (only your Google Workspace organization).
   - App homepage, privacy policy and terms links: the URLs in the table above.
   - Authorized domains: for a custom domain add the registrable domain (for example `example.com`). Google does
     not accept `workers.dev` here; leave it empty for a workers.dev URL (allowed while the app is unverified).
     If Google asks you to verify domain ownership, add the domain as a Domain property in Google Search Console
     with the same Google account that owns the Cloud project.
4. Google Auth Platform > Data access > Add or remove scopes > add the five scopes in the table above > Save.
   Three of them are "sensitive"; that is expected.
5. Google Auth Platform > Audience:
   - While **Testing**, add your own Google account under Test users. In Testing mode Google expires refresh
     tokens after 7 days, so the calendar disconnects weekly.
   - For long-lived connections choose **Publish app** (In production). Without Google's verification review,
     users see an "unverified app" warning they can click through, and the app is capped at 100 users, which is
     fine for a personal scheduling page. Submit for verification only if you need more users or no warning.
6. Google Auth Platform > Clients > Create client:
   - Application type **Web application**, name for example `Slotwise web`.
   - Authorized JavaScript origins: optional (Slotwise does the OAuth exchange on the server).
   - Authorized redirect URIs: add every URI from the table you will use.
   - Create, then copy the **Client ID** and **Client secret**. Save the secret to a file readable only by you
     (`chmod 600`); never paste it into a chat or a tracked file.
7. Give them to Slotwise:
   - Cloudflare: `GOOGLE_CLIENT_ID=<id> GOOGLE_CLIENT_SECRET_FILE=/secure/path/google-secret npm run deploy:cloudflare -- --yes`
     (the id is a plain var and is remembered for later deploys; the secret becomes a Worker secret). `--yes`
     skips the account prompt, so only use it once you have confirmed the Cloudflare account the deploy script
     printed on an earlier run (or leave it off in your own terminal to be asked).
   - Node: environment variables `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (see docs/SELF-HOST.md).
8. In Slotwise: Integrations > Google Calendar > **Connect**, sign in, approve. Back on the Integrations page,
   choose which calendars to check for conflicts and which one receives new bookings.
9. Check it: create a busy event in that Google calendar during your availability, then run
   `node scripts/smoke-booking.mjs --url <APP_URL> --token-file <file> --busy-start <ISO> --busy-end <ISO>`.
   It fails if any offered slot overlaps the busy event, and it books and cancels one real slot (written to and
   removed from the calendar).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `redirect_uri_mismatch` | The URI in step 6 must match exactly, including scheme, host, port and no trailing slash |
| Card says "Not configured on this server" | `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` missing in the running app |
| `access_denied` back on Integrations | You declined consent, or the account is not a Test user while in Testing mode |
| "OAuth callback does not match the signed-in owner" | You started Connect on a different hostname than `APP_URL`; sign in at `APP_URL` and retry |
| A booking shows a calendar error | The write calendar is read-only for the account, or the refresh token was revoked; reconnect |
| Connection stops working after a week | App is in Testing mode; publish it (step 5) and reconnect |
