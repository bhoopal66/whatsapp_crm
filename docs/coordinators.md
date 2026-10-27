# Coordinators

A **coordinator** is the employee who files a customer's application with a
bank. The agent finds the customer and collects the documents, then hands
the case over in the submission (Compass) application; the coordinator
submits it to the bank and contacts the customer when the bank needs
something. This is the operator contract for migration 133
(`133_coordinators.sql`, `lib/coordinators/*`).

## Who is a coordinator

Coordinator is not an account role. It is a live **agent** or **team
leader** whom an owner or admin has given one or more banks, in Settings ->
Members. The banks are the workspace's case banks (Settings -> Cases). One
bank can have several coordinators, and one coordinator can work several
banks. Clearing every bank makes the person an ordinary agent or team
leader again. Viewers and bank guests cannot be coordinators.

Apart from what is shared with them, a coordinator works exactly like an
agent or team leader of their role: their own chats, tasks, calls, team
chat, calendar and meetings (attend only; creating meetings stays team
leader and up). The submission group's **Coordinator** label
([submission-groups.md](submission-groups.md)) and a case's named
coordinator ([cases.md](cases.md)) are unchanged and independent of the
bank list.

## WhatsApp number

Owners and admins can save a WhatsApp number for each coordinator in
Settings -> Members, in the coordinator-banks dialog (migration 142). When a
submission's WhatsApp group is opened, every coordinator of the case's bank
who has a number is added to it. Clearing the number is allowed for anyone
in the account; setting it is owner and admin only.

## Sharing a chat

An agent (or anyone of agent rank and up who can see the chat) opens the
chat and uses **Share with coordinator**: pick the bank, then one of that
bank's coordinators. The coordinator gets a `conversation_shared` bell (and
push, if enabled), and the chat appears in their inbox labelled
**Shared · BANK**. A chat can be shared with several coordinators; with
each one under a single bank at a time (sharing again under another bank
replaces the share).

The coordinator may:

- read the chat and its messages;
- **reply** to the customer, only from the number the chat is on;
- read the customer's contact details.

The coordinator may not edit or delete the contact, edit or delete
messages, reassign or tag the chat, move it to another number, or use that
number for any other chat. The contact's calls, recordings, tasks, deal
rooms and memory stay under their usual rules. The agent stays the owner of
the chat. A coordinator's reply counts as a staff reply: it pauses the AI
auto-reply and clears the "Important" pin, as an agent's reply does.

A coordinator gets no push for the customer's new messages on a shared
chat (the inbox shows them live).

## How long a share lasts

Until it is revoked. The sharer, the coordinator, the chat's owner or
assignee, their team leader, or an owner or admin can revoke it from the
same dialog. A share also stops granting anything, without being revoked,
while the coordinator no longer holds that bank, is deactivated, or is
working in another workspace; giving the bank back restores it.

## API

Internal routes (`{ error }` on failure):

| Route                                                                                  | Who          | Does                               |
| -------------------------------------------------------------------------------------- | ------------ | ---------------------------------- |
| `GET /api/coordinators[?bank=CODE]`                                                    | agent and up | coordinators and their banks       |
| `PUT /api/account/members/[userId]/coordinator-banks` `{ bank_codes }`                 | owner, admin | replaces a person's banks          |
| `PUT /api/account/members/[userId]/coordinator-phone` `{ phone }`                      | owner, admin | sets or clears the person's number |
| `GET /api/conversations/[id]/coordinator-shares`                                       | agent and up | the chat's open shares             |
| `POST /api/conversations/[id]/coordinator-shares` `{ coordinator_user_id, bank_code }` | agent and up | shares; `{ id }`                   |
| `DELETE /api/conversations/[id]/coordinator-shares/[shareId]`                          | see above    | revokes; `{ revoked }`             |

Nothing is exposed through the public API (`/api/v1`).

## Database

Migration 133 must be applied as a superuser or BYPASSRLS role.
`coordinator_banks` and `conversation_coordinator_shares` are written only
through `set_coordinator_banks`, `share_conversation_with_coordinator` and
`revoke_conversation_share`. Access is the caller's granting shares,
`my_coordinator_shares()` (also the client's list of shared chats), added
beside the existing conversation, message and contact policies (SELECT,
plus a narrow messages INSERT through `coordinator_share_grants`);
`can_view_conversation` and `can_view_contact` are unchanged. A coordinator
reads a shared chat's reactions and events but cannot write reactions, and
never reads the contact's TypeSafe decision rows (`ts_log_read` and
`message_reactions_modify` state the normal visibility rule explicitly).
`supabase/ci/verify-coordinators.sql` asserts the rules.

Migration 142 adds `coordinator_phones`, written only through
`set_coordinator_phone`; `supabase/ci/verify-coordinator-phones.sql` asserts
it.
