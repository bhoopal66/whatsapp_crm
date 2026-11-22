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
