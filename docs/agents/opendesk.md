> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### OpenDesk / Taamul sales app (`lib/taamul-sales/*`, migration 139)

"Contact marked as interested" webhooks from the sales app
(opendesk.taamul.ae) at `POST /api/taamul-sales/webhook`, shown to
admins at `/opendesk` (sidebar Integrations, after Compass).
`docs/taamul-sales.md` is the contract.

- **Auth** is `TAAMUL_WEBHOOK_SECRET`: HMAC over `"<timestamp>.<raw
  bytes>"`, verified before parsing, 5-minute skew, fail closed. The
  workspace is `TAAMUL_WEBHOOK_ACCOUNT_ID`; nothing in the payload picks it.
- **Kept apart from `contacts`**, like `compass_contacts`: nothing here
  writes a CRM contact. One row per sales-app contact in
  `taamul_sales_contacts`, every event in `taamul_sales_events`.
- **Synchronous on purpose.** The work runs before the 200, not in
  `after()`: failure answers 503 so the sales app redelivers.
  `taamul_sales_record_interested` claims the `event_id` and writes the
  snapshot in one transaction, so a failed event is never marked seen;
  only an event at least as new rewrites the snapshot.
- **Who reads:** admin+ by RLS (056's rule); only the service role
  writes. Never log a payload. `verify-taamul-sales.sql`.
