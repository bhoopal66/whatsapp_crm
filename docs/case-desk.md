# Case desk

The case desk (migration 220, `/desk`) is where staff hand documents and
information for bank cases to the coordinators. Every upload is one
**intake item**. An upload whose details are complete is filed at once;
anything else waits in a **sorting queue** for a person. It is a port of
the outside package's release 035 (modules 035a, 035b and 035c), fitted
to this repo's cases.

## Numbers

- A company is identified by its **trade licence number** (stored
  upper-case with spaces and dashes removed). One company request is an
  **application**, numbered `TC-YY-NNNNN` from one counter per workspace
  that never restarts by year (`YY` is the opening year in Dubai, for
  display only). Numbers are gapless: a refused open does not use one.
- Each bank in an application is its own case, numbered
  `TC-YY-NNNNN-BBB`, where `BBB` is the bank's three-letter **desk code**
  (Case desk → Desk codes, owners and admins). A second case of the same
  application at the same bank is `BBB2`, up to `BBB9`. A bank keeps its
  desk code once it has numbered cases.
- The **caption code** is the short form staff write: the application
  number without leading zeros, the bank part, and one check character,
  e.g. `1RAK1`. Any single mistyped character is refused (the check is a
  Luhn mod 36 over `NNNNN` + bank part), so a typo never files a
  document to another case.
- Cases opened before 220, or outside the desk, have no number; upload to
  them through the case page as before.

## What a desk case is

A desk case is an ordinary **lead** (migration 130): it opens at
*Interested* in the uploader's name, for a CRM **contact**, with lead
source `desk`. It needs a contact because every case file lives in that
contact's customer folder (178–181). The rest of the case tools work on
it unchanged, and a later submission from Compass attaches to it as to
any lead. One open lead per contact and bank still holds: a contact who
already has an open lead at that bank for another company or product
gets `CASE_CONFLICT`.

## Uploading

Any live staff member (agent and up) uploads. An upload says what it is:

| Kind | Needs | Files to |
|---|---|---|
| Pending document | a case number or caption code, a file | that open case |
| Information | a case number or caption code | that open case |
| New case | bank, company legal name, trade licence, product, customer contact | the company's case at that bank (opened, or joined) |

- A **caption** is optional shorthand and fills only the fields left
  empty: `4271RAKD ejari`, `INFO 4271RAKD customer travelling`,
  `NEW RAK Kite Trading 1234567` (`RAK` is the desk code).
- Files: PDF, JPEG or PNG, up to 10 MB; the bytes must match the type.
  They are stored in the private `case-files` bucket at
  `intake/<item id>/<sha256>.<ext>` and, once filed, recorded as the
  uploader's staff upload in the contact's folder, so the NAS worker
  copies them like any other case file. They land **unclassified**; the
  case team classifies them on the case page.
- Anyone holding a valid case number or caption code may upload to that
  case, even if it is not theirs: the code is the proof, and the file
  lands unclassified for the case team to review.
- A new case joins an existing one only under the company's own legal
  name (case and spacing ignored). The licence on file under another
  name waits as `CASE_EXISTS_NAME_MISMATCH`.
- The same bytes filed twice to one case become a **duplicate** of the
  first upload; no second file is registered.
- Each upload carries an idempotency key; resending it returns the first
  result.

## Waiting and sorting

