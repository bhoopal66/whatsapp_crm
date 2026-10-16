# Submission groups

An external **submission application** opens one WhatsApp group per
submitted case, through the public API. The group runs on a Whapi number;
staff work it from the CRM. This is the operator contract for module 018a
(migration 115, `lib/submission-groups/*`). It is separate from
[WhatsApp groups](whatsapp-groups.md) (migration 114): different tables,
different screens, and nothing here reaches the inbox, flows,
automations, the AI or outbound webhooks.

## How the submission app triggers it

An API key with the `submission_groups:write` scope (and
`submission_groups:read` for lookups) calls `POST
/api/v1/submission-groups` when an agent submits a case. The contract is
in [public-api.md](public-api.md).

```json
{
  "submission_id": "SUB-10482",
  "customer": { "phone": "+971501234567", "name": "Jane Doe" },
  "agent_email": "agent@example.com",
  "coordinator_email": "coord@example.com",
  "team_lead_email": "lead@example.com",
  "coordinator_phone": "+971507654321",
  "subject": "Jane Doe - SUB-10482",
  "channel_id": "3f2c0c1e-0000-4000-8000-000000000000"
}
```

Only `submission_id`, `customer.phone` and `agent_email` are required. The
call is idempotent per `submission_id`: a repeat returns the existing group
(`200`). A new group answers `201`. If WhatsApp could not create the
group yet, the answer is `202` with `whatsapp.pending: true` and the
cron finishes it. Errors: `409 consent_required`, `422 unknown_user`,
`duplicate_user`, `no_whapi_number`, `channel_not_allowed`.

When the case reaches a final status the app reports it with `PATCH
/api/v1/submission-groups/{submission_id}` `{ "status": "APPROVED" }`.

## Who is in the WhatsApp group

- the **hosting Whapi number**: `channel_id` if given (it must be a Whapi
  number the agent may use), else the agent's own number as a new chat
  would pick it (allocation rules of migration 060);
- the **customer**, found or created as a contact by phone;
- optionally the **coordinator's own phone** (`coordinator_phone`).

If WhatsApp refuses to add the customer (privacy settings), the group
still exists and the group's invite link is sent to them 1:1 from the
hosting number. That invite is the one message this module sends without
storing it: it appears neither in the group's log nor in the inbox. Its
outcome is recorded on the group (migration 118): `invite_sent_at` when it
went out, or the reason it failed, and the group page's header shows
"Invite link sent to the customer" or "Invite link could not be sent".

## The access list and labels

Staff are named by **login email**: the agent (required), optionally a
coordinator and a team lead. Each must be a live agent, team leader,
admin or owner of the workspace (never a viewer or bank guest), and one
person holds one label per group. The label (Agent, Coordinator, Team
Lead) belongs to the group, not to the person's account role. Owners and
admins can change the list on an ACTIVE group.

## The prefix

Every staff message goes out from the hosting number as
`Name (Label): text`, for example `Sam Ali (Coordinator): documents
received`. Staff cannot send as themselves.

## Who reads and sends, and when

| State | Read | Send |
| --- | --- | --- |
| **ACTIVE** | anyone on the open access list; owners and admins of the workspace | anyone on the open list (an admin only if on it) |
| **ENDED** | owners and admins; a coordinator or team lead who was on the list at the end, for **60 days** after it ended | nobody |

Agents never read an ENDED group. An ENDED group's **messages** are read
only through the archive view, and **every archive view is written to an
audit log first** (who, when, which window); a refused view writes
nothing. Its details (submission id, customer, final status, the access
list at the end) stay listed, without an audit entry, for the same people
who may open its archive. Messages that
arrive after the end are kept but hidden from every live read.

## Ending

A group ends when its submission reaches a **final status** (`APPROVED`,
`DECLINED`, `WITHDRAWN`, `CLOSED`) via PATCH, or when an admin ends it
manually. Ending closes the access list. **Idle ending is off.** An
ended group never reopens.

## Closing on Whapi

After the end the number removes every other participant and then leaves
the group. A participant that WhatsApp shows only as a hidden `@lid`
cannot be removed and stays in the group after our number leaves. A PATCH answer reports `closed` or `close_deferred` (a send
was still in flight; the next call or the cron retries).

## The cron

The automations cron (`GET /api/automations/cron`, throttled to every 2
minutes) retries pending creates older than 2 minutes, fails sends still
pending after 10 minutes (one sweep over every workspace), and retries
closes that did not finish, one workspace at a time on that workspace's
own numbers. It starts no new work after 45 s.

## Consent

A contact who opted out, or is marked do-not-contact, cannot have a group
created (`409 consent_required`), and a staff send to them is settled
`blocked`. There is no opt-in register: only opt-out and do-not-contact
are checked.

## Removing a number or a contact

Removing the hosting number, or deleting the customer's contact, does not
block the delete. The group is detached (its number or contact becomes
empty): the archive and its audit survive, but sends are refused
(`NUMBER_REMOVED` / `CONTACT_REMOVED`), a pending create is not retried
and the WhatsApp close is not attempted.

## Known limits

- If WhatsApp accepts a staff message but the CRM fails to record that
  twice in a row, the sender is told "sent, but not recorded" and the
  stored copy stays pending. Whapi echoes every send back to the webhook,
  and that echo reconciles it: when no message of the group carries the
  echo's id yet, the group's oldest pending staff message of the last 15
  minutes with exactly the echo's text (name and label prefix included)
  is marked sent with that id. Only when the echo never arrives does the
  cron mark the copy failed after 10 minutes, although the customer has
  it. An echo is never stored as a customer message; a media echo is
  ignored.
- Whapi has **no idempotency key**. If a create succeeds but its response
  is lost, a retry can leave an orphan WhatsApp group.
- A customer's "stop" written in the group is **not watched** by the AI or
  TypeSafe; opt-outs there are recorded by a person.
- Delivery and read receipts for group sends are **not tracked**; a send
  is `sent` once Whapi accepts it.
- The 1:1 invite link is recorded only as `invite_sent_at` (or the
  failure reason); its text is not stored. A later failed attempt keeps
  the earlier `invite_sent_at`, and nothing records whether the customer
  then joined.
- Text only.
