# Taamul Compass integration guide

This guide is for the team building the **Taamul Compass** (ERP) side
of the integration with **Taamul Connect** (the WhatsApp CRM). It
covers everything Compass needs to:

1. **Sync its customers** into Taamul Connect: one initial backfill,
   then a call each time a customer is created or changed.
2. **Send status notifications** to customers on WhatsApp, for example
   "your bank account application has been approved".
3. **Open submission groups and keep cases in step** (migration 134):
   Compass is the master of a submitted case, so it reports stage,
   details and documents with `PATCH`, and Taamul Connect tells Compass
   about leads, group lifecycle and opt-outs by webhook.

Everything here is plain HTTPS + JSON, so any language or HTTP client
works. In this document "Compass" is the submission tracker app where
agents submit cases and coordinators update their status.

---

## 1. How it works

```
 Taamul Compass                               Taamul Connect
 ──────────────                               ──────────────
 customer created/updated ──POST /compass/contacts──▶ compass_contacts table
                                                     (Compass's own table,
                                                      keyed by compass_id)

 application status changed ─POST /compass/notifications─▶ WhatsApp message
                                                     • always sent on the
                                                       Whapi number
                                                     • lands in the
                                                       customer's existing
                                                       chat, if there is one
                                                     • chat owner unchanged
```

**Customers go into a separate table.** Synced customers are stored in
`compass_contacts`, apart from the CRM's own contact list. Agents'
contact lists are not flooded with ERP records. A Compass customer is
linked to a CRM contact the first time Compass messages them.

**Notifications behave like this:**

| Rule                               | What it means for Compass                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Always the Whapi number**        | Messages are free-form text, so they are sent on the Whapi WhatsApp channel and never on the Meta Cloud API number. If Whapi is not connected, the call fails with `whapi_not_connected` and nothing is sent. It is never silently moved to the other number. |
| **Existing chat, owner unchanged** | If the customer already has a chat with an agent, the message is posted **into that same chat**. The chat and the contact **stay with that agent**: no reassignment, no ownership change. The agent sees the update in their own thread.                      |
| **New customers**                  | If no chat exists yet, one is created — unassigned, and owned by the account's default user (the admin who connected WhatsApp), the same as for any API-created chat. When the customer replies, it appears in the inbox for an admin to assign as usual.     |
| **Names are not overwritten**      | The name Compass sends is used only for a contact that doesn't exist yet. It never renames a contact an agent has already edited.                                                                                                                             |
| **At most once per key**           | Every notification carries an `idempotency_key`. Sending the same key twice never sends the message twice, so Compass can retry freely.                                                                                                                       |
| **No bot interruption**            | A notification does not pause a WhatsApp flow the customer is in the middle of.                                                                                                                                                                               |

---

## 2. One-time setup (done by a Taamul Connect admin)

1. **Apply the database migration.** Run
   `supabase/migrations/056_compass_integration.sql` against the
   Supabase project (self-hosters: see `CHANGELOG.md`).
2. **Check the Whapi channel is connected:** **Settings → WhatsApp → Connections**.
   Notifications cannot be sent without it.
3. **Create three API keys:** **Settings → Integrations → API keys → New API key**.
   Using separate keys means a large backfill can never use up the rate
   limit that urgent notifications need.

   | Key name                  | Scopes to tick                                                         |
   | ------------------------- | ---------------------------------------------------------------------- |
   | `Compass – customer sync` | `compass_contacts:write`, `compass_contacts:read`                      |
   | `Compass – notifications` | `compass_notifications:send`                                           |
   | `Compass – submissions`   | `submission_groups:read`, `submission_groups:write`, `webhooks:manage` |

   Each key is shown **once**. Copy all three into Compass's secret store
   (environment variables or a vault), never into source code.

4. Apply `supabase/migrations/134_compass_case_sync.sql` (as a
   superuser or BYPASSRLS role) for the case sync and the new webhook
   events.
5. Give the Compass team this document, the **base URL**, and the three
   keys.

Once Compass is live, admins can see what has arrived under
Integrations → **Compass** in the sidebar. It has two tabs: synced customers,
and every notification with its delivery status and any error.

---

## 3. Connection details

|                  |                                       |
| ---------------- | ------------------------------------- |
| **Base URL**     | `https://<your-crm-host>/api/v1`      |
| **Auth header**  | `Authorization: Bearer taamul_live_…` |
| **Content type** | `Content-Type: application/json`      |
| **Rate limit**   | 120 requests per minute **per key**   |

For development use `https://crm.taamul.ae/api/v1`. The samples below
use that host. Check a key works (any key, no scope needed):

```bash
curl https://crm.taamul.ae/api/v1/me \
  -H "Authorization: Bearer $COMPASS_SYNC_KEY"
```

