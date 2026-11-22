# Track C notes: cases and the Case desk

Branch `claude/track-c-cases`. Migrations used: **246** (CSAT) and **248** (file preview). **247 is unused.**

## Items and status

| # | Item | Status |
|---|---|---|
| 1 | N9 desk card spacing | Done |
| 2 | N6 case Overview | Done |
| 3 | U4 case numbers, copy, search | Done |
| 4 | N7 filters on one row | Done |
| 5 | U6 desk tabs, Settings → Case desk | Done |
| 6 | U5 file preview (migration 248) | Done |
| 7 | U16 desk forms | Done |
| 8 | N10 Open chat button | Done |
| 9 | CSAT (migration 246) | Done |

## CHANGELOG entry (items 1–4, 8)

- Case desk cards: removed the extra top padding.
- Case page Overview now opens on the document checklist status, the next step and the customer's last message (with an Open chat link); SLA, stage, reassignment and detail boxes show only when they have rows.
- Case page header shows the case number (TC-YY-NNNNN-BBB) and caption code, each with a Copy button.
- Cases list: search box (`q`, kept in the link) finds by case number, caption code or customer name; Bank, stage, agent, priority, SLA and sort are on one row; the toggles are behind "More filters" with a count.
- Customer page: the "WhatsApp" button is now "Open chat".

No migration for these.

## CLAUDE.md paragraph (items 2–4)

- **Case Overview and search (`lib/cases/overview.ts`, `search.ts`, `search-inbox.ts`).** The Overview's lead row reads the documents checklist and `GET /api/cases/[id]/last-message`, which reads the contact's company chat through the caller's RLS client (not the audited group conversation; no chat visible = no card). `case_inbox` has no text filter, so `GET /api/cases?q=` pages the inbox (200 a page, at most 15 pages) and keeps matches on case number, caption code (check character valid), customer name, own name and submission ref; the cursor of the last scanned page goes back. `q` is not part of a saved view (`ViewFilters` omits it). `cases.case_number` rides on `Case.caseNumber`.

## Defaults chosen

- Search: 100 characters, 400 ms debounce, scan cap 15 pages of 200 cases.
- Last message snippet: 200 characters, company chat only (`personal_owner_id IS NULL`).
- Next step: missing documents first, then the next allowed stage in the bank's list.
- More filters: collapsed by default; the count covers the toggles, no-activity days and a non-default snooze mode.

## Merge needs (whole track)

- Nothing restated from other features. Migrations 246 and 248 add tables and functions only (see sub-notes).
- Migrations 246/248 must be applied after 235. 247 is free.
- Settings → Case desk (`case-desk` section) now holds Desk codes, routing, digest, cover roles and the CSAT card; the desk screen's `?tab=codes` redirects to Settings.
- A Meta CSAT template must be submitted and approved before Meta sends outside the 24 h window (texts under "Meta templates to submit" below).

## Gate results (merged tree, 2026-11-22)

- `npm run lint`: 0 errors, 31 warnings.
- `npm run typecheck`: clean.
- `npm test`: 1092 files, 15,636 tests pass.
- `npm run build` with the CI dummy env: passes.
- Migration replay (Postgres 17 `supabase/postgres` image with real GoTrue and storage-api containers, not the Supabase CLI): classic-grants, all 001–248 files and every verify step in `migrations.yml`: 365 of 365 pass.
- Not done: no real-browser check (PDF in the iframe, 375 px layout), no component render tests (the repo has no DOM).

---

# Sub-notes: csat-notes

# Track C: case CSAT, merge notes

Migration **246** (`supabase/migrations/246_case_csat.sql`). Number 247
was not needed and is unused. Operator contract: `docs/case-csat.md`.

## Meta templates to submit

Coordinator-approved wording, used as the defaults (template bodies and
the linked-device text). `{{1}}` = customer's first name, `{{2}}` = bank
and product (e.g. "Emirates NBD business account"). Scale 1-5, replies
counted 7 days, sent once at submission and once at approval. Category
Utility, language `en`.

