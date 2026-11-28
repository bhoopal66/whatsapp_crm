# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev            # Next dev server on :3000
npm run build          # Production build (also typechecks)
npm run typecheck      # tsc --noEmit — fastest correctness pass
npm run lint           # ESLint (eslint-config-next flat config)
npm test               # vitest run (node env, ~2 min, ~5,000 tests, ~350 files)
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
- **Lint is a gate.** As of 2026-10-12 (`9c029cd`) the tree lints with
  0 errors and ~32 pre-existing warnings (mostly unused vars and unused
  `eslint-disable` directives), so any *error* is yours. Don't use
  `git stash` to compare against a clean tree — worktrees share one stash
  stack; set your change aside as a patch file instead.
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
  broadcasts, automations, flows, agents, notifications, settings), plus
  team chat at `/chat` (deal rooms at `/chat/rooms/[roomId]`),
  `/journeys`, `/calls`, `/worklist` (My worklist, see HR workflows) and
  the customer page `/contacts/[id]`. Tasks have
  no screen of their own (`/tasks` is only reserved in `middleware.ts`):
  they show on the customer page, the calls view and chat cards. Wrapped
  by `dashboard-shell.tsx`, which mounts the call layer and keeps a bank
  guest on `/chat` (`guestRedirectPath`) — UX only, since RLS gives a
  guest nothing else.
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
  viewer > bank_guest`) mirroring the SQL `is_account_member(account_id, min_role)` CASE
  expression. Capability predicates (`canManageMembers`, `canEditSettings`, …)
  are the single source of truth; never compare role strings inline.
- `bank_guest` (rank 0, migrations 082–083) is a partner bank's login.
  `current_account_id()` is NULL for a guest, so every account-wide
  policy denies them; access is opt-in per table (team chat, deal rooms).
  `ASSIGNABLE_ROLES` and `STAFF_ROLES` leave it out.
- One login can hold a profile in several workspaces, the active one
  marked `is_active`; see **Workspaces** below.
- `lib/auth/account.ts` — **server-only**. API routes call
  `await requireRole('admin')` for a loaded context (`supabase`, `userId`,
  `accountId`, `role`) and `return toErrorResponse(err)` in one catch.
- `lib/auth/conversation-visibility.ts` — client-side mirror of the
  `can_view_conversation` / `can_view_contact` SQL functions (migrations 042 and
  043). It informs UI decisions only; the DB decides. Change one, change both.
  Since 217, `conversations_select`, `messages_select` and `messages_insert`
  restate `can_view_conversation` / `can_view_personal_chat` as set
  membership over `contact_visibility_people()` and
  `personal_number_visible_ids()`, because the per-row calls timed out for
  leaders and agents. A change to either function changes those three
  policies too; `verify-conversations-select-set-based.sql` compares them.
- Client side: `hooks/use-auth.tsx` (profile/account context),
  `hooks/use-can.ts` and `components/auth/require-role.tsx` for gating.
- Workspaces: every policy means the caller's **active** account
  (`is_account_member`, `current_account_id`); see the Workspaces entry
  in the module index.
- The rest of the auth rules (contact owner follows its chat 169,
  deactivation 069/199, member password 140, member details 167):
  `docs/agents/auth-roles.md`.

### Module index

Each module's full rules live in `docs/agents/<slug>.md`, moved there
verbatim from this file. **Read the module's file before changing that
area**; the line here is only the invariant that most often bites. A new
module gets its own file and one line here; don't grow this file.

- **WhatsApp connection** (`lib/whatsapp/*`, 040, 046, 060–062, 144, 190–191) → `whatsapp-connection.md`. Only `channels.ts`/`provider.ts`/`inbound-pipeline.ts` touch gateways or `decrypt`; inbound: nothing side-effecting above the `messages` idempotency boundary, work awaited inside `after()`; provider switches exhaustive with a `never` default.
- **Taamul Compass** (`lib/compass/*`, 056) → `compass.md`. Notify is Meta only, existing conversation untouched, once per `idempotency_key`.
- **Team activity** (`lib/team-activity/*`, 068, 073, 074, 204–206) → `team-activity.md`. Definitions live in SQL; defaults in three places agree; hard restrictions fail open.
- **Chat tags** (`lib/chat-tags/*`, 075–076) → `chat-tags.md`. Writes go through `writeConversationChatTags` (compare-and-set); opt-out is `contacts.opted_out_at`, not a tag.
- **Pipelines** (`lib/pipelines/*`, 080, 138) → `pipelines.md`. Visibility follows the deal's owner; `assigned_to` is a profile id, `user_id` an auth id.
- **Workspaces** (`lib/auth/my-workspaces.ts`, 082–083, 105) → `workspaces.md`. A read by `user_id` alone is multi-row: scope it or use `pickActiveProfile`.
- **Edge security** (`lib/edge/*`, 084) → `edge-security.md`. Webhooks never answer 429; replay is claim then confirm; keys from the authenticated row.
- **Tasks** (`lib/tasks/*`, 085) → `tasks.md`. System writers use only `createSystemTask` / `closeSystemTasks`; holder-role lists change together.
- **Journey bot** (`lib/journeys/*`, 086) → `journey-bot.md`. `journey_commit` is the only writer; only SEND is at-most-once.
- **Team chat** (`lib/chat/*`, 087, 143, 156–160, 172) → `team-chat.md`. Writes are `chat_*` RPCs with their own GRANT; apply 156–160 in order, once.
- **Deal rooms** (`lib/deal-rooms/*`, 088) → `deal-rooms.md`. Guests never read `deal_rooms`; `deal_room_admit_block` is the one admit rule.
- **Phone system** (`lib/pbx/*`, 089, 103–104, 113, 119) → `pbx.md`. Never log or store recording/socket URLs; `pbx_can_view_call` decides who sees a call.
- **WhatsApp groups** (`lib/groups/*`, 114, 173, 208, 219) → `whatsapp-groups.md`. Group traffic never enters `messages`; access lives in SQL and `access.ts`.
- **Submission groups** (`lib/submission-groups/*`, 115, 136, 141, 173–174) → `submission-groups.md`. Writes are `sg_*` RPCs only; `sg_rule_can_read` ↔ `rules.ts`.
- **Customer documents** (`lib/customer-docs/*`, 178) → `customer-documents.md`. Recording never throws; the NAS copier never runs in the app.
- **Departments** (`lib/auth/departments.ts`, 192) → `departments.md`. Defaults in SQL and `DEPARTMENT_DEFAULTS`; restriction is layout/API, not RLS.
- **HR workflows** (`lib/hr/*`, 200–203, 212–213, 215, 226) → `hr-workflows.md`. No new visibility (`hr_can_see`); AI drafts never send; restating migrations: apply in order, once.
- **Contact search** (`lib/contacts/fuzzy-search.ts`, 193) → `contact-search.md`. `search_contact_candidates` repeats the contacts SELECT policies: change both.
- **Second brain** (`lib/brain/*`, 194–196) → `second-brain.md`. Off by default; TS redaction must cover what the SQL guard refuses.
- **Cases** (`lib/cases/*`, 122–130, 134, 179–187, 214, 225) → `cases.md`. Check the case's account against the ACTIVE account before any service-role call.
- **Case desk** (`lib/desk/*`, 220, 229–235, 248) → `case-desk.md`. Check character lives in SQL and TS; `DESK_REFUSALS` read from the migration.
- **Health and metrics** (`lib/metrics/*`, 228) → `health-metrics.md`. `/api/healthz` never touches the database; edge-refusal counting never changes the answer.
- **Privacy, PDPL** (`lib/privacy/*`, 221–224, 229) → `privacy.md`. Every table is in `data-map.ts`; a new AI call path calls `assertAiTransfer`.
- **OpenDesk / Taamul sales** (`lib/taamul-sales/*`, 139) → `opendesk.md`. HMAC before parsing; synchronous on purpose; never log a payload.
- **Coordinators** (`lib/coordinators/*`, 133) → `coordinators.md`. Not a role; `can_view_conversation`/`can_view_contact` deliberately unchanged.
- **CRM memory and vault** (`lib/memory/*`, `lib/vault/*`, 121, 129) → `memory-vault.md`. Redact (and tokenise) before storing; the app encrypts, never the DB.
- **Assistant safety** (`lib/assist/*`, `lib/chat-assist/*`, 120, 132, 321) → `assistant-safety.md`. Called only by the inbox Assistant panel, always supervised (every WRITE waits for the person); fail closed; the model never sees the nonce.
- **Video meetings** (`lib/meetings/*`, 106, 111–112, 176) → `meetings.md`. The session owns the call; background effects fail closed; keep the pre-176 fallback.
- **Calendar and web push** (`lib/calendar/*`, `lib/push/*`, 108–110, 117, 197) → `calendar-push.md`. Only the organiser edits; push routes 503 without VAPID keys.
- **Smart insights** (`lib/insights/*`, 147–153, 197) → `smart-insights.md`. Off until switched on; ordinal keys and redacted text only; a person always wins.
- **Release 2026-11-22** (236–253, 257: assignment, response times, worklist, notes, voice library, CSAT, web form, saved views, recycle, drafts, contact sort) → `release-2026-11-22.md`. `assignment_rotate_assign` is the only automatic assigner; notes never enter `messages`.
- **Shell and reports** (`nav-items.ts`, 254–255, `lib/csv/build.ts`) → `shell-and-reports.md`. A new screen is added in `nav-items.ts` once; CSV always through `build.ts`.
- **Flows vs Automations, crons** (`lib/flows/*`, `lib/automations/*`) → `flows-automations.md`. Seven `x-cron-secret` endpoints; a new background job joins the automations cron.
- **AI** (`lib/ai/*`, 030, 052, 054, 077–079, 081, 154, 290) → `ai.md`. Every dispatch records one outcome; `ai_usage_log.mode` ↔ `LogAiUsageArgs` ↔ `byMode`.
- **TypeSafe** (`lib/typesafe/*`, 063–064) → `typesafe.md`. `act: false` changes nothing; no database id goes into TypeSafe state.
- **Outbound webhooks** (`lib/webhooks/*`, 134) → `outbound-webhooks.md`. Signed, SSRF-guarded, at-most-once, never throws; `WEBHOOK_EVENTS` ↔ 134.

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
mount; the sidebar fully prefetches its role-guarded routes, so a
guard's answer can be served from the router cache for up to 5 minutes
(`staleTimes.static: 300`): a demoted admin can reopen an admin
screen's shell for that long, but its data stays RLS- and API-gated)
and `lib/client-cache.ts` (`cachedQuery`, a TTL cache for
slow-moving reference data: chat tags, members, team rosters, channel
status); its keys must name the *question* including any user/team
parameter, or two users on one device read each other's data.
Conversations, messages, and contacts never go in `client-cache.ts`
(a TTL hit skips the round trip). They may be kept only in
`src/lib/session-cache.ts` (`useSessionQuery`), under the rule the
product owner approved: **memory only** (never localStorage,
IndexedDB or any other disk); **kept separately per user and
workspace** (`sessionKey(accountId, userId, question)`); **wiped on
sign-out, workspace switch or user change** (`use-auth.tsx`:
`sessionCache.clear()`, `noteSessionUser`); and **always refreshed the
moment it is shown** (no TTL; a cached value is only a starting point).

### `next.config.ts` is a constraint file

Every block there is a fix for a specific production failure, documented
in place. In practice: the CSP (built in `src/lib/csp.ts`, pinned by
`csp.test.ts`) is `Content-Security-Policy-Report-Only` and any new
external origin (script, image, `connect-src`) has to be
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
fires on `supabase/**` changes). It replays through `psql` in autocommit, not
the CLI's runner (off in `config.toml`: 044 adds an enum value and uses it in
one file), after `supabase/ci/classic-grants.sql` restores the default grants
a classic Supabase project gives `anon` / `authenticated` / `service_role`,
which the CLI's current image no longer sets and the migrations assume. A
verify file that commits its fixtures (older ones do) leaves its users behind:
give a new file's fixture emails a prefix of its own. Apply 082 and 083 in separate runs (a
new enum value cannot be used in the transaction that adds it); 087 and
088 refuse to apply except as a superuser or BYPASSRLS role. A schema
change ships as: new numbered
migration + a **Migration required** note in `CHANGELOG.md` + updated TS
mirrors of any SQL predicate.

Files carry no BEGIN/COMMIT, and a hand apply runs in autocommit, so a
migration that can refuse itself on existing data runs every refusal scan
in one block **before its first DDL** (130 once left a half-applied schema
that broke every new submission). A plain `psql -f` keeps going after an
error, so 130's scan records the refusal, sets the session
`default_transaction_read_only`, and raises in the next statement. When a migration adds keys to a function
returning JSON, check older verify files for an exact key-list assertion
(`verify-bank-dashboard.sql` has one).
Re-running a file must not undo a later one: a later migration that
`CREATE OR REPLACE`s an earlier file's function is reverted when the
earlier file is re-applied. Keep one body in the earlier file and reach
the later objects behind a `to_regprocedure` / `to_regclass` guard (194),
or document "apply in order, once" (157-160).

### i18n

`next-intl`; catalogues in `messages/*.json` (`en`, `ar`, `ko`). The locale is
per request (`src/i18n/locales.ts`): the `NEXT_LOCALE` cookie (written at
sign-in and by Settings → Appearance from `profiles.preferred_language`, 259,
set only through `set_my_language`), else the build-time
`NEXT_PUBLIC_APP_LOCALE`, else `en`; `LOCALES` ↔ 259's CHECK. Fallback is
whole-file, not per-key, so `messages.test.ts` enforces key parity with
`en.json`, and `ar-catalogue.test.ts` that every `ar` string keeps its en
string's ICU shape. Strings containing literal `{{1}}` placeholders or raw HTML
are not valid ICU — read them with `t.raw()` / `t.rich()`, and
`icu-safety.test.ts` fails if one is wired to plain `t()`. The root layout sets
`<html dir>` (`rtl` for `ar`), so use logical classes (`ms-`, `ps-`, `start-`,
`text-start`, `rounded-s`, `border-s`) and run `node scripts/rtl-sweep.mjs`
after a merge; a back/forward icon needs `rtl:rotate-180` by hand. Don't add
`rtl:space-x-reverse`: Tailwind 4's `space-x`/`divide-x` already mirror.
`docs/languages.md`.

## Conventions

- Path alias `@/*` → `src/*`. Tests are colocated as `*.test.ts(x)`; pure logic
  lives in `lib/` precisely so it can be unit-tested without I/O.
- UI is shadcn (`style: base-nova`, neutral, lucide icons, base-ui
  primitives) in `src/components/ui` — regenerate via the shadcn CLI
  rather than hand-editing. Charts use `src/components/tremor` + recharts.
- Dark mode is `html[data-mode='dark']`, never a `.dark` class; the
  `dark:` variant is keyed to that attribute (`globals.css`). Prefer
  semantic tokens (`bg-card`, `text-muted-foreground`, `bg-wa-*`) and the
  status tokens (`text-success` / `bg-success-soft`, `warning`, `info`,
  `destructive` / `bg-destructive-soft`) over raw palette classes; a raw
  hue (an identity colour such as a calendar or stage colour) needs a
  shade per mode (`text-violet-700 dark:text-violet-300`). Never a
  `text-*-300/400` without a light-mode pair: it vanishes on white.
  The default accent is `taamul` (brand blue); dark mode lifts every
  accent and puts dark text on it.
- Light mode puts near-white cards (`bg-card`) on a neutral grey canvas
  (`bg-background`). No surface carries a hue (a blue-tinted ramp read
  as a colour cast, 2026-11-16) and none is pure white (users found it
  too bright). So `bg-background` inside a card reads as a grey hole: inner
  surfaces use `bg-card-2`. Don't override a field's fill:
  `Input`/`Textarea`/`SelectTrigger` own it (`bg-card`, dark
  `bg-input/30`); a native field takes `border-input bg-card
  dark:bg-input/30`, and only a read-only one is grey. The main nav is
  dark in both modes (`data-mode="dark"`) and brand navy in light mode
  (the `[data-nav]` block in `globals.css`); scrims are `bg-overlay`.
- Prettier: single quotes, semicolons, 80 cols, `prettier-plugin-tailwindcss`.
  Most of the tree predates this — format the files you touch, not the repo.
- `NEXT_PUBLIC_*` values are inlined at build time — changing one requires a
  rebuild, not just a restart (see `scripts/sync-tunnel-url.sh`).
- Commit style: `type(scope): imperative summary`; body explains the *why*.
- This is a **template meant to be forked** (see `CONTRIBUTING.md`), so
  user-visible changes belong in `CHANGELOG.md` and self-hosting
  behaviour is documented in `docs/` — `whapi.md`, `meta-cloud-api.md`,
  `docker.md`, `public-api.md`, `mcp.md`, `campaign-journeys.md`,
  `compass.md`, `typesafe.md`, `team-activity.md`, `ai-agent.md`,
  `meetings.md`, `whatsapp-groups.md`, `submission-groups.md`,
  `cases.md`, `memory-and-vault.md`, `assistant-safety.md`,
  `coordinators.md`, `workspaces.md`, `security.md`, `tasks.md`,
  `journey-bot.md`, `internal-chat.md`, `yeastar.md`, `calendar.md`,
  `push.md`, `taamul-sales.md`, `openwa.md`, `jev-insights.md`,
  `customer-documents.md`, `departments.md`, `second-brain.md`,
  `hr-workflows.md`, `case-desk.md`, `privacy.md`, `monitoring.md`,
  `case-csat.md`, `chat-notes.md`, `voice-library.md`, `web-form.md`,
  `recycle.md`, `funnel-report.md`, `chat-tag-report.md`.
- Comments here carry the history of a bug — when a comment explains why code is
  shaped oddly, treat it as a constraint, not noise.
