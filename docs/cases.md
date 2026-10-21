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
copied.

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
| the case's named **agent** (agent or team leader)       | that case   | yes  | no                                                                  |
| viewers, bank guests, deactivated people, anyone else   | nothing     | no   | no                                                                  |

"Acts" covers stage moves, details, tasks, documents, notes, the bank
contact log, SLA events and replies. The new agent or coordinator must be
live staff (agent and up) of the workspace. Reassigning does **not** change
the submission group's access list: a newly assigned agent must be added to
the group before they can send in it.

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
(`APPROVED`, `DECLINED`, `WITHDRAWN`, `CLOSED`) moves a case that is not
yet final to Approved, Declined, Withdrawn or Closed, also when the group
had already ended. A case already at a final stage is left alone; other
statuses change nothing.

## Leads

A **lead** is a case with no WhatsApp group yet: a customer who is interested
in a bank product before anything is submitted (migration 130). It starts at
**Interested** and moves through **Data collection** and **Review**.

- **Who opens one.** The agent who will work it, an owner or admin, or that
  agent's team leader (`POST /api/cases/leads`, agent and up; viewers and
  bank guests are refused). The contact must be visible to the agent. The
  person signed in is always the actor; the agent defaults to them. One open
  lead per contact and bank (`LEAD_EXISTS`, `CASE_EXISTS`: 409); the same
  agent opening it again gets the existing lead back.
  Staff open a lead from the customer page or Cases -> New lead (which
  starts with a customer search on the caller's own visibility).
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
- **Where staff open one.** The customer page (`/contacts/<id>`) has a
  **Cases** card, shown to agents and up: the customer's cases with stage,
  bank, product, amount and a **Lead** chip, and an **Open lead** button
  (bank and product required; amount in AED and lead source optional).
  Team leaders, admins and owners may pick the agent; an agent opens for
  themselves. On success the new case page opens. The Cases inbox marks
  leads with the same chip.
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

### Managed in Compass (the lock)

An owner or admin can turn on **Settings -> Cases -> Submitted cases are
managed in Compass**. While on, people cannot, on a submitted case, move
the stage, edit bank, product or amount, set the outcome reason, or mark a
document received or rejected (409 `MANAGED_EXTERNALLY`). Notes, tasks,
priority, due date, reassigning, bank contacts, document requests and
replies stay open; leads are never locked; the v1 API is never locked. The
case page shows a "Managed in Compass" banner with an Open in Compass link
and the time of the last sync.

## Settings -> Cases

Owners and admins configure, per bank (`/api/cases/config/banks/...`; staff
from agent up may read):

- the bank list (code `^[A-Z0-9_]{2,32}$`, name up to 100);
- the bank's stage list (rules above);
- task templates (key, title, position, default due hours);
- required documents per product (key, label, position);
- SLA timers per stage.

## The cron

The automations cron (`GET /api/automations/cron`) runs, each at most every
5 minutes per process, inside `after()`:

- the **SLA job**: due soon / overdue over every running timer, one case at
  a time (each in its own transaction, so a case being worked on never
  waits for the whole sweep); a case that fails is logged by id and the
  rest still run, and it starts no case after 20 seconds;
- the **group-end sweeper**: final-stage cases whose group end never
  completed, each ended through its own workspace; it starts no case after
  20 seconds.

A failure is only logged.

## Known limits

- **Take over is disabled** until legal approves the hand-over wording
  (draft English only; Arabic to do).
- Reassigning a case does not change the group's access list.
- Case tasks are separate from CRM [tasks](tasks.md): they are not on the
  calendar or the customer page's task list.
- A case edit that changes details, priority and due date together is not
  atomic (three separate writes).
- Bank spaces are self-contained; they are not team chat.
- Concurrency rules (races) are not covered by the SQL verify files.
- A team leader who is also the named coordinator or agent of a case acts as
  team leader on it when they lead the agent's team.
