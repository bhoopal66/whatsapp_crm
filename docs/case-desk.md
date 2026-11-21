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

## Not built (known gaps)

- WhatsApp media is not wired to the desk: the caption parser is ready,
  but uploads come only from the screen.
- A refused or replayed upload with a file leaves its stored object
  behind (`intake/<item id>/…`, unreferenced).
- No function closes an application or merges two companies
  (`desk_customers.merged_into` is reserved).
- Not ported from the package: its `bank_desks` roster and 035d's desk
  visibility (the repo's bank holders, 133/161, already do both) and
  035e's judge shadow (the repo's Jev judgments cover it).
