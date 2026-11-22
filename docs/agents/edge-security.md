> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Edge security (`lib/edge/*`, migration 084)

Replay claims, sliding-window rate limits and the sign-in lockout live in
`edge_seen_keys`, `edge_rate_events`, `edge_auth_failures` and
`edge_auth_locks` behind advisory-locked functions on the database clock; RLS
is on with no policy, and tables and functions are granted to `service_role`
only. `edge_purge()` only trims expired rows, so nothing depends on it for
correctness. `lib/edge/rpc.ts` states the failure matrix: rate limits fail
open or closed per scope (`DEFAULT_SCOPES` in `ratelimit.ts`), the replay
store fails open, lockout errors propagate. `docs/security.md` is the operator
contract; `verify-edge-security.sql` asserts the SQL.

- **Webhooks.** `screenWebhook` (`screen.ts`) runs once per request after
  authentication: Whapi once the secret has resolved the row, Meta over the
  HMAC-verified numbers. It **never answers 429**: an IP over `webhook.ip`
  (600/s) gets 200 with nothing processed, and the only non-200 is a 503 while
  another delivery holds a live claim. A sender over `webhook.number` (4/s,
  spent only by new messages) is still persisted, through `processMessage(…, {
  fanOut: false })`, which returns after the persist, unread bump and reopen:
  no flows, journeys, automations, AI, outbound webhooks or TypeSafe watch.
- **Replay is two-phase**: `edge_replay_claim` (60 s lease), then
  `confirmAccepted` (24 h key) only once the events are persisted; a failed
  persist lets the claims lapse. Keys come from the authenticated row, never
  the payload: Whapi's use the config row id, not `phone_number_id`, which
  adoption rewrites. Decisions are positional (statuses, messages, then Meta
  group messages), so `screenEvents` and `applyScreen` change together.
- **Sign-in** posts JSON to `POST /api/auth/login` (any other content type is
  a 400). `admitAdmin` checks the lock (423) and the `admin.ip` / `admin.user`
  limits (429, **fail closed**) before GoTrue; `settleAdmin` then counts the
  failure or clears the pair. The lockout guards this route only.
- **API keys.** `requireApiKey` locks per client IP before the key lookup and
  answers the ordinary 429 `rate_limited`; it fails open, and is off when no
  client IP is known.
- **Client IP.** `clientIp` trusts only the header named by
  `EDGE_CLIENT_IP_HEADER` (`cf-connecting-ip`, `x-real-ip` or
  `x-forwarded-for`; unset means no IP) and, for `x-forwarded-for`,
  `EDGE_TRUSTED_PROXY_HOPS` (default 1); With no IP, webhooks share one
  `unknown` bucket and sign-in keys on `unknown:<email>`.
