# HR workflows

Migration 200. Built on the HR inbox of migration 192
(`docs/departments.md`): a chat owned by or assigned to someone in HR
carries `conversations.inbox_department = 'hr'`. HR workflows add a
second layer on those chats, so the HR team can sort and track them.

## Screens (sidebar group "HR")

| Item | Route | Who sees it |
|---|---|---|
| Recruiter HR | `/hr/recruiter` | admins, recruiter HR roles |
| HR department | `/hr/department` | admins, dept HR roles |
| Not sorted | `/hr/unsorted` | admins, any HR role |
| Tasks, Rules | `/hr/tasks`, `/hr/rules` | admins, any HR role |
| Hire fast | `/hr/hire-fast` | admins, recruiter HR roles |
| Automated messages | `/hr/automated-messages` | admins, recruiter leads |

The three inbox screens are the WhatsApp inbox with the HR list header,
two-line HR rows and the HR Conversation pane on the right (desktop).
Old `/hr-inbox` URLs redirect (`src/lib/hr/routes.ts`); `/hr-inbox?c=`
opens the chat in its own inbox. Every `/hr` path needs a session
(`src/middleware.ts`) and passes `HrAccessLayout`.

## Two HR inboxes

| Inbox | Who is in it | How a chat is sorted |
|---|---|---|
| Recruitment (`recruiter`) | Job candidates | One of four stages, in order: CV review, AI interview, HR interview, Manager interview |
| HR department (`dept`) | Employees | One topic (migration 201): Offer letter, Onboarding, Visa & documents, Leave & attendance, Payroll, Training (Staff admin); Warning letter, Complaint, Termination (Conduct); Message, Other |

A chat is in at most one of them (`hr_conversations`, one row per chat).
An HR chat with no row yet is **Not sorted**. In the chat's side panel
the HR team tracks it as a **Candidate** (Recruitment, starting at CV
review) or an **Employee** (HR department, no topic until one is
picked). Picking a stage moves a chat to Recruitment and clears its
topic; picking a topic moves it to the HR department and clears its
stage. Every move is kept in `hr_stage_history`.

Every tracked chat also shows:

- **Reply state**, worked out from the chat's messages, never set by
  hand: *New* (nobody from the team has written yet), *Reply due* (the
  customer wrote last), *Waiting on them* (the team wrote last). Bot
  messages do not count.
- **Urgent** and **Upset** flags.
- **Close** with an outcome: Recruitment closes as *Hired*, *Not
  selected* or *Withdrawn*; the HR department closes with none. A
  closed chat cannot be moved or flagged until it is reopened, and
  closing does not close the WhatsApp chat itself (`conversations.status`
  is untouched; a new message does not reopen the HR record).

The owner of a tracked chat is the chat's ordinary assignee.

## The HR team