### Response format

Every response has one of two shapes:

```json
{ "data": { … } }
```

```json
{ "error": { "code": "machine_code", "message": "Human-readable explanation" } }
```

Branch on `error.code`, which is stable. Only log `message`, because
its wording may change.

### Rate limiting

When a key goes over 120 requests/min, the API returns **429**
`rate_limited` with a `Retry-After` header (seconds). Wait that long and
retry. The `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset` headers are also returned.

---

## 4. Syncing customers

### `POST /compass/contacts` — create or update customers

Scope: `compass_contacts:write`

This one call handles both the **initial backfill** and **every later
change**. Records are keyed by `compass_id` (Compass's own customer
id), so:

- a new `compass_id` creates the record;
- a known `compass_id` **replaces** the record with what you send.

Sending the same record twice is therefore harmless.

**Request**

```json
{
  "contacts": [
    {
      "compass_id": "CUST-1001",
      "name": "Jane Doe",
      "phone": "+971 50 123 4567",
      "email": "jane@example.com",
      "company": "Doe Trading LLC",
      "attributes": {
        "branch": "Dubai Main",
        "customer_type": "individual",
        "relationship_manager": "A. Khan"
      }
    }
  ]
}
```

| Field        | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compass_id` | **yes**  | String or number, ≤ 200 chars. `42` and `"42"` are the same customer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `name`       | no       | ≤ 500 chars.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `phone`      | no       | **Must include the country code** (`+971…`). Spaces, dashes and brackets are fine. A local number such as `050 123 4567` is **rejected**: we can't guess the country, and a wrong guess would send a customer's bank details to a stranger. So are fewer than 10 or more than 15 digits (UAE `800` toll-free numbers excepted), more than 64 characters, spreadsheet notation (`9.71505E+11`) or a `.0` suffix, letters in the number, a +971 number that is not a mobile (`+971 5x` + 7 digits), a landline (`+971` + 8 digits) or a 600/800 service number, and any number that does not fit the numbering plan of the country code its first digits spell. A leading `00` is read as `+`, and a trunk `0` right after the country code is removed (except where numbers really start with 0, such as `+39 06…`). The same rule applies to `to` on notifications, and a stored phone that fails it is refused with `422 invalid_phone`. A customer without a phone can be stored but not messaged. |
| `email`      | no       | ≤ 500 chars.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `company`    | no       | ≤ 500 chars.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `attributes` | no       | Any JSON object (≤ 16 KB) for extra ERP fields you want kept alongside the record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

- **Up to 500 records per request.** Send larger sets in several
  requests.
- **Full replace:** each record replaces the stored one entirely. A
  field you leave out is cleared, and `attributes` is replaced
  wholesale, not merged. Always send the complete record.
- If the same `compass_id` appears twice in one batch, the **last** one
  wins.

**Response `200`**

```json
{
  "data": {
    "received": 3,
    "upserted": 2,
    "rejected": [
      {
        "index": 1,
        "compass_id": "CUST-1002",
        "error": "'phone' \"0501234567\" has no country code. Replace the leading 0 with the country code, e.g. +971 50 123 4567"
      }
    ]
  }
}
```

A bad record **does not fail the batch**. The good records are stored
and each bad one is listed in `rejected` with its position (`index`,
from 0) and the reason. Log these so the data can be fixed in Compass
and re-sent.

### `GET /compass/contacts` — list synced customers

Scope: `compass_contacts:read`

| Query param     | Meaning                                                |
| --------------- | ------------------------------------------------------ |
| `search`        | Match on name, phone or compass_id                     |
| `updated_since` | ISO 8601 timestamp; only records synced at or after it |
| `limit`         | 1–100, default 50                                      |
| `cursor`        | Pass back `meta.next_cursor` for the next page         |

```json
{
  "data": [
    {
      "compass_id": "CUST-1001",
      "name": "Jane Doe",
      "phone": "971501234567",
      "email": "jane@example.com",
      "company": "Doe Trading LLC",
      "attributes": { "branch": "Dubai Main" },
      "contact_id": "7c9e…",
      "created_at": "2026-09-23T08:00:00.000Z",
      "updated_at": "2026-09-23T08:00:00.000Z"
    }
  ],
  "meta": { "next_cursor": "MjAyNi0wOS0y…" }
}
```

Phones are returned as digits only, with no `+`. `contact_id` is set
once the customer has been messaged and has a chat.
`meta.next_cursor` is `null` on the last page.

### `GET /compass/contacts/{compass_id}` — read one

Scope: `compass_contacts:read`. URL-encode the id. Returns **404**
`not_found` if unknown.

### `DELETE /compass/contacts/{compass_id}` — remove one

Scope: `compass_contacts:write`. Removes the synced record only. Any
chat history with that customer stays in the CRM, because it is the
agents' working record. Returns `{ "data": { "deleted": true } }`, or
**404**.

### Recommended sync design

1. **Initial backfill:** page through all customers in Compass in
   batches of 500 and `POST` each batch. At 120 requests/min that is
   up to 60,000 customers a minute. If you get a `429`, honour
   `Retry-After`.
2. **Ongoing:** whenever a customer is created or edited in Compass,
   `POST` that one record (or a small batch), e.g. from an
   after-save hook or an outbox/queue.
3. **Retries:** because the call is an upsert, any failed or timed-out
   request can simply be sent again.
4. **Optional nightly reconciliation:** re-send customers changed in
   the last 24 hours. This covers any events that were lost.
5. **Deletions:** call `DELETE` when a customer is removed in Compass,
   if you want them removed here too.

---

## 5. Sending status notifications

### `POST /compass/notifications`

Scope: `compass_notifications:send`

**Request**

```json
{
  "idempotency_key": "APP-2291:approved",
  "compass_id": "CUST-1001",
  "text": "Dear Jane, your bank account application APP-2291 has been approved. Your account number will be shared within 2 working days.",
  "event": "application.status_changed",
  "reference": "APP-2291"
}
```

| Field                | Required           | Notes                                                                                                                                                                                  |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotency_key`    | **yes**            | ≤ 200 chars. **Unique per status change**, e.g. `"<application id>:<new status>"` or the id of the status-history row. Reuse the same key on a retry; use a new key for a new message. |
| `compass_id`         | one of these       | The synced customer. Their phone and name are looked up from the synced record.                                                                                                        |
| `to`                 | one of these       | A phone number with country code. If both are sent, `to` is used as the number (and `compass_id` still links the customer).                                                            |
| `text`               | yes for `text`     | The message, ≤ 4096 chars. WhatsApp formatting works: `*bold*`, `_italic_`, line breaks with `\n`.                                                                                     |
| `type`               | no                 | `text` (default), `document`, or `image`.                                                                                                                                              |
| `media_url`          | for document/image | A public **https** URL to the file, e.g. an approval letter PDF. `text` then becomes the caption (≤ 1024 chars).                                                                       |
| `filename`           | no                 | File name shown for a document, e.g. `approval-letter.pdf`.                                                                                                                            |
| `event`, `reference` | no                 | Your own labels (≤ 200 chars), stored and echoed back, shown in the admin screen.                                                                                                      |
| `name`               | no                 | Names the contact **only if it's new**. Existing contacts are never renamed.                                                                                                           |

