# Track D notes: leads, contacts and campaigns

Branch `claude/track-d-leads`. Migrations used: **249** (lead source + web form),
**250** (saved views), **251** (recycle), **252** (broadcast drafts). Apply in order.

## CHANGELOG entry (coordinator: paste under Unreleased)

- **Broadcast wizard:** with no approved templates, step 1 now has a "Create template"
  button that opens Settings -> Templates, with a "Back to your new broadcast" link.
- **Contacts table:** sortable Name and Created, sticky header, formatted phones with Copy,
  bulk "Set chat tag" and "Add to campaign", hide/show columns, Source column and filter.
- **Saved views:** personal and shared views on the WhatsApp inbox and Contacts. Anyone saves
  personal views (only they see them); team leaders and up save shared ones.
  **Migration required:** 250.
- **Lead source:** contacts carry `lead_source` + details; Meta click-to-WhatsApp ad referral is
  captured on a contact's first inbound; public web form (off until an admin turns it on).
  **Migration required:** 249 (apply BEFORE deploying: the contact form and CSV import write the column).
- **Campaign audiences:** match all / any for chat tags, bank filter, lead source filter, and
  Save draft that reopens from the Broadcasts list. **Migration required:** 252.
- **Recycle:** `/recycle` list of long-declined customers with campaign and follow-up task actions.
  **Migration required:** 251.

## CLAUDE.md paragraphs

See each part's notes below (sections "CLAUDE.md paragraph"). Plus for saved views:

### Saved views (`lib/saved-views/*`, migration 250)

One generic `saved_views` table (`screen` text, `filters` jsonb object <= 16 KB) for the inbox and
Contacts; the cases inbox keeps its own 185 views (they run through case-role RPCs and a server
validator). RLS is the rule: a personal view is read/changed/deleted by its owner only (not even an
admin reads it); a shared view is read by the workspace, saved or kept shared only by a team leader+
(`canShareSavedViews`), changed/deleted by its owner or an admin. Identity columns are frozen by a
trigger. Each screen owns its filter shape and reads it back defensively (`parseInboxView`,
`fromViewFilters`). `SavedViewsMenu` is the shared UI. `verify-saved-views.sql`.

## Defaults chosen

- Saved views: personal by default; sharing is a switch visible to team leaders+.
- Web form off until an admin enables it; recycle 90 days, outcomes Declined+Withdrawn, no chat tags;
  audience match = any, bank source = case. Other defaults in the part notes.

## Merge needs

- `docs/public-api.md`: document `lead_source` on v1 contacts. Add `web-form.md`, `recycle.md` to
  the CLAUDE.md docs list.
- Nav: `/recycle` added to `nav-items.ts` (+ its test), `middleware.ts`, `departments.ts`
  RESTRICTED_PATHS, `page-title.ts`: other tracks' nav edits may textually conflict.
- Migrations 249 and 251 refuse to apply except as superuser/BYPASSRLS (like 220).
- messages: new namespaces `SavedViews`, `ContactsTable`, `Recycle`, `WebForm`; existing
  `Broadcasts` extended. The file's top-level order is not alphabetical, so namespaces were put
  at the nearest sensible spot.
- Both `src/lib/contacts/lead-source.ts` (client helpers) and `src/lib/leads/lead-source.ts`
  (list + server capture) exist; the first re-exports the list from the second.
- Two broadcast-wizard handoffs exist (recycle: `recycle.audience.v1`; contacts: `audience=handoff`);
  both feed the CSV audience type. Harmless; unify later.

## Not done

- Contacts sort by Owner, Assigned and Last activity (PostgREST cannot order contacts by a to-many embed;
  needs an RPC/view: no migration number left).
- `lead_source` not auto-set for broadcast / compass / v1 POST /contacts.
- No iframe embed for the web form (global frame-ancestors none): HTML form snippet only.
- Browser checks (375px, sticky header) not run: tests are node-only.

## Gate results

Final tree (merged), 2026-11-22:
- `npm run lint`: 0 errors (26 warnings, pre-existing kinds); `npm run typecheck`: clean.
- `npm test`: 1095 files, 15,602 tests passed.
- `npm run build` with the CI dummy env: passed.
- SQL: fresh supabase/postgres 17.6 container, storage-schema stand-in, `classic-grants.sql`, every migration
  in order (through 252), then every verify file in migrations.yml order (incl. saved views, web lead form,
  recycle, broadcast drafts): all passed. Replay was done with a local script, not the Supabase CLI.

---
# Part notes (from the builders)



---
## Part: lead-source

# Track D — lead source and the public web form (item 4)

Migration **249** (`249_lead_source_web_form.sql`), verify file
`supabase/ci/verify-web-lead-form.sql` (33 checks), wired in
`.github/workflows/migrations.yml`. Operator contract: `docs/web-form.md`.

