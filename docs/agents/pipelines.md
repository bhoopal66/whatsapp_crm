> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Pipelines (`lib/pipelines/*`, migration 080)

Deal visibility follows the deal's **owner** (assignee, else creator),
not its contact: admins see all, leaders their own and their team's,
agents and viewers their own (`can_view_deal`, also the WITH CHECK on
insert/update). `deals.assigned_to` is a `profiles.id` but
`deals.user_id` an auth user id, so a person is carried as both
(`deal_owner()` in SQL, `PersonIds` in `lib/pipelines/owner.ts`).

A stage linked to a main chat tag (`pipeline_stages.auto_chat_tag_id`)
gets a deal opened by the `create_deals_for_chat_tag` trigger when a
chat *arrives* at that tag, or (138) the contact's open deal in that
pipeline (this chat's first, else the newest) moved there. The title is
`<name> · <sub-tag>`; a sub-tag change re-titles that deal but never
opens one, and only a title still in that generated shape is rewritten.
An unlinked tag moves nothing, and it never blocks the tag write
(failures are WARNINGs).
Automation/flow tagging fires it too. Links are written one stage at a
time, clears before sets (`stage-tag-links.ts`), because a partial
unique index allows one stage per tag per pipeline.
