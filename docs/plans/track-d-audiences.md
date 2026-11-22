# Track D: campaign audiences (U14)

## CHANGELOG entry
- Broadcast audience: "Match any / Match all" for chat tags; "Narrow this audience" by bank (from the customer's case, or from the chat sub-tag) and by lead source; drafts now save the whole wizard and reopen from the Broadcasts list ("Open draft"), can be deleted there, and saving again updates the same draft.
- **Migration required:** `252_broadcast_drafts.sql` (adds `broadcasts.draft_state jsonb`). The lead-source filter needs `contacts.lead_source` (migration 249).

## CLAUDE.md paragraph
Broadcast audiences (track D U14). Audiences are resolved in the browser (`estimateAudience` / `resolveAudience` in `use-broadcast-sending.ts`); the server only replays frozen `broadcast_recipients`, so there is no server-side re-resolution. Pure filter semantics live in `lib/broadcasts/audience-narrow.ts`: `chatTagMatch` 'any' (default/absent) | 'all' (chat holds every picked tag: main + its sub-tag), `bankCodes` + `bankSource` ('case' = any case at the bank via `cases.contact_id`, any stage; 'chat_tag' = chat sub-tag named like the bank's name or code), `leadSources` (any-of, `contacts.lead_source`). Not offered for CSV/Compass. Stored in `audience_filter` only when set. Drafts: `broadcasts.draft_state` (252) holds the whole wizard (`lib/broadcasts/draft-state.ts`, v1; CSV rows kept up to 5,000, else flagged and re-uploaded); the list opens `/broadcasts/new?draft=<id>`; Save updates the row; a real send deletes the draft. `verify-broadcast-drafts.sql`.

## Defaults chosen
- chatTagMatch 'any'; bank source 'case'; filter section collapsed. Bank from sub-tag matches sub-tag name to bank name/code, case-insensitive (caption not required).
- Draft CSV cap 5,000 rows. A past schedule time is dropped on reopen. Drafts without state ("Old draft") are listed but not reopenable; delete only.
- No RLS change: broadcasts write policies are admin (135).

## Merge needs
- `src/lib/contacts/lead-source.ts` was created by me (LEAD_SOURCES tuple, LeadSource type); reconcile if another agent has one. Needs migration 249 column `contacts.lead_source`.
- `draft_state` can hold CSV phones/names: add a note to data-map.ts for `broadcasts` (not edited by me).
- Recycle agent: if it adds an audience type, extend `AudienceConfig.type`, `isAudienceComplete` and `AUDIENCE_TYPES` in draft-state.ts.
- Wizard page now wraps in Suspense (useSearchParams).
- New i18n keys under the existing `Broadcasts` namespace (audienceNarrow, page.draft, new.toastDraft*, wizard.selectAudience.match*).

## Gates
typecheck ok; eslint 0 errors; vitest src/lib/broadcasts + messages pass; migration replay: migrations ok, verify fail=0.

## Not done
API v1 broadcast creation takes explicit recipients (no audience), so unchanged. No wizard UI test (node env).
