# Taamul Compass integration guide

This guide is for the team building the **Taamul Compass** (ERP) side
of the integration with **Taamul Connect** (the WhatsApp CRM). It
covers everything Compass needs to:

1. **Sync its customers** into Taamul Connect: one initial backfill,
   then a call each time a customer is created or changed.
2. **Send status notifications** to customers on WhatsApp, for example
   "your bank account application has been approved".

Everything here is plain HTTPS + JSON, so any language or HTTP client
works.

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
2. **Check the Whapi channel is connected:** **Settings → WhatsApp**.
   Notifications cannot be sent without it.
3. **Create two API keys:** **Settings → API keys → New API key**.
   Using separate keys means a large backfill can never use up the rate
   limit that urgent notifications need.

   | Key name                  | Scopes to tick                                    |
   | ------------------------- | ------------------------------------------------- |
   | `Compass – customer sync` | `compass_contacts:write`, `compass_contacts:read` |
   | `Compass – notifications` | `compass_notifications:send`                      |

   Each key is shown **once**. Copy both into Compass's secret store
   (environment variables or a vault), never into source code.

4. Give the Compass team this document, the **base URL**, and the two
   keys.

Once Compass is live, admins can see what has arrived under
Integrations → **Compass** in the sidebar. It has two tabs: synced customers,
and every notification with its delivery status and any error.

---

## 3. Connection details

|                  |                                       |
| ---------------- | ------------------------------------- |
| **Base URL**     | `https://wacrm.taamul.ae/api/v1`      |
| **Auth header**  | `Authorization: Bearer taamul_live_…` |
| **Content type** | `Content-Type: application/json`      |
| **Rate limit**   | 120 requests per minute **per key**   |

Check a key works (any key, no scope needed):

```bash
curl https://wacrm.taamul.ae/api/v1/me \
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

| Field        | Required | Notes                                                                                                                                                                                                                                                                                                  |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `compass_id` | **yes**  | String or number, ≤ 200 chars. `42` and `"42"` are the same customer.                                                                                                                                                                                                                                  |
| `name`       | no       | ≤ 500 chars.                                                                                                                                                                                                                                                                                           |
| `phone`      | no       | **Must include the country code** (`+971…`). Spaces, dashes and brackets are fine. A local number such as `050 123 4567` is **rejected**: we can't guess the country, and a wrong guess would send a customer's bank details to a stranger. So are fewer than 10 or more than 15 digits (UAE `800` toll-free numbers excepted), more than 64 characters, spreadsheet notation (`9.71505E+11`) or a `.0` suffix, letters in the number, a +971 number that is not a mobile (`+971 5x` + 7 digits), a landline (`+971` + 8 digits) or a 600/800 service number, and any number that does not fit the numbering plan of the country code its first digits spell. A leading `00` is read as `+`, and a trunk `0` right after the country code is removed (except where numbers really start with 0, such as `+39 06…`). The same rule applies to `to` on notifications, and a stored phone that fails it is refused with `422 invalid_phone`. A customer without a phone can be stored but not messaged. |
| `email`      | no       | ≤ 500 chars.                                                                                                                                                                                                                                                                                           |
| `company`    | no       | ≤ 500 chars.                                                                                                                                                                                                                                                                                           |
| `attributes` | no       | Any JSON object (≤ 16 KB) for extra ERP fields you want kept alongside the record.                                                                                                                                                                                                                     |

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

| HTTP | `code`                      | Meaning                                                                                                          | What Compass should do                                                |
| ---- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 400  | `bad_request`               | Invalid body: missing `idempotency_key`, no recipient, local phone number, text too long, etc.                   | Fix the request. **Don't retry as-is.**                               |
| 401  | `unauthorized`              | Missing, wrong, or revoked key                                                                                   | Check the key; ask an admin for a new one                             |
| 403  | `forbidden`                 | Key lacks the scope                                                                                              | Ask an admin to create a key with the right scope                     |
| 404  | `compass_contact_not_found` | Unknown `compass_id`                                                                                             | Sync the customer first, or send `to`                                 |
| 409  | `in_progress`               | The same key is being sent right now                                                                             | Wait a few seconds, then `GET` the key                                |
| 409  | `whapi_not_connected`       | The Whapi WhatsApp channel isn't connected, or the Whapi number this customer's chat uses is logged out of WhatsApp. Nothing was sent | Alert an admin; retry later with the **same** key                     |
| 422  | `no_phone`                  | The synced customer has no phone                                                                                 | Sync a phone for them, or send `to`                                   |
| 422  | `invalid_phone`             | The synced customer's phone is not a valid international number (it was stored before the sync enforced the rule). Nothing was sent | Re-sync the customer with the full number and country code, or send `to`; then retry with the **same** key |
| 429  | `rate_limited`              | Over 120 requests/min on this key                                                                                | Wait `Retry-After` seconds, retry the same key                        |
| 502  | `whatsapp_error`            | WhatsApp refused or failed the send (e.g. the number isn't on WhatsApp, or the phone paired to Whapi is offline) | Retry later with the same key. If it keeps failing, check the number. |
| 500  | `internal` / `db_error`     | Unexpected server error                                                                                          | Retry later with the same key                                         |

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

## 6. Code samples

### curl

```bash
# Sync customers
curl -X POST https://wacrm.taamul.ae/api/v1/compass/contacts \
  -H "Authorization: Bearer $COMPASS_SYNC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contacts":[{"compass_id":"CUST-1001","name":"Jane Doe","phone":"+971501234567"}]}'

