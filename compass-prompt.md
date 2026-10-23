You are working on **Taamul Compass**, our submission tracker. Agents create and submit bank-application cases here and upload the documents; coordinators update each case's status here. Integrate Compass with **Taamul Connect**, our WhatsApp CRM, using its public REST API as described below. Read the existing code first: find where cases are created, submitted and status-changed, where documents are uploaded, and where customers are created or edited. Hook the integration into those places. Don't scatter HTTP calls across the codebase.

## Goal

1. When an agent **submits** a case, Taamul Connect opens a WhatsApp group (customer + hosting number + optional coordinator phone) and a mirrored **case** that staff work in the CRM.
2. Every **status change, detail edit and document update** in Compass is mirrored to the CRM case. Compass is the master of a submitted case.
3. Customers get **WhatsApp status notifications** ("your application was approved") with no double sends.
4. Compass customers are **synced** to the CRM.
5. Compass **receives signed webhooks** from the CRM (group ready or failed, group ended, lead opened in the CRM, stage changed in the CRM, customer opted out).

## Connection

- Base URL: `https://crm.taamul.ae/api/v1` (development). Make it a config value (`TAAMUL_CONNECT_BASE_URL`). Production will have a different URL and keys.
- Auth: `Authorization: Bearer <key>`, `Content-Type: application/json`.
- Three keys, kept in environment variables or the secret store, never in code or logs, and used only by the server (never the browser):
  - `TAAMUL_SYNC_KEY` (customer sync)
  - `TAAMUL_NOTIFY_KEY` (notifications)
  - `TAAMUL_SUBMISSIONS_KEY` (submission groups + webhooks)
- Rate limit: 120 requests/min **per key**. A `429` carries `Retry-After` (seconds): wait that long, then retry.
- Every response is `{ "data": … }` or `{ "error": { "code", "message" } }`. Branch on `error.code`, and only log `message`.
- Smoke test: `GET /me` with each key returns 200.

## Architecture to build in Compass

- **One client module** (e.g. `taamulConnect`) that wraps every call: base URL, keys, timeouts (30 s), JSON parsing, and error mapping to `{retryable: boolean}`.
- **A durable outbox table** (`taamul_outbox`: id, kind, payload JSON, dedupe_key, attempts, next_attempt_at, last_error, status). Every hook below **inserts an outbox row in the same DB transaction as the Compass change**, and a worker sends it. A failed or slow CRM never blocks or rolls back a Compass save, and nothing is lost on a crash.
- Retry policy: retry `409 in_progress`, `409 whapi_not_connected`, `429`, `5xx` and network timeouts with backoff (30 s, 2 min, 10 min, 1 h, then every 6 h; mark the row dead after 48 h and alert). **Never retry** `400`, `401`, `403`, `404` or `422`: mark the row failed, show the error on the case, and alert. A retry **resends the identical payload**. Never mint a new idempotency key or submission id on a retry.
- Ordering: send outbox rows **per case in order** (one in flight per case). Every case update carries `changed_at` (ISO 8601, the Compass change time), so the CRM can drop stale ones.
- Store on the Compass case: `crm_case_id`, `crm_group_status`, `crm_last_sync_at`, `crm_last_error`. Show a small **"WhatsApp / CRM" panel** on the case page: group status (pending, active, ended, failed), the last sync, the last error, and a link to `https://crm.taamul.ae/cases/<crm_case_id>`.
- Nightly reconciliation job: re-send the full current state (stage, details, documents) for every case changed in the last 24 h. This is safe because the CRM ignores stale or identical updates.

## A. Submit → open the group and case (works today)

`POST /submission-groups`, key `TAAMUL_SUBMISSIONS_KEY`. Trigger: the moment a case is **submitted**, not when it is drafted.

```json
{
  "submission_id": "<Compass case id, stable, ≤128 chars>",
  "customer": { "phone": "+971501234567", "name": "Jane Doe" },
  "agent_email": "agent@company.ae",
  "coordinator_email": "coord@company.ae",
  "team_lead_email": "lead@company.ae",
  "coordinator_phone": "+971507654321",
  "subject": "Jane Doe - SUB-10482",
  "bank": "FAB",
  "product": "Personal loan",
  "amount": "150000.00"
}
```

