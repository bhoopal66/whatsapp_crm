> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Auth and roles

- `lib/auth/roles.ts` — pure role ladder (`owner > admin > team_leader > agent >
  viewer > bank_guest`) mirroring the SQL `is_account_member(account_id, min_role)` CASE
  expression. Capability predicates (`canManageMembers`, `canEditSettings`, …)
  are the single source of truth; never compare role strings inline.
- `bank_guest` (rank 0, migrations 082–083) is a partner bank's login.
  `current_account_id()` is NULL for a guest, so every account-wide
  policy denies them; access is opt-in per table (team chat, deal rooms).
  `ASSIGNABLE_ROLES` and `STAFF_ROLES` leave it out.
- One login can hold a profile in several workspaces, the active one
  marked `is_active`; see **Workspaces** below.
- `lib/auth/account.ts` — **server-only**. API routes call
  `await requireRole('admin')` for a loaded context (`supabase`, `userId`,
  `accountId`, `role`) and `return toErrorResponse(err)` in one catch.
- `lib/auth/conversation-visibility.ts` — client-side mirror of the
  `can_view_conversation` / `can_view_contact` SQL functions (migrations 042 and
  043). It informs UI decisions only; the DB decides. Change one, change both.
  Since 217, `conversations_select`, `messages_select` and `messages_modify`
  restate `can_view_conversation` / `can_view_personal_chat` as set
  membership over `contact_visibility_people()` and
  `personal_number_visible_ids()`, because the per-row calls timed out for
  leaders and agents. A change to either function changes those three
  policies too; `verify-conversations-select-set-based.sql` compares them.
- **A contact's owner follows its chat (migration 169).** `contacts.user_id`
  is the owner, not the creator: assigning the chat to a live staff member
  of the account moves it (`conversations_move_contact_owner`, any writer;
  unassigning leaves it, and an UPDATE that also changes `contact_id` moves
  nothing). The creator is `contacts.created_by`: `auth.uid()` on insert,
  else `user_id`, then frozen by a trigger; nothing displays it.
  `verify-contact-follows-assignment.sql`.
- **Deactivation (migration 069)** is `profiles.deactivated_at`, set
  only through `set_member_active` (PATCH `/api/account/members/[id]`
  `{ active }`), which the route pairs with a GoTrue ban. The ban stops
  sign-in and refresh; `is_account_member` / `current_account_id` /
  `current_role_rank` ignoring the profile is what neuters an access
  token issued before it, and the profile guard trigger stops a
  deactivated admin's RPCs. Since 199 a trigger on the NULL → time
  transition takes them off their team (member or leader) and unmaps
  their `pbx_extensions` in that workspace, then re-runs the number
  sync; direct number allocations stay, and reactivating restores
  nothing. `supabase/ci/verify-member-deactivation.sql` asserts this.
- **Setting a member's password (migration 140)** is POST
  `/api/account/members/[id]/password`: `authorize_member_password_change`
  decides as the caller, then GoTrue changes it, then
  `log_member_password_change` (service role) writes an audit row in
  every workspace the person belongs to. The
  caller must strictly outrank the person in the active workspace **and
  in every other workspace the person belongs to**: one login opens them
  all. `canChangePasswordOf` mirrors only the first half (the roster
  cannot see other workspaces). `verify-member-password.sql`.
- **Editing a member's name and email (migration 167)** is PATCH
  `/api/account/members/[id]/details`: `authorize_member_details_change`
  (140's rule), then GoTrue for a new email (`email_confirm: true`, put
  back if the profiles write fails), then the profiles rows, then
  `log_member_details_change`. `verify-member-details.sql`.
- **Guards (migration 265).** Both checks refuse an admin, not the owner,
  for someone another person lowered from admin or owner in the last 7
  days (`member_lately_admin`, read from `workspace_audit`): lowering a
  role must not be the way to a login. `set_member_role`,
  `set_member_active` and `transfer_account_ownership` lock the target
  before reading its role. `profiles_reset_grants` drops the call-review,
  personal-number and department grants when a profile row moves to
  another workspace: a new per-workspace grant on `profiles` joins it.
  `verify-guards.sql`.
- Client side: `hooks/use-auth.tsx` (profile/account context),
  `hooks/use-can.ts` and `components/auth/require-role.tsx` for gating.
