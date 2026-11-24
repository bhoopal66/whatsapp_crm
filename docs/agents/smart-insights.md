> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Smart insights (`lib/insights/*`, migrations 147–152)

Jev (TypeSafe) beyond the bot's safety checks: customer signals, chat-tag
suggestions and auto-tagging, campaign reply sorting, the pre-send
message check, meaning triggers, Compass status mapping, lead score and
knowledge-gap topics. `docs/jev-insights.md` is the contract.

- **Selection judgments.** Each feature is a `SELECTION_CALLERS` entry in
  `typesafe/client.ts` (own breaker), with `questions/` + `checks/` like
  `route.ts`: no account switch in `ts_account_settings`, no policy, no
  decision-log row, never throws. Ordinal option keys only; every text
  (admin hints and descriptions included) through `redactClipped`; model
  mismatch = failure. Campaign text goes with placeholders blanked: names
  are not redacted, so recipient values must never reach Jev.
- **Off until switched on.** `ai_insight_settings` (no row = all off) plus
  `insightsAvailable()` (key + `TS_ACCOUNT_IDS`) gate everything; off means
  today's behaviour exactly. Knowledge-gap judging has its own switch.
- **Sales chats only.** `runInboundInsights`, `classifyCampaignReply` and
  the tag writes after them take the pipeline's `salesChat` decision (HR,
  another department, personal or unreadable = nothing asked or written);
  `dispatchChatTagSet` passes it on, or reads the chat itself when given
  none, so a tag's message steps stay off there. Reminder suggestions and
  the opt-out watch are not sales features and are not gated by it.
- **One request per inbound.** `runInboundInsights` runs after the opt-out
  watch (chained, awaited in `after()`) and reuses the watch/bot triage
  row for the same message hash. Meaning triggers share one memoised
  request across Flows and Automations (`loadMeaningCandidates`); a failed
  request is "no match" for both.
- **Writes are compare-and-set.** Insight and suggestion columns are
  service-role-only (`conversations_insight_guard`); signals are
  forward-only on `insight_at`; a suggestion is written only if the chat's
  tags, dismissed tag and `suggestion_basis_at` (server time of the read)
  are unchanged. Auto-tag uses `writeConversationChatTags` with
  `onlyIfUntagged` + `requireDismissedId` + `requireBasisAtMost`: a person
  always wins. Its timeline note is a `conversation_events` row of kind
  `chat_tag_auto` (`details` jsonb); the timeline renders only known kinds.
- **The message check never blocks.** Errors and a 2.5 s timeout send at
  once; a chat switch mid-check parks the text/attachment for its own chat
  (`compose-check-flow.ts`). Only warning codes are logged.
- **Drafts are per chat.** Every chat switch (and leaving the inbox)
  parks the composer's text, staged attachment and reply quote for the
  chat left and restores the opened chat's own, silently; only a switch
  during a check shows the "wasn't sent" notice. The stash is per tab and
  per login (emptied, its files deleted, when another user signs in). An
  upload, voice note or AI draft that finishes after a switch is parked
  for, or dropped from, the chat it started in, never put in the open
  one. A parked attachment is never deleted while it can come back.
- **Precedence.** Active run › campaign follow-up flow › keyword / first
  inbound › meaning triggers; at most one `intent_match` automation per
  message, none when a `keyword_match` automation ran; `intent_match` is
  content-level (suppressed with `keyword_match`).
- **Case status map (151).** Consulted before 137's name rule, only for a
  stage in the case's own bank list; final statuses unmappable;
  `case_status_map_apply` is forward-only and re-reads each case under its
  lock. `verify-case-status-map.sql`.
- **Gap topics (152).** `kb_gap_topics_replace(account, topics,
  p_expected)` refuses as STALE when a dismissal raced the recompute;
  recomputes honour a deadline (cron 45 s / account 40 s / Refresh 25 s).
- **Client copies.** Constants a client component needs (warning codes,
  reply classes, intent keys) live in dependency-free modules pinned to
  the server's list by a test that reads the server file as text.
- **Pins (153).** `insight_attention_at`/`reason` (urgent = time pressure
  alone, wants_person, upset, callback) are set only by
  `insight_pin_attention` (service role; locks the chat row, then answers
  'answered' if a person replied — or any `insight_attention_cleared` was
  recorded — at/after the message, so a late judgment never re-pins) and
  cleared only by a person's reply (trigger, takes the same row lock),
  `acknowledge_insight_attention` (Handled, agents+) or closing. Bot and
  automation messages never clear. The precedence lives in
  `ATTENTION_REASONS` and the RPC's `c_order` (`attention-order.test.ts`
  pins them); the bell type `insight_attention` lives in 153 §9
  (`notifications_type_check`, `push_bell_url`), `hrefFor`, `PUSH_KINDS`
  and `kindGroup` — change them together.
- **Reminder suggestions (197).** A chip under a chat message that names a
  later time; off until `reminder_suggest_enabled`. `lib/reminders/suggest.ts`
  gates (text, time finder, 2 min ahead, company chats, 60/min, Jev
  `qs-reminder-v1` at 0.6) and never throws. Rows in
  `message_reminder_suggestions` are service-role writes; adding files a normal
  follow-up task. `verify-reminder-suggestions.sql`.
- **Colours** come only from `src/lib/insights/palette.ts`: complete literal
  class strings with a `dark:` pair (Tailwind can't see composed names).
  Inbox chips sit on the meta line and never replace the message preview.
- Verify files: `verify-smart-insights.sql`, `verify-insights-v2.sql`, `verify-campaign-reply-classes.sql`,
  `verify-compose-check-events.sql`, `verify-meaning-triggers.sql`,
  `verify-case-status-map.sql`, `verify-kb-gap-topics.sql`.
