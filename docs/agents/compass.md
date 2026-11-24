> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Taamul Compass (`lib/compass/*`, migration 056)

The ERP integration, on the v1 API. Customers sync into
`compass_contacts` — deliberately **not** `contacts`, so agents' scoped
contact lists aren't flooded — and link to a CRM contact on first
message. `notify.ts` sends status notifications with three hard rules:
Meta only (`provider: 'meta'` + `requireProvider`, never a
linked-device fallback; free text inside the customer's 24 h window on
that number, else the approved template worded like the message, one per
event in `COMPASS_TEMPLATES` (`meta-template.ts`), company and bank read
back out of the text; no match or media → not sent outside the window), the existing conversation with ownership untouched (no
`sender_id`, `renameExisting: false`, `pauseActiveFlows: false`), and at
most once per `idempotency_key` (claimed as `sending` before the
gateway call; a `db_error` after the gateway accepted keeps the key
spent). `error_code = 'delivery_unconfirmed'` is written on the row right
before the gateway call and removed only by a definite refusal or the
`sent` record: a row carrying it may have reached the customer and is
never sent again (409). A customer who opted out or is do-not-contact is
refused (422) in the group and one-to-one, before anything is created; a
failed read refuses too. `docs/compass.md` is the contract handed to the
Compass team.