An upload that cannot file waits, oldest first, in the queue of its bank
(the bank given, or the case's bank), or in the **no-bank queue**, with a
reason: `NO_KIND`, `NO_CASE`, `NO_CONTACT`, `NO_FILE`, `CASE_NOT_FOUND`,
`BANK_MISMATCH`, `CASE_EXISTS_NAME_MISMATCH`, or the refusal that
stopped it.

- **Who sorts.** Owners, admins and team leaders sort every queue,
  including the no-bank queue. A coordinator — a live agent or team
  leader holding a bank in Settings → Coordinators (133) — sorts that
  bank's queue only. There is no separate desk roster: the bank holders
  are the desk, and 161 already lets them read and work that bank's
  cases.
- **Sorting** files the upload to an open case of a bank the sorter
  sorts and that they may work (a bank holder is its coordinator by 161;
  a team leader works only their team's cases, so filing into another
  team's case, or looking it up, answers as not found). No case is
  pre-selected: the screen shows the case's number, bank and company
  first, and a company-name mismatch needs a typed confirmation.
  Sorting can also open the company's case (in the uploader's name; a
  sorter holding the bank is named its coordinator), or reject the
  upload with a reason the uploader sees.
- **Retag.** Only the uploader may correct the details of their own
  waiting upload; it is routed again.
- **My uploads** shows each upload's fate.
- **Overview** (team leaders and up): per bank, how many hold it, how
  many uploads wait and the oldest's age, with an alert:
  `no_coordinator` (nobody holds the bank) › `lead` (over 4 hours) ›
  `second` (over 2 hours) › `none`. The two thresholds are the package's
  and await the owner's confirmation.

## Company contacts

Migration 229 (design 035 D1). A company is not a phone number: the
**Companies** tab lists who acts for each company, with a role
(owner, PRO, accountant, other) and an **authorised** flag.

- **Many to many.** One PRO's phone may act for several companies, and a
  company has several people. A CRM contact is one phone per workspace,
  so linking a contact links its phone.
- **Automatic link.** Opening a desk case links the case's contact to
  the company (role *other*, not authorised, shown as *From a case*).
  Existing desk cases were linked once when 229 was applied. The link
  never fails a case write.
- **A fact, never a grant.** A link opens no case, chat or contact to
  anyone. WhatsApp routing (a later slice) reads it and never files a
  document by phone alone: a phone that acts for more than one company
  goes to a person.
- **Who.** Anyone who can read one of the company's cases sees its
  people; anyone who can write one (its agent, the bank's coordinator)
  and team leaders and up change them. Only contacts you can see can be
  linked. Someone with no case of the company gets *Company not found*,
  as for an unknown one.
- **Privacy.** The links are in a customer's PDPL export and are kept on
  erasure (KYC: who acted for a company account); the contact itself is
  anonymised as before.

## One document, several banks

Migration 231 (design 035 D5, D11, D13). Under Companies, **Banks and
documents** shows a company across its banks.

- **Every case, stage only.** Anyone who can read one of the company's
  cases sees all of them with their stage, never another bank's files,
  notes or reasons.
- **Stored once, linked per bank.** A file of a case you can open can be
  linked into another open case of the same company that you can change.
  Nothing is copied: the other case gets its own row with its own
  status, so a rejection at one bank never touches another.
- **Consent per bank.** Linking into another bank's case needs the
  company's consent for that bank, recorded with its evidence (for
  example "WhatsApp reply 21 Nov: yes") and revoked with a reason. The
  history is kept; nothing is deleted. Whether a WhatsApp reply is
  enough evidence is for legal sign-off (design section 8).
- **The database refuses a cross-customer file** on every insert, by
  any writer: a case file must be the case customer's document or, for a
  desk case, a document of a person who acts for the same company.

## WhatsApp routing and the tray

Migration 230 (design 035 section 4). **Off by default:** an owner or
admin switches it on under Case desk → Desk codes → WhatsApp routing.

When a customer sends a document 1:1, it is first kept in their document
archive as before. Then the desk decides, and **never by phone number
alone**:

| Evidence | Effect |
|---|---|
| E1: the customer replied to one of our messages that names a case number | file to that case |
| E2: the caption carries a case number or caption code (check character verified) | file to that case |
| E4: the sender acts for one company, which has exactly one open case | file to that case |
| E1 and E2 name different cases, several codes, several companies or several open cases without E1/E2 | tray, every open case listed, none chosen |
| the chosen case belongs to another person (a PRO sending for the owner) | tray: a person files it |
| the sender acts for no company | ignored, unless it arrived on a **desk number**: tray |

- An automatic filing is the system intake (`registered_by` empty), the
  file then waiting *unclassified* on the case like any other.
- **Staff on WhatsApp.** A document from a staff member's saved WhatsApp
  number (Settings → Members, the coordinator number) becomes a desk
  upload in their name, tagged from its caption exactly like the upload
  form's caption field (`4271RAKD ejari`, `NEW RAK Kite General Trading
  12345`); what the caption does not settle waits in the sorting queue.
  It shows under *My uploads* as arriving by WhatsApp.
- **The tray** (Case desk → Tray) shows the sender, the companies they
  act for, why the document is there, the document, and the candidate
  cases with their reasons (*quoted*, *case code*, *asked for a
  document*, *sender's own case*). Nothing is pre-selected. Team leaders
  and up see every item; a bank's holders the items with a candidate at
  their bank. Filing to a company the sender does not act for needs its
  legal name typed. Another person's document is copied through the
  desk intake in the sorter's name. Dismissing needs a reason; the
  document stays in the customer's archive.
- **Duty owner and escalation.** A team leader puts someone on duty;
  new tray items carry them. An item still open after the delay
  (default 120 minutes, 15–1440) becomes one follow-up task for the duty
  owner (else the workspace owner), from the automations cron. The task
  names no customer.
- Not built yet: E5 (a case that asked for a document in the last 72
  hours) is not a candidate reason; nothing is sent back to the staff
  member who uploaded by WhatsApp (they see it under *My uploads*).

## Rules held in the database

- Tables (`desk_bank_codes`, `desk_customers`, `desk_number_seq`,
  `desk_applications`, `intake_items`, `intake_item_events`) force RLS
  with no policy and no grants. Every access is a SECURITY DEFINER
  function granted to the service role only; the API routes call them
  with the caller's id and **active** workspace.
- An item's state changes only through `intake_set_state`, which appends
  one `intake_item_events` row each time; the event log is append-only.
- `supabase/ci/verify-case-desk.sql` asserts the numbering vectors (the
  same as `src/lib/desk/case-number.test.ts`), gapless numbering, the
  routing rules, duplicates, scope and the closed tables.
- `desk_customer_contacts` (229) is closed the same way; links change
  only through `desk_customer_contact_set` / `_remove`.
  `supabase/ci/verify-desk-customer-contacts.sql` asserts the automatic
  link, who may read and change, one phone across two companies, the
  privacy export and the closed tables.
- `desk_tray` and `desk_settings` (230) are closed the same way; the
  tray changes only through `desk_tray_file` / `_resolve` / `_dismiss`
  and the router. `supabase/ci/verify-desk-whatsapp-routing.sql` asserts
  the evidence order, the tray rules, escalation, privacy and the closed
  tables.
- `desk_doc_consents` (231) is closed the same way and append-only (a
  row is only revoked, once). `case_document_files_same_customer` guards
  every insert into `case_document_files`.
  `supabase/ci/verify-desk-shared-documents.sql` asserts the refusals,
  consent, per-case status, stage-only visibility and the register.

## API

All under `/api/desk`, session-authenticated, sales departments only.
Refusals answer `{ error, code }`.

| Route | Who | Does |
|---|---|---|
| `POST /intake` (multipart) | staff | upload |
| `GET /intake` | staff | my uploads |
| `POST /intake/[id]/retag` | the uploader | correct a waiting upload |
| `GET /queue[?bank=]` | sorters | the sorting queue |
| `GET /lookup?ref=` | sorters | confirm a case before filing |
| `POST /intake/[id]/file` | sorters | file to a case |
| `POST /intake/[id]/new-case` | sorters | open the company's case |
| `POST /intake/[id]/reject` | sorters | reject with a reason |
| `GET /overview` | team leaders and up | queue overview |
| `GET /banks`, `PUT /banks/[code]` | staff / owners and admins | desk codes |
| `GET /companies?q=` | staff | find a company you can see (licence or name) |
| `GET /companies/[id]/contacts` | readers of a company's case, team leaders and up | its people |
| `PUT`, `DELETE /companies/[id]/contacts/[contactId]` | writers of a company's case, team leaders and up | link (`{ role, authorised }`) or unlink |
| `GET /companies/[id]/overview` | readers of a company's case, team leaders and up | cases (stage only), your files, consents |
| `PUT`, `DELETE /companies/[id]/consents/[bank]` | writers of a company's case, team leaders and up | record (`{ evidence }`) or revoke (`{ reason }`) |
| `POST /files/[fileId]/link` | readers of the file's case who can write the target | `{ caseId }` |
| `GET /tray[?state=]` | team leaders and up, a candidate bank's holders | the tray |
| `POST /tray/[id]/file` | the same | `{ caseId, confirmCompany? }` |
| `POST /tray/[id]/dismiss` | the same | `{ reason }` |
| `GET /settings`, `PUT /settings` | staff / owners and admins | routing switch, desk numbers, escalation delay |
| `PUT /duty` | team leaders and up | `{ userId }` or `null` |

## Not built (known gaps)

- A refused or replayed upload with a file leaves its stored object
  behind (`intake/<item id>/…`, unreferenced).
- No function closes an application or merges two companies
  (`desk_customers.merged_into` is reserved).
- Not ported from the package: its `bank_desks` roster and 035d's desk
  visibility (the repo's bank holders, 133/161, already do both) and
  035e's judge shadow (the repo's Jev judgments cover it).
