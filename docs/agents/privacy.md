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
  row is anonymised, opt-out kept. Calls inline 093's match
  (`pbx_erase_contact_calls` needs `auth.uid()`): change both. Files are
  deleted by the route after the commit (`erase-objects.ts`).
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