- Required: `submission_id`, `customer.phone` (**international format with country code**; local `05…` numbers are rejected) and `agent_email`. Emails are the staff's **CRM login emails**: keep a mapping if Compass logins differ. No person may fill two roles.
- `bank`: an upper-case code `^[A-Z0-9_]{2,32}$` (FAB, CBD, ADCB …), agreed with the CRM admin. Send `amount` in AED as a **string** with at most 2 decimals.
- Idempotent per `submission_id`. Replies:
  - `201`: created.
  - `200`: it already existed. Treat it as success.
  - `202` with `data.whatsapp.pending: true`: the group is still being made. The CRM finishes it, and you'll get a `submission_group.ready` webhook (Phase 2). Until then, poll `GET /submission-groups/{submission_id}` every 2 min, for up to 30 min.
- Save `data.case.id` as `crm_case_id`, and `data.status` and `data.whatsapp` for the panel.
- Errors:
  - `409 consent_required`: the customer opted out. Show it on the case and don't retry.
  - `422 unknown_user` or `duplicate_user`: a staff email problem. Show it and alert an admin.
  - `422 no_whapi_number` or `channel_not_allowed`: a CRM config problem. Alert an admin, and retry after it's fixed with the **same** `submission_id`.
- WhatsApp group creation is not idempotent on WhatsApp's side, so **never** change the `submission_id` of a case once it has been sent.

## B. Final status (works today)

`PATCH /submission-groups/{submission_id}` with `{ "status": "APPROVED" }`, where status is one of `APPROVED`, `DECLINED`, `WITHDRAWN` or `CLOSED`. It moves the CRM case to the matching final stage and ends and closes the WhatsApp group. Other statuses are stored but change nothing until Phase 2. The response contains `ended`, `closed`, `close_deferred` and `case { id, stage, outcome }`.

## C. Full status, details and document sync (Phase 2 — the CRM is adding these fields; build against this contract behind a feature flag `TAAMUL_FULL_SYNC`)

Same `PATCH /submission-groups/{submission_id}`, extended body. Send only the keys that changed, plus `changed_at`:

```json
{
  "changed_at": "2026-10-21T10:15:00Z",
  "status": "QUERY_RAISED",
  "stage": "Query raised",
  "outcome_reason": { "code": "CREDIT_POLICY", "text": "DBR above limit" },
  "bank": "FAB", "product": "Personal loan", "amount": "120000.00",
  "compass_url": "https://compass.../cases/123",
  "documents": [
    { "key": "passport", "status": "received", "received_at": "2026-10-21T09:00:00Z", "compass_url": "https://compass.../docs/9" },
    { "key": "salary_certificate", "status": "requested" }
  ]
}
```

- `stage` must be a CRM stage name. Build a **configurable map** in Compass, from each Compass status to a CRM stage, per bank. The CRM default stage list is: Interested, Data collection, Review, Submitted, Bank acknowledged, Documents requested, Documents received, Under review, Query raised, Query answered, Approved, Declined, Withdrawn, Closed. The first three are pre-submission (lead) stages, so never send them for a submitted case. A bank may have its own list: fetch it from `GET /case-stages?bank=FAB` (Phase 2) and validate your map at startup. Unmapped statuses go as `status` only.
- A final stage (Approved, Declined, Withdrawn) can only be followed by Closed. Closed is terminal.
- `outcome_reason.code` is sent only with Declined or Withdrawn. It is one of `INCOMPLETE_DOCS`, `CREDIT_POLICY`, `INCOME_INSUFFICIENT`, `KYC_AML`, `CUSTOMER_WITHDREW`, `NO_RESPONSE` or `OTHER`, with `text` of 500 chars or fewer.
- Document `key`s are the CRM's per-bank, per-product keys (`GET /case-documents?bank=&product=`). Map Compass document types to them. File bytes stay in Compass, and only the link is sent.
- Responses:
  - `{applied:false, reason:"stale"}`: an older update. This is fine, so mark it done.
  - `422 unknown_stage`: fix the map and don't retry.
  - `data.rejected[]`: lists unknown document keys. Log them.

## D. Customer notifications (works today)

`POST /compass/notifications`, key `TAAMUL_NOTIFY_KEY`:

