> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Customer documents (`lib/customer-docs/*`, migration 178)

Every document or photo a customer sends is filed under their own
reference (`TC-000123`, one `customer_doc_folders` row per contact) and
copied to the NAS by a worker. Archive only: nothing is sent or changed.
`docs/customer-documents.md` is the contract.

- **Recording** (`recordCustomerDocument`, via `customer_documents_record`)
  sits in `inbound-pipeline.ts` after the `messages` idempotency boundary
  and before the `fanOut: false` cut. It never throws. The kind comes
  from the normalised type (`customerDocumentKind`): a sticker is stored
  as `image` and must stay out; audio, voice and video are not filed.
  A customer's document in a submission group goes through
  `groupCustomerDocumentHook` (`group-documents.ts`), called from
  `recordSubmissionGroupInbound` once the message is recorded; it mirrors
  the media into `chat-media` first (ignoring 039's opt-out, since the
  worker has no other way to fetch it) and never throws.
- **The copier never runs in the app.** `scripts/customer-docs-worker.mjs`
  (logic in `nas-worker.ts`) is its own systemd service: the NAS is a
  `hard` CIFS mount and an outage would block the app. It claims nothing
  until the mount is live and the root holds `.wacrm-customer-docs`.
- **Writes are RPCs**: `_record`, `_claim`, `_existing`, `_settle`
  (service role) and `_retry` (owner/admin). RLS on both tables reuses the
  contacts policy; a deleted contact's rows are admin-only.
  `verify-customer-documents.sql`.
