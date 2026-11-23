> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Privacy, PDPL (`lib/privacy/*`, migrations 221-224)

Port of package 033h-k. `docs/privacy.md` is the contract.

- **The data map** (`data-map.ts`) classifies every migrated table as
  PERSONAL (link, class, erase delete | anonymise | retain + reason,
  exported) or NOT_PERSONAL. `data-map.test.ts` fails on a table in
  neither, and checks 221's export and 222's erase name every table the
  map says they cover: a new table joins the map, and the SQL if it is
  personal.
- **Export / erase / hold** (`privacy_subject_export`,
  `privacy_subject_erase`, `privacy_legal_hold_set`): owner/admin,
  active account, service role. Erase previews by running inside a
  rolled-back block; executing needs `ERASE <id>`; a customer hold or a
  093 recording hold blocks it. Cases and all filed to them, the case
  group, consent and audit are retained (owner's decision); the contact
  row is anonymised; its opt-out stays on that row and, from 280, by
  keyed hash of the number (`contact_suppressions`), so a re-imported
  number is opted out again. Calls inline 093's match
  (`pbx_erase_contact_calls` needs `auth.uid()`): change both. Files are
  deleted by the route after the commit (`erase-objects.ts`).
- **Files (262).** `privacy_objects_unreferenced` runs after the erase's
  deletes and before every retry: only `account-<id>/` paths, nothing a
  remaining row points at. A new table or JSON column holding a
  chat-media URL or path joins its `urls` / `texts` list. The list is in
  `privacy_requests.detail.objects_list`; `retryErasedObjects` (daily,
  `runRetentionSweeps`) finishes it. 262 restates 222's erase, 223's
  problem and sweep, and 225's claim: apply in order, once.
- **Holds (262).** Sweep matching mirrors 222's call match; `contacts`
  DELETE is refused (HINT `LEGAL_HOLD`) only under an active hold.
- **Retention** (`privacy_retention_sweep`, daily from the automations
  cron): allow-list `privacy_retention_rules()` = `RETENTION_RULES`
  (`retention.test.ts` compares); no retained table may join it. Dry
  run until the workspace applies; holds skipped.
- **AI transfer** (`ai_transfer_check`): `assertAiTransfer` before every
  OpenAI/Anthropic call of a config with `accountId` (generate,
  translate, HR agents, query and gap embeddings) and the TypeSafe
  gateway's `transferAllowed` (`TRANSFER_REFUSED`). Logs first; refuses
  only while `require_basis` is on and the basis incomplete; fails open
  when the check cannot run. A new AI call path calls it too.
- `privacy_requests` and `ai_transfer_log` are append-only and hold
  hashes and counts, never contact ids or text. `verify-privacy.sql`.
- **Deleting a customer (280).** A stamped number that leaves a contact
  (delete, number change, erase) is kept in `contact_suppressions`; insert
  or a change to that number restores the stamps with one `restored`
  consent event; lifting a stamp clears the kept one. Never the
  do-not-contact reason. A number change writes `contact_id`, so going back
  to that number keeps nothing for the one undone, and a lift, the export
  and the erase reach the numbers left before; a row two contacts wrote has
  none (one's lift must not lift a stranger's). `contact_open_work`
  refuses a signed-in person's delete (ZC280, HINT `HAS_OPEN_WORK`, DETAIL
  the counts); the service role, no-user statements and an account deletion
  pass. 280 restates 086's `contacts_consent_log`: re-run 280 after 086; it
  refuses while the `kind` CHECK lacks `restored`.
  `verify-contact-delete.sql`. App side: `lib/contacts/delete-preview.ts`
  (dialog, reasons) and `delete-contacts.ts` (a refused bulk delete retries
  each id); the only way a screen deletes a contact.