## Contract for the other Track D agents (column names)

- `contacts.lead_source text NULL`, CHECK `contacts_lead_source_check`:
  `ad, web_form, broadcast, manual, import, compass, other` (NULL = unknown).
- `contacts.lead_source_detail jsonb NOT NULL DEFAULT '{}'` (object, ≤ 4 KB).
- Index `idx_contacts_lead_source (account_id, lead_source) WHERE lead_source IS NOT NULL`.
- TS: `LEAD_SOURCES`, `LeadSource`, `isLeadSource` in
  `src/lib/leads/lead-source.ts` (dependency-free apart from types; safe in
  client components); `Contact.lead_source?` / `lead_source_detail?` in
  `src/types/index.ts`.
- Service-role setter: `contact_set_lead_source_if_empty(p_account, p_contact,
  p_source, p_detail) → boolean`; TS wrapper `setLeadSourceIfEmpty` (never
  throws).

## CHANGELOG entry

### Added
- **Lead source.** Contacts record where they came from (`lead_source`: ad,
  web form, broadcast, manual, import, Compass, other). A Meta
  Click-to-WhatsApp ad's referral is captured on the contact's first inbound
  message; Add contact records `manual`, Import records `import`. Automatic
  writers only ever fill an empty source. The public API's contacts carry a
  read-only `lead_source`.
- **Public web form** (Settings → Integrations → Web form, owners/admins,
  off by default). A hosted page `/f/<token>` and a script-free HTML snippet
  post to `POST /api/public/web-form/<token>`, which creates or completes the
  contact (source `web_form`) and opens an unassigned "New web lead"
  follow-up task, at most one per number per 10 minutes. Allowed websites
  list, rate limits (10/min per IP, 200/h per form, fail closed), honeypot,
  8 KB body cap. Never sends WhatsApp, never touches consent. See
  `docs/web-form.md`.

**Migration required:** apply `249_lead_source_web_form.sql` as a
superuser or BYPASSRLS role **before deploying the build** (the contact form
and CSV import now write `lead_source`; without the column those inserts
fail).

## CLAUDE.md paragraph (proposed, under Architecture)

### Lead source and web form (`lib/leads/*`, `lib/web-form/*`, migration 249)

`contacts.lead_source` (seven values or NULL = unknown; CHECK
`contacts_lead_source_check` ↔ `LEAD_SOURCES`, pinned by
`lead-source.test.ts`) and `lead_source_detail` (object ≤ 4 KB) are plain
columns people set at insert (Add contact `manual`, Import `import`);
automatic writers fill an EMPTY source only, through
`contact_set_lead_source_if_empty` (service role), so the first known source
wins. The Meta referral (`message.referral`, already normalised) is captured
in `inbound-pipeline.ts` after the idempotency boundary and before the
`fanOut: false` cut, on the chat's first inbound only, never a personal
number, via `later` (never throws). The web form (`docs/web-form.md`):
`web_lead_forms` (one row per account, FORCE RLS, no grants; 64-hex token
generated in SQL) is read and written only through `web_form_get` /
`web_form_set` (owner/admin of the ACTIVE account) and the service-role
`web_form_public_config` / `web_form_submit`; unknown and disabled tokens are
indistinguishable (404). `web_form_submit` finds the contact by
`phone_normalized` (the route normalises with `validateContactPhone`) or
creates it owned by `accounts.owner_user_id`, fills only empty name/email,
never writes consent, and opens one `follow_up` task (`source 'automation'`,
`source_ref web_form:<contact>:<ms>`, no assignee) per contact per 10 minutes
under a per-(account, phone) advisory lock. `web_form_origin_ok` (SQL) ↔
`normalizeAllowedOrigin` (TS): change both. Rate scopes `webform.ip` /
`webform.token` fail closed. No iframe embedding: frame headers unchanged.
`verify-web-lead-form.sql`.

## Defaults chosen

- Web form **off** until an admin switches it on; no row until the first save.
- Contact owner for a new web lead: the workspace owner (`accounts.owner_user_id`).
- Task: title "New web lead", note = the visitor's message, kind `follow_up`,
  source `automation`, no assignee, linked to the contact (so admins and anyone
  who can see the contact see it). Dedupe window 10 minutes per contact.
