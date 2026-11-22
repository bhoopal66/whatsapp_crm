# Track D: Declined recycling (migration 251)

## CHANGELOG entry
- Added a Recycle screen (`/recycle`, team leader and up) listing customers whose case was Declined/Withdrawn, or whose chat has an admin-picked declined-type tag, at least N days ago; start a campaign or file follow-up tasks from a selection. Opted-out, do-not-contact, open-case and came-back customers are never listed. Settings (days, tags, outcomes) for owners/admins on the screen. docs/recycle.md.
- **Migration required:** `251_recycle_declined.sql` (apply as superuser/BYPASSRLS).

## CLAUDE.md paragraph
### Declined recycling (`lib/recycle/*`, migration 251)
`/recycle` lists customers whose latest case ended Declined/Withdrawn (`cases.outcome`, `closed_at`) or whose company chat has a main chat tag in `recycle_settings.chat_tag_ids`, at least `days` ago (chat ended = `last_message_at`; no tag timestamp exists). `recycle_candidates` is SECURITY INVOKER (contacts/cases/conversations RLS decide, team leader and up); one row per contact for the latest ending, then the days filter. Always excluded: opted out, do-not-contact, an open case/lead of any bank, a customer message newer than the ending; the last two come from the DEFINER helper `recycle_excluded_among` (answers only for ids passed, own workspace) because they must hold whatever the caller sees. `recycle_create_tasks` (INVOKER) files `follow_up` tasks as the caller, source `chat`, source_ref `recycle:<contact>:<UTC date>` (`recycleTaskRef` mirrors it), assigned to the contact owner if live staff else the caller. Settings: `recycle_settings`, written only by `recycle_settings_set` (owner/admin). The campaign goes through `lib/recycle/handoff.ts` (session storage + `?audience=recycle`, read by the wizard page as its initial CSV audience); nothing is sent automatically. `verify-recycle.sql`.

## Defaults chosen
90 days (1..730); outcomes Declined + Withdrawn; no chat tags (so chats are off until an admin picks tags); 25 per page; "select all" and each action cap at 1000; tasks have no due date; nav item minRole team_leader; RESTRICTED_PATHS includes /recycle.

## Merge needs (shared files touched)
- `src/app/(dashboard)/broadcasts/new/page.tsx`: 1 import (`readRecycleAudience`) and the `useState<AudienceConfig>` initializer (`() => readRecycleAudience() ?? { type: 'all' }`). step2 untouched.
- `src/components/layout/nav-items.ts`: `Recycle` icon import + one item after `/desk`; `nav-items.test.ts`: new `LEADER` const and `/recycle` in three expectations (will conflict with other nav additions: re-add `/recycle` to team-leader+ lists).
- `src/middleware.ts` protectedPaths, `src/lib/auth/departments.ts` RESTRICTED_PATHS, `src/components/layout/page-title.ts`: one line each.
- `messages/en.json`, `ko.json`: `Recycle` namespace before `Reminders`; `Sidebar.recycle`, `Header.recycle`.
- `src/lib/privacy/data-map.ts`: `recycle_settings` in NOT_PERSONAL config list.
- `.github/workflows/migrations.yml`: step appended at the end.

## Gates
typecheck clean; eslint 0 errors on touched files; vitest recycle, layout, privacy, auth, messages pass. Full SQL replay (migrations + all verify files incl. verify-recycle.sql) passed: "migrations ok / verify done fail=0".

## Not done
No Playwright/visual check of the screen (375px layout is stacked cards, not browser-verified). Declined (non-lead) cases are not fixture-tested because they need a submission group; Withdrawn cases cover the path.
