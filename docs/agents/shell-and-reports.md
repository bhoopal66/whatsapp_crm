> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Shell and reports (Round 6, migrations 254–255)

- **Shell.** `nav-items.ts` is the one list of screens: the sidebar, the
  Ctrl+K bar (`lib/command`) and the phone bottom bar (`MOBILE_TAB_HREFS`)
  all filter it through `isNavItemVisible`, so a new screen is added there
  once; role guards stay in the module layouts. `/team-inbox` and
  `/team-contacts` are the Team side of `TeamViewSwitch`, not nav rows; HR is
  one row (`/hr`) over `HR_TABS`. The page title is the top bar's `<h1>`
  only. Fold state is localStorage (try/catch). The phone drawer traps focus
  (`trapTabTarget`); the chat header's action buttons stay mounted inside
  the Chat actions menu because their dialogs live in them.
- **Funnel (254, `docs/funnel-report.md`).** `funnel_report()` (DEFINER,
  owners/admins of the ACTIVE account) returns the page as one jsonb: a
  cohort of company chats created in the period, followed to now. Stage
  definitions live in SQL and the doc: change both. `verify-funnel-report.sql`.
- **Chat tag report (255, `docs/chat-tag-report.md`).** Counts only, never
  text, names or phones. `chat_tag_report` (DEFINER) answers the owner or a
  live grantee in `report_access` (written only by the owner's
  `report_access_set`; deactivation keeps the row, which opens nothing
  until reactivation, 330; leaving the workspace deletes it, 256); the menu reads `report_my_access()`
  (`useReportNav`) and the pages keep `ReportAccessLayout`.
  `chat_tag_history` is written by a trigger that never fails the
  conversations write. Its functions are `chat_*`, so keep them revoked
  from service_role (`verify-internal-chat-admin.sql`). `REPORT_KEYS` ↔
  255's CHECK. `verify-chat-tag-report.sql`.
- **CSV** always goes through `lib/csv/build.ts` (quotes every field,
  neutralises `= + - @` starts). Team activity and dashboard downloads are
  owner-only (`canExportReports`), checked in the route.