- `case_csat_submitted`: "Hi {{1}}, your {{2}} application has been
  submitted to the bank. How happy are you with our service so far? Reply
  with a number from 1 (not happy) to 5 (very happy)."
- `case_csat_approved`: "Hi {{1}}, good news: your {{2}} account has been
  approved! How would you rate our service? Reply with a number from 1
  (not happy) to 5 (very happy)."

Arabic drafts (not coordinator-approved) are in
`docs/plans/track-c-csat-template.md`.

**Wording issue to confirm:** with `{{2}}` = "Emirates NBD business
account", the approved text would read "your Emirates NBD business
account account has been approved". The code drops a trailing "account"
from the product for the approved moment only (`csatBankProduct`), so it
reads "your Emirates NBD business account has been approved". If the
coordinator prefers, change the approved template to "your {{2}} has
been approved" and remove that rule (one line in `src/lib/cases/csat.ts`
plus its test).

## Defaults chosen

- Off by default; no settings row = off. Both moments on once switched on.
- Template names `case_csat_submitted` / `case_csat_approved`; language
  `en` (`ar` switches the text and the template language to Arabic).
- Reply window 7 days (1-30).
- Send hours 09:00-20:00 Dubai (start 8-20, end 9-21); nothing ever
  before 08:00 or from 21:00.
- One rating request per person per 24 hours; a request not sent within
  3 days of its moment expires; held requests retry hourly; a claim with
  no result for 10 minutes is `unconfirmed` and never resent.
- "Submitted" = the first stage write that leaves the pre-submission
  stages for a non-final stage (covers banks with their own stage list
  and cases opened straight at a later stage). "Approved" = stage
  `Approved` or outcome `Approved`.
- No contact / no company chat / opted out / do-not-contact at the
  moment: the request is written `skipped` and never asked later.
- A Flow consuming the message wins; a captured rating suppresses the
  journey bot, content automations and AI reply (like a Flow). Not
  captured over the webhook rate limit (`fanOut: false`) or on a
  personal number. No thank-you reply.
- Compass lock (`case_managed_externally`) not consulted: it blocks
  people, CSAT changes nothing on the case.
- Team activity: unchecked, like the desk digest (`sendDeskDigest`).
- Not counted in the HR automsg / desk digest daily cap of 3 (their claim
  functions are not restated).
- Privacy: requests and ratings are personal (link contact, content,
  erase delete, exported) via `privacy_extensions` `case_csat`;
  settings are config.
- Averages: last 90 days, ratings of cases the viewer can read
  (`case_can_read` once per distinct case); agent and bank are the case's
  at the time of asking.

## Shared files touched

- `src/components/cases/case-page/overview-tab.tsx`: one import, one JSX
  line (`<CsatScore caseId={detail.case.id} />`, first in the grid).
- `src/components/cases/cases-inbox.tsx`: one import, one JSX line
  (`<CsatAverages />`, last child of the page wrapper, after the list).
- `src/lib/whatsapp/inbound-pipeline.ts`: import + `csatConsumed` after
  the Flow dispatch; journey, `botConsumed` and the AI-reply condition
  include it.
- `src/lib/whatsapp/inbound-pipeline.fanout.test.ts`: a `csatRpc` mock and
  a "case CSAT reply" describe block.
- `src/app/api/automations/cron/route.ts`: imports, `scheduleCaseCsat`
  (every 5 min), called after `scheduleDeskDigests()`.
- `src/lib/privacy/data-map.ts`: `case_csat_requests`,
  `case_csat_responses` (PERSONAL), `case_csat_settings` (config).
- `messages/en.json`, `messages/ko.json`: namespace `CaseCsat` between
  `CustomerCases` and `CasePage` (ko is English).
- `.github/workflows/migrations.yml`: "Verify case CSAT" after the desk
  worklist step.

## Not mounted yet

`CsatSettingsCard` (`src/components/settings/csat-settings-card.tsx`,
props `{ readOnly?, className? }`, self-loading) is for Settings → Case
desk. Its API is owner/admin only (`requireRole('admin')`), so mount it
only for owners and admins.

## Merge needs

