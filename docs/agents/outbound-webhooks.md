> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Outbound webhooks (`lib/webhooks/*`)

Accounts register endpoints that receive CRM events. Three constraints
live here and each has a test file: payloads are signed Stripe-style
(`X-Taamul-Signature: t=…,v1=…` over `${t}.${rawBody}`, `sign.ts`);
target URLs pass an SSRF guard (`ssrf.ts` — resolves the host and
rejects loopback/private/link-local, paired with `redirect: 'manual'`
at the call site); delivery is at-most-once, best-effort, never throws,
and auto-disables an endpoint after `MAX_CONSECUTIVE_FAILURES`
(`deliver.ts`) that span 30 minutes (293, `record_webhook_failure`):
`first_failure_at` is cleared by a trigger whenever `failure_count` is
set to 0 or the endpoint is switched on, never by a session, and the flip
rings the live owners and admins (`webhook_disabled`). Semantics are
published in `docs/public-api.md` — keep the two in step.

The 134 outbox: SQL triggers enqueue `case.stage_changed`,
`case.lead_created`, `submission_group.ready|failed|ended` and
`contact.opted_out` into `webhook_event_outbox` only when an active
endpoint subscribes (`webhook_enqueue`); the automations cron drains it
(`drainWebhookOutbox`, `webhook_outbox_claim`), at most once. A row whose
endpoints could not be read (`deliverSigned` answers false, before any
POST, so at most once holds) goes back with `webhook_outbox_release` (293)
for 24 hours, and that drain pass stops.
`WEBHOOK_EVENTS` and 134's event names change together (`outbox.test.ts`
checks).

**Keys (315).** `webhook_endpoints.api_key_id` is the key that made or last
changed the endpoint (v1 POST and PATCH write it; NULL = before 315, or the
key is gone). Triggers on `api_keys` switch a revoked or deleted key's
endpoints off and ring `webhook_disabled`; `webhook_endpoint_key` keeps one
off while its key is revoked, until a PATCH by a live key takes it over. A
session never writes the column (289's column grants). An expired key does
not switch its endpoints off. Message events (`MESSAGE_EVENTS`) need
`messages:read` as well. Settings → API keys lists the endpoints
(`/api/account/webhooks`, admin+: the URL's host only, never `secret`) and may
only switch off or delete. A new outbox payload that names a customer carries
`contact_id` or `conversation_id`, which is how the erase finds it.
`verify-webhook-keys.sql`.
