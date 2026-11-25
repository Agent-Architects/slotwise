# Security controls

Cookie sessions need a CSRF token for mutations, API tokens are scoped and revocable, pages carry CSP and anti
framing headers, and public write endpoints are rate limited per IP.

## Sub-features

- `sec-csrf` cookie PATCH without `X-CSRF-Token` is 403.
- `sec-scopes` read-only token cannot write (403); revoked token is 401.
- `sec-headers` `Content-Security-Policy` with `frame-ancestors 'none'` on HTML pages (both adapters).
- `sec-ratelimit` public writes return 429 with `Retry-After`; on Node, spoofed `cf-connecting-ip` / `x-real-ip` do not reset it.
- `sec-404` unknown `/api/v1` paths are 404 (not 401); `sec-badtime` `25:00` is 400.

## How to get to it (user POV)

- Any owner mutation from the browser; CLI tokens; repeated public booking attempts.

## Driving it with verify.mjs

Preconditions:

- Owner signed in in the owner context; runs last.

- **CSRF.** Owner context `request.patch('/api/v1/me')` without the header returns 403.
- **Scopes.** Token exchanged with `scopes: ["read"]` gets 403 on `POST /api/v1/event-types`; after `slotwise tokens revoke <id>` it gets 401.
- **Headers.** `GET /app/event-types` has CSP containing `frame-ancestors 'none'`.
- **404 and 400.** `GET /api/v1/definitely-not-here` is 404; `PATCH /api/v1/availability` with `25:00` is 400 `bad_request`.
- **Rate limit.** Repeated `POST /api/v1/public/bookings` hits 429 with `Retry-After` within the configured limit; on the node adapter each request carries a different `cf-connecting-ip` and `x-real-ip`.
- **Proof.** results.json checks for this journey.

## Gotchas

- On Workers, HTML is served by static assets before the worker runs; the headers come from `public/_headers`.
- The rate-limit window is a fixed 60 s; the journey starts its burst in the first half of a window so the burst cannot be split across two windows.
- wrangler dev passes client `cf-connecting-ip` through, so the spoof check only runs on node; on Cloudflare the edge sets that header.
