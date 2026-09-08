# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev            # Next dev server on :3000
npm run build          # Production build (also typechecks)
npm run typecheck      # tsc --noEmit — fastest correctness pass
npm run lint           # ESLint (eslint-config-next flat config)
npm test               # vitest run (node environment, ~8s, 850+ tests)
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
- **Lint is a gate, and it fails on `main`** (as of 2026-09, commit
  `9ed21ba`): one React Compiler error — `Compilation Skipped: Existing
  memoization could not be preserved` — in
  `src/app/(dashboard)/contacts/page.tsx`, plus ~37 warnings. Verify
  against a clean tree before assuming your change caused a lint error.
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

The MCP server in `mcp-server/` is a separate npm package (`wacrm-mcp`)
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
- Client side: `hooks/use-auth.tsx` (profile/account context),
  `hooks/use-can.ts` and `components/auth/require-role.tsx` for gating.

### WhatsApp connection (two providers, side by side)

An account can connect **both** a Whapi channel and a Meta Cloud API
number (migration 046), and an admin routes each surface to one of them.
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

**`whatsapp_config` is one row per `(account_id, provider)`,** and the
column names mean different things per provider — the biggest source of
confusion in this area (migrations 040 and 046):

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

**Two inbound hubs, one pipeline.** `POST /api/whatsapp/webhook` (Whapi)
and `POST /api/whatsapp/meta/webhook` (Meta) own only authentication and
tenancy; both then hand a resolved channel to `inbound-pipeline.ts`, which
resolves contact + conversation with dedup and fans out: **Flows →
automations → AI auto-reply → outbound webhook delivery**, all inside
`after()`. Both run on the service role (no `auth.uid()` on those paths —
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

Conversations stay **one per contact** across both numbers — 046
deliberately did not split them, because contact dedup, the `flow_runs`
one-active-run index, and the 042/043/044 visibility rules all key on the
contact. `messages.provider` records which number carried each message,
and that is what `resolveReplyChannel` reads.

`encryption.ts` (`ENCRYPTION_KEY`) decrypts both AES-256-GCM (`iv:ct:tag`) and
legacy CBC (`iv:ct`); `isLegacyFormat` is how call sites decide to rewrite a
row in the current format after a successful decrypt.

`docs/whapi.md` and `docs/meta-cloud-api.md` are the operator-facing
contract for all of the above — a behaviour change here ships with a doc
change.

### Flows vs Automations

Two independent engines, deliberately kept apart:

- `lib/flows/*` — stateful, per-contact conversational runs over a node graph
  (`flow_runs`), suspending on customer input. Concurrency is enforced in the DB
  (idempotency on `meta_message_id`, optimistic update on `current_node_key`,
  partial unique index for one active run per contact). Abandoned runs are swept
  by `GET /api/flows/cron`.
- `lib/automations/*` — stateless trigger → steps rules (keyword, tag,
  inbound message, schedule). Scheduled work runs via `GET /api/automations/cron`.

Both cron endpoints authenticate with `AUTOMATION_CRON_SECRET` and must be
pinged externally (Vercel Cron / GitHub Actions / any pinger).

### AI (`lib/ai/*`)

Bring-your-own-key: the account stores an OpenAI or Anthropic key
(encrypted) plus an optional separate embeddings key. `providers/`
holds the two HTTP clients behind one shape; `generate.ts` drafts,
`auto-reply.ts` is the bot (per-conversation reply cap, `handoff.ts`
hands the thread to a human and stamps `ai_handoff_summary`),
`usage.ts` logs token spend.

The knowledge base is hybrid retrieval: `chunk.ts` splits documents,
`embeddings.ts` embeds with OpenAI `text-embedding-3-small` (1536 dims,
matching the `vector(1536)` column in migration 030 — changing the model
means a migration), and `knowledge.ts` retrieves semantically when an
embeddings key exists, topped up with Postgres full-text. With no
embeddings key it degrades to lexical-only rather than failing.

### Outbound webhooks (`lib/webhooks/*`)

Accounts register endpoints that receive CRM events. Three constraints
live here and each has a test file: payloads are signed Stripe-style
(`X-Wacrm-Signature: t=…,v1=…` over `${t}.${rawBody}`, `sign.ts`);
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
slow-moving reference data: tags, members, team rosters, channel
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
- Prettier: single quotes, semicolons, 80 cols, `prettier-plugin-tailwindcss`.
  Most of the tree predates this — format the files you touch, not the repo.
- `NEXT_PUBLIC_*` values are inlined at build time — changing one requires a
  rebuild, not just a restart (see `scripts/sync-tunnel-url.sh`).
- Commit style: `type(scope): imperative summary`; body explains the *why*.
- This is a **template meant to be forked** (see `CONTRIBUTING.md`), so
  user-visible changes belong in `CHANGELOG.md` and self-hosting
  behaviour is documented in `docs/` — `whapi.md`, `docker.md`,
  `public-api.md`, `mcp.md`.
- Comments here carry the history of a bug — when a comment explains why code is
  shaped oddly, treat it as a constraint, not noise.