- None of another feature's functions or CHECK lists are restated.
- If the shared daily cap (HR automsg 203/215/226 claim and
  `desk_digest_claim` 234) should count CSAT requests, those claims need
  a `case_csat_requests` term (status `sent`/`sending`/`unconfirmed`,
  `sent_at`/`claimed_at` today); 246's claim would then add their counts.
  Not done to avoid restating their bodies.
- Settings search (`src/components/settings/settings-search.ts`) may want
  a CSAT entry once the card is mounted.

## CHANGELOG entry (to paste)

```
### Added
- Customer ratings (CSAT) for cases, off by default. When a case is
  submitted and when it is approved, the customer is asked to rate our
  service from 1 to 5 from their chat's own number (plain text on
  Whapi/OpenWA and inside Meta's 24-hour window; an approved utility
  template on Meta outside it, else the request waits). A reply of 1-5
  (with an optional comment) within 7 days is stored once and shown on
  the case page; the Cases screen shows the 90-day average per agent and
  per bank. Respects opt-out and do-not-contact, send hours (09:00-20:00
  Dubai by default) and at most one request per person a day.
  docs/case-csat.md.

**Migration required:** apply `246_case_csat.sql` as a superuser or
BYPASSRLS role, after 234. Submit the two Meta templates
(`case_csat_submitted`, `case_csat_approved`) before switching CSAT on
for a workspace with a Meta number.
```

## CLAUDE.md paragraph (to paste under Cases)

```
- **CSAT (246, `lib/cases/csat*.ts`, `docs/case-csat.md`).** Off by
  default (`case_csat_settings`, no row = off). The
  `case_stage_history_csat` trigger (never fails the stage write)
  queues one `case_csat_requests` row per case per trigger: 'submitted'
  on leaving the pre-submission stages for a non-final stage,
  'approved' on Approved (`case_csat_trigger_for` ↔ `csatTriggerFor`);
  'skipped' with no contact, no company chat, opt-out or DNC. The
  automations cron runs `runCaseCsat` (5 min): `case_csat_claim`
  re-checks switches, send hours (Dubai), opt-out/DNC, one per person
  per 24 h under an advisory lock, expiry at 3 days; stale claims ->
  'unconfirmed', never resent. `sendCaseCsat`: the chat's own number,
  never personal; text on Whapi/OpenWA and Meta inside the window, the
  approved utility template ({{1}} first name, {{2}} bank and product)
  outside it, else 'held' (`awaiting_template`, hourly retry); Team
  activity unchecked, not in the HR/digest daily cap. Replies:
  `noteCsatReply` in `processMessage` after Flows (a Flow wins; a
  capture suppresses journey, content automations and AI);
  `parseCsatReply` costs nothing for non-ratings; `case_csat_capture`
  stores once per request within `reply_window_days`. Reads:
  `case_csat_for_case` (case_can_read) and `case_csat_scores` (per
  distinct case) behind TENANCY-checked routes. The wording lives in
  `CSAT_TEMPLATE_BODIES`; defaults pinned to the migration by
  `csat.test.ts`. `verify-case-csat.sql`.
```

## Gates run

- `npm run typecheck`: clean.
- `npx eslint` on every touched file: 0 errors, 0 new warnings.
- vitest: `src/lib/cases/csat*.test.ts`, the inbound pipeline tests,
  `src/lib/privacy`, `src/components/settings`, `src/i18n`, every test
  that reads `supabase/migrations`, `src/lib/cases`, `src/app/api/cases`,
  `src/lib/whatsapp`.
- Local replay: every migration 001-246 against a clean PostgreSQL 16
  (with a minimal Supabase base-schema stand-in for auth/storage/roles,
  then `supabase/ci/classic-grants.sql`), 246 applied twice, then every
  verify file listed in `migrations.yml` (127, including
  `verify-case-csat.sql`, 36 checks): all pass. Not the Supabase CLI
  image itself.

---

# Sub-notes: preview-notes

# Track C — File preview while sorting (U5): merge notes

Branch: `worktree-agent-a58793a77c6b8ea2c`, fast-forwarded to
`claude/track-c-cases` (7756835) before any work, because the worktree was
created at 29de8d4, which has neither the tray (230) nor migrations 228-235.

