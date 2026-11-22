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
