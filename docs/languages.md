# Languages

Taamul Connect's interface is offered in **English** (the source),
**Arabic** (right to left) and **Korean**. Each person picks their own
language; the workspace has a default for everyone who has not.

## How a page's language is chosen

For every request, `src/i18n/request.ts` uses, in order:

1. **The person's choice** — the `NEXT_LOCALE` cookie. Sign-in
   (`POST /api/auth/login`) writes it from `profiles.preferred_language`,
   and the auth provider re-syncs it on load (`syncLocaleCookie` in
   `src/i18n/locales.ts`), so the choice follows the person to every
   device and browser.
2. **The workspace default** — `NEXT_PUBLIC_APP_LOCALE`, set at build
   time (`Dockerfile`, `docker-compose.yml`). Changing it needs a rebuild.
3. **English.**

An unsupported value at any step is ignored. A supported language whose
catalogue is missing from the build renders in English.

The root layout sets `<html lang>` and `dir` from that locale: `rtl` for
Arabic. The global error page reads the same cookie in the browser.

## Changing your language

**Settings → Appearance → Language.** The choice is saved on your
profile, in every workspace you belong to (`set_my_language`, migration
259), and the page reloads in the new language. "Workspace default"
clears the choice.

## Right-to-left layout

The layout uses logical Tailwind classes (`ms-`/`me-`, `ps-`/`pe-`,
`start-`/`end-`, `text-start`, `rounded-s`, `border-e`, …), so it mirrors
from the one `dir="rtl"` attribute. `scripts/rtl-sweep.mjs` rewrites
physical classes to logical ones across `src/`; it is re-runnable, and
should be run after merging other work:

```bash
node scripts/rtl-sweep.mjs          # rewrite
node scripts/rtl-sweep.mjs --check  # list what it would change; exit 1 if any
```

What deliberately does not mirror:

- **Charts** (recharts, Tremor): time runs left to right in every language.
- **Phone numbers, codes, ids and amounts** are wrapped in `dir="ltr"`
  where shown, so `+971 50 …` is not reordered.
- **Direction icons** (chevrons and arrows meaning back/forward, next/
  previous) carry `rtl:rotate-180`; icons that mean something else (a
  dropdown chevron, "expand", "send") do not.
- **Chat bubbles:** the bubble paragraph never gets `dir="auto"` (the time
  overlay reserves room at the end of the last line); only the words sit in
  an inline `<span dir="auto">`, so an English message in the Arabic screen
  keeps its punctuation. The inbox preview line has `dir="auto"` with the
  UI's alignment, and customer names are wrapped in `<bdi>`, so a number
  shown as a name keeps its order. The composer has `dir="auto"`.
- **Side panels and the phone menu:** a sheet's `left` / `right` mean the
  start / end side, so in Arabic they open from the right; the phone menu
  hides rightwards. A closed expand arrow points in the reading direction
  (`-rotate-90 rtl:rotate-90` on a down chevron).

## Stage names

Built-in stage names are **shown** in the person's language but **stored**
in English: the default pipeline's stages (New Lead, Qualified, Proposal
Sent, Negotiation, Won) and the case stages (Interested … Closed, 130's
`case_default_stages()`). `stageLabel` (`src/lib/i18n/stage-label.ts`,
strings under `StageNames.*`) recognises a built-in by its exact seeded
English name, blanks at either end ignored; any other name, one the team
typed or renamed (a bank's own stage too), is shown exactly as typed. Only
screens translate: filters, rules, the API, CSV exports and WhatsApp
messages keep the stored name, and so does the stage name field in
pipeline settings. A submission-tracker status on a case is shown word for
word, never translated.

## The Arabic catalogue

`messages/ar.json` was **machine-translated** from `en.json` into Modern
Standard Arabic for UAE business users. It has not yet been reviewed by a
native reader, and it needs one before Arabic is offered to customers'
staff at large. Things a reviewer should look at first:

- Plurals use the English categories (`one` / `other`, plus any `=0`/`=1`);
  Arabic's `two`, `few` and `many` forms were not added, so some counts
  read stiffly. They may be added freely (see below).
- Terms chosen without a house glossary: "case" → ملف, "Second brain" →
  العقل الثاني, "macro" → ماكرو, "extension" → تحويلة, "Sales funnel" and
  "pipeline" both → مسار المبيعات.
- Literal values the code or WhatsApp matches stay in English on purpose:
  stage names in the case-settings errors (`Interested`, `Approved`, …),
  the chat tag `Interested`, the `Reply STOP …` template line, `[erased]`.
- The settings search keywords (`Settings.keywords.*`) are Arabic only.

## Rules every catalogue keeps

- **Same keys as `en.json`** (`src/i18n/messages.test.ts`). There is no
  per-key fallback: a missing key renders as its keypath.
- **Same shape as its English string** for Arabic
  (`src/i18n/ar-catalogue.test.ts`, logic in `src/i18n/message-shape.ts`):
  the same ICU argument names and types, select keys and rich-text tags;
  for strings read with `t.raw()`, the same `{{1}}` tokens and HTML tags.
  A plural may add categories but keeps `other` and every `=N`. Korean is
  exempt from the plural rule (it has no plural).
- Strings with `{{1}}` or raw HTML are read with `t.raw()` / `t.rich()`
  (`src/i18n/icu-safety.test.ts`).

`node scripts/i18n/check-catalogue.mjs` runs the shape check outside the
test suite, and also compares any two fragments
(`… check-catalogue.mjs en-part.json ar-part.json`).

## Adding a language

1. Add its code to `LOCALES`, `LOCALE_NAMES` (and `RTL_LOCALES` if it is
   written right to left) in `src/i18n/locales.ts`.
2. Add it to the CHECK and the `set_my_language` list in a **new**
   migration (259's lists are pinned by `src/i18n/locales.test.ts`; move
   that test to the new file).
3. Add `messages/<code>.json` with every key of `en.json`, and the code to
   `TRANSLATED_LOCALES` in `src/i18n/messages.test.ts`. For a language
   with plurals like English's, add it to `STRICT_LOCALES` in
   `scripts/i18n/check-catalogue.mjs` and give it a shape test like
   `ar-catalogue.test.ts`.
4. Add its copy to `COPY` in `src/app/global-error.tsx` (that page cannot
   load the catalogue).
5. If its script is not Latin, check the font stack in `layout.tsx` /
   `globals.css` covers it.
