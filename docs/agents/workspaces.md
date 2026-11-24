> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Workspaces (`lib/auth/my-workspaces.ts`, migrations 082–083)

A workspace is an `accounts` row, and a person holds one `profiles` row per
workspace (`UNIQUE (user_id, account_id)`). `is_active` marks the one they
work in, at most one per person (`profiles_one_active_per_user`, not
deferrable, so every write demotes before it promotes). Every existing policy
still means "the caller's **active** account": `is_account_member` and
`current_account_id` read only the active, live (`deactivated_at IS NULL`),
non-guest row, `current_role_rank` the active live row. Someone deactivated in
B but active in A reaches nothing of B. `docs/workspaces.md` is the operator
contract.

- **A read by `user_id` alone is multi-row now.** In SQL a scalar subquery
  raises "more than one row returned", so scope it to the account or
  `is_active`. In TS `.maybeSingle()` errors and `rows[0]` is arbitrary: go
  through `pickActiveProfile` (`lib/auth/active-profile.ts`).
- **Switching** is `switch_account()` (a live row there, guest rows included)
  behind `POST /api/workspaces/switch`, which authenticates by session only
  because `getCurrentAccount` 403s a deactivated active row. `is_active` and
  `bank_code` are guarded columns: only `switch_account`,
  `redeem_invitation` and `archive_workspace` raise `app.account_switch`.
- **Member RPCs** take the account from the caller's active row and touch only
  the target's row there. `remove_account_member`, `redeem_invitation`,
  `provision_account_member` and `add_workspace_member` take the per-person
  row lock `switch_account` takes (`… WHERE user_id = … ORDER BY id FOR
  UPDATE`).
- **`add_workspace_member`** also takes back somebody this workspace removed
  (`workspace_audit`) whose only row is their disposable private account
  (306; a removed admin by the owner only). Else it
  adds only someone live in a workspace where the
  caller is a live owner/admin; an unknown email and an ineligible one raise
  the same P0002 `no_such_user`.
- **Removing someone's only membership** moves their row to a fresh account as
  `viewer` (a bank guest stays a guest, `bank_code` and all), never owner.
- **Deactivation is per workspace.** The GoTrue ban fires only when no other
  live row is left; otherwise the client moves to `fallbackWorkspace` instead
  of signing out.
- `my_live_account_ids()` (every live row, active or not, in a workspace
  that is not archived) scopes the `notifications` policies, so the bell
  covers every workspace.
  `ts_is_account_admin` needs the caller's active live row; the four-eyes
  proposer it is asked about need only be live there.
- Staff↔guest is a removal plus `add_workspace_member`, never a role edit.
  `verify-workspaces.sql`.
- **Archive (105).** `accounts.archived_at` is written only by
  `archive_workspace` (a live owner there, from any of their rows, so
  restore works from elsewhere). It refuses while a WhatsApp number or the
  PBX is connected, while another workspace's PBX routes or extensions
  point at it, while anyone works only there, or when the owner has
  nowhere to go. It moves everyone active there to another live workspace
  and revokes its invitations. Nobody becomes active in an archived
  workspace: `switch_account`, `redeem_invitation` and
  `remove_account_member` skip it, and a profiles trigger refuses every
  other writer, reactivation included. Triggers refuse connecting a number,
  PBX, route or extension to it. Its API keys answer 401 without counting
  toward the IP lockout (the per-key rate limit still applies).
  `chat_user_role` and `my_live_account_ids` leave it out, so its team chat
  and bells close until restore.
