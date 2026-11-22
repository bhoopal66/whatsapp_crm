# Track C, case desk: tabs (U6) and forms (U16)

Notes for the merge. No migration is needed.

## CHANGELOG entry (paste)

- **Case desk: tabs in the link, counts, and a Settings home.** The open
  desk tab is now `?tab=` (a reload or shared link lands on the same tab;
  unknown values open Upload). Sorting queue and Tray show how many wait,
  and each row of the Case desk card on My worklist opens its own tab.
  Desk codes, WhatsApp routing, the customer reminder digest and each
  bank's primary and second coordinator moved to **Settings → Case desk**
  (owners and admins); the old `?tab=codes` link redirects there.
- **Case desk forms.** Document type is a pick list of labels ("Trade
  licence"), never an id. Bank, kind and role lists and the file chooser
  use the app's own controls. The case is looked up while its number is
  typed and its customer and bank show before you upload or file. A
  disabled button now says why. The Tray has "Find case" (by number, code
  or customer name).

## CLAUDE.md paragraph (replace the opening of "Case desk (`lib/desk/*`, migration 220)")

Add to the bullet list:

- **Tabs and settings.** `/desk` keeps only daily work: Upload, My
  uploads, Sorting queue, Tray, Companies and (team leaders and up)
  Overview. The open tab is `?tab=` (`resolveDeskTab`, `lib/desk/tabs.ts`;
  unknown or not-yours falls back to Upload; the old `codes` tab redirects
  to Settings). The queue and tray badges and the worklist rows read
  `desk_worklist` (one call, re-read on a tab change). Desk codes, 230's
  routing, 234's digest and 232's primary/second roles are in
  **Settings → Case desk** (`case-desk` section, `case-desk-panel.tsx`,
  admin+); the Overview's cover card keeps who covers today and leave
  (read-only roles). Forms use `DeskSelect` / `DeskFilePicker`, never a
  native select or file input; the case number is looked up as it is typed
  (`classifyCaseRef` first, then the sorting lookup, which answers a
  non-sorter NOT_ALLOWED: shown as "checked when you upload"); a doc type
  shows its label (`docTypeLabel`: workspace label from
  `GET /api/desk/doc-types`, else built-in, else humanised key); each
  disabled button gets a reason from `lib/desk/form-hints.ts`.

## Defaults and behaviours worth knowing

- Default tab stays Upload (link has no `?tab=`).
- Badges show only when above zero (99+ above 99). They are numbers with a
  screen-reader "N items waiting", not colour alone.
- Worklist row "follow-ups" (tasks) has no tab, so it is plain text, not a link.
- The doc-type list is account-wide (all banks and products), because the
  upload form does not know the bank/product yet. A key that is not in the
  list (from a caption, or an older upload) stays selectable.
- Tray "Find case" by number uses the sorting lookup (the caller's banks and
  readable cases). By name it uses the company search (companies the caller
  may read: a case of theirs, or team leader and up), expanded to open cases
  they can write. A bank holder who is not on the case may not find it by
  name but can by number. Filing still goes through the server's bank scope.
- Cover: the Overview card (team leaders and up) stays, with leave. An agent
  adding their own leave has no screen (the cover GET is leader-only); that
  was already so.

## Shared files touched (merge care)

- `src/components/desk/desk-view.tsx` (DeskView head, UploadTab, SortPanel
  file/new/reject blocks, one QueueTab line `docTypeLabel(i.docKey)`; the
  `CodesTab` function moved to `desk-codes.tsx`).
- `src/components/desk/tray-tab.tsx` (TrayCard only: merged candidates,
  `TrayCaseFinder`, disabled hints).
- `src/components/desk/tag-fields.tsx`, `desk-api.ts` (+`docTypes`),
  `cover-card.tsx` (`CoverCard` read-only; new `CoverRolesEditor`),
  `desk-worklist-card.tsx`, `companies-tab.tsx`, `company-banks.tsx`
  (native selects to `DeskSelect`, doc labels).
- `src/components/settings/settings-sections.ts` (+test), `src/app/(dashboard)/settings/page.tsx`,
  `src/app/(dashboard)/desk/page.tsx` (Suspense for `useSearchParams`).
- `messages/en.json`, `messages/ko.json`: new namespaces `CaseDeskSettings`,
  `DeskForms`, `DeskTabs` (after `Desk`), and `Settings.sections|hints|keywords['case-desk']`.
  ko reuses English.

## Slot for the CSAT feature

`src/components/settings/case-desk-panel.tsx` ends with
`{/* CSAT settings card mounts here */}`. Import `CsatSettingsCard` there
when it exists; nothing imports it today.

## Merge needs

- None in SQL. Base: the worktree branch was fast-forwarded to
  `claude/track-c-cases` first (its base predated desk 230-235).
- `NATIVE_FIELD` (tag-fields.tsx) now has no users; remove it on a later clean-up.
- The other agent's file-preview component goes into QueueTab/SortPanel/TrayCard:
  my SortPanel edit replaces the "find" row and the kind/doc selects; their
  preview should sit above or below the `mode === 'file'` block.

## Not done

- No browser run (no DOM tests in this repo; logic is in tested pure helpers).
- Upload form does not require anything beyond the file for a pending document
  (the server stays the judge); other disabled reasons are the existing ones.