# Send a status notification
curl -X POST https://wacrm.taamul.ae/api/v1/compass/notifications \
  -H "Authorization: Bearer $COMPASS_NOTIFY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"idempotency_key":"APP-2291:approved","compass_id":"CUST-1001","text":"Your application APP-2291 has been approved."}'

# Check it
curl https://wacrm.taamul.ae/api/v1/compass/notifications/APP-2291%3Aapproved \
  -H "Authorization: Bearer $COMPASS_NOTIFY_KEY"
```

### Node.js / TypeScript (Node 18+)

```ts
const BASE = 'https://wacrm.taamul.ae/api/v1';

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

BASE = "https://wacrm.taamul.ae/api/v1"

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

## 7. Go-live checklist

- [ ] Migration `056_compass_integration.sql` applied
- [ ] Whapi channel connected (Settings → WhatsApp shows it)
- [ ] Two API keys created with the scopes above and stored in
      Compass's secret store
- [ ] `GET /api/v1/me` succeeds with both keys
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

## 8. Good to know

- **Whapi uses a real WhatsApp account** on a phone paired to the
  gateway. Keep that phone online and charged. Very high volumes of
  unsolicited messages can get a WhatsApp number restricted, so send
  status updates customers expect, not marketing.
- **Message wording is Compass's.** Taamul Connect sends the text
  exactly as given; there are no templates to register for Whapi.
- **Security:** the keys can send WhatsApp messages as your business.
  Keep them server-side only. If one leaks, revoke it in **Settings →
  API keys** (effective immediately) and create a new one.
- The general public API (other endpoints, webhooks for inbound
  replies) is documented in [`public-api.md`](public-api.md).

## 9. Broadcasting to Compass customers

A Taamul Connect admin can send a WhatsApp broadcast (template
campaign) to synced Compass customers: **Broadcasts → New → Compass
contacts**. Nothing is needed from Compass for this; it is described
here so both teams know what a broadcast does to the synced records.

- **Which customers.** Only customers with a phone number are counted.
  The admin picks an order — top or bottom of the Compass list (most or
  least recently updated), newest or oldest added, name A→Z or Z→A — a
  start position (1 = the first customer in that order) and how many
  numbers (blank = all from the start position on). "100 numbers from
  the bottom of the list" is *bottom of the Compass list*, start 1,
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
  fewer people than it names. Exclude tags and the frequency cap apply
  too, and two customers with the same number get one message.
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
