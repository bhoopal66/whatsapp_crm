> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Team activity (`lib/team-activity/*`, migrations 068, 073, 074)

The admin monitor for Whapi restriction risk: per person and per number,
chats started, replies, unanswered runs, bursts, night starts, links and
identical openers in first messages, failures, response times.

- **The definitions live in SQL.** `team_activity_starts()` defines a
  start: a non-customer message with no message in the conversation for
  24 hours, unless the customer wrote last (that is a late reply). Sends
  WhatsApp refused are ignored. A start is *replied* if the customer
  writes before the next start; younger than 24 h and unanswered it is
  *pending*, out of reply rates on both sides. "Phone" numbers are
  the linked devices, Whapi and OpenWA (145; `isLinkedDeviceNumber`).
  Per-person limits count phone-number starts only, and
  `thread-guard.ts` mirrors the same rule. Pass `p_to = 'infinity'` unless the range really ends in the
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
  are `>=` everywhere; number limits are phone-number-only, and
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
  composer on phone (Whapi or OpenWA) numbers.
- **Hard restrictions (204-206).** Default ON (no settings row = on;
  `block_over_limit` is the master switch, set once by 204), owner exempt,
  company Whapi/OpenWA numbers only (never personal, never Meta).
  `team_activity_start_check(conv, channel, text)` runs in `send-message.ts`
  before the gateway: unlock, chase, then for starts quiet hours, daily
  person (throttled by low reply rate), daily number, burst, link first,
  same opener, then Jev `cold_pitch` in TS (1.5 s, ≥ `jev_block_min_p`).
  Refusal is 429 `restricted`; blocks land in `team_activity_blocks` (90
  days, no text). An approved unlock (205, 2 h, one use) bypasses all.
  Broadcast, API v1, flows, automations, case CSAT (held) and desk digests
  (failed) use `team_activity_auto_check`
  (number limit only); AI reply, Compass notify, HR automsg and the journey
  bot are unchecked. It **fails open** on any error. Agents read `/my-activity`
  (206). Apply 204, 205, 206 before the build. `docs/team-activity.md`;
  `verify-team-activity-enforcement.sql`.
- **Personal numbers (268).** `personal_owner_id` chats and `is_personal`
  numbers are out of starts, report, drill-down and (through starts)
  alerts; a new read of messages here needs the same two filters.
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
  needs both filters. Since 216 `v_convs` asks `can_view_conversation`
  once per distinct (owner, assignee, number, pinned number) tuple, and
  the report runs with `plan_cache_mode = force_custom_plan`: a cached
  generic plan (pooled connections) took the owner's 90-day report past
  the 8 s timeout. Time a plpgsql RPC past its sixth call in one session.
- **Tests.** The SQL behaviour is asserted in
  `supabase/ci/verify-team-activity.sql`.

SQL invariants of most recent migrations are asserted by a
`supabase/ci/verify-*.sql` file of their own (chat tags, opt-out,
partner banks, pipeline deals, approved answers, and 082–089's
workspaces, edge security, tasks, journeys, internal chat (two files),
deal rooms and PBX, then 106's meetings and 176's host tools), each a step in `.github/workflows/migrations.yml`
and each one statement (the pinned CLI rejects more). A migration that
changes one of those rules updates its verify file; a new verify file must
be wired in there. In a plpgsql verify block, assign a writing function's
result first and read its effect in a separate statement — a subquery in
the same expression reads the snapshot taken before the call.
Migrations 120–129 add nine more (134 adds `verify-compass-sync.sql`, 136 `verify-submission-no-whatsapp.sql`): assistant safety, vault, cases, case
tools, case SLA, case inbox, bank workspaces, bank dashboard and CRM
memory (`verify-assistant-safety.sql` … `verify-crm-memory.sql`).
Team chat 156–160 add five more (`verify-chat-messaging-v2.sql` …
`verify-chat-moderation.sql`).
