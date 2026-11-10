# Cases

A **case** is the CRM's record of one submitted application: which bank,
which product, how much, where it stands, and the work around it. There is
one case per [submission group](submission-groups.md), so one per case of
the external submission application. This is the operator contract for
module 018c (migrations 122-128, `lib/cases/*`). Staff work cases at
`/cases` (the inbox) and `/cases/[id]`, and banks at `/banks`.

## Opening a case

- `POST /api/v1/submission-groups` opens the group's case, on a new call
  and on a repeat one, so re-posting a submission opens a case for a group
  made before migration 122. The answer carries it as `case` (see
  [public-api.md](public-api.md)).
- An owner or admin can open the case of an older group with
  `POST /api/cases` `{ group_id, bank?, product?, amount? }`.

Bank, product and amount (AED) are optional at open; staff fill them in
later on the case page. A repeat open fills only the fields still empty and
never overwrites one. A bank code the workspace does not know yet is added
to its bank list (named after the built-in bank name when the code is a
known one, else the code; admins can rename it). The case's agent is the
group's open **Agent** entry and its coordinator the open **Coordinator**
entry (none if the group has none); a group with no agent cannot open a
case. Customer, submission id and number are read from the group, never
copied. The customer shown is the name the submission tracker sent as
`customer.name` (kept on the group since migration 141), else the CRM
contact's name; the contact itself is never renamed.

Every change of bank, product, amount, priority or due date is kept in an
append-only log. Changing the bank is refused when the case's current stage
is not in the new bank's stage list.

## Who sees and does what

Roles are worked out live from the person's profile and teams, never stored
on the case. There is no IT role.

| Person (live, in the case's workspace)                  | Reads       | Acts | Reassigns                                                           |
| ------------------------------------------------------- | ----------- | ---- | ------------------------------------------------------------------- |
| **Owner** (super admin)                                 | every case  | yes  | yes                                                                 |
| **Admin**                                               | every case  | yes  | yes                                                                 |
| **Team leader** of the team the case's agent is in      | those cases | yes  | yes: the agent only to someone in a team they lead; any coordinator |
| the case's named **coordinator** (agent or team leader) | that case   | yes  | no                                                                  |
| a **coordinator of the case's bank** (Settings → Members) | that bank's cases | yes | no                                                              |
| the case's named **agent** (agent or team leader)       | that case   | yes  | no                                                                  |
| viewers, bank guests, deactivated people, anyone else   | nothing     | no   | no                                                                  |

"Acts" covers stage moves, details, tasks, documents, notes, the bank
contact log, SLA events and replies. The new agent or coordinator must be
live staff (agent and up) of the workspace. Reassigning moves the active
submission group's access with the case (migration 173): the new person
gets the agent or coordinator row and the old one loses it, unless they
hold another label there. An ended group's list does not change.

**Read audit.** Every time a coordinator, team leader, admin or owner opens
a case's conversation, a row is written to the case's view audit first; an
agent's own reads are not audited. Only owners and admins read that audit
(`GET /api/cases/[id]/audit`).

A case route acts only on cases of the caller's active workspace.

## Stages

The default list, used by a case with no bank and by a bank with no list of
its own:

Interested, Data collection, Review, Submitted, Bank acknowledged,
Documents requested, Documents received, Under review, Query raised, Query
answered, Approved, Declined, Withdrawn, Closed.

The first three are the pre-submission stages of a lead (see Leads below).
Every bank list starts with exactly those three, in that order, and may not
use their names again later (`PRESUB_STAGES_REQUIRED`; the settings screen
warns before Save).

An admin can give a bank its own list in **Settings -> Cases**
(`PUT /api/cases/config/banks/[code]/stages`; an empty list goes back to the
default). A list is refused unless:

- its first stage is not a final stage;
- the four final stages are in it, spelled exactly **Approved**,
  **Declined**, **Withdrawn**, **Closed**;
- it drops no stage an open case of that bank is at (`STAGE_IN_USE`).

A new case starts at the first stage of its list. A move to a stage that is
not in the case's list is refused.

**Outcomes.** Approved, Declined and Withdrawn are outcomes, set by the move
to that stage. From one of them a case can only move to Closed, which keeps
the outcome. Closed is terminal.

**Decline / withdraw reason.** A Declined or Withdrawn case can be given
one reason, once (also after Closed): `INCOMPLETE_DOCS`, `CREDIT_POLICY`,
`INCOME_INSUFFICIENT`, `KYC_AML`, `CUSTOMER_WITHDREW` or `OTHER`, with
optional text up to 500 characters.

**Ending the WhatsApp group.** The first move of a case to a final stage
ends its submission group, exactly once: that move takes a claim, and only
the call holding it ends the group. The move dialog then says one of:

- "The WhatsApp group was ended."
- "Ending the WhatsApp group is pending; it will be retried."
- "The WhatsApp group could not be closed. It will be retried; check the
  group page."

A failed end gives the claim back; the cron retries every final-stage case
whose group end has not completed (a claim older than 15 minutes counts as
free).

**Status from the submission app.** A `PATCH` with a final status
(`APPROVED`, `DECLINED`, `WITHDRAWN`, `CLOSED`, and since migration 166
Compass's `Customer Withdrawn` and `Agency Withdrawn`, which close as
Withdrawn; case, spaces and `_` ignored) moves a case that is not yet
final to Approved, Declined, Withdrawn or Closed, also when the group had
already ended. A case already at a final stage is left alone. Since
migration 137 any other status moves an open case to the stage of the
bank's list with the same name, reading `_` as a space and ignoring case
(`UNDER_REVIEW` -> Under review, `DOCUMENTS_REQUESTED` -> Documents
requested), as the API (history actor NULL, role `api`). It never moves
into a pre-submission or final stage this way, nor out of a final one; a
status that names no stage changes nothing. A `stage` sent in the same
`PATCH` wins over a non-final status.

**Status mapping (migration 151).** Before the name rule, the account's
status map is consulted: owners and admins map a Compass status name to a
stage in Settings → Cases → Compass status mapping, optionally from a Jev
suggestion. A mapping also overrides an exact-name match: a mapped status
goes to its mapped stage even where a stage of the same name exists. A
mapped stage is used when it is in the case's bank list (the same rules as
above: never a pre-submission or final stage, never out of a final one);
otherwise the name rule applies. Final statuses cannot be mapped. A new
mapping acts on the next update; **Move N open cases now** re-applies it to
open cases already holding the status through the same path, **forward
only**: a case moves only when the resolved stage comes later in its bank
list than its current stage, because the stored status may be older than a
person's later move. A case already at or past that stage is left alone. A
Compass update itself is not forward-only: a fresh status is authoritative.
See `docs/jev-insights.md`.

