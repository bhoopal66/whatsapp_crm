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

`customer.name` (Compass sends the company) is stored on the group
(`submission_groups.customer_name`, migration 141) and shown as the case's
customer; the CRM contact found or created by phone keeps its own name.

Only `submission_id`, `customer.phone` and `agent_email` are required. The
call is idempotent per `submission_id`: a repeat returns the existing group
(`200`). A new group answers `201`. If WhatsApp could not create the
group yet, the answer is `202` with `whatsapp.pending: true` and the
cron finishes it. Errors: `409 consent_required`, `422 unknown_user`,
`duplicate_user`, `no_whapi_number`, `channel_not_allowed`.

When the case reaches a final status the app reports it with `PATCH
/api/v1/submission-groups/{submission_id}` `{ "status": "APPROVED" }`.

## Without a WhatsApp group (migration 136)

Opening the WhatsApp group is a per-workspace switch,
`case_account_settings.submission_whatsapp_groups` (**Settings → Cases →
Open a WhatsApp group for each submission**), **off by default**; only
owners and admins change it (`case_settings_set_whatsapp_groups`).
Each row carries `submission_groups.wa_mode`, fixed at creation:

- `group` — everything on this page, as before 136 (every older row).
- `none` — the row is only the CRM's record of the submission: `ACTIVE`,
  with its customer contact but no hosting number (`channel_id` NULL),
  never a `wa_group_id`, never a create claim. `sg_send_begin` refuses
  it and nothing is stored: a case reply answers `409
  NO_WHATSAPP_GROUP` ("This submission has no WhatsApp group"), a
  documents request `409 REFUSED` with `refusal: "NO_WHATSAPP_GROUP"`. `sg_end` works as usual: a final status ends the
  row and closes the case, with no WhatsApp close (`closed: false`,
  `close_deferred: false`).

With the switch off, a **new** submission is opened as `none`: staff
emails are still resolved (`unknown_user`, `duplicate_user`), but no
Whapi number is looked up (no `no_whapi_number` /
`channel_not_allowed`; a body `channel_id` is ignored), consent is not
checked because nothing is sent to the customer, there is no invite, and
the answer is `201` (a repeat `200`), never `202`. With it on, a new
submission is a `group` row. Turning the switch on or off never changes
an existing row. The case page's Conversation tab says the case has no
WhatsApp group instead of offering a composer. The internal `/submission-groups` screens do the same: a `none` row
shows a "No WhatsApp group" badge instead of "Setting up", an info
banner instead of the pending, create-error and number-removed notices,
no composer and no Retry create (the views expose `wa_mode`; `pending` is
true only for `group` rows).

## Who is in the WhatsApp group

- the **hosting Whapi number**: `channel_id` if given (it must be a Whapi
  number the agent may use), else the agent's own number as a new chat
  would pick it (allocation rules of migration 060);
- the **customer**, found or created as a contact by phone;
- every **coordinator of the case's bank** (`bank`) who has a saved
  WhatsApp number (Settings → Members, migration 142): live agents and
  team leaders set up as coordinators of that bank;
- optionally the **coordinator's own phone** (`coordinator_phone`).

The coordinator numbers are the bank's first, then `coordinator_phone`,
each once, never the customer's own number, at most 5 in all. They are
fixed when the group is created (`submission_groups.coordinator_phones`):
a coordinator added to the bank later does not join an existing group,
and a message from any of these numbers is logged as the coordinator's.
Groups-off submissions (`wa_mode 'none'`) look nothing up.

The group's name is `subject` when Compass sends one; otherwise it
defaults to `<company> x Taamul Credit`, the company being
`customer.name` (the customer's phone when no name is sent).

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

When a WhatsApp group is opened for a submission with a `bank`, every
coordinator of that bank is added to the list as a Coordinator too
(142), whether or not they have a saved number; someone the request
already names keeps the label the request gave them.

## The prefix

Every staff message goes out from the hosting number as
`Name (Label): text`, for example `Sam Ali (Coordinator): documents
received`. Staff cannot send as themselves.

## Who reads and sends, and when

| State      | Read                                                                                                         | Send                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **ACTIVE** | anyone on the open access list; owners and admins of the workspace                                           | anyone on the open list (an admin only if on it) |
| **ENDED**  | owners and admins; a coordinator or team lead who was on the list at the end, for **60 days** after it ended | nobody                                           |

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

## Cases

Every group has one **case** (module 018c, migrations 122-128): bank,
product, amount, stage, tasks, documents and SLA timers, worked at
`/cases`. The contract is in [cases.md](cases.md).

- `POST` opens the group's case (also on a repeat call) and takes optional
  `bank`, `product` and `amount`; an owner or admin can open the case of an
  older group from the CRM.
- A move of the case to a final stage (Approved, Declined, Withdrawn,
  Closed) ends the group, exactly once; the cron retries an end that did not
  complete.
- A `PATCH` with a final status ends the group as above and also moves the
  case to the matching final stage, even when the group had already ended.

### Sync from the submission app (migration 134)

The same `PATCH` can report the case itself: `changed_at`, `stage`,
`outcome_reason`, `bank`, `product`, `amount`, `compass_url` and
`documents`, with `status` optional. It is applied in one call
(`case_sync_from_submission`), stale updates are ignored by `changed_at`,
and the answer adds a `sync` block. A sync that moves the case to a final
stage ends an active group. `GET /api/v1/case-stages` and
`GET /api/v1/case-documents` give the stage and document lists to validate
against. The group lifecycle (`submission_group.ready`, `.failed`,
`.ended`) is also sent to subscribed webhook endpoints. Contract and
rules: [compass.md](compass.md) and [public-api.md](public-api.md).

### Managed in Compass

With the account switch **Submitted cases are managed in Compass** on
(Settings -> Cases), people in the CRM cannot change a submitted case's
stage, bank, product, amount, outcome reason or document received/rejected
status (409 `MANAGED_EXTERNALLY`). Notes, tasks and the rest stay open,
and this API is never locked. See [cases.md](cases.md).

## Known limits

- If WhatsApp accepts a staff message but the CRM fails to record that
  twice in a row, the sender is told "sent, but not recorded" and the
  stored copy stays pending. Whapi echoes every send back to the webhook,
  and that echo reconciles it: when no message of the group carries the
  echo's id yet and exactly one pending staff message of the group,
  written in the last 15 minutes and not after the echo, has exactly the
  echo's text (name and label prefix included), it is marked sent with
  that id. Two such messages (the same text sent twice) are left pending,
  because the echo cannot say which one it is. Only when the echo never
  settles it does the cron mark the copy failed after 10 minutes,
  although the customer has it. If the gateway call errors after the echo
  already marked the message sent, the sender is told "sent, but not
  recorded", not that it failed. An echo is never stored as a customer message; a media echo is
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