- A name equal to the number (inbound's fallback) counts as empty and is
  filled by the form.
- Limits: name 120, email 254, message 2000, page_url 500 (query string
  dropped), body 8 KB, ≤ 20 allowed origins, https only, no path.
- Rate limits: `webform.ip` 10/min, `webform.token` 200/hour, both fail closed.
- Origin rule: own origin always (no ACAO); listed origin → ACAO echo; no
  Origin header → accepted only while the list is empty; `Origin: null` never.
- Referral `source_type` `ad` → `ad`; anything else (post) → `other`.
- HTML-form posts get a 303 back to `/f/<token>?sent=1` or `?error=<code>`;
  JSON posts get JSON.
- No iframe snippet (decided): `X-Frame-Options: DENY` / `frame-ancestors
  'none'` stay global. `form-action 'self'` is unaffected (the hosted page posts
  same-origin; a third-party site's form is governed by that site's CSP).
- Middleware unchanged: `/f/*` and `/api/public/*` are not in
  `protectedPaths` and not under `/api/whatsapp/`, so they already pass
  unauthenticated (the session refresh still runs; harmless for anonymous).

## Skipped / not done

- `lead_source` 'broadcast' (CSV audience contacts in
  `hooks/use-broadcast-sending.ts`): left to the campaign-audience agent's
  area. 'compass': Compass customers live in `compass_contacts`, not
  `contacts`; nothing trivial to stamp. Public API `POST /api/v1/contacts`
  writes no source (NULL).
- Metrics: web form refusals are not counted in `countEdgeRefusal` (its
  `EdgeRefusal` union is fixed; adding kinds is another file's change).
- PDPL: `lead_source_detail` may hold a page URL / ad headline. 222's erase
  anonymises the contact row but does not know the new column (see Merge needs).
- No iframe embedding (see defaults).

## Merge needs

- `docs/public-api.md`: contacts gain a read-only `lead_source` field
  (serializer done in `src/lib/api/v1/contacts.ts`). `mcp-server/` untouched.
- `CLAUDE.md` docs list: add `web-form.md`; and the paragraph above.
- PDPL erase (222 / `privacy_extensions` 229): consider resetting
  `contacts.lead_source_detail` to `'{}'` on erase. Not done here (would mean
  restating 222's body).
- `settings-sections.ts` / settings `page.tsx` / `settings-sections.test.ts`:
  a new `web-form` section was appended to Integrations; other agents adding
  sections will conflict textually there (trivial merge).
- `messages/*.json`: new top-level `WebForm` (inserted after `Voicemail`) and
  `Settings.webForm`, plus `Settings.sections/hints/keywords['web-form']`.
- `src/lib/edge/ratelimit.ts` DEFAULT_SCOPES gained two scopes (test updated).

## Gate results

- `npm run typecheck`: clean.
- `npx eslint` on touched files: 0 errors (pre-existing warnings only).
- vitest: `src/lib/web-form`, `src/lib/leads`, `src/app/api/public`,
  `src/lib/api/v1`, `src/components/settings`, settings page, `src/lib/privacy`,
  `src/lib/edge`, `src/lib/whatsapp`, `src/i18n`: 92 files, 1766 tests passed.
- SQL: full stack replayed with the coordinator's `replay.sh` (fresh
  supabase/postgres container): `migrations ok`, `verify done fail=0`;
  249 re-applied a second time and the verify re-run: passed (33 checks).


---
## Part: contacts-table

# Track D: Contacts table (U15)

## CHANGELOG entry

**Contacts table.** The Contacts screen (and Team contacts) gains:
sortable Name and Created columns (kept in the URL: `?sort=name&dir=asc`),
a sticky header with sticky checkbox and name columns, phones shown as
`+971 50 123 4401` with a copy button, bulk "Set chat tag" and "Add to
campaign" beside Delete in a sticky bulk bar, a Columns menu with "Hide empty
columns" (saved per user in the browser), a Source column and any-of Source
filter (`?source=ad,web_form`), and a slot for saved views.

- Migration required: none from this part. The Source column and filter read
  `contacts.lead_source`, added by migration 249 (another part). Until 249 is
  applied set `LEAD_SOURCE_COLUMN_AVAILABLE = false` in
  `src/lib/contacts/lead-source.ts` (it ships as `true`).

## CLAUDE.md paragraph (suggested, under Chat tags or a new "Contacts table")

### Contacts table (`lib/contacts/*`, `components/contacts/*`)

The list is server-paginated (25/page). **Sort** is `lib/contacts/sort.ts`:
only `name` and `created` (columns of `contacts`) are offered, ordered in the
query, or over the whole match set when the chat-tag filter is on
(`pageOfContactIds(…, sort)`). Owner, Assigned to and Last activity are NOT
sortable: owner/assignee are uuids and the assignee and last message live in
the to-many `conversations` embed, which PostgREST cannot order contacts by;
sorting only the loaded page would mislead. A close-match search ranks by
relevance, so the sort headers are disabled while it is active. State lives in
the URL (`sort`, `dir`, `source`), read on mount (`urlReady` gates the first
fetch). `formatPhoneDisplay` is display-only (stored phones untouched);
`phoneForCopy` copies the raw international number. Bulk tag is
`POST /api/contacts/bulk/chat-tag` (agent+, <= 200 ids, concurrency 4): each
contact's company chat goes through `writeConversationChatTags({contactId})`
under the caller's RLS client, `clearTagSuggestion` (now shared,
`lib/chat-tags/clear-suggestion.ts`) and `dispatchChatTagSet` once per
changed chat; answer `{updated, unchanged, skipped, failed}`. Add to
campaign uses `lib/broadcasts/audience-handoff.ts` (sessionStorage key
`taamul.broadcast.audienceHandoff`, `?audience=handoff`). Column prefs
(`lib/contacts/columns.ts`) are per user in localStorage. `lead-source.ts` is
the dependency-free source list; `view-filters.ts` is the saved-view shape.

## Defaults chosen

- Default sort: Created, newest first (unchanged behaviour). Name sort is
  ascending first; a blank name sorts last in the tag-filter path, and at the
  database's null ordering in the plain path (null last; empty string is not
  null). Name ordering follows the database collation in the plain path and
  `localeCompare('en')` in the filter path; they can differ slightly on
  accents.
