> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

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
embeddings key it degrades to lexical-only rather than failing. A search that
errors (the count, or the semantic half with a key set) comes back `failed`:
with a floor or strict grounding the bot hands off (`error`), except on a
short turn. Gap questions are masked before they are stored or embedded.

**AI agent v2 (migration 077, `docs/ai-agent.md`).**
- *Tiers.* `ai_configs.model` is the standard tier; `model_small` / `model_large` are the others. `router.ts` picks one per message: a TypeSafe route judgment (`lib/typesafe/checks/route.ts`, `qs-route-v1`), run in parallel with triage, else a heuristic. The route judgment is not a safety check: it is not in `ts_account_settings`, never written to `ts_decision_log`, and has its own breaker key.
- *Escalation.* At most one extra generation per dispatch, plus one guardrail rewrite on the large model.
- *Held drafts.* A guardrail **hold** is queued in `conversations.ai_pending_draft` for Send / Edit / Discard (`/api/ai/pending-draft`, claim-then-send). It is written by the hand-off's own conditional update, so a chat a person took meanwhile gets neither. A **block** is never queued.
- *Pauses.* `ai_paused_reason` records why the bot is paused. The `agent_reply` pause is set by a `messages` trigger, never by app code, and only that pause auto-resumes.
- *Cut-off answers.* The adapters set `truncated` (the output cap, the context window, a refusal, a content filter) and every caller of an adapter runs `assertComplete`, which throws `AiError` `truncated`: half an answer, or a lost `[[HANDOFF]]`, never goes out. OpenAI reasoning models (by id) get `OPENAI_REASONING_TOKENS` on top of the cap.
- *Outcomes.* Every dispatch records one outcome (`outcomes.ts`) on the conversation and in `ai_reply_events`. That record is how "why didn't the AI reply" gets answered, so an exit path without one is a bug.
- *Sales chats only.* The bot stands down (`skipped_number`) for a personal chat, an `inbox_department` other than sales, a chat with an `hr_conversations` row (closed too) and a message on an HR line; a check that cannot be read records `error` and sends nothing. `hr_lines` has no service-role grant: the line is asked of `hr_is_line` (279), before it of `hr_auto_open_recruiter`, which answers `off` while auto-open is off.
- *Time budget.* The dispatch runs on a deadline inside the 60 s `after()`. A step that cannot fit is skipped in favour of a hand-off, never left to be killed.
- *Partner banks (078).* `ts_account_settings.partner_banks` (`{codes, custom}`) is the account's own list for the guardrail; NULL means the built-in `PARTNER_BANK_CODES` (`lib/typesafe/banks.ts`). Parsed tolerantly by `parsePartnerBanks`.
- *Important pin (078).* `conversations.ai_attention_at` is stamped at hand-off; the inbox pins those chats with a red "Important" label (`lib/inbox/attention.ts`). A person's reply clears it via 077's messages trigger (`ai_pause_on_agent_reply()`), whatever the AI config now says; Take over / Resume / acting on a held draft clear it too.
- *Every number (079).* `ai_configs.reply_on_all_numbers` (default false) answers on the number the customer wrote to instead of only the `ai_reply` route; a chat pinned with `send_channel_id` is left alone.

**Approved answers (migration 081, `lib/kb/*`, `docs/ai-agent.md`).**
`ai_configs.answer_mode = 'approved'` is a bot that **never writes
text**: it sends one admin-approved `kb_entries` row verbatim or hands
off. Pipeline: the usual gates and triage (no router) →
`kb_shortlist()` (SQL, ≤ 8 rows; `KB_SELECT_MAX_CANDIDATES` in
`lib/typesafe/checks/kb-select.ts` — change one, change both) → a
TypeSafe `kb_select` judgment → `lib/kb/select-policy.ts` (a pricing,
legal or angry signal ≥ 0.5 → reason `kb`; best score below
`approved_min_score` → `no_knowledge`). No TypeSafe means every message
is handed off, never sent unjudged; the guardrail does not run on
approved text. Invariants held in SQL: `internal_staff` rows are
hard-coded out of `kb_shortlist`; an `approved` row cannot be blank or
carry a `[TO CONFIRM …]` placeholder (CHECK); a trigger bumps `version`
on any change an approval depends on, and `PATCH /api/ai/kb/[id]`
updates only the version it displayed. Import is `kb_import()` from the
review spreadsheet (`lib/kb/import.ts`), as the calling admin, by
`(account_id, ref)`; a file with no Status column cannot publish an
edit. `sensitive_data_reply` (`lib/kb/sensitive.ts` — Emirates ID,
Luhn-checked card, checksummed IBAN) applies in **both** modes and
short-circuits model and TypeSafe.

**Translate (migration 154, `lib/translate/*`, `lib/ai/translate.ts`).**
`POST /api/ai/translate/message` (viewer and up) turns a message into
English and `POST /api/ai/translate` (agent and up) turns a composer
draft into Arabic. Both use the draft route's key and switch
(`loadAiConfig`, default `requireActive`), but a saved translation is
served before the switch is read. English uses `model_small`,
else `model`; Arabic, which the customer reads, uses `model`. Drafts are
never stored. The message route checks visibility through the caller's
RLS client, then reads and writes `message_translations` on the service
role. That table is service-role only (RLS, no policy, no grants). A
trigger derives its account and conversation from the message. It is
re-translated when `source_hash` (sha256 of the text) differs.
`verify-message-translations.sql`. `ai_usage_log.mode` (154),
`LogAiUsageArgs.mode` and the usage route's `byMode` change together:
the route indexes `byMode[r.mode]`, so an unlisted mode crashes the
panel. The bubble text never gets `dir="auto"`, because the time overlay
reserves room at the end of the last line; the composer textarea does
get it. Anything under a bubble goes after the reactions chip, which
overlaps the bubble (`-mt-1.5`).

**Learn from team answers (migration 290, `lib/kb/learn*.ts`,
`docs/ai-agent.md`).** Off by default (`kb_learn_settings`, set only via
`kb_learn_set_enabled`, admin+ of the active account). The automations
cron runs `runKbLearning` hourly; `kb_learn_claim_run` lets an account
through once per 7 days and `kb_learn_finish_run` records its draft
count. A team answer is the first non-holding person reply (bubbles
joined, `pickTeamAnswer`); a topic needs `MIN_ANSWERS_PER_TOPIC` (2). Drafts are written only by
`kb_learn_record_draft` (service role), always status `draft`, source
`learned`, ref `LRN-…`; it refuses while the switch is off and when the
topic has a live draft (`kb_learned_drafts`: same gaps ≥ half, or same
`topic_key`, a SHA-256 of the label; a deleted or `remove` draft frees the topic). A discarded
one (`kb_learn_record_discard`) holds it for 28 days. The label is a
customer's message: never sent or stored. Chats pass `notSalesChat`
(`lib/ai/not-sales-chat.ts`, shared with auto-reply; `readOnly` here) for
the chat and every message's number; every read throws. Evidence is
masked with `maskIdentifiers` (`brainRedact`, case numbers, 5+ digit runs)
and `buildNameMatcher` over the account's whole list (`knownNames`, once
per run; `kb_learn_case_names` for tables the service role may not read) before `generateReply`
(purpose `kb_learn`, so `assertAiTransfer` runs), fail closed; the
model's question and both answers are screened with the same
(`screenText`). Usage mode
`kb_learn`: 290 restates 202's CHECK list, so apply in order, once.
The bot's reply path and `kb_shortlist` are unchanged.
