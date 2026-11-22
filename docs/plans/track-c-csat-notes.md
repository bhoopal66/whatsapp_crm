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