## Leads

A **lead** is a case with no WhatsApp group yet: a customer who is interested
in a bank product before anything is submitted (migration 130). It starts at
**Interested** and moves through **Data collection** and **Review**.

- **Nobody opens one in the CRM.** Cases come only from the submission
  tracker (Compass). The Cases page, the customer page and its menu have
  no New lead / Open lead action, and `POST /api/cases/leads` does not
  exist (405). 130's `case_open_lead` stays in SQL with no caller, so leads
  opened earlier keep working as described below.
- **Attach on submission.** When the submission app later submits the same
  contact and bank, its new group attaches to the open lead: one case from
  lead to outcome, moved to the bank's first submission stage (**Submitted**
  by default). A submission with no lead starts a case at that stage.
- **Stage rules.** A lead cannot jump to a submitted stage without a
  submission (`SUBMISSION_REQUIRED`), and a submitted case cannot go back to
  a pre-submission stage (`PRESUB_REENTRY`).
- **Cold lead.** A lead that goes nowhere is moved to **Withdrawn** with the
  outcome reason **No response** (`NO_RESPONSE`, valid only on Withdrawn).
- **No group, so no chat.** There is no reply, take-over or document
  request until a submission creates the group (422 `NO_GROUP`); reading a
  lead's conversation answers an empty one (`groupId: null`). Ending a lead
  never ends a group.
- **Listing.** `GET /api/cases/leads?contactId=` returns the contact's cases
  the caller may read.
- **Where staff see them.** The customer page (`/contacts/<id>`) has a
  read-only **Cases** card, shown to agents and up: the customer's cases
  with stage, bank, product, amount and a **Lead** chip. The Cases inbox
  marks leads with the same chip.
- **What the case page shows.** A "Lead - no submission yet" banner (with
  the lead source); the Conversation tab, take-over and documents request
  stay disabled until the submission arrives, and a stage move offers only
  the moves a lead can make.

Two defaults are waiting for the owner to confirm:

1. On the bank dashboard an amount that is empty or 0 counts as **account
   opening**, and an amount above 0 as **financing**.
