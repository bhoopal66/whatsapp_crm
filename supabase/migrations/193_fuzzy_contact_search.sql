-- 193: fuzzy contact search (Contacts page and both inboxes).
--
-- search_contacts(term, limit) returns the caller's contacts that match
-- a number, a customer name or a company name: exact matches first,
-- then close ones (typos, missing or extra letters, swapped words,
-- spelling variants such as Mohamed / Muhammad, a wrong or swapped
-- digit, with or without +971 / 00971 / 0).
--
-- Two functions, because RLS and the indexes do not mix:
--
-- * search_contact_candidates (SECURITY DEFINER) finds and ranks the
--   matches. LIKE, the pg_trgm operators and array @> are not
--   leakproof, so under RLS the planner must run contacts_select first
--   and can never use the GIN indexes: an owner's text search took ~3 s
--   on 50k contacts, computing every row's phonetic keys. As the
--   definer it reads without RLS, so the indexes drive. It returns ids,
--   a score and the exact flag only, never contact data, and only for
--   contacts the caller may see: the account is current_account_id()
--   (NULL, a guest or the service role, finds nothing) and each
--   candidate must pass the visibility predicate of contacts_select OR
--   contacts_coordinator_select (177, 133), restated below over the
--   same SECURITY DEFINER helpers. So calling it directly tells nobody
--   anything their own SELECT on contacts would not. CHANGE ONE, CHANGE
--   BOTH: verify-contact-search.sql pins the two policies' text.
-- * search_contacts (SECURITY INVOKER, the client entry point) joins
--   those ids back to contacts as the caller, so contacts_select still
--   decides what is returned even if the restatement ever drifted
--   (primary-key lookups, over-fetching so a drop costs no results).
--
-- Index use: candidates come only from predicates the GIN indexes
-- below serve (LIKE '%x%', %, <%, @>), and both branches run as
-- dynamic SQL so each call is planned with its real values (a cached
-- generic plan cannot see a pattern and falls back to a scan, and an
-- admin's visibility term folds to true).
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE throughout.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;

-- Phonetic keys of a name: one metaphone code per word (letters only,
-- 2+ characters; 'th' and 'kh' read as 't' and 'k', so Fatima and
-- Fathima agree). A word with no Latin letters (Arabic script) has no
-- code and is left out; trigram matching covers it.
CREATE OR REPLACE FUNCTION public.contact_search_keys(p_text text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions
AS $$
  SELECT coalesce(array_agg(DISTINCT k ORDER BY k), '{}'::text[])
  FROM (
    SELECT metaphone(replace(replace(w, 'th', 't'), 'kh', 'k'), 6) AS k
    FROM regexp_split_to_table(lower(coalesce(p_text, '')), '[^[:alpha:]]+') AS w
    WHERE length(w) >= 2
  ) s
  WHERE k <> '';
$$;

COMMENT ON FUNCTION public.contact_search_keys(text) IS
  'Metaphone code per word of a name (193), for the phonetic branch of search_contacts and its GIN indexes.';

-- Edit distance between two digit strings where one swap of adjacent
-- digits counts as one edit (levenshtein counts it as two).
CREATE OR REPLACE FUNCTION public.contact_search_digit_distance(a text, b text)
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions
AS $$
  SELECT CASE
    WHEN a = b THEN 0
    WHEN length(a) = length(b) AND EXISTS (
      SELECT 1 FROM generate_series(1, length(a) - 1) AS i
      WHERE substr(a, 1, i - 1) || substr(a, i + 1, 1) || substr(a, i, 1)
            || substr(a, i + 2) = b
    ) THEN 1
    ELSE levenshtein(a, b)
  END;
$$;

COMMENT ON FUNCTION public.contact_search_digit_distance(text, text) IS
  'Levenshtein distance with an adjacent swap counted as one edit (193, number typos in search_contacts).';

REVOKE ALL ON FUNCTION public.contact_search_keys(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.contact_search_digit_distance(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contact_search_keys(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.contact_search_digit_distance(text, text) TO authenticated, service_role;

-- Indexes. The trigram opclass is schema-qualified the way 059 does it,
-- because pg_trgm may live in another schema on an older install.
DO $$
DECLARE
  v_trgm text := (SELECT n.nspname FROM pg_extension e
                  JOIN pg_namespace n ON n.oid = e.extnamespace
                  WHERE e.extname = 'pg_trgm');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_contacts_name_lower_trgm') THEN
    EXECUTE format(
      'CREATE INDEX idx_contacts_name_lower_trgm ON public.contacts USING gin (lower(name) %I.gin_trgm_ops)',
      v_trgm);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_contacts_company_lower_trgm') THEN
    EXECUTE format(
      'CREATE INDEX idx_contacts_company_lower_trgm ON public.contacts USING gin (lower(company) %I.gin_trgm_ops)',
      v_trgm);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_name_keys
  ON public.contacts USING gin (public.contact_search_keys(name));
CREATE INDEX IF NOT EXISTS idx_contacts_company_keys
  ON public.contacts USING gin (public.contact_search_keys(company));

CREATE OR REPLACE FUNCTION public.search_contact_candidates(p_term text, p_limit int DEFAULT 50)
RETURNS TABLE (contact_id uuid, score real, exact boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_acct  uuid := public.current_account_id();
  v_lim   int  := least(greatest(coalesce(p_limit, 50), 1), 800);
  -- contacts_select / contacts_coordinator_select, for the caller.
  v_all   boolean := public.current_role_rank() >= 4;
  v_coord boolean := NOT v_all AND public.i_hold_open_coordinator_shares();
  v_vis   text := '($6 OR c.user_id IN (SELECT public.contact_visibility_people())'
    || ' OR c.id IN (SELECT public.contact_visibility_chat_contact_ids())'
    || ' OR ($7 AND c.id IN (SELECT public.coordinator_granted_contact_ids())))';
  t       text := regexp_replace(lower(btrim(coalesce(p_term, ''))), '\s+', ' ', 'g');
  tl      text;   -- t escaped for LIKE
  d       text;   -- the term's digits, leading zeros dropped
  dn      text;   -- the national part (last 9 digits) of a long number
  k       int;    -- digit typos tolerated
  v_words text[];
  w0      text;   -- the longest word, escaped for LIKE
  v_keys  text[];
  v_cand  text := '';
  -- The trigram thresholds are set transaction-locally for the index
  -- operators and put back before returning. (A function-level SET
  -- clause would restore them by itself, but a non-superuser cannot
  -- create one while pg_trgm's library is not loaded in the session.)
  v_old_s text := current_setting('pg_trgm.similarity_threshold', true);
  v_old_w text := current_setting('pg_trgm.word_similarity_threshold', true);
BEGIN
  IF v_acct IS NULL OR length(t) < 2 THEN
    RETURN;
  END IF;
  PERFORM set_config('pg_trgm.similarity_threshold', '0.3', true);
  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.5', true);

  -- ---- Number mode: 4+ digits and no letters --------------------------
  IF t !~ '[[:alpha:]]' AND length(regexp_replace(t, '\D', '', 'g')) >= 4 THEN
    d := ltrim(regexp_replace(t, '\D', '', 'g'), '0');
    IF length(d) < 4 THEN
      RETURN;
    END IF;
    dn := CASE WHEN length(d) >= 10 THEN right(d, 9) END;
    k  := CASE WHEN length(d) >= 9 THEN 2 WHEN length(d) >= 6 THEN 1 ELSE 0 END;
    PERFORM set_config('pg_trgm.word_similarity_threshold', '0.3', true);

    IF dn IS NOT NULL THEN
      v_cand := v_cand || ' OR c.phone_normalized LIKE ''%'' || $3';
    END IF;
    -- Close candidates by trigram: the national part when there is
    -- one, since a full number's country-code trigrams (971...) are
    -- shared by half the book and every candidate is then scored.
    IF k > 0 THEN
      v_cand := v_cand || CASE WHEN dn IS NOT NULL
        THEN ' OR $3 <% c.phone_normalized'
        ELSE ' OR $2 <% c.phone_normalized' END;
    END IF;

    RETURN QUERY EXECUTE format($q$
      WITH cand AS (
        SELECT c.id, c.name, c.phone_normalized AS pn
        FROM public.contacts c
        WHERE c.account_id = $1
          AND (c.phone_normalized LIKE '%%' || $2 || '%%' %s)
          AND %s
      ), scored AS (
        SELECT id, name,
          CASE
            WHEN pn LIKE '%%' || $2 OR ($3 IS NOT NULL AND pn LIKE '%%' || $3) THEN 1.0
            WHEN pn LIKE '%%' || $2 || '%%' THEN 0.95
          END AS ex,
          least(
            public.contact_search_digit_distance(right(pn, length($2)), $2),
            CASE WHEN $3 IS NOT NULL
              THEN public.contact_search_digit_distance(right(pn, 9), $3) END
          ) AS dist
        FROM cand
      )
      SELECT id, coalesce(ex, 0.9 - 0.1 * dist)::real, ex IS NOT NULL
      FROM scored
      WHERE ex IS NOT NULL OR dist <= $4
      ORDER BY 3 DESC, 2 DESC, name, id
      LIMIT $5
    $q$, v_cand, v_vis)
    USING v_acct, d, dn, k, v_lim, v_all, v_coord;
    PERFORM set_config('pg_trgm.similarity_threshold', coalesce(v_old_s, '0.3'), true);
    PERFORM set_config('pg_trgm.word_similarity_threshold', coalesce(v_old_w, '0.6'), true);
    RETURN;
  END IF;

  -- ---- Text mode: names and companies (a mixed term lands here) -------
  tl := replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_');
  v_words := array_remove(string_to_array(t, ' '), '');
  IF array_length(v_words, 1) > 1 THEN
    SELECT replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_')
      INTO w0
      FROM unnest(v_words) AS w
     WHERE length(w) >= 3
     ORDER BY length(w) DESC
     LIMIT 1;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_words) AS w WHERE length(w) >= 4) THEN
    v_keys := public.contact_search_keys(t);
    IF v_keys = '{}' THEN
      v_keys := NULL;
    END IF;
  END IF;

  -- Candidates: one index-served SELECT per predicate, UNIONed. A single
  -- OR across all of them is planned as a sequential scan (the RLS
  -- predicate rides along), which computed every row's phonetic keys.
  -- Each branch carries the columns scoring needs: joining the ids back
  -- to contacts was planned as a sequential scan with the scoring
  -- pushed into it.
  v_cand := 'SELECT id, user_id, name, company FROM public.contacts WHERE account_id = $1 AND lower(name) LIKE ''%'' || $3 || ''%'''
    || ' UNION SELECT id, user_id, name, company FROM public.contacts WHERE account_id = $1 AND lower(company) LIKE ''%'' || $3 || ''%''';
  IF w0 IS NOT NULL THEN
    v_cand := v_cand
      || ' UNION SELECT id, user_id, name, company FROM public.contacts WHERE account_id = $1 AND lower(name) LIKE ''%'' || $5 || ''%'''
      || ' UNION SELECT id, user_id, name, company FROM public.contacts WHERE account_id = $1 AND lower(company) LIKE ''%'' || $5 || ''%''';
  END IF;
  IF length(t) >= 3 THEN
    v_cand := v_cand
      || ' UNION SELECT id, user_id, name, company FROM public.contacts WHERE account_id = $1 AND $2 <% lower(name)'
      || ' UNION SELECT id, user_id, name, company FROM public.contacts WHERE account_id = $1 AND $2 <% lower(company)'
      || ' UNION SELECT id, user_id, name, company FROM public.contacts WHERE account_id = $1 AND lower(name) % $2'
      || ' UNION SELECT id, user_id, name, company FROM public.contacts WHERE account_id = $1 AND lower(company) % $2';
  END IF;
  IF v_keys IS NOT NULL THEN
    v_cand := v_cand || ' UNION SELECT id, user_id, name, company FROM ph';
  END IF;

  RETURN QUERY EXECUTE format($q$
    WITH ph AS MATERIALIZED (
      SELECT id, user_id, name, company FROM public.contacts
       WHERE $4 IS NOT NULL AND account_id = $1
         AND public.contact_search_keys(name) @> $4
      UNION
      SELECT id, user_id, name, company FROM public.contacts
       WHERE $4 IS NOT NULL AND account_id = $1
         AND public.contact_search_keys(company) @> $4
    ), cand AS (
      SELECT c.id, c.name,
             lower(coalesce(c.name, '')) AS n,
             lower(coalesce(c.company, '')) AS co,
             c.id IN (SELECT id FROM ph) AS ph  -- hashed; EXISTS rescanned ph per row
      FROM (%s) AS c
      WHERE %s
    ), scored AS (
      SELECT id, name, ph,
        CASE
          WHEN n = $2 OR n LIKE $3 || '%%' THEN 1.0
          WHEN co = $2 OR co LIKE $3 || '%%' THEN 0.97
          WHEN n LIKE '%% ' || $3 || '%%' THEN 0.93
          WHEN n LIKE '%%' || $3 || '%%' OR co LIKE '%%' || $3 || '%%' THEN 0.9
          WHEN cardinality($6) > 1 AND NOT EXISTS (
            SELECT 1 FROM unnest($6) AS w WHERE strpos(n, w) = 0) THEN 0.88
          WHEN cardinality($6) > 1 AND NOT EXISTS (
            SELECT 1 FROM unnest($6) AS w WHERE strpos(co, w) = 0) THEN 0.86
        END AS ex,
        CASE WHEN length($2) >= 3 THEN greatest(
          word_similarity($2, n), similarity($2, n),
          word_similarity($2, co), similarity($2, co)) ELSE 0 END AS sim
      FROM cand
    )
    SELECT id,
           coalesce(ex, least(0.85, sim + CASE WHEN ph THEN 0.15 ELSE 0 END))::real,
           ex IS NOT NULL
    FROM scored
    WHERE ex IS NOT NULL OR ph
       OR (length($2) >= 3 AND sim >= 0.3)
    ORDER BY 3 DESC, 2 DESC, name, id
    LIMIT $7
  $q$, v_cand, replace(replace(v_vis, '$6', '$8'), '$7', '$9'))
  USING v_acct, t, tl, v_keys, w0, v_words, v_lim, v_all, v_coord;
  PERFORM set_config('pg_trgm.similarity_threshold', coalesce(v_old_s, '0.3'), true);
  PERFORM set_config('pg_trgm.word_similarity_threshold', coalesce(v_old_w, '0.6'), true);
END
$fn$;

COMMENT ON FUNCTION public.search_contact_candidates(text, int) IS
  'Indexed candidate lookup behind search_contacts (193): ids, score and exact flag only, for contacts of the caller''s active account that contacts_select / contacts_coordinator_select would show them. SECURITY DEFINER so the GIN indexes can be used; restates the two policies (change one, change both).';

REVOKE ALL ON FUNCTION public.search_contact_candidates(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_contact_candidates(text, int) TO authenticated, service_role;

-- The client entry point. Runs as the caller: the candidates are joined
-- back to contacts under RLS, so contacts_select has the last word. It
-- over-fetches (4x, at most 800) so a candidate RLS drops costs nothing.
CREATE OR REPLACE FUNCTION public.search_contacts(p_term text, p_limit int DEFAULT 50)
RETURNS TABLE (contact_id uuid, score real, exact boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
  SELECT cand.contact_id, cand.score, cand.exact
    FROM public.search_contact_candidates(
           p_term,
           least(greatest(coalesce(p_limit, 50), 1), 200) * 4) AS cand
    JOIN public.contacts c ON c.id = cand.contact_id
   ORDER BY cand.exact DESC, cand.score DESC, c.name, c.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
$fn$;

COMMENT ON FUNCTION public.search_contacts(text, int) IS
  'Contact search for the Contacts page and both inboxes (193): number, name or company; exact matches first (exact = true), then close ones (typos, swapped words or digits, phonetic spelling variants). Runs as the caller over search_contact_candidates, so contacts_select decides what can be found.';

REVOKE ALL ON FUNCTION public.search_contacts(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_contacts(text, int) TO authenticated, service_role;
