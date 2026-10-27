# OpenDesk (Taamul sales app): "contact marked as interested"

When a sales agent marks a contact **Interested** in the Taamul sales app
(OpenDesk, opendesk.taamul.ae), the app POSTs one signed JSON event to
Taamul Connect, which stores or updates the contact in its own OpenDesk
list. Admins see it in the sidebar under **Integrations → OpenDesk**,
next to Compass. Migration 139.

## Setup

1. Apply `supabase/migrations/139_taamul_sales_interested.sql`.
2. Give the sales app's admin the endpoint URL:
   `https://<your-crm-host>/api/taamul-sales/webhook`, exactly that, with
   no trailing slash (a trailing slash answers a redirect, which the
   sales app counts as a failure).
3. Put the signing secret they generate in `TAAMUL_WEBHOOK_SECRET`, and
   the workspace that should receive the customers (`accounts.id`) in
   `TAAMUL_WEBHOOK_ACCOUNT_ID`. Restart the app; no rebuild is needed.
4. The sales app sends a `ping`; a `200 {"ok":true,"status":"pong"}`
   confirms the connection. A ping needs only the secret.

## What is checked

- `X-Taamul-Signature` is
  `sha256=<hex HMAC-SHA256(secret, "<X-Taamul-Timestamp>.<raw body>")>`,
  verified over the raw bytes
  before the body is parsed, in constant time. A bad or missing
  signature is **401**, and so is a timestamp more than 5 minutes from
  the server's clock.
- No secret or workspace configured is **503** (fail closed; the sales
  app retries until it is set).

## Answers

| Case                                                              | Answer                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| Stored                                                            | `200 {"ok":true,"status":"recorded"}`                   |
| Same `event_id` again                                             | `200 {"ok":true,"status":"duplicate"}`, nothing written |
| `ping`                                                            | `200 {"ok":true,"status":"pong"}`, nothing written      |
| Unknown `event_type`                                              | `200 {"ok":true,"status":"ignored"}`                    |
| Bad signature / stale timestamp                                   | `401`                                                   |
| Unparseable body, or no `event_id`, `occurred_at` or `contact.id` | `400`                                                   |
| Storing failed                                                    | `503`, so the sales app redelivers                      |

Processing is a few short queries, done before answering: an event
acknowledged and then lost would never be resent.

## What is stored

Like Compass customers, OpenDesk contacts are kept **apart from the
CRM's contacts**, so agents' contact lists are not flooded: nothing here
creates or changes a CRM contact.

- **`taamul_sales_contacts`**, one row per OpenDesk contact, keyed by the
  sales app's `contact.id`: customer and company name, phone and
  additional phones, trade licence, industry, area, city,
  existing-customer flag, the agent (id, username, name, email, team),
  the call (`called_at`, notes) and the lead (id, status), plus how many
  times and since when it was marked interested. Phones arrive as UAE
  local numbers (`0501234567`) and are stored as `971501234567`; one
  that cannot be used is kept as sent, in `phone_raw`. Delivery is
  unordered, so only an event at least as new as the stored one
  rewrites these details.
- **`taamul_sales_events`**, one row per `event_id` with the raw
  payload: the history of every mark, and the dedupe key.

## The OpenDesk screen

`/opendesk`, admins and owners only (the page's server guard and the
tables' RLS both say so). It lists the contacts newest mark first, with
search by name, company, phone, trade licence or agent; clicking a row
shows every stored detail, the full call notes included. It is
read-only: OpenDesk is the system of record, and its next event
rewrites the row.

Both tables hold customer personal data: admins and owners of the
workspace read them, only the service role writes them. The route never
logs a payload, only event ids and error codes.
