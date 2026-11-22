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
