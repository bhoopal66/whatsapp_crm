# HR workflows

Migration 200. Built on the HR inbox of migration 192
(`docs/departments.md`): a chat owned by or assigned to someone in HR
carries `conversations.inbox_department = 'hr'`. HR workflows add a
second layer on those chats, so the HR team can sort and track them.

## Two HR inboxes

| Inbox | Who is in it | How a chat is sorted |
|---|---|---|
| Recruitment (`recruiter`) | Job candidates | One of four stages, in order: CV review, AI interview, HR interview, Manager interview |
| HR department (`dept`) | Employees | One topic: Onboarding, Visa & documents, Leave & attendance, Payroll, Complaint, Other |

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

Owners and admins add people in **HR inbox → Setup**: for each inbox, a
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
chat's HR panel and in HR inbox → Tasks) and set flags. An HR task is
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

## For operators

- Apply `supabase/migrations/200_hr_workflows.sql` before deploying the
  build. It is re-runnable and seeds the rules for every workspace.
- Nothing happens until an admin adds people to the HR team and someone
  tracks a chat; owners and admins can do both straight away.
- The tables are read through RLS (a tracked chat's row is visible to
  whoever can see the chat) and written only through the `hr_*`
  functions. `supabase/ci/verify-hr-workflows.sql` asserts the rules.
- Ported from the outside module package release 023 (2026-11-14). Not
  ported: its separate conversation store and owner field (wacrm uses
  its own chats and assignee), the IT read-only role, Arabic task
  titles, and its own task table (wacrm's tasks are used).
