# Public API (`/api/v1`)

The public API lets you drive your Taamul Connect instance from your own
scripts and automations — send messages, manage contacts, launch
broadcasts — without going through the dashboard UI.

> **Status:** stable. Authentication, scopes, rate limiting, the
> messages / contacts / conversations / broadcasts endpoints, and
> outbound event [webhooks](#webhooks) all ship now.

## Authentication

Every request authenticates with an **API key**, sent as a bearer
token:

```
Authorization: Bearer taamul_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are **account-scoped**: a key acts on exactly one account, the
one it was created in. There is no cross-account access.

Keys issued before the rename carry a `wacrm_live_` prefix. They
remain valid — only the prefix on **newly created** keys changed, and
the prefix is not a secret or a scope. Rotate at your convenience.

### Creating a key

In the dashboard: **Settings → Integrations → API keys → New API key**. Only
**admins and owners** can create keys.

1. Give the key a name (after the integration that will use it).
2. Grant the **scopes** it needs — nothing more (see below).
3. Copy the key. **The full key is shown exactly once.** Taamul Connect
   stores only a SHA-256 hash, so it can never be shown again. If you
   lose it, revoke it and create a new one.

### Revoking a key

**Settings → Integrations → API keys → Revoke.** Revocation is effective on the
key's next request. Revoked keys stay in the list as an audit trail.

## Scopes

A key can do only what its scopes allow — independent of who created
it. Grant the minimum.

| Scope                | Allows                                   |
| -------------------- | ---------------------------------------- |
| `messages:send`      | Send WhatsApp messages                   |
| `messages:read`      | Read messages and delivery status        |
| `contacts:read`      | List and read contacts                   |
| `contacts:write`     | Create and update contacts               |
| `conversations:read` | List and read conversations              |
| `broadcasts:send`    | Launch broadcast campaigns               |
| `webhooks:manage`    | Register and manage outbound webhooks    |
| `compass_contacts:read` | Read customers synced from Taamul Compass |
| `compass_contacts:write` | Sync customers from Taamul Compass      |
| `compass_notifications:send` | Send Compass status notifications (Whapi only) |

A key with **no scopes** still authenticates and can call
`GET /api/v1/me` — useful for verifying a key works.

## Response envelope

Every response uses one of two shapes:

```jsonc
// success
{ "data": { /* ... */ } }

// failure
{ "error": { "code": "forbidden", "message": "This API key is missing the 'messages:send' scope" } }
```

Branch on `error.code` (stable); `error.message` is for humans and
may be reworded.

| Status | `code`         | Meaning                                          |
| ------ | -------------- | ------------------------------------------------ |
| 401    | `unauthorized` | Missing / malformed / unknown / revoked / expired key, or its workspace is archived |
| 403    | `forbidden`    | Valid key, but missing the required scope        |
| 429    | `rate_limited` | Per-key rate limit exceeded                      |
| 400    | `bad_request`  | Malformed input                                  |
| 404    | `not_found`    | No such resource                                 |
| 500    | `internal`     | Server error                                     |

## Rate limits

Requests are limited **per key**: **120 requests per minute**. On a
`429`, these headers tell you when to retry:

- `Retry-After` — seconds until the window resets
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

A client IP that presents 5 unknown, revoked or expired keys (or keys of
an archived workspace) in a row, or 20 in 10 minutes, gets the same
`429 rate_limited` for 15 minutes (`Retry-After` says when), whatever
key it sends. This needs the
deployment's client-IP header; see `docs/security.md`.

> The limiter is in-memory and **per process**. A single-instance
> deploy (the common case for a self-hosted fork) is fine as-is. If
> you scale to multiple instances, swap the limiter for a shared
> store (Redis/Upstash) — see the note at the top of
> `src/lib/rate-limit.ts`. The limit is otherwise unenforced across
> instances.

## Endpoints

### `GET /api/v1/me`

Returns the account a key is bound to and the scopes it carries.
Requires only a valid key (no scope). Use it to verify a key works
and to discover its scopes.

```bash
curl https://your-crm.example.com/api/v1/me \
  -H "Authorization: Bearer taamul_live_xxx"
```

```json
{
  "data": {
    "account": { "id": "…", "name": "Acme Inc" },
    "key": { "id": "…", "scopes": ["messages:send"] }
  }
}
```

### `POST /api/v1/messages`

Send a WhatsApp message to a phone number. Scope: `messages:send`. You
pass an **E.164 number**, not an internal id — the endpoint
finds-or-creates the contact + conversation, then sends.

`to` is the recipient's number in international format with the country
code (`+971501234567`; spaces, dashes and brackets are fine, a leading
`00` is not). An existing contact is matched by number, whatever format
it was saved in; a trunk `0` typed after the country code is dropped
before matching. A number with no contact yet creates one, and it must
pass the same check as `phone` on `POST /api/v1/contacts`; otherwise the
request fails with `400 bad_request`, nothing is created or sent, and
the message names the problem (e.g. `'to' "504555843" is too short.
Include the country code, e.g. +971 50 123 4567`). Spreadsheet notation
(`9.71505E+11`), a `.0` decimal suffix and letters in the number (other
than a `tel:` prefix — so `whatsapp:+971…` is refused) are refused even
for an existing contact. The new contact's number is stored as digits
only, with a trunk `0` after the country code removed
(`+44 (0)7700 900123` → `447700900123`).

```bash
curl -X POST https://your-crm.example.com/api/v1/messages \
  -H "Authorization: Bearer taamul_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+14155550123", "type": "text", "text": "Hi 👋" }'
