# Workspaces

A **workspace is an account**: its own contacts, chats, WhatsApp numbers,
deals, teams and settings. Since migration 083 one person can belong to
several workspaces — for example Taamul Credit and TrafeeqPay — with one
login.

## One login, one membership per workspace

Each membership is its own `profiles` row (one per user and account),
with its own role and its own deactivation. Exactly one of a person's
rows is **active**: the workspace they are working in. Every RLS policy
reads the active row (through `is_account_member()`,
`current_account_id()` and `current_role_rank()`), so everything a person
sees and changes belongs to their active workspace. The one exception is
the bell: Notifications lists the person's notifications from every
workspace where their membership is live and that is not archived
(`my_live_account_ids()`), and its badge and "Mark all as read" cover
them all. Name, email and avatar
are kept the same on all of a person's rows.

## Switching

Switching lives in one place: **Settings → My account → Workspaces**
(`?tab=workspaces`). It lists every workspace the person belongs to, with
their role there, team-chat unread and mentions, and an Active badge on
the current one; **Switch** calls `POST /api/workspaces/switch`, which
calls `switch_account()`. Owners and admins create a workspace from the
same screen. The sidebar names the active workspace but no longer
switches (the workspace rail at its left edge is gone).

- The whole app follows the active workspace. A switch reloads the app
  on the new workspace's landing page (the dashboard, or team chat for a
  bank guest), so lists, caches and live updates start over there.
- The active workspace belongs to the person, not to a browser tab. Two
  tabs therefore share it: other tabs in the same browser reload into
  the new workspace when one switches. A session on another device
  reads the new workspace's data straight away and shows it fully on
  its next page load.
- A notification from another workspace carries that workspace's name.
  Opening it switches there and opens its screen, chosen with the
  person's role in that workspace. The address is always a path inside
  the app, and a bank guest still lands in team chat.
- Teams and number allocations belong to a membership and survive
  switching.
- A deactivated membership cannot be switched to.

## Roles

Each membership has one role: Owner, Admin, Team leader, Agent, Viewer
(unchanged), or **Bank guest** (migration 082).

A bank guest is an officer of a partner bank, not one of the workspace's
staff. A guest:

- sees **team chat only**, plus Settings → Workspaces to switch
  workspace. The app keeps a guest on `/chat` and `/settings`: any other
  address goes back to `/chat`, Settings shows a guest the Workspaces
  section and nothing else (any other `?tab=` lands there), the sidebar
  shows no other screen, and the account menu offers Workspaces and
  Sign out. A guest's notifications still open team chat only. Team chat itself is still being set
  up, so for now the screen says so.
- reads none of the inbox, contacts, deals, tasks, numbers, members or
  settings. This is enforced by the database, not by the screens: a
  guest has no `current_account_id()` and is never an
  `is_account_member()`, so every account-scoped policy is closed to
  them. Hiding links is only presentation.
- is never offered as an assignee, team member or number user: those
  lists show staff only.
- carries a bank code naming their bank (`profiles.bank_code`, required
  for a guest and refused for anyone else).

## Creating a workspace and adding people

- **New workspace:** an owner or admin creates one with
  `POST /api/workspaces` (name, and a short name of 1–4 letters or
  digits, `create_workspace()`). The creator becomes its owner and is
  switched into it, so the people invited in the same request are added
  there.
- **Existing people:** in the new workspace, Settings → Members adds a
  person by email (`add_workspace_member()`) with a role — Bank guest
  needs a bank code. Someone who already has a login keeps it and gains
  a membership; an unknown email gets a new login. The new membership
  does not become the person's active one unless they have no other.
