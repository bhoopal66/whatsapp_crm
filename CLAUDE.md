# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev            # Next dev server on :3000
npm run build          # Production build (also typechecks)
npm run typecheck      # tsc --noEmit — fastest correctness pass
npm run lint           # ESLint (eslint-config-next flat config)
npm test               # vitest run (node environment, ~8s, 1,200+ tests)
npm run test:watch
```

Single test file / case:

```bash
npx vitest run src/lib/flows/engine.test.ts
npx vitest run src/lib/whatsapp/send-message.test.ts -t 'retries'
```

CI (`.github/workflows/ci.yml`) runs **lint → typecheck → test → build**
on every PR. It does *not* run `format:check`.

- **Don't run `npm run format`.** It is `prettier --write .` and the
  tree has never been fully formatted — a repo-wide run rewrites ~360
  files and buries your diff. Format only what you touched:
  `npx prettier --write <path>`.
- **Lint is a gate, and it fails on `main`** (as of 2026-09-16, commit
  `c888ed7`): `@typescript-eslint/no-explicit-any` errors in
  `src/app/api/whatsapp/meta/webhook/route.ts`, plus ~40 warnings (mostly
  unused `eslint-disable` directives). Verify against a clean tree
  (`git stash` → `npm run lint` → `git stash pop`) before assuming your
  change caused a lint error.
- **The test environment is `node`, with no jsdom.** `*.test.tsx` files
  are included, but they can't mount components: they either render
  server-side (`renderToStaticMarkup`, see
  `components/ui/dropdown-menu-group-label.test.tsx`) or mock the module
  boundary and assert control flow (`components/auth/admin-only-layout.test.tsx`).
  Logic that needs a real DOM belongs in `lib/` behind a pure function.

`ENCRYPTION_KEY` is read at module load by `lib/whatsapp/encryption.ts`;
`vitest.config.ts` injects a dummy one, and CI sets the same value plus
dummy `NEXT_PUBLIC_SUPABASE_*` so `next build` can run without a real
project. Keep those three in sync between `vitest.config.ts` and
`.github/workflows/ci.yml`.

The MCP server in `mcp-server/` is a separate npm package (`taamul-connect-mcp`)
with its own `package.json`/`tsconfig.json` — the root scripts never
build or typecheck it. Use `npm --prefix mcp-server run typecheck`.

## Architecture

Next.js 16 App Router + Supabase (Postgres, Auth, Storage, Realtime, RLS).
Everything is **account-scoped**: a row belongs to an `account_id`, and RLS —
not application code — is the enforcement point.

### Route layout

- `src/app/(auth)` — login / forgot-password. There is **no self-service
  signup**; admins provision logins from Settings → Members. Invitation
  links are redeemed at `src/app/join/[token]`.
- `src/app/(dashboard)` — the authed app (inbox, contacts, pipelines,
  broadcasts, automations, flows, agents, notifications, settings).
  Wrapped by `dashboard-shell.tsx`.
- `src/app/api/*` — internal routes for the dashboard. Error shape
  `{ error: string }`.
- `src/app/api/v1/*` — the versioned **public** API. Different contract:
  `{ data }` / `{ error: { code, message } }` via `lib/api/v1/respond.ts`,
  authenticated by API keys with `<resource>:<action>` scopes
  (`lib/api-keys/scopes.ts`) through `requireApiKey()` in
  `lib/auth/api-context.ts`, rate-limited per key. Don't leak internal
  wording into it. **`mcp-server/` is a thin client of this surface**, so
  a v1 contract change is a two-package change; `docs/public-api.md` is
  the published contract.
- `src/middleware.ts` — session refresh + redirect gating. Note the
  `withRefreshedCookies` wrapper: any response returned *instead of*
  `supabaseResponse` must carry the rotated auth cookies or sessions wedge.

Screens come in personal and team pairs: `/team-inbox` and
`/team-contacts` re-export the same client component as `/inbox` and
`/contacts` with a `teamView` flag — `/inbox` narrows a team leader to
their own threads, the team view shows everything RLS will hand them
(migration 044). Per-module `layout.tsx` files are the server-side role
guard (`AdminOnlyLayout`); the sidebar merely hides links.

### Two Supabase origins (`src/lib/supabase/urls.ts`)

Self-hosted installs reach Supabase by two different routes, so:
`publicSupabaseUrl()` for anything the browser touches, `serverSupabaseUrl()`
(`SUPABASE_INTERNAL_URL`, falling back to the public one) for server code, and
`toPublicSupabaseUrl()` to rewrite server-built storage URLs before they reach
an `<img>`/`<audio>`. The session cookie name is pinned (`AUTH_COOKIE_NAME`)
because supabase-js otherwise derives different keys on each side and every
sign-in bounces back to `/login`.

### Auth and roles

- `lib/auth/roles.ts` — pure role ladder (`owner > admin > team_leader > agent >
  viewer`) mirroring the SQL `is_account_member(account_id, min_role)` CASE
  expression. Capability predicates (`canManageMembers`, `canEditSettings`, …)
  are the single source of truth; never compare role strings inline.
- `lib/auth/account.ts` — **server-only**. API routes call
  `await requireRole('admin')` for a loaded context (`supabase`, `userId`,
  `accountId`, `role`) and `return toErrorResponse(err)` in one catch.
- `lib/auth/conversation-visibility.ts` — client-side mirror of the
  `can_view_conversation` / `can_view_contact` SQL functions (migrations 042 and
  043). It informs UI decisions only; the DB decides. Change one, change both.
- **Deactivation (migration 069)** is `profiles.deactivated_at`, set
  only through `set_member_active` (PATCH `/api/account/members/[id]`
  `{ active }`), which the route pairs with a GoTrue ban. The ban stops
  sign-in and refresh; `is_account_member` / `current_account_id` /
  `current_role_rank` ignoring the profile is what neuters an access
  token issued before it, and the profile guard trigger stops a
  deactivated admin's RPCs. `supabase/ci/verify-member-deactivation.sql`
  asserts this.
- Client side: `hooks/use-auth.tsx` (profile/account context),
  `hooks/use-can.ts` and `components/auth/require-role.tsx` for gating.

### WhatsApp connection (two providers, side by side)

An account can connect Whapi channels (any number of them since
migration 060) and one Meta Cloud API number (migration 046), and an
admin routes each surface to one of them.
They are necessarily different phone numbers: a Whapi channel pairs to a
number that still lives in the WhatsApp app, and registering a number on
the Cloud API removes it from the app. Operator-facing docs are
`docs/whapi.md` and `docs/meta-cloud-api.md`.

Three modules make the rest of the codebase provider-blind. Nothing
outside them should import a gateway client or call `decrypt` on a token:

- **`channels.ts`** answers *which number sends this*. `resolveSendChannel`
  is the single entry point and encodes the one rule worth knowing: the
  human surfaces (`inbox`, `api`) **follow the customer** — replying on
  whichever number they last wrote to, which on Meta is also the only way
  to stay inside the 24-hour window — while the bot surfaces
  (`broadcast`, `automation`, `flow`, `ai_reply`) **obey the admin's
  route**, because routing marketing to Meta has to hold even when the
  trigger arrived on the other number. It returns decrypted credentials.
- **`provider.ts`** is the send layer: one shape over `whapi-api.ts` and
  `meta-api.ts`. Also `getMediaUrl`/`downloadMedia`, and
  `describeSendFailure`, which names failures that are otherwise bare
  numeric codes — above all Meta's closed service window.
- **`inbound-pipeline.ts`** is everything that happens *after* an inbound
  message is authenticated, shared byte-for-byte by both webhook routes.

`ROUTING_SURFACES` mirrors the `whatsapp_routes.surface` CHECK constraint —
change one, change both. A surface with no row inherits the account's
primary channel, so a single-channel install behaves exactly as it did
before 046.

**`whatsapp_config` is one row per connected number** — many Whapi rows,
at most one Meta row (partial unique index, migration 060) — and the
column names mean different things per provider, which is the biggest
source of confusion in this area (migrations 040 and 046):

| column | `provider='whapi'` | `provider='meta'` |
|---|---|---|
| `phone_number_id` | channel id | Meta phone number id |
| `access_token` | channel token | permanent access token |
| `verify_token` | callback URL shared secret | `hub.challenge` token |
| `waba_id` | connected phone number (display) | real WABA id |
| `app_secret` | unused | App Secret for webhook HMAC |

`phone_number_id` stays UNIQUE across both — each inbound route matches on
it. `is_primary` is the account fallback, held to one row by a partial
unique index, so promoting a channel means **demote then promote** or the
constraint trips.

`phone-utils.ts` is Meta-named and still load-bearing: `phoneVariants`
retries a rejected send with a trunk `0` inserted/removed after 1-, 2-, and
3-digit country codes.

Connecting the Whapi channel (`POST /api/whatsapp/config`, admin-only) is one action:
verify the token with `GET /health` → mint a 64-hex secret → `registerWebhook`
→ store both encrypted. `registerWebhook` **merges** into the channel's
existing webhook list so a third party's callback survives, and matches "ours"
by origin **or path** — path matters because a quick Cloudflare tunnel gets a
new hostname on every restart, and origin-only matching leaves dead URLs that
Whapi keeps retrying (`090a2d5`). It also force-enables `auto_download` for
every media kind: without it an inbound attachment is an id whose bytes were
never pulled off the phone. Whapi delivers to HTTPS only, so
`NEXT_PUBLIC_SITE_URL` must be https — and it is inlined at build time.

Connecting the Meta number (`POST /api/whatsapp/config/meta`) is a separate
route rather than one polymorphic endpoint, because almost nothing is
shared: it takes a (phone number id, WABA id, access token) triple,
subscribes the WABA to the app, and cannot write its own callback URL —
Meta's webhook is configured by hand, once per *app*, in the dashboard.
`PUT /api/whatsapp/routes` backs the selector and also moves `is_primary`.

Both error classes carry `status`/`code` and capability getters so callers
branch without knowing the provider. Two are worth memorising:
`WhapiError.isUnknownChannel` — a wrong Whapi token answers **404 "Service
not found"**, not 401, because the token selects the channel — and
`MetaError.isOutsideServiceWindow` (131047/131051), the closed 24-hour
window, which is *the* Meta-specific failure and has no Whapi equivalent.
A Whapi 401/403 is ambiguous (a logged-out phone, a channel starting up,
or a revoked token), so `explainSendFailure` probes `/health` with
`wakeup:false` before wording it; `isChannelLevelFailure` is what stops a
broadcast loop on a number-wide failure.

**Channel health (migration 065).** `whatsapp_config.status` for Whapi
rows is kept current by `channel-health.ts` (`runChannelHealthCheck`,
every ≤5 min from the automation cron and `GET
/api/whatsapp/health/cron`). `nextHealth` flips only on AUTH (connected)
or QR/ERROR/401/403/404/402 (disconnected); LAUNCH/INIT/NOT_INIT,
unknown states, 5xx and timeouts change nothing, so a Whapi blip pages
nobody. A transition notifies owners and admins (`channel_disconnected`
/ `channel_reconnected`), and Compass answers `whapi_not_connected`
while the number is disconnected. The probe must never wake a stopped
channel.

**Two inbound hubs, one pipeline.** `POST /api/whatsapp/webhook` (Whapi)
and `POST /api/whatsapp/meta/webhook` (Meta) own only authentication and
tenancy; both then hand a resolved channel to `inbound-pipeline.ts`, which
resolves contact + conversation with dedup and fans out: **campaign
follow-up flow → Flows → automations → AI auto-reply → outbound webhook
delivery**, all inside `after()`. The first step is migration 054: the
*first* reply to a broadcast with a `follow_up_flow_id` starts that flow
ahead of the keyword / first-inbound entry triggers, seeding the reply
into the run's vars (`campaign_reply`, `campaign_reply_id`) so it can
branch on which template button was tapped. `docs/campaign-journeys.md`
is the operator-facing description of that whole loop. Both run on the service role (no `auth.uid()` on those paths —
hence the `supabaseAdmin()` clients in
`lib/{flows,automations,ai}/admin-client.ts`) with `maxDuration = 60`.
That `after()` is load-bearing: work must be *awaited inside* it, never
detached as a floating promise, or the route returns and the runtime kills
the callback mid-flight (issue #301 — and #409 is the same failure
recurring one level down, in the automation dispatch loop).

The two authenticate in opposite directions, and it is not an
inconsistency:

- **Whapi** — a shared secret in the callback URL resolves the account;
  the payload's `channel_id` is only cross-checked, because the body is
  attacker-controlled and the secret is not. Secrets are stored
  encrypted, so the lookup decrypts every Whapi row and compares in
  constant time.
- **Meta** — the callback URL is per-app and carries nothing
  account-specific, so `metadata.phone_number_id` *selects* the account
  (an indexed single-row lookup) and the `X-Hub-Signature-256` HMAC over
  the **raw body** proves it. Parsing before verifying is deliberate and
  confined to choosing which key to verify with. Verification **fails
  closed**; a body altered after signing is rejected.

Each of these is a fixed bug, not a preference:

- The **secret** resolves the tenant, never the payload's `channel_id` — the
  body is attacker-controlled. Because secrets are stored encrypted, the
  lookup decrypts every row and compares in constant time; if installs ever
  outgrow that, store a SHA-256 in an indexed column.
- `/health` does not expose the channel id, so the save path writes the phone
  number as a placeholder and the first authenticated callback **adopts** the
  real id. Tightening the channel-mismatch guard without keeping adoption
  drops every inbound message while outbound still looks perfectly healthy.
- The idempotency boundary is the `messages` upsert on
  `(conversation_id, message_id)` with `ignoreDuplicates`; an empty `.select()`
  means replay, and the function returns **before** the unread bump and the
  whole fan-out (issue #367). Nothing side-effecting may move above it.
- Unread is bumped by the `bump_conversation_on_inbound` RPC, not a
  read-modify-write — two concurrent inbounds otherwise lose an increment
  (issue #369).
- `fromMe` and group chats are dropped in the Whapi normalizer, not in the
  route. The Meta normalizer needs neither filter: the Cloud API never
  echoes our own sends back as inbound and has no group messaging.
- Meta has **two** button-reply envelopes — `interactive.button_reply` for
  interactive messages and a separate `button` object (`payload`/`text`)
  for a *template's* quick-reply buttons. Handling only the first is issue
  #478, and it is invisible until someone taps a template button.
- Recipient status is a forward-only ladder (`pending → sent → delivered →
  read → replied`); `failed` is a side branch accepted only from `pending`/
  `sent`.
- A Flow that consumes the message suppresses the content-level automation
  triggers (`new_message_received`, `keyword_match`, `interactive_reply`) and
  AI auto-reply; relationship triggers (`new_contact_created`,
  `first_inbound_message`) still fire.

Gateway-hosted media links expire in ~30 days, so `mirror-inbound-media.ts`
copies the bytes into the `chat-media` bucket (`inbound/` beneath
`account-<id>` — migration 023's RLS only matches the first segment) and
persists that URL instead. It is best-effort **by contract**: it returns
`null` and never throws, because a webhook that throws makes Whapi redeliver
and re-run the entire fan-out. Per-account opt-out: `mirror_inbound_media`
(migration 039).

One `message_templates` row drives both providers, differently: Whapi has
no template registry, so the row is rendered locally (`template-body.ts`)
and sent as an ordinary message — always works. Meta addresses an
already-**approved** template in the WABA registry by (name, language), so
the same row is a hard rejection until it is submitted and approved. The
review lifecycle (`template-webhook.ts`, `template-send-builder.ts`,
`template-components.ts`) is live only for Meta sends; `status` is
advisory on Whapi.

**Message costs (migration 051)** are Meta-only: every raw `statuses[]`
object the Meta webhook receives is handed, after the pipeline and
fail-open, to the `record_whatsapp_message_cost` Postgres function via
`lib/whatsapp/message-costs.ts`. The costing rules (date-aware rate
card, longest-prefix market map, the 2026-10-01 free tier of 1,000
service messages per number per month, Meta's `pricing.billable`
override) live in SQL, next to the ledger they count over. Unknown
rates are `NULL`, never 0 — the settings panel surfaces them as *no
rate on file*. The reporting views are `security_invoker`, so the
ledger's admin-only RLS applies through them. `pricing` is deliberately
not lifted into `NormalizedStatus` (`collectMetaStatuses` is the
separate raw extraction) because the neutral shape is provider-blind.
Meta's failure reason is (`NormalizedStatus.error`), and
`describeMetaFailure` stores it on failed broadcast recipients.
Migration 066's `reconcile_broadcast_recipient_statuses` replays the
ledger onto recipients a receipt missed (a receipt that beat the wamid
stamp); `describe_meta_failure` (SQL) mirrors
`lib/whatsapp/meta-failure.ts` and `meta-failure.test.ts` compares them —
change one, change both. Status writes are forward-only in SQL
(`handleStatusUpdate`), and an AI reply that comes back `failed` hands
the thread to a person (reason `error`).

On the Meta webhook, an unknown `phone_number_id` is answered 200 and
tallied (`meta-drop-tally.ts`, one line per id per hour); a template
callback for a WABA with no row is answered 200 *before* any signature
check (nothing is touched, and a 401 there could get the app-wide
subscription disabled). `config/meta` POST refuses a different
number while one is connected (409) and checks `/{waba}/phone_numbers`
before subscribing a WABA. The route checks the parsed body's shape
(`isMetaWebhookShape`) before anything reads it, verifies a mixed
template-plus-messages POST per half against the same raw body and
processes both, and answers 503 (never 200) when a WABA or phone-number
lookup fails, so Meta redelivers.

Conversations stay **one per contact** across all numbers — 046
deliberately did not split them, because contact dedup, the `flow_runs`
one-active-run index, and the 042/043/044 visibility rules all key on the
contact. Since two rows can share a provider, `provider` no longer names
a number. `messages.channel_id` records the exact row that carried each
message, and `resolveReplyChannel` reads it, falling back to `provider`
for older rows. `conversations.channel_id` is the number a thread is on.
Inbound moves it to the number the customer last wrote to. Anyone else
may only fill it in when it is NULL; moving a thread is admin-only
(`conversations_channel_guard`).

**Number allocation (migration 060).** `whatsapp_channel_members` lists
who works each number. With no rows the number is shared, which is the
pre-060 behaviour. With rows, those members may send from it and
their new chats start from it (`pickChannelForUser`, `can_use_channel`).
Allocation grants **no visibility** (migration 072 removed the 060 grant
that showed allocated members every chat on the number): admins and
owners see everything, others their own and assigned chats, leaders
their team's, whatever numbers they are on. `conversation-visibility.ts`
mirrors that and has no allocation flag. Bot sends use `resolveBotChannel`: the admin's route
picks the provider, and within that provider the bot stays on the
thread's own number, so a Support customer never hears from Sales.
Since 071 a number can also be allocated to a team
(`whatsapp_channel_teams`). Triggers derive the team's members and leader
into `whatsapp_channel_members` with `via_team`, and hand-ticked rows are
`direct`. So every predicate still reads that one table. Write only through the
RPCs: the routes use `set_channel_access` (a number's people and teams) and
`update_team` (a team's name, leader, members and numbers), each one
transaction, over `set_channel_members` / `set_channel_teams` /
`set_team_channels` / `set_team_members`. A raw DELETE drops team-derived
access until the next sync. Leaving an account drops the person's teams
and allocations there (a `profiles` trigger).
Admin UI: Settings → Numbers & access (`/api/whatsapp/channels`), and
`/api/whatsapp/config` takes a `config_id`, plus `create: true` to add a
number.

**Per-chat sending number (migration 061).**
`conversations.send_channel_id` is a person's manual pin, and NULL
means automatic. It sits above every rule in `resolveSendChannel` and
`resolveBotChannel`, except a `preferredProvider` of the other kind
(Contact screen free-form, Compass). It is only changed through
`set_conversation_send_channel()` (`PUT
/api/whatsapp/conversations/[id]/channel`). That function is SECURITY
DEFINER with explicit checks. Running as the caller would let RLS
reject an agent's own switch away from the number that made the chat
visible to them. Since 062 the guard trigger refuses any other writer
of a pin. The function raises the transaction-local
`app.send_channel_switch` flag for its own UPDATE, and clients cannot
set it. `can_use_channel` means: an admin, the number is shared
(no allocation), or the caller is allocated to it.
`usableNumbers` is its TS mirror. A pin grants no visibility either
(072; the channel arguments of `can_view_conversation/5` are unused),
and inbound does not move `channel_id` while pinned. Switch notes live in `conversation_events`,
not `messages`, so they stay out of AI context, unread counts,
aggregates, webhooks and the public API.

**Migration 062 invariants.**
- *Same account:* `whatsapp_channel_members` and
  `conversations.channel_id` / `send_channel_id` have composite FKs to
  `whatsapp_config(id, account_id)`. A reference to another account's
  number is impossible, not merely filtered.
- *Stamping a number:* the channel and pin guards run on INSERT too. A
  non-admin may only stamp an empty `channel_id` with a number
  `can_use_channel` allows. That is why `startFor` in `channels.ts`
  starts an unallocated agent's new chat from a shared number.
- *Customer messages:* only the service role may write
  `sender_type='customer'`, because
  "follow the customer" trusts them.
- *Atomic RPCs:* access lists and the default number change only
  through `set_channel_members` / `set_primary_channel`.
- *Helpers:* `loadChannels` skips an undecryptable row, and throws only
  when every row is unreadable. `resolveSendChannel` takes the
  conversation's numbers preloaded. The AI gate uses
  `resolveAiReplyChannel`, which takes an explicit `ai_reply` route
  literally, and compares exact channel ids.
- *Status callbacks:* `handleStatusUpdate(status, accountId)` confines
  every write to the authenticated account. The Meta route splits a
  batched callback per `phone_number_id`.

`encryption.ts` (`ENCRYPTION_KEY`) decrypts both AES-256-GCM (`iv:ct:tag`) and
legacy CBC (`iv:ct`); `isLegacyFormat` is how call sites decide to rewrite a
row in the current format after a successful decrypt.

`docs/whapi.md` and `docs/meta-cloud-api.md` are the operator-facing
contract for all of the above — a behaviour change here ships with a doc
change.

### Taamul Compass (`lib/compass/*`, migration 056)

The ERP integration, on the v1 API. Customers sync into
`compass_contacts` — deliberately **not** `contacts`, so agents' scoped
contact lists aren't flooded — and link to a CRM contact on first
message. `notify.ts` sends status notifications with three hard rules:
Whapi only (`provider: 'whapi'` + `requireProvider`, never the Meta
fallback), the existing conversation with ownership untouched (no
`sender_id`, `renameExisting: false`, `pauseActiveFlows: false`), and at
most once per `idempotency_key` (claimed as `sending` before the
gateway call; a `db_error` after the gateway accepted keeps the key
spent). `docs/compass.md` is the contract handed to the Compass team.

### Team activity (`lib/team-activity/*`, migrations 068, 073, 074)

The admin monitor for Whapi restriction risk: per person and per number,
chats started, replies, unanswered runs, bursts, night starts, links and
identical openers in first messages, failures, response times.

- **The definitions live in SQL.** `team_activity_starts()` defines a
  start: a non-customer message with no message in the conversation for
  24 hours, unless the customer wrote last (that is a late reply). Sends
  WhatsApp refused are ignored. A start is *replied* if the customer
  writes before the next start; younger than 24 h and unanswered it is
  *pending*, out of reply rates on both sides. Per-person limits count
  Whapi-number starts only, and `thread-guard.ts` mirrors the same
  rule. Pass `p_to = 'infinity'` unless the range really ends in the
  past, or the next start is outside the scan and the reply window never
  closes. `docs/team-activity.md` restates these definitions; change
  both together.
- **A message's own number (073).** Attribution is
  `messages.channel_id`, its kind from that row, else
  `messages.provider` — never the conversation's number or "the only
  number of that provider". 073 backfilled NULLs once
  (`team_activity_backfill_channels()`, owner-only, fills only where one
  number of the provider existed then); the rest is
  `unattributed_starts`, outside per-number rows.
- **073 counting rules.** Runs count from the customer's last message or
  the conversation's start, not from the scan; follow-ups within 10
  minutes are one chase step (`chase_new` / `chase_existing`). Limits
  are `>=` everywhere; number limits are Whapi-only, and
  `team_activity_number_limit()` gives a number younger than 14 days
  `min(10, limit)`. API/bot rows get NULL replies and response times.
  Waiting is <24 h (headline) vs 24 h–7 days; older is ignored.
  `team_activity_opener_key()` normalises first messages for
  `similar_openers`; failures split `failed_phone` / `failed_official`.
- **One round trip.** `team_activity_report()` returns the whole page as
  one jsonb (the page sits behind a tunnel). `report.ts` parses it
  defensively, and `risk.ts` turns figures into findings. Findings are
  pure and tested; their wording is in `TeamActivity.findings`.
- **Defaults in three places.** The column defaults,
  `team_activity_limits()` and `TEAM_ACTIVITY_DEFAULTS` must agree;
  `limits.test.ts` reads the migration to check this.
- **Days are in the account's time zone.** "Today" uses the saved time
  zone (else the viewer's). `range.ts` computes the boundaries; the API
  route computes the range rather than the browser.
- **Employee side.** `team_activity_my_day()` (SECURITY DEFINER, caller's
  own counts only) feeds `thread-guard.ts`, which warns above the
  composer on Whapi numbers.
- **The optional block.** `team_activity_start_check()` runs in
  `send-message.ts` before the gateway, for human Whapi sends only. It
  **fails open**: any error lets the message through. Replies, owners and
  admins always pass.
- **Bell alerts.** `team_activity_alert_sweep()` (service role, at most
  every 5 minutes from the automation cron) dedups through
  `team_activity_alerts`. It skips any account whose limits were never
  saved.
- **Safety Meter.** Whapi's 1-3 rating comes from
  `whapi.getRiskOfBlocking` via `provider.getNumberSafetyRating`. The
  response echoes the channel token, so only the parsed figures leave the
  server.
- **Team leaders (074).** A leader's report and drill-down are scoped
  to the teams they lead plus themselves (`scope: 'team'`, people only;
  `number_today_started` is the one whole-number figure).
  `team_activity_alerts.recipient_id` (nil uuid = account-level) dedups
  each leader's copy of an alert. Owner/admin output is 073's.
  Since 074 `team_activity_report` and `team_activity_chats` are
  SECURITY DEFINER. Under invoker rights a leader's RLS ran
  `can_view_conversation()` per message row, which took over 300 s.
  Every read is filtered by `current_account_id()`. A leader's visible
  conversations are computed once (`v_convs`, the policy's own
  predicate), with the team filters on top. A new read in these functions
  needs both filters.
- **Tests.** The SQL behaviour is asserted in
  `supabase/ci/verify-team-activity.sql`.

### Chat tags (`lib/chat-tags/*`, migrations 075–076)

Admin-defined, colour-coded tags that replaced the chat header's
Open/Pending/Closed control and the list's status filters.
`conversations.status` stays: automations close chats, inbound
reopens them, the public API filters on it. A chat carries at most
one main tag (`conversations.chat_tag_id`) and one sub-tag of it
(`chat_sub_tag_id`, e.g. which bank under "Interested");
`chat_tags.sub_tag_title` captions it ("Bank: ADCB").

They are the only tag system. The older contact tags (`tags` /
`contact_tags`, many per contact) were retired from every screen and
feature; the tables are still in the schema, unused, until a cleanup
migration drops them. Their jobs moved here: broadcast audiences
(`chat_tags` / `excludeChatTagIds` in `audience_filter`), the
automation trigger `chat_tag_set`, step `set_chat_tag` and condition
`chat_tag_presence`, the flow `set_tag` node (it now sets chat tags)
and condition subject `chat_tag`, the Contacts screens' column and
filter, and the public API (conversations carry `chat_tag` /
`chat_sub_tag`; contacts keep a deprecated, always-empty `tags`).

- **Opt-out is a column, not a tag (076).** `contacts.opted_out_at` is
  set by the AI bot and the TypeSafe watch (`markOptedOut`). Every
  broadcast leaves those customers out — when the wizard plans
  (`resolveAudience` → `finalAudience`), when the API plans
  (`createBroadcast`), and again at send time (`planBroadcastResume`
  marks a recipient who opted out since as failed). The inbox contact
  panel and the Contacts screens show an "Opted out" badge. Only the
  service role (the bot, the watch) or an admin of the contact's
  account may set or clear the stamp (`contacts_opt_out_guard`, on
  INSERT too); `verify-contact-opt-out.sql` asserts it.
- **A tag change is a server write.** The header saves through
  `PUT /api/conversations/[id]/chat-tags` (the caller's RLS client via
  `writeConversationChatTags`), which dispatches `chat_tag_set` in
  `after()` only when something changed (`dispatchChatTagSet`). The
  automation step and the flow node write through the same helper; a
  chain of tag-triggered tag writes stops at depth 3
  (`vars._chat_tag_chain_depth`). `chatTagTriggerMatches` fires on
  arrival at the configured tag, never on a re-save.
- **Writes are compare-and-set.** `writeConversationChatTags` updates
  only if both columns still hold what it read, re-reading once on a
  lost race; a writer that finds the chat already where it was going
  reports no change, so two racing writers dispatch `chat_tag_set`
  once. A write that leaves `chat_sub_tag_id` out keeps the chat's
  sub-tag while the main tag is unchanged (`resolveChatTagsWrite`);
  `null` clears it. The builders' "Keep current sub-tag" saves the key
  absent.

- **The pairing lives in SQL.** `conversations_chat_tag_guard` refuses
  a sub-tag as a main tag or a sub-tag of another main tag, and clears
  the sub-tag when only the main tag changes. `chat_tags_guard` keeps
  nesting one level deep and `parent_id` immutable. Every reference is
  a composite FK on `(id, account_id)` with `ON DELETE SET NULL (col)`
  — the column list keeps `account_id`. `verify-chat-tags.sql` asserts
  all of it.
- **Who.** Members read tags, admins write them (Settings → Chat
  tags). Tagging a chat is a plain conversations UPDATE under the
  existing policy, so agents and up on chats they can see; viewers
  never.
- **Client.** `useChatTags()` caches the list per account, and
  `reload()` refreshes every mounted consumer (header, list, Settings).
  The list filter is pushed server-side through `chatTagFilterOrGroup`
  (UUID-guarded) and re-applied client-side. A save that lands after
  the agent opened another chat must not patch it:
  `patchIfSameConversation` checks inside the state updater.

### Flows vs Automations

Two independent engines, deliberately kept apart:

- `lib/flows/*` — stateful, per-contact conversational runs over a node graph
  (`flow_runs`), suspending on customer input. Concurrency is enforced in the DB
  (idempotency on `meta_message_id`, optimistic update on `current_node_key`,
  partial unique index for one active run per contact). Abandoned runs are swept
  by `GET /api/flows/cron`.
- `lib/automations/*` — stateless trigger → steps rules (keyword, chat
  tag, inbound message, schedule). Scheduled work runs via `GET /api/automations/cron`.

A flow's `fallback_policy.on_unknown_reply` (JSONB, resolved in
`lib/flows/fallback.ts`) decides what an off-script reply does: reprompt,
hand off, end, ignore — or `ai`, which answers with the AI agent while
the run stays on its node.

**Four cron endpoints**, all authenticated by `AUTOMATION_CRON_SECRET` in
an `x-cron-secret` header, none of which the app pings itself (Vercel
Cron / GitHub Actions / any pinger):

- `GET /api/automations/cron` — scheduled automation steps.
- `GET /api/flows/cron` — sweeps abandoned runs.
- `GET /api/whatsapp/broadcast/cron` (migration 053) — delivers
  scheduled broadcasts. It is deliberately the *resume* machinery from
  migration 038 (`broadcast-resume.ts` → `broadcast-core.ts`), not a
  third fan-out: claim the delivery lock, plan from the frozen
  `broadcast_recipients`, deliver in `after()`. Quiet hours
  (`lib/broadcasts/quiet-hours.ts`, jsonb `{start, end, tz}`) defer a due
  campaign to the end of its window. The tick only selects `scheduled`,
  so a large campaign left `sending` is finished by the detail page's
  Resume, not by the next tick. Every tick also runs migration 066's
  recipient reconcile.
- `GET /api/whatsapp/health/cron` (migration 065) — the channel health
  sweep. The automation cron also runs it, throttled to once per 5
  minutes per process, so an install that pings only that one is
  covered.

### AI (`lib/ai/*`)

Bring-your-own-key: the account stores an OpenAI or Anthropic key
(encrypted) plus an optional separate embeddings key. `providers/`
holds the two HTTP clients behind one shape; `generate.ts` drafts,
`auto-reply.ts` is the bot (per-conversation reply cap, `handoff.ts`
hands the thread to a human and stamps `ai_handoff_summary`),
`usage.ts` logs token spend.

**Deterministic gates run before any token is spent** (migration 052,
`escalation.ts`): an escalation-keyword match on the latest customer
message (Unicode word boundaries, trailing `*` for prefix match), a
`retrieval_min_score` cosine floor the best knowledge chunk must clear
(only meaningful with an embeddings key), and `strict_grounding`, which
makes the knowledge base the model's *only* source. A gate hand-off
sends `handoff_message` to the customer and stamps
`conversations.ai_handoff_reason` (`keyword` / `no_knowledge` / `model`
/ `error` / `cap`) — the reply cap hands off rather than going silent
(054). Every gate is off by default.

The knowledge base is hybrid retrieval: `chunk.ts` splits documents,
`embeddings.ts` embeds with OpenAI `text-embedding-3-small` (1536 dims,
matching the `vector(1536)` column in migration 030 — changing the model
means a migration), and `knowledge.ts` retrieves semantically when an
embeddings key exists, topped up with Postgres full-text. With no
embeddings key it degrades to lexical-only rather than failing.

### TypeSafe decision layer (`lib/typesafe/*`, migrations 063–064)

Module 013: TypeSafe (Jev) judgments around the auto-reply bot, hooked
from `auto-reply.ts` through `lib/ai/typesafe-gates.ts` — triage before
the model (may hand off with reason `triage`, or force strict
grounding), a passage filter between retrieval and gate 2, and a
guardrail between the model and the send (reason `guardrail`). The host
rule is absolute: **a decision with `act: false` changes nothing**.

Control is per account (migration 064, `ts_account_settings`, Settings →
AI safety checks, `/api/typesafe/{settings,activity}`): on/off, monitor
or live, which checks, English only or all languages. The server keeps
only the secrets (`TYPESAFE_API_KEY`, `TS_LOG_HASH_KEY`) plus optional
overrides that no account can undo (`TS_ENABLED_<CHECK>=false`,
`TS_SHADOW=true`, the `TS_ACCOUNT_IDS` allowlist). `checkState()` in
`config.ts` combines the two; `SwitchesStore` caches an account's row
for 30 s, and the settings PUT writes the saved row into it (`set`,
generation-checked so an older in-flight read cannot win). No row means
off, so an account that never opened the panel is never sent to
TypeSafe. A read error with nothing read before is `unknown`: off,
except that the guardrail holds (`guardrailWhenSwitchesUnknown`). The
PUT is version-checked (`expectedUpdatedAt`, else 409) and needs
`confirmLive` to start acting. A store
without `accountSwitches` (tests, the eval harness) is "unmanaged":
on and live, so the install configuration alone decides.

`act` needs the check on, live, the language not held back, TypeSafe
answering with the pinned model, and no shadow-flagged custom policy.
Live runs on the built-in thresholds unless a custom policy was approved
by a *second* admin for the pinned model and question set; an invalid
or mismatched one falls back to the built-ins with an alert. Three
exceptions, all guardrail and all fail-safe: degraded mode acts on the
fail mode plus the code checks rather than send unscreened; in a
held-back *reply* language the code checks act and a model flag holds
for review (the bot answers in the customer's language, so log-only
would be a customer-controlled switch); and with an invalid config an
account whose guardrail is on and live still holds its drafts
(`guardrailWhenConfigInvalid`, which reads the settings row). The
customer's own text is never a figure source. Monitor-mode checks run
off the reply path through `TsRef.defer` and are awaited in the
dispatcher's `finally`.

`lib/ai/typesafe-watch.ts` is the opt-out watch: the last step of the
inbound pipeline triages any text the bot's own triage did not judge
(found by the keyed message hash) and, in live, only marks the contact
opted out (`contacts.opted_out_at`) —
it never hands off or replies, because a person or a flow owns those
threads. No database id goes into TypeSafe state (a UUID trips the
last-line PII guard); ids stay local and ordinals are sent. Threshold
bounds live twice — `THRESHOLD_BOUNDS` in `policy.ts` and
`ts_threshold_bounds` in SQL — and `policy.test.ts` keeps them equal.
Changing question wording means a new `QS_VERSION`. The DB side is
asserted by `supabase/ci/verify-typesafe.sql` (one statement — the
pinned CLI rejects more), not vitest. `docs/typesafe.md` is the
operator contract.

### Outbound webhooks (`lib/webhooks/*`)

Accounts register endpoints that receive CRM events. Three constraints
live here and each has a test file: payloads are signed Stripe-style
(`X-Taamul-Signature: t=…,v1=…` over `${t}.${rawBody}`, `sign.ts`);
target URLs pass an SSRF guard (`ssrf.ts` — resolves the host and
rejects loopback/private/link-local, paired with `redirect: 'manual'`
at the call site); delivery is at-most-once, best-effort, never throws,
and auto-disables an endpoint after `MAX_CONSECUTIVE_FAILURES`
(`deliver.ts`). Semantics are published in `docs/public-api.md` — keep
the two in step.

### Realtime, presence, and the latency budget

`hooks/use-realtime.ts` subscribes to `postgres_changes` on
`messages`/`conversations`; RLS is replayed per subscriber, so a
subscription can't leak rows a query wouldn't. Callbacks are held in
refs so a parent re-render doesn't tear down the channel.

Presence (`lib/presence.ts`, migration 024) stores only what an active
client reports (`online`/`away`); **offline is derived from heartbeat
staleness**, never written — a closed tab can't be trusted to write.

Latency shapes several decisions that look like premature optimisation
but aren't: on a tunnelled self-host the same query is ~20ms from the
origin and ~700ms through Cloudflare. Hence `experimental.staleTimes` in
`next.config.ts` (caching the *shell* of dynamic routes — safe because
dashboard screens are client components that fetch their own data on
mount) and `lib/client-cache.ts` (`cachedQuery`, a TTL cache for
slow-moving reference data: chat tags, members, team rosters, channel
status). Conversations, messages, and contacts must stay uncached, and
cache keys must name the *question* including any user/team parameter,
or two users on one device read each other's data.

### `next.config.ts` is a constraint file

Every block there is a fix for a specific production failure, documented
in place. In practice: the CSP is `Content-Security-Policy-Report-Only`
and any new external origin (script, image, `connect-src`) has to be
added there before it will work once enforcement is flipped on;
`output: "standalone"` is what the Dockerfile runs; `allowedDevOrigins`
is why HMR survives an ngrok/Cloudflare tunnel; the `Cache-Control`
rules exist because a CDN once served year-old HTML pointing at deleted
chunk hashes.

### Database migrations

`supabase/migrations/NNN_*.sql`, applied by hand against the Supabase project —
nothing in the app runs them. Every statement is guarded (`IF NOT EXISTS`,
`ON CONFLICT`) so files stay re-runnable, which also means a typo'd object name
is a silent no-op; `.github/workflows/migrations.yml` replays the whole stack
against a clean Postgres and asserts `supabase/ci/verify-schema.sql` (it only
fires on `supabase/**` changes). A schema change ships as: new numbered
migration + a **Migration required** note in `CHANGELOG.md` + updated TS
mirrors of any SQL predicate.

### i18n

`next-intl` with a **build-time** locale (`NEXT_PUBLIC_APP_LOCALE`), configured
in `src/i18n/request.ts`; catalogues in `messages/*.json` (`en`, `ko`). Fallback
is whole-file, not per-key, so `messages.test.ts` enforces key parity with
`en.json`. Strings containing literal `{{1}}` placeholders or raw HTML are not
valid ICU — read them with `t.raw()` / `t.rich()`, and `icu-safety.test.ts`
fails if one is wired to plain `t()`.

## Conventions

- Path alias `@/*` → `src/*`. Tests are colocated as `*.test.ts(x)`; pure logic
  lives in `lib/` precisely so it can be unit-tested without I/O.
- UI is shadcn (`style: base-nova`, neutral, lucide icons, base-ui
  primitives) in `src/components/ui` — regenerate via the shadcn CLI
  rather than hand-editing. Charts use `src/components/tremor` + recharts.
- Dark mode is `html[data-mode='dark']`, never a `.dark` class, so Tailwind's
  `dark:` variant matches nothing here. Use semantic tokens (`bg-card`,
  `text-muted-foreground`, `bg-wa-*`), or `[[data-mode=dark]_&]:` for a
  one-off colour.
- Prettier: single quotes, semicolons, 80 cols, `prettier-plugin-tailwindcss`.
  Most of the tree predates this — format the files you touch, not the repo.
- `NEXT_PUBLIC_*` values are inlined at build time — changing one requires a
  rebuild, not just a restart (see `scripts/sync-tunnel-url.sh`).
- Commit style: `type(scope): imperative summary`; body explains the *why*.
- This is a **template meant to be forked** (see `CONTRIBUTING.md`), so
  user-visible changes belong in `CHANGELOG.md` and self-hosting
  behaviour is documented in `docs/` — `whapi.md`, `meta-cloud-api.md`,
  `docker.md`, `public-api.md`, `mcp.md`, `campaign-journeys.md`,
  `compass.md`, `typesafe.md`, `team-activity.md`.
- Comments here carry the history of a bug — when a comment explains why code is
  shaped oddly, treat it as a constraint, not noise.
