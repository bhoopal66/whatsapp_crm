# Track I notes: the three gaps

Branch `claude/track-i-gaps`, based on `claude/admiring-dirac-8082b3`.
Commits: `5e8b72c` (lead source), `1ce37e0` (embeddable form),
`722ffd5` (contact sort, migration 257).

## CHANGELOG entry

### Added
- Contacts and Team contacts sort by Owner, Assigned to and a new Last
  activity column (company chats only), kept in the URL (`?sort=owner|assignee|activity&dir=`)
  and in saved views. Without migration 257 the three headers are
  disabled and the list stays newest first.
- `lead_source` is now filled for contacts created from a broadcast CSV
  (`broadcast`) and contacts Compass creates on a first message
  (`compass`, only if empty). `POST /api/v1/contacts` and the MCP
  `create_contact` tool accept an optional `lead_source`; absent = NULL.
- The hosted web form `/f/<token>` can be embedded in an iframe by the
  websites on that form's allowed list (Settings → Web form shows the
  snippet). An empty list, an unknown or disabled token, or a failed
  lookup still means no framing. Every other route is unchanged.

### Changed
- The "Assigned to" column reads company chats only (it used to take the
  assignee of any chat, personal ones included), so it matches its sort.

### Migration required
- **257** `257_contact_sort.sql`: adds `contacts_sorted_page` (SECURITY
  INVOKER). Apply before deploying; re-runnable. Verify:
  `supabase/ci/verify-contact-sort.sql`.

## CLAUDE.md text (at most 6 lines each)

**Contact sort (257).**
`contacts_sorted_page(...)` (INVOKER, so contacts RLS decides) returns one
page `{ids, total}` ordered by owner name, assignee name or the company
chat's `last_message_at` (`personal_owner_id IS NULL`), NULLS LAST, ties
newest then id. It restates the screen's filters (search, chat tag, lead
source, a leader's "mine"): change both. `sorted-page.ts` builds the call;
a missing RPC disables the three headers. `verify-contact-sort.sql`.

**Lead source gaps.**
A broadcast CSV contact is inserted with `broadcast`
(`csv-contact-insert.ts`); Compass notify sets `compass` through
`contact_set_lead_source_if_empty` when it created the contact. v1
`POST /api/v1/contacts` takes an optional `lead_source` from `LEAD_SOURCES`
(400 otherwise); the MCP `create_contact` mirrors it.

**Embeddable form.**
`middleware.ts` sets the frame headers for `/f/*` only, from
`frameHeadersFor` (`lib/web-form/frame-headers.ts`) over
`web_form_public_config`'s origins (30 s cache, 2 s timeout, fail closed
to `'none'` + `X-Frame-Options: DENY`). A non-empty list sends an enforced
`frame-ancestors <origins>` and no XFO. `next.config.ts` keeps XFO and the
Report-Only CSP off `/f/` (`FRAME_HEADERS` rule); every other route is unchanged.

## New i18n keys (en and ko; ko reuses English except where noted)
- `Contacts.page.tableColumns.lastActivity` (ko translated)
- `ContactsTable.column.lastActivity` (ko translated)
- `ContactsTable.sortUnavailable`
- `Settings.webForm.iframeLabel`, `copyIframe`, `iframeHint`
- Changed text: `Settings.webForm.originsHint` (mentions iframes)

## Merge needs
- Migration 257 on the live database before the build.
- `messages/en.json` and `ko.json` will conflict with the Arabic track: add
  the keys above to `ar.json`.
- CHANGELOG.md and CLAUDE.md: paste the text above.
- `src/middleware.ts` and `next.config.ts` changed: merge with any other
  track touching headers or middleware.
- `.github/workflows/migrations.yml`: one new verify step after "Verify
  review fixes".

## Not done / known limits
- Compass sets `compass` only when it created the contact, not for a
  contact it merely matched; no test for that call.
- Iframe embedding not tried in a real browser on another site; a removed
  origin can still frame for up to 30 s per process; https origins only.
- Contacts sort headers for the new columns are hidden at phone width (as
  Created is); a URL or saved-view sort still applies.
- No "unknown" lead-source filter option exists on the page.

## Gate results (2026-11-22, on `claude/track-i-gaps`)
- `npm run lint`: 0 errors, 31 warnings (the pre-existing ones).
- `npm run typecheck`: clean.
- `npm test`: 1164 files, 16,357 tests, all pass.
- `npm run build` with the CI dummy env: succeeds. I passed the
  `NEXT_PUBLIC_*` and `ENCRYPTION_KEY` values from ci.yml; `META_APP_SECRET`
  and `NEXT_PUBLIC_PBX_OUTBOUND_CALLS` were not set for it.
- Migration replay: clean `supabase/postgres:17.6.1.066` container,
  `classic-grants.sql`, migrations 001-256, then 257 applied twice, with a
  hand-made `storage` stand-in (the Supabase CLI was not used). Every
  `verify-*.sql` that migrations.yml runs passes, including
  `verify-contact-sort.sql` (35 checks). `verify-schema.sql` and the other
  verify files that migrations.yml runs through `supabase db query` were run
  through `psql`.
