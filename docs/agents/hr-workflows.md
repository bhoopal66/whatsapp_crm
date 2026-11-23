> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### HR workflows (`lib/hr/*`, migration 200)

Release 023 ported onto 192's HR chats. `docs/hr-workflows.md` is the
contract.

- **One row per chat** (`hr_conversations`, PK `conversation_id`):
  inbox `recruiter` (stage, outcome) or `dept` (topic), never both
  (CHECK). No row = "Not sorted". Owner = the chat's assignee; HR
  closure (`closed_at`, `outcome`) is not `conversations.status`.
- **No new visibility.** HR team membership (`hr_team_members`, written
  only by `hr_member_set`, admins) opens the `/hr/*` screens (sidebar
  group "HR"; old `/hr-inbox` links redirect) but grants no chat;
  every `hr_*` write and both read policies use `hr_can_see` (191's
  `conversations_select` predicate, so a coordinator share does not
  reach HR rows: change both together); NOT_FOUND otherwise.
- **Reply state** is generated from `last_inbound_at` / `last_outbound_at`,
  stamped by a `messages` AFTER INSERT trigger (customer / agent; bot
  ignored) that must never fail an insert (exceptions become WARNINGs).
- **Rules create `public.tasks`** (`source 'automation'`, `kind
  'follow_up'`, `source_ref 'hr:<chat>:<rule>:<event>'`, `contact_id`
  NULL so 085's contact branch can't show an HR topic) and set flags;
  they never send. Each event fires once through the `hr_rule_fired`
  ledger (a deleted task is not re-created). Triggers on
  `hr_conversations` fire stage/topic rules; `hr_sweep` (service role,
  automations cron every 5 min) the time rules. History drives the
  dedupe counts and the "not below the furthest stage" rule.
- Lists live in SQL CHECKs and `lib/hr/types.ts` (`types.test.ts` reads
  the migration); `lib/hr/access.ts` mirrors the role rules for the UI.
  Refusals carry a HINT code (`hrErrorCode`). `verify-hr-workflows.sql`.
- **Topics (201).** Eleven department topics; `HR_TOPICS` /
  `HR_TOPIC_GROUPS` / `HR_TOPIC_FILTERS` are pinned to 201 by
  `types.test.ts`. 201 re-creates `hr_set_topic`, so re-running 200
  after it narrows the list again: apply in order, once.
- **AI reply drafts (202, `lib/hr/agents/*`, release 024/026).** Drafts
  only: no send path anywhere in the module. Recruitment inbox only,
  company and personal chats. `inbound.ts` runs from both branches of
  `processMessage` (personal before its early return), after the
  idempotency boundary, via `later`; it costs one indexed read unless
  the account's 'orchestrator' switch is on. A STOP is recorded
  (`contacts.opted_out_at` + `hr_agent_supersede`) only while agents or
  automated messages are on (`hr_automsg_active`). The model is the
  workspace's AI config (`createAiModelPort`); spend is
  `ai_usage_log.mode` 'hr_agent' (the 202 CHECK, `LogAiUsageArgs` and
  the usage route's `byMode` change together). Candidate text only
  inside `prompts.ts`'s data block (`sanitizeData`). Caps (3 pending,
  5 a day) are checked before any AI call; drafts expire in the HR
  sweep. `verify-hr-agents.sql`.
- **Automated messages (203, `lib/hr/automsg/*`, release 025-027).**
  Template-only, from the chat's own number (`send.ts`), never a
  personal chat or number; a Meta send needs the local
  `message_templates` row approved and utility, params in the HR
  text's `{name}`/`{slot}` order. Rows are queued in SQL
  (`hr_automsg_on_history`, only while that trigger is on); the
  automations cron drains every minute (`drain.ts` → `engine.ts`
  `processDue`). The claim re-checks the switches, opt-out, consent and
  the cap under an advisory lock, so `row_state` → claim never sends
  past a fresh STOP; accepted-but-unrecorded is 'unconfirmed' and never
  resent. Tables are FORCE RLS with no grants (203 refuses to apply
  except as BYPASSRLS). Promotional phrases and required placeholders
  are TypeScript (`templates.ts`, imported by the client too);
  structural body rules are SQL. `verify-hr-automsg.sql`.