Owners and admins add people in **HR → Rules**: for each inbox, a
person is a **Lead** or a **Member**. Someone can be in both inboxes.
Being in the HR team lets a person open the HR inbox, but it **does not
let them see more chats**: they see exactly the chats they saw before
(their own, and a team leader their team's). Every HR action also checks
that the person can see the chat.

| Action | Member (of the chat's inbox) | Lead | Owner / admin |
|---|---|---|---|
| Track a chat as candidate / employee | yes (in the target inbox) | yes | yes |
| Move a candidate to a later stage, set a topic, flags, close | yes | yes | yes |
| Move a candidate back a stage | no | Recruitment lead, with a reason | yes, with a reason |
| Reopen a closed chat | no | yes, with a reason | yes, with a reason |
| Change workflow rules | no | rules of the inbox they lead | yes |
| Add or remove HR team members | no | no | yes |

A candidate who went to the HR department and comes back cannot land
on a stage earlier than the furthest one they reached, unless a lead or
admin moves them with a reason.

## Workflow rules

Rules never send anything to anyone. They create **tasks** (the ordinary
tasks of `docs/tasks.md`, with the usual due-time ring, listed in the
chat's HR panel and in HR → Tasks) and set flags. An HR task is
linked to the chat but not to the contact, so it is not on the customer
page: under the tasks rules a contact link would show "Respond to
complaint" to anyone who can see the contact. It is seen by its
assignee, the assignee's team leader, and owners and admins. Each workspace starts with
these eleven, all on:

| Rule | When | Does | Due |
|---|---|---|---|
| CV review | a candidate enters CV review | task "Review CV" | 24 h |
| AI interview | enters AI interview | task "Send AI interview link" | 24 h |
| HR interview | enters HR interview | task "Schedule HR interview" | 48 h |
| Manager interview | enters Manager interview | task "Schedule manager interview" | 48 h |
| Payroll | an employee chat gets topic Payroll | task "Check payroll query" | 24 h |
| Visa & documents | topic Visa & documents | task "Check visa or document request" | 48 h |
| Complaint (flag) | topic Complaint | marks the chat Urgent | – |
| Complaint (task) | topic Complaint | task "Respond to complaint" | 4 h |
| Reply overdue (Recruitment) | the customer has waited 4 h for a reply | task "Reply to customer" | now |
| Reply overdue (HR department) | the same, in the HR department | task "Reply to customer" | now |
| No activity | a candidate has not answered for 72 h | task "Chase candidate" | 24 h |

A rule's switch, hours and task title can be changed in Setup; what
triggers it and what it does cannot. A task goes to the chat's assignee
(else its owner, else nobody).

Each rule fires once per event (`hr_rule_fired`): a task someone deletes
is not created again.

Each event creates its task once: setting the same stage or topic again
creates nothing, a candidate moved back and forward again gets a fresh
task for the stage they re-enter, and a topic rule fires once per stay
in the HR department. The two time rules (reply overdue, no activity)
are checked every 5 minutes by the automations cron
(`GET /api/automations/cron`, `hr_sweep`), once per customer message or
team message they wait on. Closed chats and switched-off rules fire
nothing.

The HR department list has quick chips over the topics: All, Letters
(offer and warning letters), Training, Leave, Messages and Exits
(termination); they combine with the other filters. The five topics
added by 201 fire no rule.

## AI reply drafts (migration 202)

In a Recruitment chat the HR panel can suggest a reply to the
candidate. **Nothing is ever sent from it**: a person approves or
rejects each draft, and an approved draft is copied and sent from the
chat like any other message.

- **When.** On each new message from a tracked, open candidate, and on
  **Draft a reply** in the panel (with optional interview times, the
  only dates a draft may mention). Personal chats included.
- **How.** An orchestrator reads the message and the chat's last ten
  messages, works out what the candidate wants and hands it to one
  agent: CV screening, Interview scheduling, Candidate questions or
  Escalation. It uses the workspace's own AI key (Settings → AI); the
  spend shows as "HR agent drafts" in the AI usage panel.
- **Safety rules, in code.** Salary, offer, visa, contract and legal
  questions get only an acknowledgement and go to a person; an upset
  candidate is marked Urgent; a draft never promises salary, an offer,
  a visa or a date other than the supplied interview times; every draft
  ends with "This is an automated assistant; a recruiter will confirm."
  On a Meta (Cloud API) number more than 24 hours after the candidate's
  last message a free reply is not allowed, so the draft only says a
  template is needed. At most 3 drafts wait per chat and 5 are made per
  chat a day; a waiting draft expires after 24 hours.
- **STOP.** A candidate who writes stop / unsubscribe (or the Arabic
  equivalents) is opted out (`contacts.opted_out_at`, the same opt-out
  campaigns use) and their waiting drafts are withdrawn. This happens
  only while AI drafts or automated messages are switched on.
- **Switches.** HR → Rules → Recruiter AI drafts: "Draft replies"
  is the master switch; each agent can be switched off on its own (its
  messages then go to a person). Admins and recruiter leads change
  them. Auto-send does not exist.

Members and leads of the Recruitment inbox (and admins) see the drafts
of chats they can see, and approve or reject them.

## Hire fast

HR → Hire fast ranks the open Recruitment candidates the user can
see by who needs action next, read only: +100 when the candidate is
waiting on us (10 when we wait on them), +50 Urgent, +30 Upset, +1 per
hour waited (up to 72), +5/10/15 for the later stages, +20 for an
overdue HR task, +20 when they have gone quiet longer than the
No activity rule. Filters: stage and Mine (assigned to me).

## Automated messages (migration 203)

HR → Automated messages sends fixed, approved templates to
candidates. It is for admins (everything) and Recruitment leads
(switch triggers, cancel queued messages).

| Trigger | When | Template |
|---|---|---|
| CV received | a chat is tracked as a candidate | CV acknowledgement |
| Moved to AI / HR / manager interview | the candidate enters that stage | the interview invite |
| Reply nudge | the candidate has not answered for the No activity rule's hours (72) | "We are still waiting for your reply" |
| Interview reminder | not available yet (wacrm stores no interview times) | — |

- **Off until switched on.** The master switch starts ON (blocking
  every message) and every trigger OFF. While a trigger is off its
  events record nothing. With a trigger on and the master switch still
  on, the history shows what would have been sent, held "Kill switch".
- **Who receives it.** Only company chats: never a personal number. The
  message goes from the chat's own number (its pinned number, else the
  number the candidate wrote to) and appears in the chat as a bot
  message.
- **Templates.** One per message kind and language (English, Arabic),
  edited by admins: only `{name}` and `{slot}` placeholders, Utility
  category only, promotional wording refused (discounts, offers, other
  vacancies, links…). A template must be marked Approved to be sent; on
  a Meta number it must also exist, approved and Utility, in Templates
  under the same name (its `{{1}}`/`{{2}}` in the order the text uses
  name and time).
- **Guards, in order** (the first that applies holds the message): the
  master switch, the trigger switched off, the chat closed, the
  candidate opted out, no consent (on by default: record it in the
  chat's HR panel), quiet hours (21:00–08:00 Asia/Dubai), no approved
  template, the daily cap (3 per candidate). A closed chat or an
  opt-out cancels the message instead.
- **Delivery.** The automations cron drains due messages every minute.
  Each message is claimed before it is sent, so two runs never send it
  twice; a failed send is retried up to 3 times; a message held or
  failing for more than 24 hours is cancelled, never sent late. A
  message the gateway accepted but wacrm could not record is marked
  "not confirmed" and never resent; one stuck in sending for 15 minutes
  is marked for review. The nudge counts only conversations that went
  quiet after the trigger was switched on, and within the last 7 days.
- **Sends that cannot work (migration 212).** A failure that retrying
  cannot fix is marked failed at once, with a short reason kept on the
  message and in the audit log (`outbox_failed_terminal`), instead of
  being retried: an invalid or not-allowed number, a template that is
  missing, paused or rejected at Meta, Meta's 24-hour window closed, a
  revoked token or unknown Whapi channel, a personal chat or number, a
  chat that no longer exists. Anything else (rate limits, the gateway
  down, a timeout, a Whapi number briefly logged out, the chat's number
  disconnected) is still retried up to 3 times.
- **Receipts (migration 212).** WhatsApp's sent, delivered, read and
  failed receipts for an automated message are recorded on it
  (`delivery_state`, `delivery_at`). They only move forward: a late
  "delivered" never overwrites "read", and nothing overwrites "failed".
  A "failed" receipt marks the message failed for good with WhatsApp's
  error code (`delivery_failed:<code>`). A receipt that arrives in the
  moment before the message is marked sent lands on the chat's own copy
  of the message, and is copied onto the automated message when it is
  marked sent (the error code is then `unknown`). A message that failed
  for good keeps its status and reason: the 24-hour clean-up cancels
  only messages that could still be sent. The history screen does not
  show the receipt or the reason yet (neither does the package's).
- **History.** Every message with its status (queued, held and why,
  sent, failed, cancelled); leads and admins cancel a waiting one,
  admins can run the queue now.

Check with legal (UAE PDPL: consent, retention, privacy notice) before
switching any of this on.

## HR lines (migration 213)

HR → Rules → **HR lines** (owners and admins) names the WhatsApp
numbers HR uses, company or personal, and holds one switch: open a
Recruitment chat when someone new writes to an HR line. Off by default.

- With the switch on, a message to an HR line from a chat that has no
  HR row yet (tracked or closed) opens it in Recruitment at CV review,
  as if a recruiter had tracked it, with no person as its opener. The
  recruiter agents then see the same message. A chat already in
  Recruitment, HR department or closed in HR is left alone, and so is a
  chat that has ever used a number that is not an HR line: wacrm keeps
  one company chat per customer across all numbers, so a sales customer
  who writes to the HR number stays a sales chat (the package's rule is
  "an unknown number on an HR line"). Personal-number chats only ever
  use their own number, so they are not affected by this.
- Opening a chat this way may queue the CV-received automated message,
  which still passes every guard above (company chats only).
- In the package this was server configuration (`HR_LINE_IDS`,
  `HR_AUTO_CREATE_RECRUITER`); in wacrm it is per workspace, because one
  install serves several workspaces. The webhook itself is wacrm's own:
  every number's messages already reach the inbound pipeline.
- `hr_lines` and `hr_line_settings` are read and written only through
  `hr_lines_get` / `hr_lines_set`; the inbound hook calls
  `hr_auto_open_recruiter` on the service role (one indexed read when the
  switch is off). `supabase/ci/verify-hr-lines.sql` asserts it.

## My worklist

`/worklist` ("My worklist", sidebar under Dashboard) is one ranked list
of what needs action next, built in the browser from reads that already
exist; there is no worklist API, table or migration (package release
029c).

- **HR chats** (open, both inboxes) score like Hire fast: reply due or
  new 100, waiting on them 10, urgent +50, upset +30, one point per hour
  waited (at most 72), later Recruitment stages 0/5/10/15, an overdue HR
  task +20, stalled past the No activity rule +20 (Recruitment only).
- **Cases** appear only when something needs doing: SLA overdue +80 or
  due soon +40, documents missing +25, an overdue task +20.
- **AI reply drafts** waiting for approval: +60, +10 more after 24 hours.
- Agents and viewers see items assigned to them (an HR chat's assignee,
  a case's agent or coordinator); team leaders, admins and owners see
  everything their access already shows, with an "Assigned to" filter.
  What each list returns is still decided by RLS.
- Rows name the kind and a short reference only, never a person or a
  message (the package's privacy rule). Weights are pinned to Hire fast's
  by `src/lib/worklist/rank.test.ts`.

## For operators

- Apply `supabase/migrations/200_hr_workflows.sql` before deploying the
  build. It is re-runnable and seeds the rules for every workspace.
- Then `201_hr_topics.sql`, `202_hr_agents.sql`, `203_hr_automsg.sql`,
  in that order, before the build that uses them. 201 re-creates
  `hr_set_topic`: re-running 200 after it narrows the topics again, so
  re-run 201 too. 203 refuses to apply except as a superuser or
  BYPASSRLS role (its tables are reached only through its functions).
  `supabase/ci/verify-hr-agents.sql` and `verify-hr-automsg.sql` assert
  them.
- Then `212_hr_automsg_delivery.sql` and `213_hr_lines.sql` (release
  029), as a superuser or BYPASSRLS role, before the build that uses
  them: the drain calls `hr_automsg_fail_terminal` and the inbound
  pipeline calls `hr_auto_open_recruiter`. Without them a terminal send
  failure is counted as an error and left for the stuck-message review,
  and receipts and auto-opening only log an error line.
  `verify-hr-automsg-delivery.sql` and `verify-hr-lines.sql` assert
  them.
- Nothing happens until an admin adds people to the HR team and someone
  tracks a chat; owners and admins can do both straight away.
- The tables are read through RLS (a tracked chat's row is visible to
  whoever can see the chat) and written only through the `hr_*`
  functions. `supabase/ci/verify-hr-workflows.sql` asserts the rules.
- Ported from the outside module package release 023 (2026-11-14). Not
  ported: its separate conversation store and owner field (wacrm uses
  its own chats and assignee), the IT read-only role, Arabic task
  titles, and its own task table (wacrm's tasks are used).
- Topics, AI drafts, Hire fast and automated messages are ported from
  releases 024–028 (2026-11-16). Differences: drafts answer the chat's
  real messages (no typed candidate text) with the workspace's AI key
  rather than a server key; one opt-out (`contacts.opted_out_at`) rather
  than a separate list; automated messages really send (the package's
  sender was a stub) and events are queued in SQL; "CV received" fires
  when a chat is tracked as a candidate. Not ported: release 028 (a
  Voicenter call event triggering a WhatsApp message), the interview
  reminder's event source, the staff avatar style, per-topic colours
  (red stays for Urgent), and the Arabic wording review the package
  flags as pending.