## What shipped

- **Migration 248** `supabase/migrations/248_intake_file_preview.sql`
  - `desk_file_previews` — append-only audit (account, actor, intake item
    id XOR tray id, time). No URL, path or file name. FORCE RLS, no grants,
    no FK on the item / tray id (so 222's erase of a tray row is never
    blocked).
  - `intake_file_for_preview(actor, account, item, now)` → `storage_path,
    mime, original_name, size_bytes`. Uploader always; anyone else only
    while the item is `untagged` and `intake_scope_ok(actor, account,
    queue_bank_code)`. Otherwise `ITEM_NOT_FOUND` (same answer for another
    workspace / non-staff / unknown id); no file → `FILE_NOT_FOUND`.
  - `desk_tray_file_for_preview(actor, account, tray, now)` →
    `storage_bucket, storage_path, media_url, mime, original_name`. Open
    items only, `desk_tray_can_sort`; else `TRAY_NOT_FOUND`.
  - Both write the audit row before returning (so before the route signs).
    SECURITY DEFINER, `search_path ''`, service_role only. Re-runnable;
    restates no other migration's function.
- **Verify** `supabase/ci/verify-intake-file-preview.sql` (one DO block,
  fixture prefix `dfp-`, UUIDs `…000000248xxx`, 23 checks), wired into
  `.github/workflows/migrations.yml` after the desk worklist step.
- **Routes** (`Cache-Control: no-store` on every answer, URL never logged):
  - `GET /api/desk/intake/[id]/preview`
  - `GET /api/desk/tray/[id]/preview`
  - 200 `{ url, expiresAt, mime, name, kind }`; 404 `ITEM_NOT_FOUND` /
    `TRAY_NOT_FOUND` / `FILE_NOT_FOUND`; 501 `NOT_CONFIGURED` (no storage
    signer); 400 bad id; 500 on a signing failure (logged by function name
    only).
  - Intake: re-checks the path is `intake/<this item>/<sha256>.(pdf|jpg|png)`
    before signing (`isIntakeObjectPath`). Tray: a `case-files` copy is
    signed; a public chat-media URL is returned re-pointed at the public
    origin (expiresAt null); anything else is `FILE_NOT_FOUND`.
- **Lib** `src/lib/desk/preview.ts` (pure, client-safe: `previewKind`,
  intake path rule, route URLs, `parsePreviewLink`, `previewErrorKey`,
  `msUntilExpiry`) and `src/lib/desk/preview-server.ts` (`DeskPreviewStore`
  RPC wrapper with 220's HINT → `DeskRefusedError` mapping, 300 s signing,
  `noStore`, `notConfigured`). `store.ts` is untouched.
- **UI** `src/components/desk/file-preview.tsx`: `FilePreview` (fetches on
  demand, image `<img>` / PDF `<iframe>` / other → `EmptyState` +
  "Open in new tab"; loading/error/expired states with icon + words;
  re-fetch after expiry) and `PreviewBeside` (stacked on phone, two
  columns from `lg`).
- **CSP** `frame-src 'self' https://*.supabase.co <NEXT_PUBLIC_SUPABASE_URL
  origin>` (was falling back to `default-src 'self'`); `csp.test.ts`
  updated. `img-src` already allows `https:`.
- **i18n** new top-level `DeskPreview` namespace (after `Desk`) in en/ko.
- **Privacy** `desk_file_previews` in `PERSONAL` (link case, identifier,
  retain, AUDIT, not exported).

## Defaults chosen

- Signed URL TTL 300 s (`PREVIEW_URL_TTL_SECONDS`); the component shows
  "link expired, load again" when it lapses rather than a dead frame.
- Sorting queue: preview loads automatically when the Sort panel opens.
  Tray: on demand ("Show file"), so opening the tab does not audit /
  sign one link per card.