2. A cold lead is recorded as Withdrawn + NO_RESPONSE rather than a stage
   of its own.

## Working a case

**Tasks.** Created from the bank's task templates (Settings -> Cases); a
case with no bank has none. The owner defaults to the case's agent and must
be someone who may act on the case. The due date is the one given, else now
plus the template's hours. Status is open, done or blocked, every change
logged. A task not done whose due date has passed is **overdue** (worked
out, never stored).

**Documents.** The required list comes from the bank and the product
(Settings -> Cases; the product matched case-insensitively). A case with no
bank or no product requires nothing. Each document is requested, received
or rejected; received needs a **file reference** (an id of a stored file,
1-128 of `A-Za-z0-9._:-`), not the file itself. Missing = not received.

**Request missing documents** sends one message listing the missing
documents into the case's WhatsApp group, from your own name, through the
group's normal send path. It needs you on the group's open access list. It
is refused when the customer opted out or is do-not-contact, and counts
toward the per-person send limit of the group (20 messages a minute; over
it: `SEND_RATE_LIMITED`). The documents are marked requested only after the
send succeeded.

**Notes** are internal, never sent. `@` mentions name a person who may act
on the case; any other handle is ignored.

**Bank contact log.** Who at the bank, when, what was said, the next action
and its date. Internal and append-only.

**SLA timers.** Three per case: **customer reply** (waiting for the
customer), **bank response** (waiting for the bank) and **document chase**.
Each is configured per bank and stage (amount in minutes or days, and when
it turns "due soon": a percentage, default 20 %, or a number of minutes). A
case with no bank has no timers. A timer is **on track**, **due soon** or
**overdue**; the case shows the worst running one.

