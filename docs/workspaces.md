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

When a person belongs to more than one workspace, the sidebar shows the
active workspace's short name and name; its menu lists the others
(`POST /api/workspaces/switch`, which calls `switch_account()`).

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

- sees **team chat only**. The app keeps a guest on `/chat`: any other
  address goes back there, the sidebar shows no other screen, and the
  account menu offers only Sign out. Team chat itself is still being set
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
- **Who can add people (migration 099):** an owner or admin of the
  active workspace, with any role but owner; or a **team leader** of
  it, as an **agent or viewer** only — never admin, team leader, owner
  or bank guest. Both the add-by-email and the invite-link paths hold
  the same rule twice: in the API routes (`canGrantRole`) and in the
  database (`add_workspace_member()` refuses any other role with 42501
  before it looks the email up, and the `account_invitations` leader
  policies admit only agent/viewer links). A team leader sees and
  revokes only the invite links they made — a link's stored hash is
  enough to redeem it, so other people's links stay hidden — and
  cannot edit one, nor make one valid for more than the 365 days the
  API allows. Changing a role, deactivating, removing, transferring
  ownership and creating workspaces stay owner/admin only; Settings →
  Members shows a team leader the invite button and their own pending
  links, not "Add person" or the roster.
- **Only an owner or admin creates a login (099).** Whoever creates one
  chooses its password and claims its address, so a team leader brings
  a new person in with an invite link (which needs the person to have a
  login already, or an admin to create one). By email a leader adds
  only an existing login the rule below allows; for any other address
  `add_workspace_member()` answers them 42501 "This email is not a login
  you can add. Invite them with a link instead." — one answer for an
  unknown and an ineligible address, and never the P0002 on which the
  API creates a login. `POST /api/account/members` is rate-limited to
  30 a minute per caller, like creating invite links.
- **A link dies with its creator's right to grant it (099).**
  `redeem_invitation()` checks, at redemption, that the link's creator
  still has a live (not deactivated) membership in its workspace with a
  role that may give the link's role: owner or admin any, team leader
  agent or viewer. A link whose creator was demoted, deactivated or
  removed, or whose login was deleted, is refused as "Invitation has
  expired" — admins' links included. The `/join` page's preview does
  not apply this check, so such a link still previews as valid and is
  refused on Accept.
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

## Renaming

An owner or admin renames their active workspace in Settings → Team →
Workspace, which sends `PATCH /api/account` `{ name?, short_name? }`
with only the fields that changed: the name, and the short name of 1–4
letters or digits shown in the sidebar and the switcher.
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

| action                                      | when                                                           | detail                               |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `member_added`                              | a membership is created, or moved in from another account      | `role`, `name`, `bank_code` (guests) |
| `member_removed`                            | a membership is deleted, or moved to another account           | `role`, `name`                       |
| `role_changed`                              | the role changes (an ownership transfer records both people's) | `from`, `to`                         |
| `member_deactivated` / `member_reactivated` | deactivation is set or lifted                                  | —                                    |
| `bank_changed`                              | a guest's bank code changes                                    | `from`, `to`                         |
| `workspace_renamed` / `short_name_changed`  | the name or short name changes                                 | `from`, `to`                         |
| `ownership_transferred`                     | `transfer_account_ownership()`; the target is the new owner    | `from_user_id`                       |
| `team_chat_enabled` / `team_chat_disabled`  | Team chat is switched on or off                                | —                                    |

- **Actor** is the signed-in caller (`auth.uid()`), or empty for the
  server: the service role, which also provisions new logins
  (`provision_account_member`), and anything run without a session.
- **Not recorded:** workspace switches (`is_active`), name, email and
  avatar edits, and a membership that disappears with its deleted
  account. A move between accounts (removal from someone's only
  workspace, an invitation redeemed by a new login) records both sides;
  when the new login's empty personal account is then deleted, only the
  joining side remains.
- **Where:** Settings → Team → Audit log, source _Workspace_, merged
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

Apply 082, then 083, each in its own run. All three are re-runnable.

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
workspaces they own, each with Restore. On the rail an archived
workspace's tile is dimmed and does not switch.
