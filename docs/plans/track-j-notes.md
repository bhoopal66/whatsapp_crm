# Track J — per-person language and Arabic (RTL): merge notes

Branch `claude/track-j-arabic`, from `claude/admiring-dirac-8082b3`
(`e2620f9`). Three commits: runtime language (259), the Arabic
catalogue, the RTL sweep and hand fixes.

## CHANGELOG entry

```markdown
### Added
- **Your own language, including Arabic.** Each person now picks English,
  Arabic or Korean in Settings → Appearance → Language. The choice is
  saved on their profile, so it follows them to every device; people who
  have not picked one see the workspace default (`NEXT_PUBLIC_APP_LOCALE`,
  still build time). Arabic is shown right to left, with Noto Sans Arabic
  for its letters. The Arabic text is machine-translated and still needs
  a native reader (docs/languages.md).

### Changed
- The layout uses logical (start/end) Tailwind classes, so every screen
  mirrors in Arabic. Direction icons flip; charts, phone numbers and email
  fields stay left to right. `scripts/rtl-sweep.mjs` converts physical
  classes and is safe to run again.
- The funnel CSV export and the global error page follow the person's
  language instead of the build-time one.

**Migration required:** apply `259_preferred_language.sql` (adds
`profiles.preferred_language`, `set_my_language()` and two profiles
triggers). Without it the app still runs: nobody can save a language, and
everyone sees the workspace default.
```

## CLAUDE.md text (8 lines, for the i18n section)

```markdown
The locale is per request (`src/i18n/locales.ts`): the `NEXT_LOCALE`
cookie (written at sign-in and by Settings → Appearance from
`profiles.preferred_language`, 259, set only through `set_my_language`),
else `NEXT_PUBLIC_APP_LOCALE`, else `en`; `LOCALES` ↔ 259's CHECK. The
root layout sets `<html dir>` (`rtl` for `ar`), so use logical classes
(`ms-`, `ps-`, `start-`, `text-start`, `rounded-s`, `border-s`); run
`node scripts/rtl-sweep.mjs` after a merge. `ar.json` must keep each en
string's ICU shape (`ar-catalogue.test.ts`). `docs/languages.md`.
```

## Merge needs

1. **New keys from other tracks (Track I).** Translate them into
   `messages/ar.json` before merging, or `messages.test.ts` (now covering
   `ar`) fails. Then `node scripts/i18n/check-catalogue.mjs` must print
   `ok`; `ar-catalogue.test.ts` runs the same check.
2. **Run the sweep after merging every track:** `node scripts/rtl-sweep.mjs`
   then `node scripts/rtl-sweep.mjs --check` (prints 0). It skips test
   files, so a test asserting a physical class of a swept component fails:
   update the test (three needed this here: rich-text, reminder-alarm,
   insights palette).
3. **Icons other tracks add** are not covered by the sweep: a new
   ChevronLeft/Right or ArrowLeft/Right meaning back/forward needs
   `rtl:rotate-180` by hand (not on disclosure chevrons that rotate open).
4. **`rtl:space-x-reverse` was deliberately not added** (the brief asked
   for it): in Tailwind 4.3 `space-x-*` / `divide-x-*` are built on
   `margin-inline` / `border-inline`, which already mirror; the reverse
   would put the gap on the wrong side. Don't add it on merge.
5. **Migration 259 only** (260 unused). It does not restate 057/198's
   `enforce_profile_privilege_columns`; its own `profiles_language_guard`
   trigger keeps clients off the column. Verify file
   `verify-preferred-language.sql` is wired at the end of migrations.yml.
6. **`src/i18n/message-shape.ts` imports `@formatjs/icu-messageformat-parser`**,
   a dependency of next-intl, not listed in package.json (hoisted). Add it
   as a devDependency if a lockfile change ever drops the hoist.
7. **The global error page** keeps its own copy of `ErrorPages` per
   language (now en, ar, ko).

## Gate results (final)

- `npm run lint`: 0 errors, 30 warnings (all in untouched lines).
- `npm run typecheck`: clean.
- `npm test`: 1164 files, 16,338 tests passed.
- `npm run build` with CI's dummy env: passes.
- Migrations replay: fresh `supabase/postgres:17.12.0.001` container,
  waited for 3 consecutive answers, a storage/GoTrue stand-in (tables and
  helpers the storage-api and GoTrue migrations would create; not in the
  repo), `classic-grants.sql`, every migration in order as `postgres`
  through `psql -v ON_ERROR_STOP=1`, then every verify file named in
  migrations.yml: all migrations applied, 141 of 141 verify files passed
  (14 checks in the new one). 259 re-applies
  cleanly.

## Not done / not verified

- **Screens behind sign-in were not checked visually** (no Supabase
  project here). Only `/login` was rendered in Arabic (RTL, Arabic font,
  correct). The inbox, sheets, popovers and tables in RTL need a look on
  a real install.
- Phone numbers are wrapped in `dir="ltr"` where shown as a phone (inbox
  header and panel, customer page, pickers, desk, number settings), not
  where a contact with no name shows its number *as* the name (chat list,
  cards): those can reorder `+971 50 …` in Arabic.
- Sheets keep a physical `side` (`left`/`right`); in Arabic a left sheet
  still opens from the left.
- Disclosure chevrons that rotate 90° when open still point right when
  closed in Arabic.
- English customer messages in the Arabic UI read as RTL paragraphs (no
  `dir="auto"` on bubbles, by the CLAUDE.md rule).
- Arabic plurals use only the English categories; `two`/`few`/`many` can
  be added (the shape test allows it).
