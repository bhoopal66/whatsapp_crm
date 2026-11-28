> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### WhatsApp connection (three providers, side by side)

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
nobody. OpenWA `disconnected` is down only once consecutive probes at
least ~5 minutes apart agree (`confirmDisconnected`, in-process): the
gateway resets every session to it on each boot. A transition notifies
owners and admins (`channel_disconnected` / `channel_reconnected`), or for
a personal number (190) its active holder alone, and Compass answers `whapi_not_connected`
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

**Inbound is durable (migration 264).** Every 1:1 message (over-limit ones
included), receipt, personal-number own send and Whapi/OpenWA group message
is recorded in `webhook_inbox` (`recordInboundEvents`, one all-or-none call
per POST) **before the 200**; a failed record releases the replay claims and
answers 503. Inside `after()`, `runDeliveredEvents` (`inbound-delivery.ts`)
runs each event on its own: `processInboundEvent` → `settleInboundEvent` →
confirm its replay claim only when it settled `done`, else release it (a
confirmed key swallows redeliveries for 24 h). 1:1 events run before group
messages, which file documents inside their event. What is left is drained
by the automations cron (`inbound-drain.ts`), one row claimed at a time,
8 attempts, then a `inbound_message_failed` bell. A STOP on an HR chat or
HR line whose stamp failed (`owed.stop`, `recordHrStop`) is retried here too.
A new kind of event goes
through the queue, with its payload built in `inbound-events.ts`. **Not
queued**: Whapi `groups` / OpenWA `group.*` events and submission-group
membership, Meta deal rooms, message costs, template and health events.
While 264 is missing the routes run `processWithoutQueue`, the former path.
Removing a number cascades its rows away, so interactive removals (Whapi,
Meta, OpenWA, personal) first ask `waitingMessages` (`waiting-messages.ts`,
293's `webhook_inbox_waiting`) and answer 409 `messages_waiting` unless
`?force=1`; the abandoned-connect sweep skips such a number, offboarding
only logs the count; a failed count is 0, never a blocked removal.
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
  `sent`, and corrected only by `delivered`/`read` (never `sent`): the
  failure text goes and the campaign is re-settled. Same rule for
  `messages`, WhatsApp groups (`GROUP_STATUS_PREDECESSORS`), 291's
  `reconcile_broadcast_recipient_statuses` and `hr_automsg_delivery_apply`.
- A Flow that consumes the message suppresses the content-level automation
  triggers (`new_message_received`, `keyword_match`, `interactive_reply`) and
  AI auto-reply; relationship triggers (`new_contact_created`,
  `first_inbound_message`) still fire.

Gateway-hosted media links expire in ~30 days, so `mirror-inbound-media.ts`
copies the bytes into the `chat-media` bucket (`inbound/` beneath
`account-<id>`, with the service role: since migration 283 a signed-in
person reaches only the objects they uploaded themselves, and uploads only
to the top of `account-<id>`, `staged/` and `groups/`) and persists that
URL instead. It is best-effort **by contract**: it returns
`null` and never throws, because a webhook that throws makes Whapi redeliver
and re-run the entire fan-out. Per-account opt-out: `mirror_inbound_media`
(migration 039).

Outbound, the composer uploads an attachment when it is attached, into
`staged/` beneath `account-<id>` (`buildMediaPath(…, 'staged')`); the
message then stores that public URL as its `media_url`. One never sent
(tab closed, draft abandoned) is deleted after 30 days by the daily
automations-cron sweep (`runStagedMediaSweep`), which lists through migration 155's
`chat_media_staged_orphans` (service role): staged names that no
`messages.media_url` or template/broadcast `header_media_url` points at,
compared on the URL's path because the public origin changes with the
tunnel. Only `[A-Za-z0-9._-]` names are candidates, so a name that could
be percent-encoded in a stored URL is leaked, never deleted while sent.
A parked, staged or retried attachment lives only in the browser, so the
composer stops using one past 29 days (`isExpiredStagedMedia`,
`lib/storage/staged-media.ts`, one day under the sweep's age): it is
deleted and the agent told, never sent as a dead link.
`verify-chat-media-staged.sql`, `verify-chat-media-owner.sql`.

One `message_templates` row drives both providers, differently: Whapi has
no template registry, so the row is rendered locally (`template-body.ts`)
and sent as an ordinary message — always works. Meta addresses an
already-**approved** template in the WABA registry by (name, language), so
the same row is a hard rejection until it is submitted and approved. The
review lifecycle (`template-webhook.ts`, `template-send-builder.ts`,
`template-components.ts`) is live only for Meta sends; `status` is
advisory on Whapi. APPROVED without a `meta_template_id` is ours, not
Meta's: the picker decides with `lib/whatsapp/template-offer.ts` (only one
Meta refused is held back; an unsynced one is offered and Meta answers). An
edit never writes `status` over a verdict of Meta's.

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
`describeMetaFailure` stores it on failed broadcast recipients and, since
292, on the message itself (`messages.failure_reason`, service role only;
the bubble shows it, a correcting delivery clears it).
Migration 066's `reconcile_broadcast_recipient_statuses` replays the
ledger onto recipients a receipt missed (a receipt that beat the wamid
stamp); `describe_meta_failure` (SQL, latest body in 292) mirrors
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

**A limited number stays limited (314).** `whatsapp_config.access_restricted`
is set by a trigger on any `whatsapp_channel_members` / `whatsapp_channel_teams`
row and cleared only by `set_channel_access` with BOTH lists empty; limited with
nobody allocated = owners and admins (`can_use_channel` ↔ `usableNumbers`,
`startFor`, `chooseHostingNumber`). Replacing a number's lists or a team's
members sends what the screen showed (`p_expected_*` overloads, 409).

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

**OpenWA, a third provider (migration 144, `docs/openwa.md`).**
`provider = 'openwa'` is a self-hosted linked-device gateway run beside
the app (never inside it). An openwa row stores the OpenWA session id in
`phone_number_id`, a session-scoped operator key in `access_token`, the
webhook secret in `verify_token` and the phone in `waba_id`;
`OPENWA_API_KEY` (admin) is used only to add and remove numbers.
`isLinkedDeviceProvider` (whapi | openwa) is the test for "not the Cloud
API"; `=== 'whapi'` stays where code means Whapi's own API (Safety Meter,
groups, submission groups, Compass). Every provider switch is exhaustive
with a `never` default, because `=== 'meta'` else-Whapi silently sent
openwa through the Whapi client and typecheck did not notice. Its webhook
authenticates like Meta's: `sessionId` selects the row, the
`X-OpenWA-Signature` HMAC over the raw body proves it, fail closed. No
buttons or lists (numbered text instead): a flow maps a typed number or
exact title back to its option whatever the meaning switch
(`sendsMenusAsText`, `resolveTypedReply`'s `menuSentAsText`);
automations and the journey bot do not. Team activity counts it as a
phone number, like Whapi (migration 145); the Safety Meter stays
Whapi-only.

A personal number records nothing once its owner is deactivated or
removed: `mayRecordFor` (`personal-owner.ts`) runs before the webhook
screens or queues and again per event, and `personal-offboarding.ts`
disconnects the number when they go.
An import stopped by an error keeps its lease for `PAUSED_RETRY_MS` like a
paused one, and a chat the database refuses 3 times (`ChatDbError`) fails.
**Personal numbers (190, 191).** An admin allows a person
(`profiles.may_connect_personal_whatsapp`) to link their own OpenWA
number: a `whatsapp_config` row with `is_personal`, owner = `user_id`, one
per person per workspace, never primary, routed or allocated to others.
191 gives their traffic its own chats: `conversations.personal_owner_id`
(NULL = company chat), two partial unique indexes replacing 036's
(company: per contact; personal: per contact and owner),
`conversations_personal_guard`, and `can_view_personal_chat` (owner,
owner's leader, admins) in the conversations/messages policies; the old
190 channel-based visibility exception is gone. Bots, flows, automations,
integrations and the public API filter `personal_owner_id IS NULL`.
`POST /api/whatsapp/send` with `personal: true` uses the caller's
personal chat (409 `no_personal_number`); `can_use_channel` has a
personal branch and only an admin, the owner or the owner's leader sends
(`maySendFromPersonal`). History import (first link, text only) has its
own tables and RPCs. The customer page takes the company chat as its
conversation and links personal chats apart (`splitConversations`).
`verify-personal-numbers.sql`, `verify-personal-chats.sql`,
`verify-departments.sql`.

**Credentials (migration 285).** No session reads `access_token`,
`verify_token` or `app_secret`: the columns are not granted. Never
`select('*')` from `whatsapp_config` through a session. Read the visible
columns with the caller's client (RLS decides the rows), then
`withChannelSecrets()`; `loadChannels` and `loadOpenWARow` already do.

**Send guard (188, 334).** `meta-health/check-send.ts` (`checkSend`) is the one entry
point for guarded sends (broadcasts, automation templates, HR, desk digests,
CSAT, call service details); rules live in `guard.ts`. Enforce is off by
default. It must never block an agent's inbox reply, and a log failure never
stops a session reply or a utility template. Runbook:
`docs/runbook-meta-restriction.md`.