- A sorter may not preview an item once it is sorted (it is then a case
  file, readable through the case's own audited download); the uploader
  keeps access to their own upload in any state.
- Inline kinds: PDF, JPEG, PNG, WebP, GIF; everything else (HEIC, Word…)
  gets only "Open in new tab".

## Shared files touched (small, localised edits)

- `src/components/desk/desk-view.tsx`: one import, and the `SortPanel`
  in `QueueTab` wrapped in `<PreviewBeside preview={i.hasFile && <FilePreview …/>}>`.
- `src/components/desk/tray-tab.tsx`: one import, one `<FilePreview …/>`
  just above the candidates `<fieldset>`. The old "Open · name" link to
  `item.mediaUrl` is left in place (the other agent may drop it; the
  preview's own "Open in new tab" covers it).
- `messages/en.json`, `messages/ko.json` (new namespace only),
  `src/lib/csp.ts` / `csp.test.ts`, `src/lib/privacy/data-map.ts`,
  `.github/workflows/migrations.yml`.

## CHANGELOG entry (to paste)

```md
### Added
- **Case desk: see the file while sorting.** Opening an upload in the
  Sorting queue shows its PDF or image beside the sort panel (stacked on a
  phone), and each Tray document has a "Show file" preview. Links are
  signed for 5 minutes, never cached, and every preview is audited.
  New routes `GET /api/desk/intake/[id]/preview` and
  `GET /api/desk/tray/[id]/preview`.

**Migration required:** apply `supabase/migrations/248_intake_file_preview.sql`
as a superuser or BYPASSRLS role (after 220 and 230). The CSP gains
`frame-src` for the Supabase origin; rebuild so `NEXT_PUBLIC_SUPABASE_URL`
is inlined.
```

## CLAUDE.md paragraph (to paste under "Case desk")

```md
- **File preview (248, U5).** `intake_file_for_preview` (uploader always;
  others only while `untagged` and `intake_scope_ok` on the queue) and
  `desk_tray_file_for_preview` (open items, `desk_tray_can_sort`) write an
  append-only `desk_file_previews` row (ids and time, no URL) and return
  the location; the routes (`/api/desk/{intake,tray}/[id]/preview`) then
  sign 300 s, `no-store`, never logged. The intake route re-checks the
  220 path (`isIntakeObjectPath`) before signing. `frame-src` in
  `csp.ts` carries the Supabase origin for the PDF frame.
  `verify-intake-file-preview.sql`.
```

## docs/case-desk.md paragraph (not edited here, to avoid conflicts)

```md
## File preview while sorting (migration 248)

Opening an upload in the Sorting queue shows the file beside the sort
panel; a Tray document has a "Show file" button. The server hands out a
link valid for 5 minutes, only to the uploader or, while the upload waits,
to someone who sorts that queue (tray: someone who may sort the item).
Each preview is recorded (who, which item, when). PDFs and common images
show inline; other files open in a new tab.
```

## Gates run

- `npx eslint` on every touched TS/TSX file: 0 errors, 0 warnings.
- `npm run typecheck`: clean.
- `npx vitest run src/components/desk src/lib/desk src/app/api/desk
  src/lib/csp.test.ts src/i18n src/lib/privacy`: 28 files, 122 tests pass.
- Local replay: Postgres 16 + pgvector with a minimal Supabase shim
  (roles, `auth.users`, `auth.uid()`, `storage.*`, `supabase_realtime`),
  `classic-grants.sql`, then every migration 001-248 in order: all
  applied; 248 re-applied cleanly; `verify-case-desk`,
  `verify-desk-whatsapp-routing`, `verify-desk-worklist-suggest` and the
  new `verify-intake-file-preview` pass. The shim is not the CLI image,
  so CI remains the authority.

## Not done / unverified

- Not checked in a real browser against real Supabase Storage: whether
  the storage API's response headers (Content-Disposition / any
  X-Frame-Options or CSP sandbox) let a signed PDF render inside the
  iframe. If it does not, the component still shows "Open in new tab";
  the fallback would be a same-origin byte-proxy route.
- No Playwright/visual check at 375 px (no browser here); layout is
  `grid gap-3 lg:grid-cols-2` with `min-w-0` columns and a `h-[28rem]`
  frame on phones.
- No docs/case-desk.md edit (paragraph above).

---

# Sub-notes: desk-notes

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

---