**Response `201`: sent now**

```json
{
  "data": {
    "id": "5b1d…",
    "idempotency_key": "APP-2291:approved",
    "status": "sent",
    "delivery_status": "sent",
    "compass_id": "CUST-1001",
    "event": "application.status_changed",
    "reference": "APP-2291",
    "phone": "971501234567",
    "text": "Dear Jane, your bank account application …",
    "message_id": "0f3a…",
    "whatsapp_message_id": "wamid.…",
    "conversation_id": "a81c…",
    "contact_id": "7c9e…",
    "error": null,
    "created_at": "2026-09-23T09:15:00.000Z",
    "updated_at": "2026-09-23T09:15:01.000Z",
    "duplicate": false,
    "contact_created": false,
    "conversation_created": false
  }
}
```

- `conversation_created: false` means the message went into the
  customer's **existing** chat, which is still handled by the same
  agent.
- **`200` with `"duplicate": true`** means this key was already sent.
  Nothing was sent again, and you get the original result back. Treat
  it as success.

### `GET /compass/notifications/{idempotency_key}` — check one

Scope: `compass_notifications:send`. URL-encode the key. Returns the
same object without the last three fields. Use it after a timeout to
find out what happened before deciding anything.

- `status` is **our** processing state: `sending`, `sent`, or
  `failed` (with `error.code` / `error.message`).
- `delivery_status` is **WhatsApp's** progress once sent: `sent`, then
  `delivered`, then `read`, or `failed` if WhatsApp could not deliver
  it. It updates over time, so poll it later if you need read receipts.

### `GET /compass/notifications` — list

Scope: `compass_notifications:send`. Filters: `status`
(`sending`/`sent`/`failed`), `compass_id`. Pagination: `limit`,
`cursor`, same as the contacts list. Newest first.

### Error codes

