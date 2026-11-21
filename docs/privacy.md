# Privacy (UAE PDPL)

Migrations 221-224 and Settings → Privacy (owners and admins) cover what
the UAE Personal Data Protection Law (Federal Decree-Law 45/2021) asks of
a system holding customer data: knowing where it is, handing a customer
their data, erasing it, not keeping it longer than needed, and recording
the basis for sending it abroad. Port of the outside package's 033h-k,
fitted to this schema.

**Counsel must confirm** the legal points flagged below before you rely
on them: response timeframes, retention periods, which records KYC/AML
law requires you to keep, and the basis for each AI provider.

## The data map

`src/lib/privacy/data-map.ts` lists every table the migrations create,
as either personal (it holds data about a customer) or not. For each
personal table it records how a customer's rows are found, the kind of
data, what erase does (delete, blank or keep, with the reason) and
whether the export includes it. A test fails when a migration adds a
table that is in neither list, so the map cannot silently go stale.

Tables added from migration 229 on join the export and the erase by
registering their own functions in `privacy_extensions`: the export and
the erase call every registered one (inside the same transaction, so a
dry run rolls them back too). Only the migration owner writes that
registry. The same test checks the registered functions name every
table the map says they cover.

## A customer's request

Settings → Privacy → A customer's request. Pick the customer, then:

- **Export their data.** One JSON file with everything held about them:
  the contact, chats and messages, notes, tasks, deals, calls, documents
  (names and dates, not the files), cases, groups, memory, vault entries
  (by kind; values stay encrypted). Staff identities, storage locations
  and internal ids are left out. Each export is logged.
- **Legal hold.** With a reason. While a hold is on, erase and the
  retention sweep leave the customer alone. A call recording's own hold
  (Settings → Consent and retention) blocks erase too.
- **Erase.** Always previewed first: the preview runs the real erase and
  rolls it back, so its counts are exact and nothing changes. Erasing
  needs `ERASE <contact id>` typed exactly.

What erase does:

- **Deleted or blanked:** chats and messages (with their translations,
  events and AI records), notes, tags, custom fields, tasks, flow and
  journey runs, call notes and recordings, documents not filed to a case,
  deal-room and WhatsApp-group messages they sent, HR chat records and
  drafts, the texts of HR automated messages, CRM memory, second-brain
  items, vault entries, Compass and sales-app copies of their details.
- **Kept, by your decision (KYC/AML):** bank cases and everything filed
  to them (stage history, notes, documents, files, tasks), the case's
  WhatsApp group and its messages, desk uploads and company records.
- **Kept as records:** consent and opt-out history, audit trails, the
  legal hold itself.
- **The contact** stays as "Erased customer" with no name, email or phone,
  so the kept records keep their reference and their opt-out still holds.
- **Stored files** are deleted after the database commit. Any that fail
  are recorded and listed on the screen for a retry.

Not erased by this request, and to handle outside the app:

- **Backups.** Database backups keep erased data until they age out. Do
  not restore an erased customer into production.
- **The NAS.** The customer-documents worker's copies on the NAS
  (docs/customer-documents.md) are not deleted. Remove the customer's
  folder (`TC-…`) there by hand.
- **Providers.** Messages already delivered on WhatsApp, and data held by
  the gateway, Meta or an AI provider, are outside this system.

Every request (export, preview, erase, hold placed or released) is one
row in `privacy_requests`. The row holds who made it, when, and counts.
The customer is identified only by a hash of the workspace and contact
id, never the id itself.

## Retention

Settings → Privacy → Retention. Turn on a kind of data, give it a number
of days (30 at least) and choose delete or blank. The automations cron
sweeps once a day:

| Kind | Delete | Blank |
|---|---|---|
| Deal room messages | yes | yes |
| WhatsApp group messages | yes | yes |
| HR automated message texts (sent, failed or cancelled) | | yes |
| Decided HR AI drafts | yes | |
| Call records (numbers and notes; only once the recording is gone) | | yes |

- **Preview until applied.** Until you switch **Apply** on, the sweep
  only counts what it would remove and logs that.
- **Legal holds.** A customer under a legal hold is skipped.
- **What can never be swept.** Bank cases, case files, the case's
  WhatsApp group, consent and audit tables are not on the list and
  cannot be added by a setting.
- **Call recordings** have their own retention (Settings → Consent and
  retention).

## Sending customer text to AI providers

These features send customer text to providers outside the UAE:

- the AI reply bot, drafts and translation (OpenAI or Anthropic, your key);
- HR AI drafts;
- semantic search of the knowledge base (OpenAI embeddings);
- the safety checks and insights (Jev / TypeSafe, US).

Settings → Privacy → Sending customer text to AI providers:

- **Record the legal basis:** consent, a contract with the provider, an
  adequacy decision, standard contractual clauses, or other, with
  details, who approved it and the providers' region.
- **Every call is logged** before it goes: destination, purpose, model
  and size. Never the text, never an id.
- **Require a recorded basis** is off by default. Switched on, every AI
  feature of the workspace is refused until the basis is complete. The
  bot hands the chat to a person, drafts and translation show an error,
  and the safety checks act as if unavailable (so the guardrail holds
  drafts rather than sending them unchecked).
- **If the check itself cannot run** (the database is down, or 224 is
  not applied), the call goes ahead and the failure is logged.

## Rules held in the database

- All the privacy tables force RLS with no grants. Every function is
  SECURITY DEFINER, service role only, and is called by the API with the
  caller's id and **active** workspace. Owners and admins only.
- `privacy_requests` and `ai_transfer_log` are append-only.
- `supabase/ci/verify-privacy.sql` asserts the export, erase, legal hold,
  retention and AI register rules.

## API

All under `/api/privacy`, owners and admins, every answer `no-store`.

| Route | Does |
|---|---|
| `POST /export` `{ contactId }` | the customer's data, as a download |
| `POST /erase` `{ contactId, dryRun, confirm }` | preview or erase |
| `GET/POST /legal-hold` | read, place (with a reason) or release a hold |
| `GET/PUT /retention` | the retention policy and Apply |
| `GET/PUT /ai-transfer` | the AI transfer basis and Require |
