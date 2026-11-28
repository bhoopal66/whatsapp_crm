> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Second brain (`lib/brain/*`, migrations 194-196)

A searchable, redacted store of case notes, case replies, case-group
customer text, stage changes and bank workspace pins/posts, plus
extractive case/contact/bank summary pages and a per-person daily digest
(`/brain`, `/digest`, the case Brain tab). Ported from package 022.
`docs/second-brain.md` is the contract.

- **Inbox Assistant tools** (`lib/chat-assist/brain.ts`,
  `brain-server.ts`): `brain_search` (READ) and `brain_remember` (WRITE,
  confirmed card). Hidden and refused unless `brain_enabled`, sales
  access at agent or up, and `assertAiTransfer` all pass; search shares
  the `brain.search` rate bucket. CRM memory stays out of the Assistant.
- **Off by default.** `case_account_settings.brain_enabled`
  (`case_settings_set_brain`, owner/admin); while off `brain_item_upsert`
  stores nothing, routes answer 403 `brain_disabled`, the nav rows hide.
- **Writes are best-effort.** `lib/brain/sink.ts` runs after the primary
  write, awaited inside `after()`, never throws; failures are counted in
  `brainSinkCounters`. Hook points: case notes, stage (route and macro
  apply), case conversation reply, bank pins/threads/posts, and the
  webhook's `customerText` hook (`recordGroupCustomerText`, switch checked
  before the case lookup).
- **Redaction twice.** `brainRedact` (memory redactor + a `\p{Nd}` 9+ digit
  `[ID]` mask) in TS; the SQL guard (explicit ASCII, Arabic-Indic,
  extended and full-width digit classes) refuses `TEXT_UNREDACTED`. The
  TS mask must cover everything the SQL refuses (`brain.test.ts` holds a
  copy of the SQL pattern): change both together.
- **Visibility** is `case_can_read` for case items and owner/admin or the
  writer for the rest (`brain_item_visible`, `brain_actor_role`; no IT
  role). Marked = a `brain_contact_marks` row or the contact's
  `opted_out_at` / `do_not_contact_at`. Search, page read and digest are
  set-based (once per distinct case), not per item.
- **All tables** are RLS-forced with no policies and no grants; every
  access is a SECURITY DEFINER function granted to service_role only.
  Actors are auth user ids; system writers pass NULL plus a
  `system:<name>` label.
- **One body per function.** `brain_item_forget` and the contact-delete
  trigger live only in 194 and call 195's `brain_page_wipe` behind a
  `to_regprocedure` guard, so re-running 194 after 195 changes nothing.
- Client files import only `lib/brain/{ui,page-view,digest-view}` (or
  `import type`); the rest pulls the admin client and `node:crypto`.
  `verify-second-brain.sql`, `verify-brain-pages.sql`.
