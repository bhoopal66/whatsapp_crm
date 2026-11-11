-- 193: fuzzy contact search (Contacts page and both inboxes).
--
-- search_contacts(term, limit) returns the caller's contacts that match
-- a number, a customer name or a company name: exact matches first,
-- then close ones (typos, missing or extra letters, swapped words,
-- spelling variants such as Mohamed / Muhammad, a wrong or swapped
-- digit, with or without +971 / 00971 / 0).
--
-- SECURITY INVOKER on purpose: every read goes through contacts_select
-- (177), so nobody finds a contact they could not open. It is also
-- scoped to current_account_id(), so a guest (NULL) finds nothing.
--
-- Index use: candidates come only from predicates the GIN indexes
-- below serve (LIKE '%x%', %, <%, @>), and both branches run as
-- dynamic SQL so each call is planned with its real values (a cached
-- generic plan cannot see a pattern and falls back to a scan).
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

CREATE OR REPLACE FUNCTION public.search_contacts(p_term text, p_limit int DEFAULT 50)
RETURNS TABLE (contact_id uuid, score real, exact boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_acct  uuid := public.current_account_id();
  v_lim   int  := least(greatest(coalesce(p_limit, 50), 1), 200);
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
    IF k > 0 THEN
      v_cand := v_cand || ' OR $2 <% c.phone_normalized';
      IF dn IS NOT NULL THEN
        v_cand := v_cand || ' OR $3 <% c.phone_normalized';
      END IF;
    END IF;

    RETURN QUERY EXECUTE format($q$
      WITH cand AS (
        SELECT c.id, c.name, c.phone_normalized AS pn
        FROM public.contacts c
        WHERE c.account_id = $1
          AND (c.phone_normalized LIKE '%%' || $2 || '%%' %s)
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
    $q$, v_cand)
    USING v_acct, d, dn, k, v_lim;
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
  v_cand := 'SELECT id FROM public.contacts WHERE account_id = $1 AND lower(name) LIKE ''%'' || $3 || ''%'''
    || ' UNION SELECT id FROM public.contacts WHERE account_id = $1 AND lower(company) LIKE ''%'' || $3 || ''%''';
  IF w0 IS NOT NULL THEN
    v_cand := v_cand
      || ' UNION SELECT id FROM public.contacts WHERE account_id = $1 AND lower(name) LIKE ''%'' || $5 || ''%'''
      || ' UNION SELECT id FROM public.contacts WHERE account_id = $1 AND lower(company) LIKE ''%'' || $5 || ''%''';
  END IF;
  IF length(t) >= 3 THEN
    v_cand := v_cand
      || ' UNION SELECT id FROM public.contacts WHERE account_id = $1 AND $2 <% lower(name)'
      || ' UNION SELECT id FROM public.contacts WHERE account_id = $1 AND $2 <% lower(company)'
      || ' UNION SELECT id FROM public.contacts WHERE account_id = $1 AND lower(name) % $2'
      || ' UNION SELECT id FROM public.contacts WHERE account_id = $1 AND lower(company) % $2';
  END IF;
  IF v_keys IS NOT NULL THEN
    v_cand := v_cand || ' UNION SELECT id FROM ph';
  END IF;

  RETURN QUERY EXECUTE format($q$
    WITH ph AS MATERIALIZED (
      SELECT id FROM public.contacts
       WHERE $4 IS NOT NULL AND account_id = $1
         AND public.contact_search_keys(name) @> $4
      UNION
      SELECT id FROM public.contacts
       WHERE $4 IS NOT NULL AND account_id = $1
         AND public.contact_search_keys(company) @> $4
    ), cand AS (
      SELECT c.id, c.name,
             lower(coalesce(c.name, '')) AS n,
             lower(coalesce(c.company, '')) AS co,
             EXISTS (SELECT 1 FROM ph WHERE ph.id = c.id) AS ph
      FROM public.contacts c
      JOIN (%s) AS ids ON ids.id = c.id
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
  $q$, v_cand)
  USING v_acct, t, tl, v_keys, w0, v_words, v_lim;
  PERFORM set_config('pg_trgm.similarity_threshold', coalesce(v_old_s, '0.3'), true);
  PERFORM set_config('pg_trgm.word_similarity_threshold', coalesce(v_old_w, '0.6'), true);
END
$fn$;

COMMENT ON FUNCTION public.search_contacts(text, int) IS
  'Contact search for the Contacts page and both inboxes (193): number, name or company; exact matches first (exact = true), then close ones (typos, swapped words or digits, phonetic spelling variants). Runs as the caller, so contacts_select decides what can be found.';

REVOKE ALL ON FUNCTION public.search_contacts(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_contacts(text, int) TO authenticated, service_role;
