> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Tasks (`lib/tasks/*`, migration 085)

One `tasks` table serves people and system writers (PBX missed calls and
call-backs, the journey bot). Kinds are `manual`, `callback`, `missed_call`,
`journey`, `follow_up`; sources `manual`, `pbx`, `journey`, `chat`,
`automation`. A person (agent and up, `created_by` = self) inserts only source
manual/chat with kind manual, callback or follow_up; everything else is the
service role's. `docs/tasks.md` is the contract.

- **Who sees** (`tasks_select`, active account only): admins all; the assignee
  and the creator; anyone who can see its contact (`can_view_task_contact`); a
  leader the tasks *assigned to* people they lead. A system task with neither
  assignee nor contact is admin-only. **Edit:** agent and up who is the
  assignee, the creator, the assignee's leader or an admin, and the row must
  still pass `tasks_select` afterwards, so nobody hands a task out of their
  own sight. **Delete:** admins any; otherwise only the creator of a
  manual/chat task.
- `can_link_task` judges each link (contact, conversation, deal) on its own:
  visible to the caller, or equal to what the stored row already has, so an
  edit is never refused over a link the editor cannot see. The API's PATCH
  cannot change links.
- `tasks_guard` binds the service role too: links in the task's own account,
  an active staff assignee (checked when it changes), identity frozen,
  `completed_at`/`completed_by` stamped on leaving `open` and cleared on
  reopen.
- **System writers** use only `createSystemTask` (upsert on `(account_id,
  source, source_ref)` with `ignoreDuplicates`, then read back; a plain UNIQUE
  because PostgREST's `on_conflict` cannot target a partial index) and
  `closeSystemTasks` (open → done only), and filter by account themselves.
- **One bell per assignment.** The `tasks_notify_assigned` trigger sends
  `task_assigned` when an open task gets an assignee other than the writer; a
  redelivered system task inserts nothing, so it never rings twice. Since 089
  a `pbx` insert is silent (the processor sends its own `call_missed`).
  `task_due` is reserved; nothing emits it.
- Untested pairs, change together: the holder roles in `tasks_guard`,
  `TASK_HOLDER_ROLES` (`system.ts`) and `TASK_HOLDERS` (`pbx/process.ts`); the
  lists and length limits in `lib/tasks/types.ts` and 085. `verify-tasks.sql`.