```json
{ "idempotency_key": "<case id>:<status-history row id>", "compass_id": "CUST-1001",
  "text": "Dear Jane, your application APP-2291 has been approved.", "event": "application.status_changed", "reference": "APP-2291" }
```

- Send `to` (a phone with country code) instead of `compass_id` when the customer isn't synced. `type` can be `document` or `image`, with a public https `media_url`; `text` is then the caption (≤1024 chars).
- The idempotency key is **unique per status change** and reused on every retry. `201` means sent. `200` with `duplicate: true` means it was already sent, so treat it as success.
- On `409 in_progress`, wait 5 s, then `GET /compass/notifications/{key}`. `delivery_status` (sent, delivered, read, failed) updates over time.
- Make the **message templates per status editable** in Compass admin (English and Arabic). Only notify on statuses the customer should hear about, never marketing. Messages go out from a real WhatsApp number, so volume matters.

## E. Customer sync (works today)

`POST /compass/contacts`, key `TAAMUL_SYNC_KEY`:

```json
{ "contacts": [ { "compass_id": "CUST-1001", "name": "Jane Doe", "phone": "+971501234567", "email": "…", "company": "…", "attributes": { "branch": "Dubai Main" } } ] }
```

- Batches of up to 500. **Full replace** per record, so always send the complete record. A bad record doesn't fail the batch: read `data.rejected[]` (index, compass_id, error) and surface those records in Compass for correction. The phone rule is international format only.
- Hooks: an initial backfill (paged, honour `429`), then send on every customer create or edit, and `DELETE /compass/contacts/{compass_id}` on delete. Nightly, re-send the customers changed in the last 24 h.

## F. Webhooks from the CRM (Phase 2 events; the mechanism works today)

- Add an endpoint `POST /integrations/taamul-connect/webhook` (https, public).
- Register it once with `POST /webhooks` `{ "url": "...", "events": [ ... ] }` (key `TAAMUL_SUBMISSIONS_KEY`). The response contains `secret` (`whsec_…`) **once**: store it as `TAAMUL_WEBHOOK_SECRET`.
- Verify **every** request before parsing:
  - The header is `X-Taamul-Signature: t=<unix seconds>,v1=<hex>`.
  - Compute `hex(HMAC_SHA256(secret, "${t}.${rawBody}"))` over the **raw** body and compare in constant time.
  - Reject the request if `|now - t| > 300 s`. Answer 401 if verification fails.
- Answer `2xx` fast and process asynchronously. Deliveries are best-effort and at most once, so the nightly reconciliation is the safety net. Dedupe on the event id.
- Events to handle:
  - `submission_group.ready` / `submission_group.failed`: update `crm_group_status`.
  - `submission_group.ended`: mark the group ended on the case.
  - `case.stage_changed`: **ignore if `source` is `"compass"`** (our own echo). Otherwise show it as a CRM-side note on the case; don't overwrite Compass's stage.
  - `case.lead_created`: optionally pre-create a draft case in Compass, linked by `crm_case_id`, so the agent submits from it.
  - `contact.opted_out`: flag the customer "WhatsApp opted out" and stop sending notifications to them.

## Tests and acceptance

- Unit tests for: the client's error mapping (retryable vs not, for every code above), the outbox worker (ordering per case, backoff, dead-letter), the status → stage and document maps, and webhook signature verification (valid, wrong secret, tampered body, old timestamp).
- An integration test with a mocked Taamul Connect server: submit, then 202, then a poll, then ready; status changes; a duplicate notification; and a 429 with `Retry-After`.
- Manual acceptance against `https://crm.taamul.ae` (QA Test workspace):
  - Submitting a case creates a WhatsApp group, and the CRM case appears at **Submitted**.
  - A coordinator status change appears in the CRM within 1 min.
  - `APPROVED` ends the group.
  - The same notification sent twice gives one WhatsApp message.
  - A rejected phone is shown in Compass.
  - Killing the network mid-send recovers from the outbox without duplicates.
- Document the setup (env vars, the key scopes above, the webhook registration step, the status and document maps) in Compass's README or admin guide.

Ask me before you change existing Compass statuses, data models or permissions beyond adding the integration fields and tables. Build sections A, B, D, E and the outbox first, because they work against the CRM today. Put C and F behind `TAAMUL_FULL_SYNC` until the CRM confirms its Phase 2 has shipped.