- **Hire fast** (`lib/hr/hirefast.ts`): pure ranking over the rows RLS
  shows the caller; `assigned_agent_id` is an auth user id.
- **Sends that cannot work, receipts (212, release 029a/b).**
  `classifySendFailure` (`lib/hr/automsg/failure.ts`; `send.ts` throws
  `HrSendRefusal` for its own refusals) splits failures: non-retryable →
  `hr_automsg_fail_terminal` (failed, attempts 3, reason in `last_error`,
  audit `outbox_failed_terminal`); the rest retry as before (a Whapi
  401/403 is ambiguous, so retryable). `handleStatusUpdate` mirrors a
  receipt for a bot message onto the outbox (`hr_automsg_delivery_record`,
  forward-only `delivery_state`, `failed` → terminal
  `delivery_failed:<code>`); a receipt that beats the provider-id stamp
  is caught up from `messages.status` by a trigger when the row turns
  `sent`. 212 restates 203's `hr_automsg_expire` (a terminal failure is
  never relabelled cancelled): apply in order, once.
  `verify-hr-automsg-delivery.sql`.
- **RCS channel (215, release 030).** `channel` ('whatsapp' | 'rcs') on
  triggers, templates, consent and outbox (default whatsapp; the
  template and consent keys include it). `lib/hr/automsg/rcs-config.ts`
  reads `RCS_*` at call time; unset (production) means not connected: an
  rcs row is held `channel_not_connected`, never sent, never re-routed
  (no fallback anywhere). `rcs.ts` / `rcs-webhook.ts` (POST
  `/api/rcs/webhook`) are the package's UNVERIFIED placeholders. Opt-out
  and the daily cap span both channels; the claim re-checks consent for
  the row's channel. 215 restates 203's on_history, enqueue_nudges,
  row_state, claim, mark, config, trigger_set, template_set, consent_get,
  consent_set, outbox_list and 212's delivery_record: apply in order,
  once. `verify-hr-automsg-rcs.sql`.
- **SMS channel (226, release 032).** 'sms' joins 215's channels
  (Dinstar GSM gateway, `dinstar.ts`, UNVERIFIED wire format);
  `sms-config.ts` reads `DINSTAR_*` / `SMS_*` at call time, unset = held
  `channel_not_connected`. The engine hands only 'whatsapp' rows to the
  WhatsApp sender; every other channel needs its own sender (a
  `channel === 'rcs' ? … : whatsapp` once would have sent SMS over
  WhatsApp). An approved sms template needs a label (203's
  `approved_named`); the text is the body, measured by `sms-text.ts`
  (3-segment cap, shared by sender and editor). Gateway pushes match by
  provider id suffix `:<user_id>` plus the number's last nine digits;
  `hr_automsg_delivery_apply` holds the receipt ladder once. 226
  restates 215's on_history, enqueue_nudges, trigger_set, template_set,
  consent_get, consent_set and delivery_record: apply in order, once.
  `verify-hr-automsg-sms.sql`.
- **HR lines (213).** `hr_lines` / `hr_line_settings` (RPC-only; HR →
  Rules, owners/admins). `processMessage` runs `autoOpenRecruiterChat`
  (`hr_auto_open_recruiter`, service role) before the recruiter-agents
  hook in both branches: a chat with no HR row writing to an HR line opens
  in Recruitment (cv_review, created_by NULL), but only if every message
  in it came through an HR line (`'other_numbers'` otherwise: one company
  chat per contact means a sales chat must never turn into a candidate).
  Off by default.
  `verify-hr-lines.sql`.
- **My worklist (029c).** `/worklist`: `lib/worklist` ranks open HR
  chats (Hire fast's own scoring, imported), cases needing action and
  pending drafts in the browser from existing reads; no API or migration.
  Assignee ids are auth user ids; titles carry no names or bodies.
- **263.** `hr_automsg_due` lets channels take turns under its limit (203's
  order within a channel).
