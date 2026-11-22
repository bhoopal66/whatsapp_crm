# Track F (Round 6) — reports and exports: notes for the coordinator

Branch `claude/track-f-reports`, built on `74c8abfd`. Migrations 254–255
(256–257 unused).

## CHANGELOG entry

```markdown
### Reports

- **Funnel report** (`/reports/funnel`, owners and admins). New chats →
  Interested → case opened → submitted → approved, with declined and
  withdrawn beside, for a chosen period, as counts and conversion
  between stages. Filters: lead source, agent, bank, WhatsApp number.
  Days follow the account's time zone. Download as CSV.
  `docs/funnel-report.md`.
- **Chat tag report** (`/reports/tags`). Chats per main tag and sub-tag
  (e.g. Interested · ADCB), split by agent, number and lead source, and
  the chats that arrived at each tag in the period. Counts only: never
  chat contents, customer names or phone numbers. The owner always sees
  it and ticks who else may; a grantee sees workspace-wide counts.
  Movement is counted from the day migration 255 is applied.
  `docs/chat-tag-report.md`.
- **Reports** (`/reports`) lists the reports the person may open.
- **Owner-only CSV downloads** on Team activity (per person and per
  number for the chosen range) and on the dashboard's figures.
- Every CSV export quotes every field and neutralises cells that start
  with `=`, `+`, `-` or `@` (formula injection).

**Migration required:** apply `254_funnel_report.sql`, then
`255_chat_tag_report.sql` (255 as a superuser or BYPASSRLS role), before
the build.
```

## CLAUDE.md paragraphs

### Reports (`lib/reports/*`, migrations 254–255)

- **Funnel (254, `docs/funnel-report.md`).** `funnel_report()` returns
  the page as one jsonb, owners/admins of the ACTIVE account (DEFINER).
  The stages are a cohort of company chats created in the period,
  followed to now; their definitions live in SQL and the doc: change
  both. The Interested tag is the main tag named "Interested" (any
  case); interest ignores the bank filter, the case stages honour it.
  The lead-source list in its check is pinned to `LEAD_SOURCES` by
  `funnel.test.ts`. Days in the account's zone (team activity's
  `range.ts` and zone rule). `verify-funnel-report.sql`.
- **Chat tag report (255, `docs/chat-tag-report.md`).** Counts only:
  never a chat's text, a customer's name or phone. `chat_tag_report` is
  DEFINER and answers the owner or a live grantee in `report_access`
  (owner-written only, `report_access_set`; deleted by a `profiles`
  trigger when the holder is deactivated, turned guest or leaves),
  workspace-wide whatever the
  grantee can see. `chat_tag_history` is append-only, written by the
  `chat_tag_history_log` trigger, which must never fail the
  conversations write (errors become WARNINGs); movement counts from
  `chat_tag_history_since()`. Its functions are named `chat_*`, so
  `verify-internal-chat-admin.sql`'s service-role list applies: keep
  them revoked from service_role. `REPORT_KEYS` ↔ 255's
  `report_access_report_key_check` (`access.test.ts`).
  `verify-chat-tag-report.sql`.
- **CSV.** Every export goes through `lib/csv/build.ts` (quotes every
  field, neutralises `= + - @` starts). Team activity and dashboard
  downloads are owner-only (`canExportReports`), checked in the route.

## Defaults

- No main chat tag named "Interested": the funnel counts interest from
  cases (and the tag log) only, and the page says so.
- Report access: nobody but the owner sees the chat tag report until
  the owner ticks people.
- Funnel periods: the Team activity presets (today, yesterday, 7, 30,
  90 days); the SQL caps a period at 400 days.
- Tag movement starts empty: it counts from the day 255 is applied.
- Funnel CSV: owners and admins (as the report). Team activity and
  dashboard CSV: owner only.

## Merge needs

- **Nav items** (`src/components/layout/nav-items.ts`, Track E):
  - `/reports`, "Reports": owners and admins, plus anyone whose
    `report_my_access()` (RPC) returns a key. If the menu can't call it,
    admin+ only; grantees then reach it by URL or a link on `/worklist`.
  - `/reports/funnel`, "Sales funnel": owners and admins
    (`canEditSettings`).
  - `/reports/tags`, "Chat tags": the owner, or `report_my_access()`
    includes `chat_tags`.
- `src/middleware.ts`: `/reports` was added to `protectedPaths`;
  `src/components/layout/page-title.ts`: `/reports`, `/reports/funnel`,
  `/reports/tags` (Header keys `reports`, `funnelReport`,
  `chatTagReport`). Track E may be reworking both: keep these entries.
- Message files: new namespaces `FunnelReport` (after `Flows`),
  `ReportExports` and `Reports` (after `Reminders`), `TagReport` (before
  `TagSuggest`). The top level is not sorted overall, so these sit in
  order among their neighbours.
- `src/lib/team-activity/load-report.ts` now holds the range/zone/RPC
  logic `/api/team-activity` used inline; the route calls it.
- `src/lib/reports/http.ts` and `src/lib/reports/funnel-server.ts` each
  resolve the period like team activity; they could share one helper.
- Limits found in review and fixed: the funnel reads the Interested
  tag log once per report (not once per chat); the bank filter no longer
  changes Interested; deactivated people leave the agent filter; a
  sub-tag-only move is not a tag arrival; a grant is deleted when its
  holder is deactivated, turned guest or leaves; an unlabelled Meta
  number is shown unnamed rather than by its WABA id.
- Not checked in a browser (no Supabase project here): the 375px layout
  of `/reports/*` and the new buttons.

## Gate results

On `108ec83` (the last code commit; this notes commit changes docs only):

- `npm run lint`: 0 errors, 31 warnings (all pre-existing).
- `npm run typecheck`: clean.
- `npm test`: 1157 files, 16,246 tests, all pass.
- `npm run build` with the CI dummy env: passes; `/reports`,
  `/reports/funnel`, `/reports/tags` and the five `/api/reports/*` routes
  build.
- Migration replay (clean `supabase/postgres:17.6.1.178`, GoTrue and
  storage-api schemas, `classic-grants.sql`, every migration in order,
  then every verify file wired in `migrations.yml`): 249 migrations
  apply, 139 of 139 verify files pass, including the new
  `verify-funnel-report.sql` and `verify-chat-tag-report.sql`. One
  earlier failure (255's `chat_tag_*` functions executable by
  service_role, caught by `verify-internal-chat-admin.sql`) is fixed in
  `ebcb813`.

## Not done

- No browser check of the new screens at 375px (no Supabase project in
  this environment).