```

`type` is `text` (default), `template`, or a media kind (`image` /
`video` / `document` / `audio`). Media needs `media_url` (and optional
`filename`); `text` doubles as the caption. `media_url` must be an
absolute `https://` URL (at most 2048 characters, no embedded
credentials) — anything else is a `400`. The one exception is an object
in the install's own public Supabase Storage bucket, which a
self-hosted dev install may serve over plain `http://`. `template`
needs a `template` object:

```jsonc
{
  "to": "+14155550123",
  "type": "template",
  "template": {
    "name": "order_update",
    "language": "en_US",
    "params": ["A123"]        // positional body vars, or a structured object
  },
  "reply_to_message_id": "<uuid>"   // optional; must be in the same conversation
}
```

Response (201):

```json
{
  "data": {
    "message_id": "…",
    "whatsapp_message_id": "wamid.…",
    "conversation_id": "…",
    "contact_id": "…",
    "contact_created": true
  }
}
```

Domain error codes beyond the table above: `whatsapp_not_configured`
(400), `whatsapp_error` (502 — the request reached the WhatsApp gateway and it rejected the
send), `template_malformed` (500).

### `GET /api/v1/contacts`

List contacts, newest first. Scope: `contacts:read`. Paginated (see
[Pagination](#pagination)). Optional filter: `?search=` (matches name
or phone).

```json
{
  "data": [
    {
      "id": "…", "phone": "+14155550123", "name": "Jane Doe",
      "email": null, "company": "Acme", "avatar_url": null,
      "tags": [],
      "opted_out_at": null,
      "created_at": "…", "updated_at": "…"
    }
  ],
  "meta": { "next_cursor": "…" }
}
```

`opted_out_at` is when the customer asked not to be messaged, or `null`.
Broadcasts skip a contact that has it (see
[`POST /api/v1/broadcasts`](#post-apiv1broadcasts)).

**Contact tags are retired.** Conversations carry a chat tag instead
(see [`GET /api/v1/conversations`](#get-apiv1conversations)). Until a
future API version drops it, `tags` stays in every contact, always
`[]`, and `?tag=` is still accepted but always returns an empty page.

### `POST /api/v1/contacts`

Create a contact. Scope: `contacts:write`. `phone` (international
format with the country code, e.g. `+971501234567`) is required. It is
refused with `400 bad_request` when it has no country code (a leading
single `0`); fewer than 10 or more than 15 digits (UAE `800` toll-free
numbers, which can be shorter, excepted); more than 64 characters;
spreadsheet notation (`9.71505E+11`) or a `.0` decimal suffix;
characters other than digits, spaces and `+ ( ) - . /` (a `tel:` prefix
is fine, and invisible direction marks are ignored); a +971 number that
is not a mobile (`+971 5x` and 7 more digits), a landline (`+971` and 8
digits) or a 600/800 service number; or any other number that does not
fit the numbering plan of the country code its first digits spell (so
`98765 43210` is refused, not read as +98). The message says which. A
leading `00` is read as `+`, and a trunk `0` right after the country
code (`+971 050…`, `+44 (0)7700…`, `+966 05…`) is removed, except where
numbers really start with 0 (`+39 06…`). A number saved without its country code would take the
customer's inbound messages while replies went nowhere. The stored
number is the digits only;
`name`, `email` and `company` are optional. A `tags` field is accepted
and ignored (contact tags are retired). **Find-or-create by phone:** an existing
match returns `200` with the existing contact; a new contact returns
`201`. The response body is the serialized contact (same shape as the
list rows above).

### `GET` / `PATCH /api/v1/contacts/{id}`

Read or update one contact. Scopes: `contacts:read` / `contacts:write`.
`PATCH` updates only the fields you send (`name`, `email`, `company`).
A `tags` field is accepted and ignored (contact tags are retired). A
contact in another account returns `404`.

### `GET /api/v1/conversations`

List conversations, newest first. Scope: `conversations:read`.
Paginated. Optional filters: `?status=` (`open` / `pending` / `closed`)
and `?contact_id=`. Each conversation embeds its contact and names its
chat tag:

```json
{
  "data": [
    {
      "id": "…", "contact_id": "…", "status": "open",
      "assigned_agent_id": null,
      "last_message_text": "Is the offer still on?",
      "last_message_at": "…", "unread_count": 1,
      "chat_tag": { "id": "…", "name": "Interested customer", "color": "#16a34a" },
      "chat_sub_tag": { "id": "…", "name": "ADCB", "color": "#2563eb" },
      "created_at": "…", "updated_at": "…",
      "contact": {
        "id": "…", "phone": "+14155550123", "name": "Jane Doe",
        "email": null, "company": "Acme",
        "tags": [], "opted_out_at": null
      }
    }
  ],
  "meta": { "next_cursor": "…" }
}
```

`chat_tag` is the conversation's tag and `chat_sub_tag` the sub-tag
under it, each `{ id, name, color }` or `null`. A sub-tag only ever
appears with the tag it belongs to. The embedded contact has the same
`tags` (always `[]`) and `opted_out_at` as on the contact endpoints.

### `GET /api/v1/conversations/{id}`

Read one conversation, in the same shape as the list rows. Scope:
`conversations:read`. `404` if it belongs to another account.

### `GET /api/v1/conversations/{id}/messages`

List a conversation's messages, newest first. Scope: `messages:read`.
Paginated. Each message includes its `direction` (`inbound` /
`outbound`), `status` (delivery state), `whatsapp_message_id`, and
`content_*`. The conversation is verified to belong to your account
first (`404` otherwise).

### `POST /api/v1/broadcasts`

Launch a template broadcast to a list of recipients. Scope:
`broadcasts:send`. The broadcast + its recipient rows are persisted
immediately and the sends fan out in the background, so the call
returns fast — poll `GET /api/v1/broadcasts/{id}` for progress.

```bash
curl -X POST https://your-crm.example.com/api/v1/broadcasts \
  -H "Authorization: Bearer taamul_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "July promo",
        "template_name": "promo_july",
        "template_language": "en_US",
        "recipients": [
          { "to": "+14155550123", "params": ["Jane"] },
          { "to": "+14155550124" }
        ],
        "flow_id": "3f2c…"
      }'
```

Recipients are capped at **1000 per request** — split larger sends.
Each recipient's `to` must pass the same rule as `phone` on `POST
/api/v1/contacts`, even when a contact with that number already exists
(unlike `POST /api/v1/messages`, which still reaches an existing contact
saved in an older format). A number that fails it is dropped and
counted as `rejected`, and no contact is created for it; accepted
numbers are sent in normalized form (digits only, with the country
code, a trunk `0` after it removed). If every recipient is rejected the
call is `400 bad_request` and the message names the first problem.

A recipient whose contact opted out of messages (`opted_out_at` set) is
skipped: it is not sent to and is counted in neither `accepted` nor
`rejected`. If every recipient with a valid number has opted out, the
call is `400 bad_request` ("Every recipient with a valid phone number
has opted out of messages.") and nothing is sent.

`flow_id` (optional) names an **active Flow** to start for each
recipient on their first reply to this campaign, so the broadcast
continues as a guided conversation — see
[campaign-journeys.md](./campaign-journeys.md). The reply is seeded
into the run's variables (`campaign_reply`, `campaign_reply_id`). A
flow that does not belong to the account is `404 flow_not_found`; a
draft or archived one is `400 flow_not_active`. Nothing is persisted
in either case.

A template with an image, video or document header and no stored media
is `400 template_media_missing` when the account's broadcasts go to its
Meta number (Meta rejects every such send). Nothing is persisted. Add the
header media to the template in Settings → WhatsApp → Templates.

Response (202):

```json
{
  "data": {
    "broadcast_id": "…",
    "status": "sending",
    "total_recipients": 2,
    "accepted": 2,
    "rejected": 0
  }
}
```

### `GET /api/v1/broadcasts/{id}`

Broadcast status + counts. Scope: `broadcasts:send`. `status` moves
`sending` → `sent`, or `failed` when every recipient failed;
`delivered_count` / `read_count` keep climbing as delivery webhooks
arrive. `status` can stay `sending` after a failure of the sending
number itself (a revoked or expired access token, a logged-out number,
a lapsed subscription): delivery stops at the first recipient that hit
it, the rest stay pending, and the campaign is finished by resuming it
from the dashboard once the number is fixed — the API has no resume.
`failed` can follow `sent`: WhatsApp can accept a send and report it
failed later, and a campaign in which every recipient failed that way
moves to `failed`. `sent` and `failed` are final unless someone resumes
or retries the campaign from the dashboard, which moves it back to
`sending`. `404` for another account's broadcast.

### Taamul Compass endpoints

`/api/v1/compass/contacts` (customer sync into a dedicated
`compass_contacts` table) and `/api/v1/compass/notifications` (status
notifications — always on the Whapi number, into the customer's
existing chat without changing who handles it, at most once per
`idempotency_key`) are the ERP integration surface. Their full
contract is [`compass.md`](compass.md).

## Pagination

Every list endpoint pages the same way. Request a page size with
`?limit=` (default 50, max 100) and read the next page with the opaque
`meta.next_cursor` from the previous response:

```
GET /api/v1/contacts?limit=50
→ { "data": [ … ], "meta": { "next_cursor": "eyJ…" } }

GET /api/v1/contacts?limit=50&cursor=eyJ…
→ { "data": [ … ], "meta": { "next_cursor": null } }   // last page
```

Cursors are keyset-based (stable under concurrent inserts). Pass the
cursor back verbatim — don't parse it. `next_cursor: null` means the
last page.

## Webhooks

Rather than polling, register an endpoint and Taamul Connect will POST to it when
things happen in your account. **Migration required:** apply
`supabase/migrations/028_webhook_endpoints.sql`.

### Events

| Event                    | Fires when                                        |
| ------------------------ | ------------------------------------------------- |
| `message.received`       | An inbound message arrives from a contact         |
| `message.status_updated` | A message you sent changed delivery status        |
| `conversation.created`   | A new conversation is opened for a contact        |

### Managing endpoints

All under scope `webhooks:manage`.

- `POST /api/v1/webhooks` — register `{ "url": "https://…", "events": ["message.received"] }`. `url` must be `https://` and must resolve to a public internet address. A URL that resolves to a private, loopback or link-local address is rejected with `400 bad_request` when you save it, not only skipped at delivery time. **The response includes `secret` exactly once** — store it to verify signatures; Taamul Connect keeps only an encrypted copy.
- `GET /api/v1/webhooks` — list your endpoints (never returns the secret).
- `GET /api/v1/webhooks/{id}` — read one.
- `PATCH /api/v1/webhooks/{id}` — update `url`, `events`, or `is_active` (re-enabling clears the failure counter).
- `DELETE /api/v1/webhooks/{id}` — remove one.

```bash
curl -X POST https://your-crm.example.com/api/v1/webhooks \
  -H "Authorization: Bearer taamul_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/taamul", "events": ["message.received"] }'
# → 201 { "data": { "id": "…", "url": "…", "events": [...], "secret": "whsec_…" } }
```

### Delivery payload

Every delivery is a POST with this envelope; `id` is a unique per-
delivery uuid you can dedupe on, and `data` varies by `event`:

```json
{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": { /* per-event, see below */ }
}
```

`data` by event:

```jsonc
// message.received
{ "conversation_id": "…", "contact_id": "…", "whatsapp_message_id": "wamid.…", "content_type": "text", "text": "Hi 👋" }
// conversation.created
{ "conversation_id": "…", "contact_id": "…" }
// message.status_updated
{ "whatsapp_message_id": "wamid.…", "conversation_id": "…", "status": "delivered" }
```

Headers: `X-Taamul-Event`, `X-Taamul-Webhook-Id`, and `X-Taamul-Signature`.

Every delivery **also** carries the pre-rebrand header names
`X-Wacrm-Event`, `X-Wacrm-Webhook-Id` and `X-Wacrm-Signature`, with
identical values. They are deprecated but still sent, so a receiver
written before the rename keeps verifying without changes. Move to the
`X-Taamul-*` names when convenient; the old ones will be dropped in a
future release.

### Verifying the signature

`X-Taamul-Signature: t=<unix_seconds>,v1=<hex>` where `v1 =
HMAC-SHA256(secret, "${t}.${rawBody}")`. Recompute it over the **raw
request body** and compare in constant time; reject if `t` is more than
a few minutes old (replay protection).

```js
const [, t, v1] = header.match(/t=(\d+),v1=([0-9a-f]+)/);
const expected = crypto.createHmac('sha256', secret)
  .update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

### Delivery semantics

Delivery is **best-effort**: a single attempt per event with a short
timeout, and **redirects are not followed**. `message.status_updated`
covers messages Taamul Connect stores (inbox + API sends), not broadcast-only
sends, and — because providers re-send and re-order status callbacks —
the same status may arrive more than once or out of order; **dedupe on
`id` and don't assume ordering**. Each consecutive failure increments
`failure_count`; after enough consecutive failures the endpoint is
auto-disabled (`is_active: false`) — re-enable it with `PATCH` (which
resets the counter). Durable retry-with-backoff (a delivery queue) is a
future enhancement; today, treat missed deliveries as possible and
reconcile with the read endpoints when it matters.

**Target restrictions (SSRF).** The `url` must be `https://` and must
resolve to a public address — requests to `localhost`, private/RFC1918
ranges, link-local (incl. cloud metadata `169.254.169.254`), CGNAT,
multicast/reserved space, IPv6 loopback/ULA/link-local, and every
IPv4-in-IPv6 spelling of those (`[::ffff:127.0.0.1]`, NAT64, 6to4) are
refused at delivery time.

## Roadmap

The public API now covers messaging, contacts, conversations,
broadcasts, and outbound webhooks — the full scope of
[#245](https://github.com/ArnasDon/wacrm/issues/245). Future ideas
(deals/pipelines, templates, flows, a delivery queue for webhooks) are
not yet scheduled.