- Table container max height `calc(100dvh - 14rem)`, min 12rem, scrolls both
  ways (this is what makes the header and the first two columns sticky).
- Hide empty columns: off; nothing is "empty" while no rows are loaded.
- localStorage key `taamul.contacts.columns.v1:<userId>`.
- Source column hidden below `md`; bulk bar sticks to the bottom of the page.
- Bulk tag with only a main tag keeps the chat's current sub-tag while the main
  tag is unchanged (header rule); "Keep the current sub-tag" is the default
  choice. "Remove the chat tag" clears both.
- Add to campaign hands over the ticked rows on the current page (selection is
  page-scoped). Contacts without a phone are dropped, numbers deduped. A
  handoff expires after 1 hour and holds at most 1000 rows.

## Merge needs

1. **Migration 249** must be applied for Source (`contacts.lead_source`).
   `LEAD_SOURCE_COLUMN_AVAILABLE` is `true`. `CONTACT_LIST_SELECT` is already
   `*, conversations(...)`, so the column arrives with the row; only the
   filter names it (`.in('lead_source', [...])`). Add `lead_source` to
   `src/types` `Contact` if wanted (not done to avoid conflicts; code reads it
   through `leadSourceOf`).
2. **Wizard receiver** (not edited by me). In the new-broadcast wizard page,
   on mount, if `new URLSearchParams(location.search).get('audience') ===
   'handoff'`:
   ```ts
   import { readAudienceHandoff } from '@/lib/broadcasts/audience-handoff';
   const h = readAudienceHandoff(window.sessionStorage); // consumes the entry
   if (h) {
     setAudience({
       type: 'csv',
       csvContacts: h.rows, // already CsvContactRow-shaped {phone,name,company,values}
       csvColumns: ['name', 'phone', 'email', 'company'], // keys present in row.values
     });
     // optionally start at step 1 (template) with a banner "N contacts from Contacts"
   }
   ```
   Wrap `window.sessionStorage` access in try/catch. If the recycle agent's
   module exists at merge time, keep one of the two handoff modules and
   point both senders at it (key and URL above).
3. **Saved views**: mount point is `toolbarExtras` (render prop on
   `ContactsPageInner`: `({ filters, applyView }) => ReactNode`, filters is a
   `ContactsViewFilters`), also marked `SAVED-VIEWS SLOT` in the page. To use it
   in `/contacts` and `/team-contacts`, pass the prop from the route files
   or edit the slot directly. `applyView` ignores `personalOnly` (scope is
   role-derived).
4. No SQL needed. A server-side sort by owner / assignee / last activity would
   need a SQL helper (e.g. a view or RPC returning contact ids ordered by
   the joined owner name / `conversations.last_message_at`); not built.
5. `messages/*.json`: new namespace `ContactsTable` (inserted after
   `ContactSearch`); no existing keys changed.
6. Refactor note: the single-chat route now imports `clearTagSuggestion` from
   `src/lib/chat-tags/clear-suggestion.ts` (moved verbatim; its log prefix
   changed).

## Not done / limits

- Sort by Owner, Assigned to, Last activity (see above; not offered rather
  than misleading).
- No UI chips for the Source filter (the trigger shows a count).
- No component tests (node env, no jsdom); logic is in pure modules with tests.
- No API test for the bulk route (the single-chat route test mocks the same
  boundary; not duplicated).
- Not exercised in a browser; layout at 375px reasoned from classes only.

## Gate results

Run on the final tree: `npm run typecheck` clean; `npx eslint` on touched
files 0 errors (one pre-existing warning in contact-form.tsx);
`npx vitest run messages src/lib/contacts src/lib/broadcasts/audience-handoff.test.ts
src/lib/chat-tags src/app/api/conversations`: all pass. SQL: none.


---
## Part: audiences

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


---
## Part: recycle

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