- **Who can add people (migration 175):** only an owner or admin of the
  active workspace, with any role but owner. Team leaders could add
  agents and viewers from migration 099 until 175 took it back; agents,
  viewers and bank guests never could. The rule is held twice, for both
  add-by-email and invite links: in the API routes (`canInviteMembers`,
  `canGrantRole`; a team leader gets 403 "requires the admin role or
  higher") and in the database (`add_workspace_member()`, and the
  `account_invitations` policies, which are admin-only). Settings →
  Members is hidden from everyone below admin. Changing a role,
  deactivating, removing, transferring ownership and creating
  workspaces are owner/admin only too.
- **A link dies with its creator's right to grant it.**
  `redeem_invitation()` checks, at redemption, that the link's creator
  still has a live (not deactivated) membership in its workspace as an
  owner or admin. A link whose creator was demoted, deactivated or
  removed, or whose login was deleted, is refused as "Invitation has
  expired" — and so is a link a team leader made before 175. The
  `/join` page's preview does not apply this check, so such a link
  still previews as valid and is refused on Accept.
- **Who can add an existing login:** only an owner or admin of a
  workspace where that person is an active (not deactivated) member —
  for example an owner bringing their RM from workspace A into
  workspace B. For any other registered address the answer is the same
  as for an unknown email, so nobody can test whether an address has a
  login; creating a login for it then fails with "This email already
  has a login. An administrator of one of that person's workspaces can
  add them here."
- **Removal from the only workspace:** the person keeps their login and
  is moved to a new, empty workspace of their own — as a viewer (a bank
  guest stays a bank guest), never as its owner or an admin, and with
  any deactivation cleared. They cannot add people or create
  workspaces from there; an invitation brings them back.

## Deactivation

Deactivation (Settings → Members) is **per workspace**: it closes one
membership and leaves the person's others alone.

- If the person is working in the workspace that deactivated them, the
  app moves them to another workspace that is still open to them.
- The login itself is banned (sign-in and token refresh refused) only
  when no active membership remains; then the app signs them out.

## Setting a member's password

An owner or admin sets another member's password from Settings →
Members (the key button on their row). The new password is shown in
plain text and starts as a suggestion, as in Add person, so it can be
passed on. `POST /api/account/members/[userId]/password` asks
`authorize_member_password_change()` (migration 140) first, as the
caller, and calls GoTrue only once it agrees:

- The caller is a live owner or admin of their active workspace, and it
  is not their own password (theirs is Settings → Login & security).
- The person has a membership there, deactivated or not, and the caller
  strictly outranks them: an admin sets a team leader's, agent's,
  viewer's or bank guest's password, never another admin's or the
  owner's; the owner sets anyone's.
- **Every other workspace counts too.** One login opens every workspace
  it belongs to, so a password set from one workspace would open the
  others. In each other workspace where the person has a membership
  (live or deactivated, archived or not), the caller needs a live owner
  or admin membership that outranks them there. Otherwise the change is
  refused and the person changes it themselves.
