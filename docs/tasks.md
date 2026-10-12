# Tasks

One shared to-do list for follow-ups: call a customer back, chase a
document, follow up on a deal. Migration `085_tasks.sql`; the rules
below are enforced in Postgres (RLS and the `tasks_guard` trigger) and
asserted by `supabase/ci/verify-tasks.sql`.

A task has a `title` (up to 300 characters), an optional `note` (up to
4,000), a `kind` (`manual`, `callback`, `missed_call`, `journey`,
`follow_up`), a `status` (`open`, `done`, `cancelled`), an optional
`due_at` and assignee, and optional links to a contact, a conversation
and a deal of the same account.

## What creates tasks

- **People**, through `POST /api/tasks` (agents and up). Their tasks
  carry `source` `manual` or `chat` and `created_by` = themselves.
- **Modules**, on the service role, through `createSystemTask`
  (`src/lib/tasks/system.ts`): the phone system's missed calls
  (`pbx`), the journey bot's advisor steps (`journey`) and automations
  (`automation`). `created_by` stays empty. `resolveTaskOwner` assigns
  the task to the person the chat is assigned to, else the contact's
  owner, whichever is an active owner, admin, team leader or agent;
  otherwise the task is left unassigned. `closeSystemTasks` marks the
  module's open task done once the event is dealt with.

## Dedupe by source reference

A module passes its own id for the event as `source_ref` (a call id,
an outbox item id). `(account_id, source, source_ref)` is unique, so a
redelivered webhook or a re-run step finds the task already there
instead of opening a second one. Tasks without a `source_ref` (those
people create) never collide.

## Who sees which task

- Owners and admins: every task of the account.
- Everyone else: tasks assigned to them, tasks they created, and tasks
  on a contact they can see. A contact is visible on the same terms as
  in Contacts: they created it or have a chat with that customer (their
  own or assigned to them).
- A team leader also sees the tasks assigned to the people they lead.
- Nobody sees another account's tasks. Number allocation and chat pins
  grant nothing here.

## Who can change a task

- **Create:** agents and up (viewers cannot), with `source` `manual` or
  `chat`, and only on a contact they can see. System sources are
  written only by the service role.
- **Edit:** agents and up on tasks they hold or created; a team leader
  also their team's; admins any task of the account. A task can be
  handed to someone else.
- **Delete:** admins, or the person who created a task by hand.
- **For every writer, the service role included:** the linked contact,
  conversation and deal must belong to the task's account; the assignee
  must be an active owner, admin, team leader or agent of it (checked
  when the assignee changes, so a task whose assignee was deactivated
  later can still be completed or handed on); `account_id`, `kind`,
  `source`, `source_ref` and `created_by` never change. `completed_at`
  and `completed_by` are set when the status leaves `open` and cleared
  when it returns.

Deleting a person's login keeps their tasks: the assignee, creator and
completer become empty.

## The bell

Assigning a task to someone else, on creation or later, sends them a
`task_assigned` notification with the task's title and, when it has
one, its due time in UTC. Assigning a task to yourself sends nothing; a
task a module assigns always notifies. A notification that fails to
write never undoes the task.

## REST contract

Internal dashboard routes, under the caller's session and RLS. Request
bodies are camelCase; a task is returned with its database columns
(`id, account_id, kind, title, note, contact_id, conversation_id,
deal_id, assigned_to, due_at, status, source, source_ref, meta,
created_by, created_at, updated_at, completed_at, completed_by`).
Errors are `{ error: string }`.

`GET /api/tasks` (viewer and up) → `{ tasks }`

| Query    | Values                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`  | `mine` (default: assigned to the caller), `all` (whatever the caller may see), `contact` (needs `contactId`), `conversation` (needs `conversationId`) |
| `status` | `open` (default), `done`, `cancelled`, `all`                                                                                                          |
| `limit`  | 1–200, default 100                                                                                                                                    |

Open tasks come first, then the soonest due (undated last), then the
newest.

`POST /api/tasks` (agent and up) → 201 `{ task }`

| Field                                   | Rule                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `title`                                 | required, trimmed, 1–300 characters                                                                                          |
| `note`                                  | optional, up to 4,000; blank is stored as none                                                                               |
| `kind`                                  | default `manual`                                                                                                             |
| `source`                                | `manual` (default) or `chat`                                                                                                 |
| `contactId`, `conversationId`, `dealId` | ids or null. With a conversation and no contact, the task takes the chat's contact; a chat the caller cannot see answers 404 |
| `assignedTo`                            | absent assigns the caller; `null` leaves it unassigned                                                                       |
| `dueAt`                                 | ISO 8601 date-time with a time zone (`2026-10-12T09:00:00Z`), or null                                                        |

`PATCH /api/tasks/[id]` (agent and up) → `{ task }`: any of `status`,
`title`, `note`, `assignedTo`, `dueAt`, at least one; `null` clears
note, assignee or due date. A task the caller may not edit answers 404.

`DELETE /api/tasks/[id]` (agent and up) → `{ ok: true }`; 404 when the
caller may not delete it.

Status codes: 400 for an invalid body or query, or a rule the trigger
refused (its own sentence is passed on, such as an assignee who cannot
hold tasks); 403 when a policy refuses the write; 404 as above; 409 for
a duplicate; 500 otherwise.
