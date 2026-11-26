> Moved verbatim from `CLAUDE.md` (2026-11-22). Read this file before changing this area.

### Contact search (`lib/contacts/fuzzy-search.ts`, migration 193)

`search_contacts(p_term, p_limit)` (SECURITY INVOKER, so contacts RLS
decides) ranks exact matches first, then close ones: trigram and phonetic
(`contact_search_keys`) on name and company, digit distance on the last 9
digits of `phone_normalized`, exact-only email and 2–3 digit numbers;
the fuzzy pass runs only for 4+ characters and only when the exact pass
left room under the limit. It reads candidates from
`search_contact_candidates` (SECURITY DEFINER), because under RLS the
pg_trgm/LIKE operators are not leakproof and the GIN indexes go unused
(3 s for an admin on 50k contacts). That helper repeats the contacts
SELECT policies (`contacts_select`, `contacts_coordinator_select`) so a
direct call reveals nothing a plain SELECT would not: change one, change
both; `verify-contact-search.sql` compares the policy text. It must be
owned by a BYPASSRLS role or it loses the indexes. Callers (Contacts page,
`contact-picker.tsx`, the inbox list) fall back to the old ilike +
`phone_normalized` search when the RPC is missing (`isMissingSearchRpc`).
The inbox turns ≤100 hits into `contact_id.in.(…)` inside the view's
or-groups, one ranked page, no caching while searching.

Filters (298): the Contacts page narrows (chat tags, lead source, a team
leader's own contacts) inside the search, never after it: the 5-argument
`search_contacts` / `search_contact_candidates` overloads, arguments from
`contactSearchArgs` (`search-rpc.ts`), at most 500 hits ("First 500
matches"; the 193 signature stops at 200). The overloads have no
parameter defaults on purpose (with them a 2-argument call is ambiguous).
The one body is now in 298: the 193 candidate signature wraps it, so
re-run 298 after re-running 193. The tag condition is read by
`search_contacts` under the caller's `conversations_select` and handed
down as contact ids; the definer lookup never reads `conversations`.