- A password is 8 characters to 72 bytes (bcrypt's limit). GoTrue may
  still refuse one it finds weak.
- The change is recorded as `password_changed` (below) in the audit log
  of every workspace the person belongs to. Whether sessions the person
  already has survive depends on the GoTrue version; to cut someone off
  at once, deactivate them.

## Editing a member's details

An owner or admin edits another member's full name and login email
from Settings → Members. `PATCH /api/account/members/[userId]/details`
`{ full_name, email }` asks `authorize_member_details_change()`
(migration 167) first, as the caller, with the same rule as setting a
password (above): a live owner or admin of the active workspace, never
for themselves (their own are Settings → Profile), strictly outranking
the person there and in every other workspace the person belongs to.

- The name and email are one identity shared by all of the person's
  workspaces (083 copies them to every membership), so an edit shows
  in each of them.
- A new email changes the login at once: the person signs in with it
  from then on, and no confirmation mail is sent. An address another
  login already has is refused, and then nothing is changed.
- A name is 1–120 characters; the email is stored lower-cased.
- The login's email is the one compared and, if the save fails half
  way, restored: it can differ from the members list when the person
  changed it themselves in Settings → Profile, and saving then brings
  the list in line. If two admins change the email at once, the second
  save is refused (409) and the login is matched to what the list shows.
- Anything that finds a person by email follows the new address: the
  submission tracker names group staff by login email
  (`sg_staff_by_email`) and the Compass push matches agents by exact
  email. Change an address there too, or those lookups stop finding
  the person (or find someone else).
- The change is recorded as `details_changed` (below) in the audit log
  of every workspace the person belongs to; a save that changes nothing
  writes nothing.

## Renaming

An owner or admin renames their active workspace in Settings → Workspace →
General, which sends `PATCH /api/account` `{ name?, short_name? }`
with only the fields that changed: the name, and the short name of 1–4
letters or digits shown on its tile in Settings → Workspaces.
The write runs as the caller, so the `accounts_update` policy holds it
to the workspace's owners and admins; for anyone else nothing changes.
Before migration 092 the short name could not be saved at all (nor
Settings → Team chat's on/off switch): the column grant on `accounts`
predated both columns.

## Audit log

`workspace_audit` (migration 092) records who changed a workspace's
people and settings. Triggers on `profiles` and `accounts` write it, so
every writer is covered: the member RPCs, `PATCH /api/account`, the
service role, a hand-run UPDATE. One row per change:

| action                                      | when                                                           | detail                                                                |
| ------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `member_added`                              | a membership is created, or moved in from another account      | `role`, `name`, `bank_code` (guests)                                  |
| `member_removed`                            | a membership is deleted, or moved to another account           | `role`, `name`                                                        |
| `role_changed`                              | the role changes (an ownership transfer records both people's) | `from`, `to`                                                          |
| `member_deactivated` / `member_reactivated` | deactivation is set or lifted                                  | —                                                                     |
| `bank_changed`                              | a guest's bank code changes                                    | `from`, `to`                                                          |
| `workspace_renamed` / `short_name_changed`  | the name or short name changes                                 | `from`, `to`                                                          |
| `ownership_transferred`                     | `transfer_account_ownership()`; the target is the new owner    | `from_user_id`                                                        |
| `team_chat_enabled` / `team_chat_disabled`  | Team chat is switched on or off                                | —                                                                     |
| `password_changed`                          | an owner or admin set the person's password (see below)        | `name`                                                                |
| `details_changed`                           | an owner or admin edited the person's name or login email      | `name`, `changed`, `name_from` / `name_to`, `email_from` / `email_to` |

- **Actor** is the signed-in caller (`auth.uid()`), or empty for the
  server: the service role, which also provisions new logins
  (`provision_account_member`), and anything run without a session.
- **`password_changed`** is the one row no trigger writes: the password
  lives in `auth.users`. The route records it through
  `log_member_password_change()` (service role only) once GoTrue has
  accepted the change, with the admin as the actor, so a refused or
  failed change is never logged. It writes one row in every workspace
  the person belongs to, since the login opens them all.
- **`details_changed`** is written the same way, through
  `log_member_details_change()` once the new name or email is saved.
  `changed` lists `full_name` and/or `email`; only the changed pairs
  are recorded.
- **Not recorded:** workspace switches (`is_active`), the name, email
  and avatar edits a person makes to their own profile (Settings →
  Profile; an admin's edit is `details_changed`), and a membership
  that disappears with its deleted
  account. A move between accounts (removal from someone's only
  workspace, an invitation redeemed by a new login) records both sides;
  when the new login's empty personal account is then deleted, only the
  joining side remains.
- **Where:** Settings → Privacy & compliance → Audit log, source _Workspace_, merged
  with the team chat, recording, phone and deal room logs. An empty
  actor shows as _System_; a person who has since left the workspace
  is named by the `name` the row recorded.
- **Who reads it:** the workspace's live owners and admins, while it is
  their active workspace. Agents, viewers, bank guests and other
  workspaces' admins read nothing.
- **Append-only:** no client, not the service role and not the table
  owner can change or delete a row (or truncate the table). Rows go
  only when their workspace is deleted.

## Migrations

- `082_account_role_bank_guest.sql` adds the `bank_guest` role. Its own
  file because a new enum value cannot be used in the transaction that
  adds it.
- `083_workspaces.sql` makes `profiles` one row per (user, account) with
  `is_active` (one per person) and `bank_code`; adds
  `accounts.short_name`; points the three RLS helpers at the active row
  and ranks a guest 0; adds `switch_account()`, `my_workspaces()`,
  `create_workspace()` and `add_workspace_member()`; and moves the member
  RPCs (role, deactivation, ownership, removal, invitations,
  provisioning) onto one membership each.

- `092_workspace_audit.sql` adds the audit log above and grants
  `UPDATE (short_name, internal_chat_enabled)` on `accounts` to signed-in
  users (the policy still limits the write to admins). Like 087 and 088
  it must be applied as a superuser or BYPASSRLS role.

- `140_member_password_change.sql` adds
  `authorize_member_password_change()` (signed-in callers),
  `log_member_password_change()` (service role only) and the
  `password_changed` audit action. Like 092 it must be applied as a
  superuser or BYPASSRLS role. `verify-member-password.sql` asserts it.
- `167_member_details_change.sql` adds
  `authorize_member_details_change()` (signed-in callers),
  `log_member_details_change()` (service role only) and the
  `details_changed` audit action. Like 140 it must be applied as a
  superuser or BYPASSRLS role. `verify-member-details.sql` asserts it.

Apply 082, then 083, each in its own run. All of them are re-runnable.

## Archiving a workspace (migration 105)

An owner can archive a workspace, and restore it later, with
`POST /api/workspaces/archive { accountId, archived: true | false }`
(`archive_workspace`). Nothing is deleted. The caller needs a live owner
row in that workspace; it need not be the active one, so an archived
workspace is restored from another.

Archiving is refused, with a 409 and a `code`, while:

- the owner has no other live, non-archived workspace to move to
  (`no_other_workspace`);
- a WhatsApp number or the phone system is still connected
  (`channels_connected`): disconnect them first, or inbound messages and
  calls keep landing in a workspace nobody can open;
- another workspace's phone system still routes a number or maps an
  extension to it (`calls_routed_here`; the error names them): its
  calls, missed-call tasks and bells would land there too. They are that
  workspace's settings, so they are not removed for you: remove them in
  its phone settings first;
- a live member, staff or bank guest, has no other workspace
  (`members_stranded`, with `count`): deactivate or remove them first.

Otherwise, in one step: the workspace's pending invite links are
revoked, and everyone working in it is moved to the first of their
other live workspaces by name (the switcher's order). The response says
where the caller now is (`activeAccountId`, `activeRole`); the app
reloads into it.

While archived, nobody can switch into it or redeem a link to it, and
nothing else makes someone active there, so no screen reads its data. A
deactivated member left active there (they had nowhere to go) cannot be
reactivated there either. No WhatsApp number, phone system, DID route
or extension can be connected to it, including by a connect that was in
flight when the archive committed. Its notifications leave every
member's bell, and its API keys answer `401 unauthorized`, so the
public API, the MCP server and Compass stop (and its outbound webhooks
with them); the keys work again once it is restored. Owners still see
it in the workspace list (`archived: true`); nobody else does. Restoring clears the archive only: members switch back
in themselves, and revoked links stay revoked. Both are recorded in the
audit log (`workspace_archived`, `workspace_restored`).

On screen, an owner archives the workspace they are in from Settings →
Workspace, after a confirmation that lists what happens and what to do
first; a refusal names its reason there. The same panel, in another
workspace where they are an admin or owner, lists the archived
workspaces they own, each with Restore. In Settings → Workspaces an
archived workspace is listed, marked Archived, with no Switch button.
