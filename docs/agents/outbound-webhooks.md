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