| HTTP | `code`                      | Meaning                                                                                                                               | What Compass should do                                                                                     |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 400  | `bad_request`               | Invalid body: missing `idempotency_key`, no recipient, local phone number, text too long, etc.                                        | Fix the request. **Don't retry as-is.**                                                                    |
| 401  | `unauthorized`              | Missing, wrong, or revoked key                                                                                                        | Check the key; ask an admin for a new one                                                                  |
| 403  | `forbidden`                 | Key lacks the scope                                                                                                                   | Ask an admin to create a key with the right scope                                                          |
| 404  | `compass_contact_not_found` | Unknown `compass_id`                                                                                                                  | Sync the customer first, or send `to`                                                                      |
| 409  | `in_progress`               | The same key is being sent right now                                                                                                  | Wait a few seconds, then `GET` the key                                                                     |
| 409  | `whapi_not_connected`       | The Whapi WhatsApp channel isn't connected, or the Whapi number this customer's chat uses is logged out of WhatsApp. Nothing was sent | Alert an admin; retry later with the **same** key                                                          |
| 422  | `no_phone`                  | The synced customer has no phone                                                                                                      | Sync a phone for them, or send `to`                                                                        |
| 422  | `invalid_phone`             | The synced customer's phone is not a valid international number (it was stored before the sync enforced the rule). Nothing was sent   | Re-sync the customer with the full number and country code, or send `to`; then retry with the **same** key |
| 429  | `rate_limited`              | Over 120 requests/min on this key                                                                                                     | Wait `Retry-After` seconds, retry the same key                                                             |
| 502  | `whatsapp_error`            | WhatsApp refused or failed the send (e.g. the number isn't on WhatsApp, or the phone paired to Whapi is offline)                      | Retry later with the same key. If it keeps failing, check the number.                                      |
| 500  | `internal` / `db_error`     | Unexpected server error                                                                                                               | Retry later with the same key                                                                              |

A **failed** notification can be retried with the **same key**; it is
not treated as a duplicate. A **sent** one never sends again.

### Retry recipe

```
send(key):
    response = POST /compass/notifications { idempotency_key: key, ... }
    if 201 or (200 and duplicate):          done ✔
    if 400 / 401 / 403 / 404 / 422:         don't retry — log & fix data/config
    if 409 in_progress:                     wait 5 s, GET /compass/notifications/{key}
    if 409 whapi_not_connected, 429, 5xx,
       or network timeout:                  retry with the SAME key, with backoff
                                            (e.g. 30 s, 2 min, 10 min, 1 h)
```

Because the key is what prevents double sends, **never generate a new
key when retrying the same status change.**

---

## 6. Submissions

### `POST /submission-groups` — open a submitted case

Scope: `submission_groups:write`. Compass calls it when an agent submits
a case. It opens one submission per `submission_id` (idempotent per
account and `submission_id`) and the case that goes with it.

Whether that submission also gets a Whapi WhatsApp group is a workspace
switch, **Settings → Cases → Open a WhatsApp group for each submission**,
off by default (migration 136):

- **Off:** only the case is opened (`whatsapp.mode: "none"`). No Whapi
  number is needed (`no_whapi_number` and `channel_not_allowed` never
  happen and a `channel_id` in the body is ignored), nothing is sent to
  the customer, so an opted-out customer is not refused, and the answer
  is `201` (`200` on a repeat), never `202`.
- **On:** one Whapi WhatsApp group per submission (`whatsapp.mode:
  "group"`), returned with `whatsapp.invite_link` when WhatsApp would not
  add the customer directly.

A submission's mode is fixed when it is first opened: switching later
changes only new submissions. A final status (`PATCH`, below) on a
`"none"` submission ends it and closes the case; there is no WhatsApp
group to close. The full request and
answer are in [`public-api.md`](public-api.md#post-apiv1submission-groups);
the group rules are in [`submission-groups.md`](submission-groups.md).
If the contact has an open lead with the same bank, the submission
attaches to that lead.

## 7. Status, details and document sync

### `PATCH /submission-groups/{submission_id}`

Scope: `submission_groups:write`. Compass reports what changed on the
submission. Every key is optional, but a body needs `status` **or** at
least one sync key.

```json
{
  "changed_at": "2026-10-21T09:30:00Z",
  "status": "UNDER_REVIEW",
  "stage": "Under review",
  "outcome_reason": { "code": "KYC_AML", "text": "Passport expired" },
  "bank": "FAB",
  "product": "Personal loan",
  "amount": 150000,
  "compass_url": "https://compass.example.com/submissions/SUB-10482",
  "documents": [
    {
      "key": "passport",
      "status": "received",
      "file_ref": "DOC-77",
      "received_at": "2026-10-21T09:00:00Z"
    },
    { "key": "salary_certificate", "status": "rejected" }
  ]
}
```

| Key              | Rules                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changed_at`     | ISO 8601 date-time of the change **in Compass**. Always send it (see below).                                                                                                             |
| `status`         | 1 to 64 characters, stored as the group's `submission_status`. A final value (`APPROVED`, `DECLINED`, `WITHDRAWN`, `CLOSED`) ends the group. Any other value that names a stage of the case's bank list (`_` read as a space, case ignored: `UNDER_REVIEW` -> Under review) moves the case there, unless the same body sends `stage` (migration 137). Case screens show this value exactly as sent. |
| `stage`          | 1 to 64 characters; must be in the case's bank list (below).                                                                                                                             |
| `outcome_reason` | `{ code, text? }`. `code` is one of `INCOMPLETE_DOCS`, `CREDIT_POLICY`, `INCOME_INSUFFICIENT`, `KYC_AML`, `CUSTOMER_WITHDREW`, `OTHER`, `NO_RESPONSE`; `text` is at most 500 characters. |
| `bank`           | Bank code, `A-Z`, `0-9`, `_`, 2 to 32 characters. An unknown code is added to the account's banks.                                                                                       |
| `product`        | 1 to 200 characters.                                                                                                                                                                     |
| `amount`         | Number, 0 or more, 2 decimals.                                                                                                                                                           |
| `compass_url`    | `https://` URL of the case in Compass (at most 2048 characters). Shown as "Open in Compass" on the case page.                                                                            |
| `documents`      | Up to 100 of `{ key, status, file_ref?, received_at? }`. `status` is `requested`, `received` or `rejected`; `key` is 1 to 64 of `a-z`, `0-9`, `_`.                                       |

**Applied in one step, in order:** details (bank, product, amount, URL),
then stage, then outcome reason, then documents. A sync is applied on
active and ended groups alike. Sending the same values again changes
nothing.

**`changed_at` and stale updates.** Taamul Connect keeps the latest
`changed_at` it applied for the case. An update with an older
`changed_at` is **stale**: nothing is written and the answer is `200`
with `sync.applied: false, reason: "stale"`. A `status` in the same
body is ignored too (not recorded, never ends the group). So a retry or
an out-of-order delivery can never move a case backwards. Without
`changed_at` the update is always applied.

**Stage rules.** Get the valid list from `GET /case-stages` (next
section).

- The stage must be in the list of the case's bank **after** this call's
  bank change (`unknown_stage`, `stage_not_in_bank`).
- Never a pre-submission stage (Interested, Data collection, Review):
  `presub_reentry`.
- From `Closed` nothing moves (`case_closed`). From `Approved`,
  `Declined` or `Withdrawn` only `Closed` is allowed (`final_stage`).
- The same stage is a no-op.
- A move to `Approved`, `Declined`, `Withdrawn` or `Closed` is **final**:
  it closes the case, sets the outcome, and **ends the WhatsApp group**
  exactly as a final `status` does.

**Outcome reason.** Set once, and only when the case's outcome is
`Declined` or `Withdrawn`; `NO_RESPONSE` only on `Withdrawn`. Send it in
the same call as the final stage, or later.

**Documents.** The key must be a requirement of the case's (bank,
product) or already on the case (`GET /case-documents`). `received`
without a `file_ref` is stored with `file_ref: "external"`; a
`file_ref` is 1 to 128 of letters, digits, `.`, `_`, `:`, `-`.
`received_at` back-dates the change.

**Per-item refusals go to `sync.rejected`, never an error.** The rest of
the call is still applied. Each entry is `{ key, error }` where `key` is
the document key or `"outcome_reason"`:

| `error`                                                                        | Meaning                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `REASON_INVALID`, `REASON_TEXT_TOO_LONG`                                       | Unknown code, or text over 500 characters.                            |
| `OUTCOME_NOT_DECLINED`, `OUTCOME_REASON`                                       | The case is not Declined or Withdrawn; `NO_RESPONSE` needs Withdrawn. |
| `REASON_ALREADY_SET`                                                           | A reason is already stored.                                           |
| `DOC_KEY_INVALID`, `STATUS_INVALID`, `FILE_REF_INVALID`, `RECEIVED_AT_INVALID` | Malformed document item.                                              |
| `DOC_NOT_REQUIRED`                                                             | Not a requirement of the bank and product, not on the case.           |

**Answer (200).** The group (as in `public-api.md`) plus `ended`,
`closed`, `close_deferred`, `case: { id, stage, outcome }` and:

```json
{
  "sync": {
    "applied": true,
    "rejected": [{ "key": "outcome_reason", "error": "OUTCOME_NOT_DECLINED" }],
    "changes": ["bank_code", "stage", "document:passport"]
  }
}
```

`changes` lists what was written (`bank_code`, `product`, `amount`,
`external_url`, `stage`, `outcome_reason`, `document:<key>`). A stale
update gives `applied: false, reason: "stale"`; a group with no case
gives `applied: false, reason: "no_case"`.

**Errors**

| HTTP | `code`                                                                                            | Meaning                                                                 |
| ---- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 400  | `bad_request`                                                                                     | Malformed body, field out of range, or neither `status` nor a sync key. |
| 401  | `unauthorized`                                                                                    | Missing, wrong or revoked key.                                          |
| 403  | `forbidden`                                                                                       | Key lacks `submission_groups:write`.                                    |
| 404  | `not_found`                                                                                       | Unknown `submission_id`, or another workspace's.                        |
| 422  | `unknown_stage`, `presub_reentry`, `case_closed`, `final_stage`, `stage_not_in_bank`              | Stage refused. Nothing was written.                                     |
| 422  | `bank_invalid`, `product_invalid`, `amount_invalid`, `external_url_invalid`, `changed_at_invalid` | A value the database refused. Nothing was written.                      |
| 429  | `rate_limited`                                                                                    | Over 120 requests/min on this key.                                      |
| 500  | `internal`                                                                                        | Retry later with the same body.                                         |

A 422 never partly applies: fix the data and resend. A retry of a
timed-out call is safe because the same values change nothing.

## 8. Stage and document lists

Both need `submission_groups:read`. Use them to validate Compass's
status-to-stage and document maps before sending.

### `GET /case-stages?bank=FAB`

```json
{
  "data": {
    "bank": "FAB",
    "stages": [
      "Interested",
      "Data collection",
      "Review",
      "Submitted",
      "…",
      "Approved",
      "Declined",
      "Withdrawn",
      "Closed"
    ],
    "presubmission": ["Interested", "Data collection", "Review"],
    "final": ["Approved", "Declined", "Withdrawn", "Closed"]
  }
}
```

`stages` is the bank's configured list; an unknown bank answers the
account's default list. `presubmission` stages can never be targeted by
`PATCH`; `final` stages end the group. `bank` is required (`400`
otherwise).

### `GET /case-documents?bank=FAB&product=Personal%20loan`

```json
{
  "data": {
    "bank": "FAB",
    "product": "Personal loan",
    "items": [{ "key": "passport", "label": "Passport", "position": 1 }]
  }
}
```

The documents the bank requires for the product, in order; the product
matches case-insensitively on trimmed text. Both `bank` and `product`
are required.

## 9. Webhooks

Taamul Connect tells Compass what happens on its side. Register an
endpoint with the `Compass – submissions` key (scope `webhooks:manage`):

```bash
curl -X POST https://crm.taamul.ae/api/v1/webhooks \
  -H "Authorization: Bearer $COMPASS_SUBMISSIONS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://compass.example.com/hooks/taamul","events":["case.stage_changed","case.lead_created","submission_group.ready","submission_group.failed","submission_group.ended","contact.opted_out"]}'
```

The answer contains the endpoint `secret` **once** (`whsec_…`). The URL
must be `https://` and resolve to a public address. Endpoint management
(`GET`, `PATCH`, `DELETE /webhooks`) is in
[`public-api.md`](public-api.md#webhooks).

### Envelope

Every delivery is a `POST` with this body (`id` is unique per delivery):

```json
{
  "id": "8f3c…",
  "event": "case.stage_changed",
  "occurred_at": "2026-10-21T09:30:00.000Z",
  "account_id": "…",
  "data": { "…": "…" }
}
```

`data` repeats `account_id` and `occurred_at`, plus the fields below.

| Event                     | Fires when                                         | `data` fields                                                                                                |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `case.stage_changed`      | A case moves stage, in the CRM or from Compass     | `case_id`, `submission_id`, `from_stage`, `to_stage`, `outcome`, `source` (`compass` or `crm`), `changed_at` |
| `case.lead_created`       | A lead (a case with no submission yet) is opened   | `case_id`, `contact_id`, `bank`, `product`, `amount`, `agent_email`, `created_at`                            |
| `submission_group.ready`  | The WhatsApp group exists                          | `submission_id`, `group_id`, `case_id`, `invite_link_present`                                                |
| `submission_group.failed` | Creating the WhatsApp group failed (it is retried) | `submission_id`, `error`, `retrying`                                                                         |
| `submission_group.ended`  | The group ended                                    | `submission_id`, `end_reason`, `ended_at`                                                                    |
| `contact.opted_out`       | A contact opted out of messages                    | `contact_id`, `phone`, `opted_out_at`, `compass_id` (null if not linked)                                     |

No invite link or token is ever in a payload; `invite_link_present` only
says whether one exists (read it with `GET /submission-groups/{id}`).

**`source` echo rule.** A `case.stage_changed` caused by Compass's own
`PATCH` arrives with `source: "compass"`. Ignore those (they are your
own change coming back); apply only `source: "crm"` moves, which are
made by staff in the CRM (a lead's stages, and submitted cases while
"managed in Compass" is off).

### Headers and signature

`X-Taamul-Event`, `X-Taamul-Webhook-Id` and
`X-Taamul-Signature: t=<unix_seconds>,v1=<hex>`. The legacy
`X-Wacrm-*` names carry the same values. Verify:

1. Take the **raw** request body, not a re-serialised copy.
2. Compute `HMAC-SHA256(secret, "<t>.<rawBody>")` as hex.
3. Compare with `v1` in constant time.
4. Reject if `t` is more than 5 minutes from your clock.

```js
const [, t, v1] = header.match(/t=(\d+),v1=([0-9a-f]+)/);
const expected = crypto
  .createHmac('sha256', secret)
  .update(`${t}.${rawBody}`)
  .digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

### Delivery guarantee

Delivery is **at most once**: events are queued in the database, claimed
by the automations cron (at most once a minute) and sent with one attempt,
no redirects and a short timeout. A failure is not retried, and an
endpoint that fails repeatedly is auto-disabled (`is_active: false`;
re-enable it with `PATCH /webhooks/{id}`). So:

- respond `2xx` quickly and do the work after;
- dedupe on `id` and do not assume ordering;
- **reconcile nightly**: re-read the cases and groups you care about
  (`GET /submission-groups/{submission_id}`) and compare. A missed event
  is possible, a wrong state should never persist.

Events are queued only while an active endpoint of the account
subscribes to them, so register before you rely on them.

## 10. Managed in Compass (the lock)

Compass is the master of a **submitted** case (one with a submission
group). A Taamul Connect owner or admin turns on **Settings → Cases →
"Submitted cases are managed in Compass"**. While it is on, people in the
CRM can no longer, on a submitted case:

- move the stage,
- edit bank, product or amount,
- set the outcome reason,
- mark a document received or rejected.

They get `409 MANAGED_EXTERNALLY`. Notes, tasks, priority, due date,
reassigning, bank contacts, document requests and replies stay open.
**Leads are never locked** (the CRM is their master), and **your API
calls are never locked**: `PATCH /submission-groups/{id}` always applies.
The case page shows a "Managed in Compass" banner with an **Open in
Compass** link (from `compass_url`) and the time of the last sync.

## 11. Code samples

### curl

```bash
# Sync customers
curl -X POST https://crm.taamul.ae/api/v1/compass/contacts \
  -H "Authorization: Bearer $COMPASS_SYNC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contacts":[{"compass_id":"CUST-1001","name":"Jane Doe","phone":"+971501234567"}]}'

# Send a status notification
curl -X POST https://crm.taamul.ae/api/v1/compass/notifications \
  -H "Authorization: Bearer $COMPASS_NOTIFY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"idempotency_key":"APP-2291:approved","compass_id":"CUST-1001","text":"Your application APP-2291 has been approved."}'

# Check it
curl https://crm.taamul.ae/api/v1/compass/notifications/APP-2291%3Aapproved \
  -H "Authorization: Bearer $COMPASS_NOTIFY_KEY"
```

### Node.js / TypeScript (Node 18+)

```ts
const BASE = 'https://crm.taamul.ae/api/v1';

async function call(key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, ...json };
}

