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

PLACEHOLDER

## Defaults

PLACEHOLDER

## Merge needs

PLACEHOLDER

## Gate results

PLACEHOLDER
