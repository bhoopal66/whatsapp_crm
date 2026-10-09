# TypeSafe decision layer (module 013)

An optional safety layer around the AI auto-reply bot. It asks
TypeSafe's **Jev** model a set of narrow, typed questions, such as
"does this reply promise a loan approval?" or "is the customer asking
to stop messages?". Plain code then turns the answers into decisions
the bot acts on. It never generates text.

Each account turns it on and off itself, in **Settings → AI safety
checks** (admins only). The server holds only the secrets. An account
that never switched it on sends nothing to TypeSafe and logs nothing.
An account chooses:

- **Monitor only**: decisions are logged and shown in the panel's
  activity list, and nothing changes for customers;
- **Live**: the decisions act. Live runs on the built-in thresholds
  unless two different admins of the account have approved custom
  ones (see [Approving a policy](#approving-a-policy)).

The design document is `docs/typesafe/2026-09-27_wacrm_module013_typesafe_design.docx`
(spec v0.1). This page is the operator-facing contract for this app.
Question set: `qs-013-v0.2`.

## What it does

| Check | Where it runs | What it can do | What it can never do |
|---|---|---|---|
| **Triage** (A) + **opt-out** (B) | Before the bot calls its model, after the escalation-keyword gate | Hand the thread to the team (the customer asked for a person, complained, might be complaining, or asked to stop messages). Or restrict the bot to knowledge-base answers | Remove an opt-out; send anything but the account's hand-off message |
| **Passage filter** (D) | After knowledge-base retrieval, before the prompt is built | Drop irrelevant or injected excerpts; set aside excerpts that contradict the customer's premise | Add knowledge; treat an excerpt as instructions |
| **Guardrail** (C) | Just before a bot reply is sent (also the closing line before a hand-off marker) | Hold or block the draft. The customer gets the account's hand-off message and the team gets the draft in the hand-off note | Let an unscreened reply out while it is on and live |
| **Eligibility** (E) | *Not wired* — the app has no pre-eligibility step | (Extracts emirate, legal form, sector, turnover band, years, licence) | Make a credit decision or do arithmetic |
| **Watch** (A/B on threads the bot did not answer) | After every inbound text the bot's own triage did not judge — threads people handle, flows, automations | Mark an opt-out on the contact (`contacts.opted_out_at`) | Hand off, reply, or change who owns the thread. A request for a person or a complaint there is logged only |

A hand-off from the layer uses the same mechanism as the bot's other
gates:

- the bot is paused on the thread;
- the thread is routed to the configured hand-off agent;
- an internal note records the reason, and `ai_handoff_reason` is set
  to `triage` or `guardrail`.

**Opt-outs are the exception.** After an opt-out, and after a
*possible* opt-out (probability in the review band), the bot sends no
farewell message. An acted-on opt-out also **marks the contact opted
out** (see [Opt-outs](#opt-outs)), and every broadcast then skips them.

A guardrail hold is a full hand-off, even when it happened only because
TypeSafe was unreachable. The operator's fail mode chose `hold`, and
this is how a person sees the draft.

Every inbound message gets its own dispatch. The escalation-keyword
gate, triage and the guardrail judge **the message that triggered it**
(a media caption included), with the conversation before it as context.
In a burst ("please stop sending these" / "thanks"), each message is
judged once, as it arrives.

Code lives in `src/lib/typesafe/` (the layer itself) and
`src/lib/ai/typesafe-gates.ts` (how the bot uses it). The schema is
`supabase/migrations/063_typesafe_decision_layer.sql`.

## The one rule

Every decision carries `act`. **If `act` is false the bot does exactly
what it did before this module.** `act` is true only when all of these
hold:

1. The server has `TYPESAFE_API_KEY` and `TS_LOG_HASH_KEY`, does not
   switch the check off (`TS_ENABLED_<CHECK>=false`), and, when
   `TS_ACCOUNT_IDS` is set, lists the account.
2. The account switched the layer and the check on in Settings, and
   chose **Live**. Neither `TS_SHADOW` nor `TS_SHADOW_<CHECK>` forces
   monitor-only.
3. If the account has an approved custom policy for the check, it is
   not marked shadow. (No policy means the built-in thresholds. A
   custom policy for another model or question set, or one that fails
   validation, is ignored in favour of the built-in thresholds, with an
   alert.)
4. TypeSafe answered, with the pinned model.
5. The text's language is not held back. With **English only** (the
   default) Arabic, mixed-language and other-script text is logged
   only (`TS_SHADOW_LANGUAGES`, default `ar,mixed,other`); **All
   languages** clears it. The guardrail keys this on the **reply**.
   While the reply's language is held back, the deterministic code
   checks below act as usual, and a model flag, which is uncalibrated
   and may be wrong, sends the draft to a person for review. It never
   blocks, and never lets the draft through. So writing in Arabic does
   not switch screening off.

The built-in thresholds are the spec's starting values; they have not
been calibrated on this installation's data. Triage hands off on an
unsure intent only when a complaint is a real possibility (complaint
probability ≥ `possibleComplaintMin`). Uncertainty between two
products the bot answers alike is no reason to pull in a person.

**Guardrail exception (fail-safe).** While the guardrail is on and
live for an account, it never falls back to "send as today". It goes
into **degraded mode** instead when:

- TypeSafe is down, rate-limited or paused;
- TypeSafe answered with an unexpected model.

In degraded mode the guardrail applies `TS_GUARDRAIL_FAIL_MODE`
(default `hold`) together with the code checks. A request the layer
itself withheld because of its content — an identifier the redaction
missed, or an oversized state — always holds, whatever the fail mode.

The code checks, which need no model:

- a non-partner bank named in the reply → **block**, or **hold** when
  the customer named that bank first (the reply is most likely
  declining it, which a person confirms);
- a percentage or AED amount in the reply that no sanctioned source
  contains → **hold**.

A figure is supported when it appears in:

- the knowledge excerpts, including as a bare number;
- the business's own sources the bot was given: the account's AI
  instructions, the campaign message the customer is replying to, and
  the guided-flow step.

What the customer wrote is **not** a source: otherwise a customer could
assert a rate and have the bot confirm it. A reply that repeats a
figure the customer gave (their turnover, say) is held for a person.

A model answer can only make the outcome stricter.

## Setup

1. **Apply the migrations.** Apply
   `supabase/migrations/063_typesafe_decision_layer.sql` and then
   `064_typesafe_account_settings.sql`, each as one transaction, then
   ask PostgREST to reload its schema cache. Each file bounds every
   lock it takes to 5 s; if one times out behind a long transaction,
   run it again.

   ```bash
   for f in 063_typesafe_decision_layer 064_typesafe_account_settings; do
     docker cp supabase/migrations/$f.sql supabase-db:/tmp/
     docker exec supabase-db psql -U postgres -1 -v ON_ERROR_STOP=1 -f /tmp/$f.sql
   done
   docker exec supabase-db psql -U postgres -c "NOTIFY pgrst, 'reload schema'"
   ```

2. **Set the two secrets** in `.env.local`, then restart the service.
   These are runtime variables, so no rebuild is needed. **No inline
   comments** on these lines: systemd's `EnvironmentFile` keeps
   `TS_SHADOW=true # note` as the value `true # note`. Check the boot
   line in the service log (below).
3. **Switch it on per account** in Settings → AI safety checks. Start
   with **Monitor only**, look at the activity list, then choose
   **Live**.
4. **Schedule retention daily.** `pg_cron` ships with Supabase's
   Postgres image; enable it once if it isn't already:

   ```sql
   create extension if not exists pg_cron;
   select cron.schedule('ts-purge-answers', '17 3 * * *',
                        $$select public.ts_purge_answers(180)$$);
   ```

   The purge clears the answers, message hash and state hash of rows
   older than N days. It keeps the decision, codes, tokens and latency
   for aggregates. N may not be below 30.

Only the first two variables are needed. The rest are install-wide
overrides that no account can undo from Settings.

| Variable | Default | Notes |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Server-side secret. Without it the layer is unavailable and the panel says so |
| `TS_LOG_HASH_KEY` | — | Required with the key; at least 32 characters (`openssl rand -hex 32`). Keys the hashes of logged state and message ids |
| `TS_ACCOUNT_IDS` | every account | Optional allowlist: a comma-separated list of account ids. Other accounts are never sent to TypeSafe and never logged, whatever their Settings say |
| `TYPESAFE_MODEL` | `jev-1.13.0` | Must be a pinned `jev-X.Y.Z`; aliases and two-part versions are refused |
| `TS_ENABLED_TRIAGE` / `_PASSAGES` / `_GUARDRAIL` / `_ELIGIBILITY` | on with a key | `false` takes a check away from every account. A disabled check makes no request, reads no policy and writes no log row |
| `TS_SHADOW` | `false` | `true` forces monitor-only on every account |
| `TS_SHADOW_TRIAGE` / `_PASSAGES` / `_GUARDRAIL` / `_ELIGIBILITY` | — | Per-check override of `TS_SHADOW` |
| `TS_SHADOW_LANGUAGES` | `ar,mixed,other` | Languages held back for an account that chose **English only** (`none` clears). `other` is any script besides Arabic and Latin |
| `TS_TIMEOUT_MS` / `TS_GUARDRAIL_TIMEOUT_MS` | `2500` / `3000` | Per attempt, one retry; 1–10000 |
| `TS_GUARDRAIL_FAIL_MODE` | `hold` | `hold` or `send`, used in degraded mode |

The SDK's own variables (`TYPESAFE_BASE_URL`, `TYPESAFE_LOG_LEVEL`,
`TYPESAFE_DEFAULT_MODEL`) are **ignored**. The layer pins the endpoint
to `https://api.typesafe.ai`, pins the log level to `warn` (the SDK
logs no request bodies at that level), and pins the model per request.

**An invalid configuration turns the layer off; it does not stop the
bot.** A bad boolean, an unknown language, an unpinned model, or a key
without a hash key all have the same effect:

- triage and the passage filter pass through, and the bot behaves as
  before this module;
- the Settings panel shows the problem, and the server log says why at
  boot and at most once a minute after that.

The guardrail keeps its fail-safe rule even then. An account that has
the guardrail on and **Live** in Settings has its drafts held for a
person, as a normal hand-off, unless the server switched the guardrail
off, forces monitor-only, chose fail mode `send`, has no key at all, or
leaves the account out of `TS_ACCOUNT_IDS`. Every other account behaves
as before.

Check the log after every change:

```bash
journalctl -u wacrm | grep '\[ts013\]' | tail
# at boot, one of:
#   [ts013] TypeSafe decision layer: off (no TYPESAFE_API_KEY on this server)
#   [ts013] TypeSafe decision layer: available for any account (triage, guardrail, passages, eligibility); each account switches it on in Settings → AI safety checks; …
#   [ts013] error CONFIG_INVALID: the TypeSafe layer is OFF until this is fixed …
# and on every change in Settings:
#   [ts013] settings changed for account <id> by <user id>: {...}
```

## Rollout, per account

1. **Monitor.** Switch the layer on in Settings with **Monitor only**.
   Decisions land in `ts_decision_log` and in the panel's activity
   list. A check in monitor mode runs off the reply's path, so
   customers don't wait for it.
2. **Live.** Choose **Live** once the activity list looks right. The
   checks act on the built-in thresholds.
3. **Tune (optional).** Label decisions in `ts_label` (below), use
   `v_ts_label_agreement` and the Phase 3 calibration (below) to choose
   thresholds, insert a `proposed` row into `ts_policy`, and have a
   **different** owner or admin approve it (below). That replaces the
   built-in thresholds for the account.

**English only** keeps Arabic, mixed-language and other-script traffic
logged only until it meets the spec §12 acceptance criteria on this
installation's own data. **All languages** lets the model act on them
too, uncalibrated.

A custom policy needs a **second** owner or admin login, and each
should be a real person. Two logins held by one person satisfy the
database, but not the intent of four-eyes.

**The passage filter has no evaluation set yet.** It is off by
default; turn it on in monitor mode first.

### The Settings panel

Settings → **AI safety checks** is admin-only (the page, the API and
the table's RLS). It shows:

- **Status**: whether the server has the keys, the model, what the
  guardrail does when TypeSafe is unreachable, any install-wide
  override, and per check whether the thresholds are built-in or an
  approved custom version.
- **Controls**, saved as they change: the master switch, **Monitor
  only** or **Live** (Live asks for confirmation), the four checks
  (triage, reply guardrail, knowledge filter, and the watch on
  conversations your team handles), and **English only** or **All
  languages**. It shows who changed them last.
- **Activity**: a summary of the last 7 days, and every decision,
  newest first, with the contact, the outcome, its reason codes and
  whether it acted. The log holds no message text. The summary
  (`ts_activity_summary()`) counts:
  - *acted on*: decisions that changed something
    (`ts_decision_log.intervened`) — a hand-off, an opt-out, a held or
    blocked reply, excerpts removed or set apart — not a Live pass;
  - *handed to a person*: the bot's triage hand-offs, opt-outs
    included; the watch never hands off;
  - *opt-outs*, *replies held*, *replies blocked*, *knowledge excerpts
    removed*, *TypeSafe unavailable*, estimated cost and p95 latency.

Saves are made against the version the admin was looking at: if
another admin saved since, the save is refused and the panel shows the
latest. Making the layer act where it did not (on and **Live**) needs
the confirmation dialog; the API refuses it otherwise.

Changing a switch applies to the next message on this server process
at once, and within 30 seconds on any other.

### Partner banks

The guardrail and the bot only discuss the banks your business works
with. That list is per account: Settings → **AI safety checks → Partner
banks** (admin-only, like the rest of the panel). An account that never
saved one uses the built-in list: Mashreq, RAKBANK, NBF, Wio, Ruya and
UBL.

- **Built-in banks.** Tick the ones you work with. The list shows the
  built-in catalogue; untick a default partner you do not work with.
- **Other banks.** Add a bank the catalogue does not know, with the
  other spellings and abbreviations customers use (comma-separated,
  e.g. `SB, Some Bank LLC`). Each one counts as a partner under all of
  those names.
- **Found in your knowledge base.** Suggests banks your documents
  mention that are not on the list, with how many documents name each.
  _Add_ puts one on the list; nothing is added for you.
- **Reset to default** discards your list and goes back to the
  built-in one.
- Saves are version-checked like the other switches, and apply to the
  next message on this server process at once and within 30 seconds on
  any other.

**What it changes.** The reply guardrail **blocks a draft that names a
bank outside the list**, the same check as before with your list in
place of the fixed one. The hand-off note names the bank and points
here: "the draft named a bank that is not on your partner list (FAB).
Add it in Settings → AI safety checks → Partner banks if you work with
it." The bot's own instructions also list your partners and tell it to
discuss only those, so it avoids naming others in the first place.

**Uploading a bank's documents to the knowledge base does not make it a
partner.** The knowledge base is what the bot may quote; the partner
list is who it may talk about. If you work with a bank, tick or add it
here as well.

Migration 078 adds the column (`ts_account_settings.partner_banks`).
Before it is applied the built-in list applies and saving a list
answers "Partner banks need database migration 078".

### Approving a policy

There is no screen for this yet, so both steps are SQL.

A proposal is an `INSERT` by an owner or admin, as themselves, or by
the operator. `calibrate.ts` generates the SQL for it (see below). A
trigger refuses the proposal unless:

- the proposer named in the row is an owner or admin of that account;
- the thresholds are complete and in range;
- the model is a pinned version.

This holds on the operator's psql path too.

Approval must run **as the approving user**. `ts_approve_policy` reads
`auth.uid()` and refuses:

- the proposer;
- anyone below admin;
- anyone outside the account;
- a proposal whose proposer has since lost the admin role.

From the database host:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '<approving admin user id>', true);
select id, check_name, version, status from ts_policy where status = 'proposed';
select status, approved_by from ts_approve_policy('<policy id>');
commit;
```

Policies are cached for 60 seconds per process, so an approval takes
effect within a minute. Policies cannot be edited or deleted; a new
version replaces the old one.

### Stopping a check

- **One account, at once.** Any admin switches the layer, or one check,
  off in Settings, or goes back to **Monitor only**. The change applies
  on the next message in this process (other processes within 30 s).
  **For the guardrail, off or monitor means screening stops acting for
  that account.**
- **One custom policy.** `ts_retire_policy('<policy id>')`, run the
  same way as the approval above, puts the account back on the
  built-in thresholds within a minute. No second person is needed. It
  is recorded in `retired_by` and `retired_at`.
- **Every account.** Set `TS_ENABLED_<CHECK>=false`, or `TS_SHADOW=true`,
  and restart the service.

### Labelling decisions

Members at agent level or above can label any decision they can see.
Admins see the account's whole log. Anyone else sees decisions about
contacts they can already open (contact RLS applies). A label is a row
in `ts_label` with the decision you believe was right:

```sql
insert into ts_label (account_id, decision_id, correct_decision)
values ('<account id>', '<decision id>', 'rm');
```

`message_id` in the log is a keyed hash of the gateway message id, not
the id itself: a Meta message id embeds the customer's phone number. To
find a message's decisions, hash its `messages.message_id` the same way
(`messageHash` in `lib/typesafe/log.ts`, with `TS_LOG_HASH_KEY`). The
passage filter logs one row per query, with each passage's route inside
`answers`, keyed by knowledge-chunk id.

## Opt-outs

When triage acts on a free-text request to stop messages:

- the bot hands the thread over and sends nothing more;
- the contact is marked opted out: `contacts.opted_out_at` (migration
  076) records when they first asked. A repeat request keeps the
  first time, and the hand-off note says "marked opted-out" only when
  this message is the one that marked them.

A *possible* opt-out (the review band) is handed over without marking
the contact, so a person can decide.

**On threads the bot does not answer** — a person owns the thread, a
flow or an automation consumed the message, the bot is off — the watch
(Settings → *Watch conversations your team handles*, on by default)
runs the same triage after the message is stored and every reply has
gone out. In **Live** it marks a clear opt-out on the contact; it never
hands over, replies or reassigns, because a person or a flow already
owns the thread. It skips a message the bot's own triage judged, and
logs each decision with the reason code `WATCH`. It has its own
budget of 60 messages a minute per account: a burst of campaign replies
beyond that is not triaged, so it cannot draw a TypeSafe rate limit
that would pause the checks on the bot's own replies.

**Broadcasts skip an opted-out contact automatically, twice:**

- **When a broadcast is planned**, no recipient row is created for
  them. The broadcast wizard leaves them out of every audience (all
  contacts, chat tags, custom field, CSV, Compass) and shows how many
  were skipped; through the public API or MCP
  (`POST /api/v1/broadcasts`) they are not counted in `accepted`, and a
  request whose every valid recipient opted out is refused with
  `400 bad_request`.
- **When it is sent.** The wizard's sends, the Resume button and the
  scheduled-broadcast cron all deliver from the recipient rows frozen
  at plan time. A customer who opted out after the campaign was planned
  is left out of the pass and their row is marked failed with the
  reason *Customer opted out of messages*, so the campaign's failed
  count includes them and it still finishes.

The mark does **not** stop other messages:

- **Automations.** They still run.
- **Campaign follow-up flows.** These start before the bot, and so
  before triage, when a customer answers a campaign.
- **People.** An agent can still write to the customer from the inbox.
- **Resuming the bot.** Re-enabling it on the thread clears the pause,
  but not the mark. The app has no control to clear the mark yet.

## Privacy

- **Redaction.** Every string is redacted before it leaves the server:
  - Emirates ID, IBAN, card numbers (Luhn-checked);
  - UAE and international phones, e-mail;
  - passport and document numbers, licence numbers;
  - any remaining run of 9 or more digits.

  Separators including spaces, dots, dashes, slashes and parentheses
  are allowed inside a number. Digits in every script (Arabic-Indic,
  Devanagari, fullwidth…) are normalised first. An amount next to a
  currency word is exempt, but only that one amount: an identifier
  typed beside it is still caught.
- **Last-line guard.** If anything identifier-shaped survives, the
  request is withheld (`TS_PII_BLOCKED`). Each string is checked
  exactly as redaction saw it.
- **Database ids.** Knowledge-chunk ids are never sent; the state
  carries ordinals.
- **What is not redacted:** personal and company names (spec §9.2).
- **The log.** `ts_decision_log` stores keyed hashes of the redacted
  state and of the message id, never text. It also keeps the typed
  answers until the retention purge.
- **Deleting a contact** erases its identifiers from the log (contact,
  conversation, message hash, state hash, answers). The decision row
  stays for aggregates. A decision logged after the deletion, for a reply
  still being drafted, is stored already erased. Erasure costs about
  2–3 s per 30,000 affected log rows. Bulk-deleting contacts that
  between them have well over 100,000 decisions can hit the database's
  8-second statement timeout; delete in smaller batches.
- **Go-live gates** (not build items):
  - **C-1:** a UAE PDPL review of the transfer to TypeSafe AI, Inc. (US)
    and a written transfer basis, per data controller. `TS_ACCOUNT_IDS`
    is how this is limited to the accounts it covers;
  - **C-2:** a review of the partner-bank DSA confidentiality and
    outsourcing clauses;
  - **C-3:** zero data retention, or a written retention period, from
    TypeSafe;
  - a review of TypeSafe's subprocessor list.

## Failure handling

| Condition | Behaviour |
|---|---|
| Timeout, 5xx, 529, connection error | Per-check fallback (guardrail on and live: degraded mode). The SDK retries once, and a hard deadline covers retries. 5 failures in 30 s open that check's circuit for 60 s (per process) |
| 429 | Not retried inside the call. Every check waits out the server's `Retry-After` (capped at 60 s), then resumes |
| 401 / 403 | Every check pauses for 5 minutes, then re-probes; a `TS_AUTH` alert each time |
| 400, 422, a malformed response | Counted **per account**, so one tenant's traffic never pauses another's. Three 422s in a row pause that check for that account for 15 minutes |
| An identifier survived redaction, or the state is oversized | The request is not sent (`PII_BLOCKED` / `STATE_TOO_LARGE`). Free-text fields are clipped (4,000 chars; 1,000 per earlier turn; 2,000 per passage) |
| Policy read error | Retried once, then the last policy this process read is kept. If there is none yet (the first read after a restart failed twice), the built-in thresholds apply and the decision records `POLICY_UNAVAILABLE` |
| Settings read error | Retried once, then the last switches this process read are kept. If there are none yet (the first read after a restart failed twice), the layer is off for that account for 5 s — except the guardrail, which **holds** the draft (`SETTINGS_LOAD`) unless the server itself would never act (guardrail off, forced monitor-only, fail mode `send`, or the account outside `TS_ACCOUNT_IDS`) |
| Active policy with invalid thresholds, or for another model or question set | The built-in thresholds, in every process, with a `POLICY_INVALID` / `POLICY_MISMATCH` alert. SQL validates at approval, so an invalid one takes a hand-edited row |
| Log write error | Alert; the message path is unaffected |

Alerts go to the server log as `[ts013] …`. Each code prints at most
once per five minutes, with a count of repeats. Alerts carry codes,
HTTP statuses and TypeSafe request ids, never text or response bodies.

**Latency.** Checks in monitor mode run beside the reply and add
nothing to it; the dispatcher awaits them afterwards.

An acting check adds its round trip to the reply path:

- triage: one request;
- the passage filter: one request per passage, all in parallel;
- the guardrail: one request.

Each is bounded by a per-call deadline of about 6–7 s.

**The AI playground does not run these checks.** It sends no text to
TypeSafe and writes nothing to the log.

## Route judgment

The AI agent's model-tier router ([ai-agent.md](./ai-agent.md#model-tiers))
asks Jev one question set per inbound message: what kind of message it
is, how complex a good reply is, and whether it needs facts about the
business. It is **not a safety check**:

- it does not appear in Settings → AI safety checks and has no account
  switch;
- it runs whenever the install has `TYPESAFE_API_KEY` and the account is
  allowed (`TS_ACCOUNT_IDS`, if set);
- the question set is `qs-route-v1`; changing its wording means a new
  version;
- it is **never written to `ts_decision_log`**;
- it has **its own circuit breaker**, so a route outage does not pause
  triage or the guardrail;
- it has a hard deadline of 2.5 s and runs in parallel with triage. On
  timeout, error or an open breaker, the router falls back to a simple
  word-count rule. The reply is never delayed or blocked by it.

## Database

Every table is account-scoped, with RLS, and closed to the anon key
from the moment it is created.

- `ts_policy`
  - Owners and admins read and propose.
  - Activation and retirement happen only through `ts_approve_policy`
    and `ts_retire_policy`.
  - A trigger validates every proposal. The database sets
    `proposed_at` itself, and a proposal cannot carry retirement fields.
  - A table CHECK makes self-approval impossible even for the owner.
  - Rows cannot be edited or deleted except by deleting the account.
- `ts_decision_log`: append-only.
  - UPDATE and DELETE are refused by trigger for every role, the owner
    included.
  - The exceptions are the retention purge, a contact's erasure, and
    the cascade when an account is deleted.
  - Only the service role writes rows.
- `ts_label`: labels, bound to a decision in the same account by a
  composite foreign key.
- `v_ts_daily_usage` (decisions, fallbacks, tokens, estimated USD, p95
  latency) and `v_ts_label_agreement`. Both are `security_invoker`, so
  the log's RLS applies through them.
- **TRUNCATE** is blocked on all three tables, even for the owner.
- `ts_account_settings` (migration 064): one row of switches per
  account. Owners and admins read and write their own account's row;
  the database stamps `updated_by` and `updated_at`. The service role
  only reads it. No row means off.

Migration 063 also:

- makes `claim_ai_reply_slot` refuse a thread that was handed off or
  assigned while a reply was being drafted;
- widens `conversations.ai_handoff_reason` with `triage` and
  `guardrail`.

`supabase/ci/verify-typesafe.sql` asserts all of this, 063 and 064, against a real
database in the Migrations workflow. `lib/typesafe/policy.test.ts`
keeps the SQL threshold bounds and the TypeScript ones identical.

## Phase 3 — evaluation and calibration

The scripts are in `scripts/typesafe-eval/`. The two synthetic sets
are labelled by construction:

- triage: 700 messages (300 EN, 300 AR, 100 mixed);
- guardrail: 150 replies (80 safe, 70 dangerous).

Run them on a machine other than the production host where you can.
`tsx` is pinned:

```bash
TSX="npx --yes tsx@4.23.15"
# 1. collect raw answers (resumable; ~1,000 calls)
TYPESAFE_API_KEY=… $TSX scripts/typesafe-eval/run-eval.ts triage    scripts/typesafe-eval/labels_triage.synthetic.jsonl
TYPESAFE_API_KEY=… $TSX scripts/typesafe-eval/run-eval.ts guardrail scripts/typesafe-eval/labels_guardrail.synthetic.jsonl
# 2. sweep thresholds offline with the production routing code
$TSX scripts/typesafe-eval/calibrate.ts \
  --triage    scripts/typesafe-eval/labels_triage.synthetic.jsonl.answers.jsonl \
  --guardrail scripts/typesafe-eval/labels_guardrail.synthetic.jsonl.answers.jsonl \
  --out calibration
# 3. propose (as one admin); a DIFFERENT admin approves — see above
docker cp calibration/proposed_policies.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres -v account=<account id> \
  -v proposer=<proposing admin user id> -f /tmp/proposed_policies.sql
```

`--simulate` on `run-eval` runs the whole pipeline against a seeded
fake model. Its output is labelled SIMULATED, and its SQL is marked
DO NOT APPLY with `shadow=true`.
`docs/typesafe/phase3-simulated-calibration.md` is an example.
`calibration.md` reports a pass or fail per language; failing languages
belong in `TS_SHADOW_LANGUAGES`.

The triage set ends with 21 hand-labelled `v02-*` rows for the v0.2
routing:

- short follow-ups that only make sense against `recent_turns`;
- the catch-all intent;
- two-product messages;
- complaint-ambiguous messages.

`calibrate.ts` sweeps `possibleComplaintMin` for complaint recall
within the to-RM budget.

A label row may carry what production sends:

- **triage:** `recent_turns`, and `journey_stage` (one of
  `open_conversation`, `campaign_reply`, `guided_flow`);
- **guardrail:** `context`, the business's own sources.

**Synthetic data is not enough.** Before any check acts, re-run the
same steps on a redacted live extract and on at least two weeks of
labels from monitor mode. Assembling that extract is manual today:
`ts_decision_log` holds no text, so it means joining labelled decisions
back to their messages. No tool does this yet.

## Differences from the standalone package

The package (`2026-09-27_wacrm_module013_typesafe_package.zip`) was
built for a single-tenant schema. Its reconciliation items resolve as
follows here:

| Item | Resolution |
|---|---|
| R1 inbound hook | `dispatchInboundToAiReply`, already inside the webhook's `after()` and after the escalation-keyword gate |
| R2 retrieval | `retrieveKnowledgeScored` now also returns each chunk's id and similarity (null for lexical hits) |
| R3 pre-send | The same function, between the model and `claim_ai_reply_slot` |
| R4 eligibility | No host step yet; not wired |
| R5 roles / ownership | "admin or supervisor" becomes account owner or admin; "the RM who owns the contact" becomes contact RLS; the two adapter functions are gone |
| R6 Node ≥ 20 | Node 22 |

Other differences:

- **Database access.** The layer uses the service-role Supabase client
  (`store.ts`) instead of a `pg` pool, so there is no
  `SERVICE_ROLE_DB_URL`.
- **Migration number.** The package's migration 013 is **063** here.
- **Question set.** It is `qs-013-v0.2`, revised after a production
  review:
  - a catch-all intent;
  - questions that read `recent_turns`;
  - a non-partner-bank question about a request rather than a mention;
  - guardrail Nouls with one condition each;
  - figure matching left to code;
  - the licence captured as a Choice.
- **Hand-offs.** The package's "RM task", "consent register" and
  holding template become this app's hand-off (reason, note, the
  account's hand-off message) and the contact's opt-out mark
  (`contacts.opted_out_at`).
- **Package tests.** Its vitest cases run colocated in
  `src/lib/typesafe/` against the real SDK and a simulated API. Its
  Postgres cases became `supabase/ci/verify-typesafe.sql`.