| Event                                       | Effect                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| stage change (any move, the API's included) | timers configured for the new stage restart; every other running timer stops |
| customer writes in the group                | customer reply stops                                                         |
| bank response logged                        | bank response stops                                                          |
| document marked received                    | document chase restarts if configured for the stage, else stops              |

Deadlines are fixed when a timer starts; a config change applies from the
next start. The states are evaluated every 5 minutes.

**Inbox** (`/cases`). The cases you may read in your active workspace.
Filters: bank, stage, agent, priority (low, normal, high, urgent), SLA
state, customer waiting, documents missing, bank query open (stage Query
raised), no activity for N days, closed cases included. Sorts: most overdue
(default), due soonest, stalest. "Last activity" ignores the SLA job and the
inbound pipeline, so a timer cannot keep a case looking active.

**Conversation.** The case's conversation is its submission group's
messages. Opening it writes the read audit first (above). An ACTIVE group is
read directly; an ENDED group is read through the group's audited archive,
so its 60-day rule applies (an agent never reads it; a coordinator or team
lead only for 60 days after the end). Replying is the group's send: you
must be on the group's open access list.

**Take over** (a coordinator or the agent's team leader taking the
conversation over with a hand-over message) is **disabled** until the
hand-over wording is approved: it answers `TEMPLATE_NOT_APPROVED`.

**Presence.** The case page shows who else has it open: a hint, not a
lock or a record. The page reports itself every 20 seconds while visible,
and someone stays listed for 30 seconds after their last report. It is
kept in the app server's memory only, so a restart clears it.

## Banks

`/banks` holds one internal space per bank of the workspace, created by an
owner or admin. Nothing in it is ever sent to a customer or a bank.

**Who is in it.** Owners and admins of the workspace, and anyone with a
role on at least one **open** case of that bank (its agent, its
coordinator, or the team leader of its agent). Membership lapses as soon as
their last such case closes; their earlier posts stay visible to others.
A bank's own coordinators (Settings → Members) are members of its space
whether or not they have an open case there; taking the bank away ends it.
Members and admins have the same discussion rights.

- **Threads and posts.** A thread has a title (up to 200) and posts (up to
  4,000 characters) with replies. A post can link a case or a case task of
  that bank that the poster may read. Only the author retracts a post; it
  then shows as retracted, without its text. Case details in a listing are
  shown only to someone who may read the case.
- **Pins.** Bank contacts, product rules, required documents, turnaround
  times, known pitfalls (up to 8,000 characters each; blank clears).
  Every edit is kept as a new version. Edited by admins, team leader
  members, and members who coordinate an open case of the bank.
- **Action needed.** One per thread, with an owner and a due date. On a
  case-linked thread it creates a task on the case (from the bank's
  "Action needed" template, so the case's task rules apply). On an
  unlinked thread the owner must be a member.
- **Summary strip.** The page header shows open cases (that the viewer
  may read), members now (the people with access through an open case,
  each counted once as coordinator, else agent, else team lead), open
  Action needed items (not done), and the viewer's role here (Admin for
  owners and admins). It loads separately from the page; if it fails, the
  strip is hidden and the page works as before.
- **Cases.** The bank's cases the viewer may read, open cases first, most
  overdue first (overdue, then due soon, then the rest, each by next due
  date), then closed cases, latest closed first. Columns: customer (linked
  to the customer page; "Unknown customer" without a contact), stage (with
  a Lead chip for a case that has no WhatsApp group yet), product, agent,
  coordinator, SLA (Overdue / Due soon / On track with the next due date;
  nothing for a closed case), opened, closed.
- **Dashboard.** Worked out on every view over the bank's cases the viewer
  may read. Scope `all` for owners and admins, `own` for everyone else.

| Figure                       | Meaning                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| total cases                  | the readable cases; every figure is over this set                                                       |
| by stage                     | count per current stage                                                                                 |
| average days per stage       | time spent in each non-final stage (the current stage of an open case counts up to now)                 |
| approval                     | approved, declined, withdrawn, and rate = approved / (approved + declined); withdrawn is not a decision |
| declined / withdrawn reasons | count per reason code                                                                                   |
| overdue                      | cases with an overdue running SLA timer or an overdue task, each once                                   |
| pre-submission               | open cases at a pre-submission stage (Interested, Data collection, Review)                              |
| with the bank                | open cases past pre-submission                                                                          |
| account openings             | open cases with no amount (or 0): an account opening is a count, never an amount                        |
| financing                    | open cases with an amount above zero, and the sum of their amounts (AED, exact)                         |
| conversion                   | leads (cases that ever reached Interested) -> those that reached the bank's submission stage, and rate  |

A case's type is not stored: an open case with no amount counts as an
account opening, one with an amount above zero as financing. A withdrawn
lead still counts among the leads; a case opened straight from a
submission never was one. The rate shows "—" with no leads. The old
"amount in pipeline" figure equals financing's amount and is no longer a
tile.

## Sync from the submission app (migration 134)

Taamul Compass, the submission app, is the master of a **submitted** case
(one with a submission group). Its `PATCH /api/v1/submission-groups/{id}`
can set the stage, bank, product, amount, outcome reason and documents in
one call (contract: [compass.md](compass.md)). The writes run as the API
(no person: history and the detail log show actor role `api`), follow the
usual move rules (bank stage list, no return to a pre-submission stage,
only Closed after a final stage), and a move to a final stage ends the
group. `cases.external_changed_at` holds the latest applied `changed_at`;
an older update is stale and ignored. `cases.external_url` is the case in
Compass. A lead is never touched by the sync: the CRM stays its master.
Stage moves also queue the `case.stage_changed` webhook (see
[public-api.md](public-api.md#webhooks)).

### What a case shows

The case page, the Cases inbox and a bank's Cases tab show a submitted
case's status **exactly as Compass last sent it** (the group's
`submission_status`, e.g. `UNDER_REVIEW`), not the stage name. A lead,
or a case Compass has sent no status for, shows its stage. The stage
still runs underneath (SLA timers, closing, the stage filter, Move
stage, the bank dashboard), set from the status as described above.

The chip colour follows Compass's own status names (`TRACKER_STATUS_CHIP`
in `lib/cases/ui.ts`; `_` reads as a space, case and extra blanks are
ignored):

| Compass status | Colour |
|---|---|
| To Submit | sky |
| Inhouse Review | indigo |
| Submitted | blue |
| Bank Review | violet |
| Awaiting Customer Response | amber |
| Returned to RO | orange |
| Awaiting Fulfillment | teal |
| Approved / Declined | green / red |
| Withdrawn / Closed | grey |

A status not in that list takes the colour of the stage it names
(`QUERY_ANSWERED` -> Query answered's cyan), else the colour of the
case's current stage, so no chip is left uncoloured. A new Compass
status name gets its own colour by adding it to that map.

### Managed in Compass (the lock)

An owner or admin can turn on **Settings -> Cases -> Submitted cases are
managed in Compass**. While on, people cannot, on a submitted case, move
the stage, edit bank, product or amount, set the outcome reason, or mark a
document received or rejected (409 `MANAGED_EXTERNALLY`). Notes, tasks,
priority, due date, reassigning, bank contacts, document requests and
replies stay open; leads are never locked; the v1 API is never locked. The
case page shows a "Managed in Compass" banner with an Open in Compass link
and the time of the last sync.

## Case files (migrations 179-182)

Migrations 179, 180, 181 and 182 apply in that order, as a superuser or
BYPASSRLS role. Each has a verify file (`verify-case-system-notes.sql`,
`verify-customer-documents-internal.sql`, `verify-case-files.sql`,
`verify-case-file-builds.sql`).

**Automatic notes (179).** A case note may be written by the system rather
than a person: `author_id` is NULL and `system_author` is `system:files` or
`system:rules`. The case shows it as "Automatic". Only no-grant definer
helpers write one (`case_note_add_system`); no API role, the service role
included, can call it.

**Where files live (180).** A file staff upload to a case, and a case-file
PDF the CRM assembles, are stored in the private `case-files` bucket (no
client policy: a browser gets a file only through a route that has checked
the caller and then uses the service role). Each is also filed in the
customer's documents (sources `staff_upload` and `case_build`), so it lands
in the customer's folder on the NAS like a document the customer sent (see
[customer-documents.md](customer-documents.md)). A coordinator who was only
shared one chat does not see these files.

**File specs (181).** Per bank and product, an owner or admin sets one spec
row per document (`PUT /api/cases/config/banks/[code]/file-specs`, audited):
position, required, max MB, allowed types (PDF, JPEG, PNG), minimum valid
days, a file-name pattern (`{{case}}`, `{{company}}`, `{{doc}}`,
`{{yyyymmdd}}`) and whether the document is merged into the case file or
only listed in its index. With no spec rows the spec is derived from the
bank's required documents with default values.

**Attaching a file.** A customer's WhatsApp document, or a staff upload,
is attached to one of the case's required documents
(`/api/cases/[id]/files`, `/files/attach`, `/files/[fileId]/classify`). Each
attach is a new version; nothing is deleted.

**Checks.** Every attached version is checked automatically: type and file
signature, size, a readable PDF and its page count, photo resolution (at
least 600 px on the short side) and expiry (minimum valid days). It ends
`passed` or `failed`. A case is **File ready** when every required document
has a passed file and no newer version of it has failed.

**Switches** (Settings -> Cases, `caseFiles` in `/api/cases/config/settings`,
owners and admins write). All three are off by default, and none ever acts
on a case Compass manages (the lock below):

- _Mark the checklist received_ when a file passes; when a newer upload
  fails, it also leaves one automatic note for the coordinator.
- _Move the case_ from one chosen stage to another when it becomes File
  ready (once, with one automatic note).
- _Intake prompts_ (`files_intake_prompts`): lets the system intake classify
  a file a customer sent by WhatsApp. Sending WhatsApp prompts to the
  customer is not built.

**Assembling the case file (182).** A coordinator, team leader or admin
builds the case file of a File-ready, open case
(`POST /api/cases/[id]/build`): either a cover/index plus every merged
document in one PDF, or an index-only PDF. The bytes go to `case-files` at
a content-addressed path (`cases/<case>/bundle-<sha256>.pdf` or
`index-<sha256>.pdf`) after a short reservation (10 minutes), so two
builders never write one object with different bytes. A build is recorded
only if it still matches the case's current passed files. When a file later
fails, is superseded or is reclassified, the build becomes stale and is no
longer the current one.

**Downloads and audit.** Downloading a file (`/files/[fileId]/download`) or
the current build (`/build/download`) first writes an audit row, then issues
a signed link valid for 10 minutes; if signing fails the row says so. A
person who cannot read the case is told the file does not exist.

## Saved views, snooze and mentions (migration 185)

`verify-case-views.sql`. Apply after 182 (183 and 184 are not part of this
stack).

- **Saved views** (`/api/cases/views`): a named set of inbox filters and a
  sort. A view is private, or shared with the workspace when an owner or
  admin saves it. Anyone with a case role may keep private views; only the
  owner or an owner/admin deletes one. Another person's private view is
  reported as not found.
- **Snooze** (`/api/cases/[id]/snooze`, `/unsnooze`): hides a case from the
  inbox for up to 30 days, with an optional reason. A coordinator of the
  case, its team leader and admins can snooze; agents cannot. Snoozing
  never touches the SLA: timers keep running, and a snooze is not a touch
  of the case. It ends by itself when its time passes; the inbox then marks
  the case "snooze expired" for 24 hours. New inbox filters: snoozed (hide,
  only, all), snooze expired, mentions me.
- **Mentions** (`/api/cases/mentions`): the list of notes that mention you
  on cases you can read, newest first.
- A system note no longer counts as a case's last touch, so an automatic
  note does not make an idle case look worked.

## Macros (migration 186)

`verify-case-macros.sql`. A macro is a saved list (1 to 10) of case actions
applied to one case in one click (`/api/cases/macros`,
`/api/cases/[id]/macros/[macroId]/apply`; the case page header has an Apply
macro control, and Settings -> Cases manages them). Private or shared like
views.

Actions: add a task from a template, add a note (`{{customer}}` and
`{{bank}}` are filled in), move the stage (optionally with an outcome), and
preview the missing-documents request. The preview sends nothing.

Applying a macro calls the normal case functions as the person applying, so
roles, stages and the Compass lock all still apply and a macro never widens
what its user may do. There is no transaction across actions: the run stops
at the first refused action, and the actions before it stay applied. Every
run is logged (`case_macro_log`, one row listing each action and its
refusal), and the log outlives a deleted macro.

## Automation rules (migration 187)

`verify-case-rules.sql`. An owner or admin defines rules (`/api/cases/rules`):
_when_ a trigger happens on a case, _if_ the conditions match, do the
actions.

- **Triggers:** a case is opened; it changes stage; it goes SLA overdue; it
  sits idle for N days (1 to 365); it gets its submission.
- **Conditions** (all must match, absent means any): bank, stage, product,
  amount range, pre-submission.
- **Actions:** assign a coordinator, assign an agent, add a note, set the
  priority. Assigned people must be live staff of the workspace. There is no
  "add a task" action.
- **Safe by construction:** rules never send anything. They never change a
  case Compass manages (the lock below) and never change a closed case. Each
  action runs on its own, so a failing action is recorded and stops only
  that rule; the next rule still runs. A rule can never stop the change that
  fired it. A rule's own changes do not fire rules and do not count as
  activity, so "idle N days" is not reset by a rule.
- **History:** every rule evaluated on a case leaves a run row, matched or
  not (`/api/cases/[id]/rule-runs`), shown on the case.
- The idle and overdue triggers are evaluated by a sweep in the automations
  cron (see below). The other triggers fire from the database at once.

## Settings -> Cases

Owners and admins configure, per bank (`/api/cases/config/banks/...`; staff
from agent up may read):

- the bank list (code `^[A-Z0-9_]{2,32}$`, name up to 100);
- the bank's stage list (rules above);
- task templates (key, title, position, default due hours);
- required documents per product (key, label, position);
- SLA timers per stage.

Two workspace switches sit above the banks (`/api/cases/config/settings`;
agents and up read, owners and admins write, each save sends only its own
key): **Submitted cases are managed in Compass** (the lock, below) and
**Open a WhatsApp group for each submission** (migration 136, off by
default). Off, a submission from Compass opens a case only; on, each new
submission also gets a WhatsApp group on a Whapi number. Existing cases
keep what they have. A case opened without a group shows that on its
Conversation tab, with no composer, and a reply or documents request into
it is refused (`NO_WHATSAPP_GROUP`); see
[submission-groups.md](submission-groups.md#without-a-whatsapp-group-migration-136).

## The cron

The automations cron (`GET /api/automations/cron`) runs, each at most every
5 minutes per process, inside `after()`:

- the **SLA job**: due soon / overdue over every running timer, one case at
  a time (each in its own transaction, so a case being worked on never
  waits for the whole sweep); a case that fails is logged by id and the
  rest still run, and it starts no case after 20 seconds;
- the **group-end sweeper**: final-stage cases whose group end never
  completed, each ended through its own workspace; it starts no case after
  20 seconds;
- the **case rules sweep** (migration 187), right after the SLA job: the
  idle and overdue triggers of the [automation rules](#automation-rules-migration-187).

A failure is only logged.

## Known limits

- **Take over is disabled** until legal approves the hand-over wording
  (draft English only; Arabic to do).
- Case tasks are separate from CRM [tasks](tasks.md): they are not on the
  calendar or the customer page's task list.
- A case edit that changes details, priority and due date together is not
  atomic (three separate writes).
- Bank spaces are self-contained; they are not team chat.
- Concurrency rules (races) are not covered by the SQL verify files.
- A team leader who is also the named coordinator or agent of a case acts as
  team leader on it when they lead the agent's team.
