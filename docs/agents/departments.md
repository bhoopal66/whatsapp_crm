> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Departments (`lib/auth/departments.ts`, migration 192)

`profiles.department` (`sales` default | `hr` | `it` | `accounts`) is
written only by `set_member_department` (owner/admin; guarded column).
`account_departments(account_id, department, own_inbox, restricted)` holds
the per-workspace switches; a missing row is the built-in default (hr on/on,
the rest off/off), in SQL `department_own_inbox()` / `department_restricted()`
and in TS `DEPARTMENT_DEFAULTS`: `departments.test.ts` reads the migration.
Written only by `set_department_settings`. `docs/departments.md` is the contract.

- **Own inbox.** `conversations.inbox_department` is recomputed by the
  `zz_conversations_inbox_department` trigger (named to run last) from the
  assignee's department, else the owner's (`user_id`), NULL when that
  department has no own inbox; profile and settings changes recompute too.
  Splitting the list is UI-level: RLS is unchanged, so it hides nothing.
- **Restricted** people cannot open the sales areas
  (`RESTRICTED_PATHS`); owners and admins never are. Enforced by the
  dashboard layouts and API guards, not by RLS.
- **UI.** Settings -> Members (department select, PATCH
  `/api/account/members/[userId]` `{ department }`) and Settings ->
  Departments (`departments-panel.tsx`). `verify-departments.sql`.
