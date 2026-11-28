# Second brain

The second brain is a searchable store of what staff write about cases and
partner banks: case notes, replies sent to the customer from a case,
customer text in a case's submission group, stage changes, and bank
workspace pins and discussion posts. On top of it sit three screens:
**Second brain** (search, and "Remember this"), **Daily digest** (a
personal to-do list), and a **Brain** tab on every case (an AI-generated
summary of the case with its sources).

It is ported from module 022 of the outside wacrm package (022a–022e).
Migrations 194 (store), 195 (summary pages) and 196 (digest).

## Switching it on

It is **off** for every workspace until an owner or admin turns it on in
**Settings → Cases → Second brain**. While it is off nothing is stored
(the database refuses too, not only the app), the routes answer 403
`brain_disabled`, and the sidebar rows are hidden.

Turning it on does not import history: only what is written from then on
is stored. Turning it off again stops new writes; what was stored stays
until it is forgotten (below).

## What is stored, and what is not

- Text is **redacted before it is stored**: phone numbers, emails, IBANs,
  Emirates IDs, card numbers and similar (the CRM memory redactor), and
  then any run of 9 or more digits, in any script (Arabic-Indic and
  full-width digits included), becomes `[ID]`. The database refuses any
  text that still holds such a run (`TEXT_UNREDACTED`), as a second line.
- Text is split into chunks of at most 800 characters.
- **Not stored:** vault items, documents and files, media, voice notes,
  the take-over hand-over text.
- **Opted-out customers are left out.** A contact with an opt-out
  (`opted_out_at`), a do-not-contact stamp, or a brain mark (opt-out or
  deletion, set with POST `/api/brain/contact-mark`) is never stored and
  never returned; marking also wipes the summaries built from their text.
- **Deleting a contact erases** their stored text and summaries.

Search uses keyword matching plus a local word-hashing "embedding"
(`hashing-v1-256`). It matches shared words, not meaning. Nothing is sent
to an outside AI service. A real embedding model is a later switch.

## Who sees what

The brain never shows more than the case screens do.

- An item about a case is visible to whoever can read that case
  (`case_can_read`: owner, admin, the team leader of the case's agent, the
  case's coordinator or a bank coordinator of its bank, the case's agent).
- An item with no case (a bank pin or post, a "Remember this" without a
  case) is visible to owners, admins and the person who wrote it.
- Viewers, bank guests, deactivated people and people of another workspace
  see nothing. People in a restricted department (192) cannot open
  `/brain` or `/digest`.
- Every search is logged with a hash of the query, the person and the
  number of results. The query text itself is never stored.

## Search and "Remember this" (`/brain`)

Agents and up. Type 2–300 characters; at most 20 results, and 60 searches a minute per person. A result shows the redacted
snippet, what kind of source it is, an **AI-generated** label where it
applies, and a link to its case. **Remember this** stores a short note
(up to 4000 characters, redacted) against a case you can read, or against
nobody (then only you and the admins see it).

## In the inbox Assistant

The inbox Assistant can search the second brain and offer to save a note
to it (`brain_search`, `brain_remember`; `docs/assistant-safety.md`).
Both appear only while the second brain is switched on for the account,
for staff who can use `/brain`, and when the AI transfer check allows it.
A search sees only what the person could find on `/brain` and counts
against the same per-minute limit. A note is saved only after the person
confirms the card, redacted exactly as "Remember this" is. CRM memory is
not given to the Assistant.

## Case summaries (Brain tab)

Each case, contact and bank has a summary page built from its stored
items. The summary is **extractive**: the last stage change, open tasks
mentioned, the last three messages, up to five bank pins, each line
citing its source item. It does not paraphrase, carries no dates, and
cannot tell a customer's message from a staff one. It is labelled
"AI-generated summary — verify against the case"; the case itself stays
the record.

A summary is marked out of date whenever a new item arrives. It is
rebuilt only when an owner or admin presses **Rebuild summaries** on a
case's Brain tab (up to 20 at a time, oldest first); there is no
scheduler. A summary is shown only if every item it was built from is
still live and visible to you; otherwise the tab says "No summary yet".

## Daily digest (`/digest`)

A list for the person who opens it. Nothing is sent to anyone.

- **Stale cases:** your open, not-snoozed cases with no activity for more
  than 3 days, stalest first.
- **Promises:** a message staff sent in the last 14 days that promises
  something ("I will send", "by tomorrow", "within 2 days", and a few
  Arabic phrases) on a case that is still open, with no later staff
  message on that case.
- **Related:** for each of those cases, up to two closed cases of the same
  customer, then the same bank, showing only their outcome and date.
- **Follow-ups:** your case tasks due by the end of today (Asia/Dubai),
  overdue ones included.

At most 10 items per section. Owners and admins can **View as** a
teammate: the list is built as that teammate, so it holds exactly what
they can see.

## Forgetting

Owners and admins can forget one item, everything about a contact, or
everything older than a date (POST `/api/brain/forget`, with a reason).
Forgetting blanks the text, deletes its vectors and wipes every summary
built from it; the row stays as an erasure record (ids, dates, a hash of
the text). The same chunk is not stored again later.

## Ingestion is best-effort

Storing happens after the note, reply or post has been saved, in the
background of the same request. A failure there never fails the
original action; it is logged (without the text) and counted.

## API (internal)

| Route | Who |
|---|---|
| POST `/api/brain/search` `{ query, caseId?, contactId?, bankCode?, limit? }` | agents and up |
| POST `/api/brain/remember` `{ text, caseId?, contactId? }` | agents and up |
| POST `/api/brain/forget` `{ itemId \| contactId \| olderThan, reason }` | owner, admin |
| POST `/api/brain/contact-mark` `{ contactId, kind: opt_out \| deletion }` | agents and up, contact visible to them |
| GET `/api/brain/pages/{case\|contact\|bank}/{key}` | anyone with sales access; 404 when missing or not visible |
| POST `/api/brain/pages/rebuild` `{ limit? }` | owner, admin |
| GET `/api/brain/digest[?userId=]` | own digest; `userId` owner/admin only |

Read paths (search, summary pages, the digest) check visibility once per
case, not once per item: on a 20,000-item test account a search takes
about 0.4 s and a digest query about 0.4 s.

The SQL behaviour is asserted by `supabase/ci/verify-second-brain.sql`
and `supabase/ci/verify-brain-pages.sql`.