// Backfill / incremental sync
export async function syncCustomers(customers: Array<Record<string, unknown>>) {
  for (let i = 0; i < customers.length; i += 500) {
    const batch = customers.slice(i, i + 500);
    const r = await call(
      process.env.COMPASS_SYNC_KEY!,
      'POST',
      '/compass/contacts',
      { contacts: batch }
    );
    if (r.status === 429) {
      i -= 500;
      await sleep(60_000);
      continue;
    }
    if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
    for (const bad of r.data.rejected) {
      console.warn('Compass customer rejected', bad.compass_id, bad.error);
    }
  }
}

// Status notification — call again with the SAME key to retry safely
export async function notifyStatusChange(app: {
  id: string;
  status: string;
  customerId: string;
  message: string;
}) {
  const r = await call(
    process.env.COMPASS_NOTIFY_KEY!,
    'POST',
    '/compass/notifications',
    {
      idempotency_key: `${app.id}:${app.status}`,
      compass_id: app.customerId,
      text: app.message,
      event: 'application.status_changed',
      reference: app.id,
    }
  );
  if (r.status === 201 || (r.status === 200 && r.data.duplicate)) return r.data;
  const retryable =
    [409, 429, 500, 502, 503].includes(r.status) &&
    r.error?.code !== 'bad_request';
  throw Object.assign(new Error(`${r.error.code}: ${r.error.message}`), {
    retryable,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

### Python (requests)

```python
import os, requests

BASE = "https://crm.taamul.ae/api/v1"

def notify_status_change(app_id, status, customer_id, message):
    r = requests.post(
        f"{BASE}/compass/notifications",
        headers={"Authorization": f"Bearer {os.environ['COMPASS_NOTIFY_KEY']}"},
        json={
            "idempotency_key": f"{app_id}:{status}",
            "compass_id": customer_id,
            "text": message,
            "event": "application.status_changed",
            "reference": app_id,
        },
        timeout=30,
    )
    body = r.json()
    if r.status_code == 201 or (r.status_code == 200 and body["data"]["duplicate"]):
        return body["data"]
    raise RuntimeError(f"{r.status_code} {body['error']['code']}: {body['error']['message']}")
```

---

## 12. Go-live checklist

- [ ] Migrations `056_compass_integration.sql` and
      `134_compass_case_sync.sql` applied
- [ ] Whapi channel connected (Settings → WhatsApp → Connections shows it)
- [ ] Three API keys created with the scopes above and stored in
      Compass's secret store
- [ ] `GET /api/v1/me` succeeds with all three keys
- [ ] Test customer synced; visible under **Taamul Compass → Customers**
- [ ] Test notification sent to an internal phone; arrives from the
      **Whapi number**; visible under **Taamul Compass → Notifications**
- [ ] Test notification to a customer who already chats with an agent:
      it appears in that agent's chat, and the chat is still assigned to
      them
- [ ] Same `idempotency_key` sent twice → second call returns
      `"duplicate": true` and only one WhatsApp message arrives
- [ ] Initial backfill run; `rejected` records reviewed
- [ ] Compass hooks wired: customer create/update → sync; application
      status change → notification
- [ ] `GET /case-stages` and `GET /case-documents` checked against
      Compass's status and document maps for every bank
- [ ] Test `PATCH` with `changed_at`, a stage and a document; an older
      `changed_at` answers `applied: false, reason: "stale"`
- [ ] A final stage ends the WhatsApp group
- [ ] Webhook endpoint registered for the six events; a test event
      verifies its signature; `source: "compass"` events are ignored
- [ ] Nightly reconcile job in place
- [ ] An admin decides whether to turn on "Submitted cases are managed
      in Compass" (Settings → Cases)

## 13. Good to know

- **Whapi uses a real WhatsApp account** on a phone paired to the
  gateway. Keep that phone online and charged. Very high volumes of
  unsolicited messages can get a WhatsApp number restricted, so send
  status updates customers expect, not marketing.
- **Message wording is Compass's.** Taamul Connect sends the text
  exactly as given; there are no templates to register for Whapi.
- **Security:** the keys can send WhatsApp messages as your business.
  Keep them server-side only. If one leaks, revoke it in **Settings →
  Integrations → API keys** (effective immediately) and create a new one.
- The general public API (other endpoints, webhooks for inbound
  replies) is documented in [`public-api.md`](public-api.md).

## 14. Broadcasting to Compass customers

A Taamul Connect admin can send a WhatsApp broadcast (template
campaign) to synced Compass customers: **Broadcasts → New → Compass
contacts**. Nothing is needed from Compass for this; it is described
here so both teams know what a broadcast does to the synced records.

- **Which customers.** Only customers with a phone number are counted.
  The admin picks an order — top or bottom of the Compass list (most or
  least recently updated), newest or oldest added, name A→Z or Z→A — a
  start position (1 = the first customer in that order) and how many
  numbers (blank = all from the start position on). "100 numbers from
  the bottom of the list" is _bottom of the Compass list_, start 1,
  100 numbers. The slice is read when the campaign is created, so a
  sync that lands between preview and send can shift it.
- **A sync during the send can make it refuse.** A slice too big for
  one read (over 1,000 numbers, or "all") is read page by page, and a
  sync that touches any customer meanwhile would move customers between
  pages. The send then stops before anything is created — "Compass
  contacts changed while the audience was being read… try again in a
  minute" — rather than message people outside the slice. A slice read
  in one request is never refused for this.
- **Bad numbers are skipped.** A number that fails the contact rules
  (no country code, too short, …) is left out, so a slice can send to
  fewer people than it names. Exclude chat tags, opted-out customers
  and the frequency cap apply too, and two customers with the same
  number get one message.
- **Recipients become CRM contacts.** A campaign's recipients have to
  be contacts, so a customer whose number is not yet a contact is added
  as one, owned by the admin who sends. A number that is already a
  contact is reused and keeps its owner.
- **The Compass record is not linked.** A broadcast does not set the
  customer's link to the CRM contact; that still happens the first time
  Compass itself messages them.
- **Personalization.** Template variables can take any Compass field —
  name, phone, email, company, `compass_id`, and every `attributes` key
  (lower-cased; nested values are sent as JSON).
