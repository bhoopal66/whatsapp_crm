-- Behavioural regression suite for migration 152: knowledge-gap topics.
--
-- Asserts that an admin reads an account's topics and members while an
-- agent and another account's admin read nothing; that dismiss and
-- reopen go through kb_gap_topic_set_status (status and dismissed_at
-- follow, a re-dismissal keeps the date) and that an agent, another
-- account's owner and an unknown status are refused; that a direct
-- write by an admin changes nothing; that kb_gap_topics_replace is the
-- service role's alone, swaps an account's topics in one call and
-- returns the count, and that another account's gap or answer id fails
-- the whole call and leaves the previous topics in place; that deleting
-- a gap drops its member rows and deleting an answer nulls
-- covered_by_entry_id only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000152001';
  u_admin  UUID := '00000000-0000-4000-8000-000000152002';
  u_agent  UUID := '00000000-0000-4000-8000-000000152003';
  u_owner2 UUID := '00000000-0000-4000-8000-000000152004';
  a_acct   UUID;
  b_acct   UUID;
  g1       UUID;
  g2       UUID;
  g3       UUID;
  gb       UUID;
  e        UUID;
  eb       UUID;
  t1       UUID;
  t2       UUID;
  tb       UUID;
  ts1      TIMESTAMPTZ;
  js       JSONB;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a role (authenticated with a signed-in user, or
  -- service_role): the value of a SELECT, the row count of anything
  -- else, or 'ERROR: <sqlstate> <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.kg_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        IF p_role = 'service_role' THEN
          SET LOCAL ROLE service_role;
        ELSE
          SET LOCAL ROLE authenticated;
        END IF;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR: ' || SQLSTATE || ' ' || SQLERRM;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'kg152-owner@example.invalid'),
    (u_admin,  'kg152-admin@example.invalid'),
    (u_agent,  'kg152-agent@example.invalid'),
    (u_owner2, 'kg152-owner2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_owner2;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  INSERT INTO ai_knowledge_gaps (account_id, question) VALUES (a_acct, 'POS without a trade licence?') RETURNING id INTO g1;
  INSERT INTO ai_knowledge_gaps (account_id, question) VALUES (a_acct, 'POS machine with no licence?') RETURNING id INTO g2;
  INSERT INTO ai_knowledge_gaps (account_id, question) VALUES (a_acct, 'Do you open Islamic accounts?') RETURNING id INTO g3;
  INSERT INTO ai_knowledge_gaps (account_id, question) VALUES (b_acct, 'Other account question') RETURNING id INTO gb;
  INSERT INTO kb_entries (account_id, ref, audience, question)
  VALUES (a_acct, 'KG-1', 'prospective_client', 'POS?') RETURNING id INTO e;
  INSERT INTO kb_entries (account_id, ref, audience, question)
  VALUES (b_acct, 'KG-B', 'prospective_client', 'Other?') RETURNING id INTO eb;

  -- ---------- replace: the service role writes a topic set ----------
  js := jsonb_build_array(
    jsonb_build_object('label', 'POS without a trade licence?', 'intent', 'pos_licence',
      'question_count', 2, 'first_seen_at', '2026-10-01T00:00:00Z', 'last_seen_at', '2026-10-02T00:00:00Z',
      'coverage', 'partial', 'covered_by_entry_id', e, 'coverage_p', 0.6,
      'gap_ids', jsonb_build_array(g1, g2, g1)),
    jsonb_build_object('label', 'Do you open Islamic accounts?',
      'question_count', 1, 'first_seen_at', '2026-10-03T00:00:00Z', 'last_seen_at', '2026-10-03T00:00:00Z',
      'gap_ids', jsonb_build_array(g3)));
  r := pg_temp.kg_try('service_role', NULL,
    format('select public.kb_gap_topics_replace(%L, %L::jsonb)', a_acct, js));
  n := n + 1;
  IF r IS DISTINCT FROM '2' THEN
    failed := array_append(failed, format('replace for A returned %s, not 2', r));
  END IF;
  SELECT id INTO t1 FROM kb_gap_topics WHERE account_id = a_acct AND intent = 'pos_licence';
  SELECT id INTO t2 FROM kb_gap_topics WHERE account_id = a_acct AND label = 'Do you open Islamic accounts?';
  n := n + 1;
  IF t1 IS NULL OR t2 IS NULL
     OR (SELECT count(*) FROM kb_gap_topic_members WHERE account_id = a_acct) <> 3
     OR (SELECT coverage = 'partial' AND coverage_p = 0.6::real AND question_count = 2
           AND covered_by_entry_id = e FROM kb_gap_topics WHERE id = t1) IS DISTINCT FROM true
     OR (SELECT coverage = 'unknown' AND status = 'open' FROM kb_gap_topics WHERE id = t2) IS DISTINCT FROM true
  THEN
    failed := array_append(failed, 'replace did not store the topics, defaults and de-duplicated members'::text);
  END IF;
  js := jsonb_build_array(
    jsonb_build_object('label', 'Other account topic',
      'question_count', 1, 'first_seen_at', '2026-10-01T00:00:00Z', 'last_seen_at', '2026-10-01T00:00:00Z',
      'gap_ids', jsonb_build_array(gb)));
  r := pg_temp.kg_try('service_role', NULL,
    format('select public.kb_gap_topics_replace(%L, %L::jsonb)', b_acct, js));
  SELECT id INTO tb FROM kb_gap_topics WHERE account_id = b_acct;
  n := n + 1;
  IF r IS DISTINCT FROM '1' OR tb IS NULL THEN
    failed := array_append(failed, format('replace for B returned %s', r));
  END IF;

  -- ---------- who reads ----------
  n := n + 1;
  r := pg_temp.kg_try('authenticated', u_admin, 'select count(*) from kb_gap_topics')
    || '/' || pg_temp.kg_try('authenticated', u_admin, 'select count(*) from kb_gap_topic_members');
  IF r <> '2/3' THEN
    failed := array_append(failed, format('admin of A read %s topics/members, not 2/3', r));
  END IF;
  n := n + 1;
  r := pg_temp.kg_try('authenticated', u_agent, 'select count(*) from kb_gap_topics')
    || '/' || pg_temp.kg_try('authenticated', u_agent, 'select count(*) from kb_gap_topic_members');
  IF r <> '0/0' THEN
    failed := array_append(failed, format('an agent read %s topics/members', r));
  END IF;
  n := n + 1;
  r := pg_temp.kg_try('authenticated', u_owner2,
         format('select count(*) from kb_gap_topics where account_id = %L', a_acct))
    || '/' || pg_temp.kg_try('authenticated', u_owner2,
         format('select count(*) from kb_gap_topic_members where account_id = %L', a_acct))
    || '/' || pg_temp.kg_try('authenticated', u_owner2, 'select count(*) from kb_gap_topics');
  IF r <> '0/0/1' THEN
    failed := array_append(failed, format('another account''s owner read %s (A topics/A members/own topics)', r));
  END IF;

  -- ---------- dismiss and reopen through the RPC ----------
  r := pg_temp.kg_try('authenticated', u_admin,
    format($q$select public.kb_gap_topic_set_status(%L, 'dismissed')$q$, t1));
  n := n + 1;
  IF r LIKE 'ERROR:%' THEN
    failed := array_append(failed, format('admin dismiss refused: %s', r));
  END IF;
  SELECT dismissed_at INTO ts1 FROM kb_gap_topics WHERE id = t1;
  n := n + 1;
  IF (SELECT status FROM kb_gap_topics WHERE id = t1) IS DISTINCT FROM 'dismissed' OR ts1 IS NULL THEN
    failed := array_append(failed, 'dismiss did not set status and dismissed_at'::text);
  END IF;
  UPDATE kb_gap_topics SET dismissed_at = dismissed_at - interval '1 day' WHERE id = t1;
  SELECT dismissed_at INTO ts1 FROM kb_gap_topics WHERE id = t1;
  r := pg_temp.kg_try('authenticated', u_admin,
    format($q$select public.kb_gap_topic_set_status(%L, 'dismissed')$q$, t1));
  n := n + 1;
  IF r LIKE 'ERROR:%' OR (SELECT dismissed_at FROM kb_gap_topics WHERE id = t1) IS DISTINCT FROM ts1 THEN
    failed := array_append(failed, format('re-dismissing moved dismissed_at (or failed: %s)', r));
  END IF;
  r := pg_temp.kg_try('authenticated', u_admin,
    format($q$select public.kb_gap_topic_set_status(%L, 'open')$q$, t1));
  n := n + 1;
  IF r LIKE 'ERROR:%'
     OR (SELECT status = 'open' AND dismissed_at IS NULL FROM kb_gap_topics WHERE id = t1) IS DISTINCT FROM true THEN
    failed := array_append(failed, format('reopen did not clear status/dismissed_at (%s)', r));
  END IF;

  -- ---------- refused callers ----------
  r := pg_temp.kg_try('authenticated', u_agent,
    format($q$select public.kb_gap_topic_set_status(%L, 'dismissed')$q$, t1));
  n := n + 1;
  IF r NOT LIKE 'ERROR: 42501%' THEN
    failed := array_append(failed, format('an agent''s dismiss was not refused 42501: %s', r));
  END IF;
  r := pg_temp.kg_try('authenticated', u_owner2,
    format($q$select public.kb_gap_topic_set_status(%L, 'dismissed')$q$, t1));
  n := n + 1;
  IF r NOT LIKE 'ERROR: 42501%' THEN
    failed := array_append(failed, format('another account''s owner''s dismiss was not refused 42501: %s', r));
  END IF;
  r := pg_temp.kg_try('authenticated', u_admin,
    format($q$select public.kb_gap_topic_set_status(%L, 'archived')$q$, t1));
  n := n + 1;
  IF r NOT LIKE 'ERROR: 22023%' THEN
    failed := array_append(failed, format('an unknown status was not refused 22023: %s', r));
  END IF;
  n := n + 1;
  IF (SELECT status = 'open' AND dismissed_at IS NULL FROM kb_gap_topics WHERE id = t1) IS DISTINCT FROM true THEN
    failed := array_append(failed, 'a refused status call changed the topic'::text);
  END IF;

  -- ---------- no direct client writes ----------
  r := pg_temp.kg_try('authenticated', u_admin,
    format($q$UPDATE kb_gap_topics SET status = 'dismissed', dismissed_at = now() WHERE id = %L$q$, t1));
  n := n + 1;
  IF NOT (r LIKE 'ERROR:%' OR r = '0')
     OR (SELECT status FROM kb_gap_topics WHERE id = t1) IS DISTINCT FROM 'open' THEN
    failed := array_append(failed, format('an admin''s direct UPDATE was not refused: %s', r));
  END IF;
  r := pg_temp.kg_try('authenticated', u_admin,
    format('DELETE FROM kb_gap_topic_members WHERE topic_id = %L', t1));
  n := n + 1;
  IF NOT (r LIKE 'ERROR:%' OR r = '0')
     OR (SELECT count(*) FROM kb_gap_topic_members WHERE topic_id = t1) <> 2 THEN
    failed := array_append(failed, format('an admin''s direct member DELETE was not refused: %s', r));
  END IF;

  -- ---------- replace is the service role's alone ----------
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.kb_gap_topics_replace(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.kb_gap_topics_replace(uuid, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.kb_gap_topics_replace(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.kb_gap_topic_set_status(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.kb_gap_topic_set_status(uuid, text)', 'EXECUTE')
  THEN
    failed := array_append(failed, 'function EXECUTE privileges are wrong'::text);
  END IF;
  r := pg_temp.kg_try('authenticated', u_admin,
    format($q$select public.kb_gap_topics_replace(%L, '[]'::jsonb)$q$, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR: 42501%' OR (SELECT count(*) FROM kb_gap_topics WHERE account_id = a_acct) <> 2 THEN
    failed := array_append(failed, format('an admin could call kb_gap_topics_replace: %s', r));
  END IF;

  -- ---------- another account's ids fail the whole call ----------
  js := jsonb_build_array(
    jsonb_build_object('label', 'fine topic',
      'question_count', 1, 'first_seen_at', '2026-10-05T00:00:00Z', 'last_seen_at', '2026-10-05T00:00:00Z',
      'gap_ids', jsonb_build_array(g1)),
    jsonb_build_object('label', 'foreign gap',
      'question_count', 1, 'first_seen_at', '2026-10-05T00:00:00Z', 'last_seen_at', '2026-10-05T00:00:00Z',
      'gap_ids', jsonb_build_array(gb)));
  r := pg_temp.kg_try('service_role', NULL,
    format('select public.kb_gap_topics_replace(%L, %L::jsonb)', a_acct, js));
  n := n + 1;
  IF r NOT LIKE 'ERROR: 23503%' THEN
    failed := array_append(failed, format('replace with another account''s gap was not refused 23503: %s', r));
  END IF;
  n := n + 1;
  IF (SELECT array_agg(id ORDER BY id) FROM kb_gap_topics WHERE account_id = a_acct)
       IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[t1, t2]) AS x)
     OR (SELECT count(*) FROM kb_gap_topic_members WHERE account_id = a_acct) <> 3 THEN
    failed := array_append(failed, 'a failed replace did not leave the previous topics in place'::text);
  END IF;
  js := jsonb_build_array(
    jsonb_build_object('label', 'foreign answer',
      'question_count', 1, 'first_seen_at', '2026-10-05T00:00:00Z', 'last_seen_at', '2026-10-05T00:00:00Z',
      'covered_by_entry_id', eb, 'coverage', 'full', 'gap_ids', jsonb_build_array(g1)));
  r := pg_temp.kg_try('service_role', NULL,
    format('select public.kb_gap_topics_replace(%L, %L::jsonb)', a_acct, js));
  n := n + 1;
  IF r NOT LIKE 'ERROR: 23503%' OR (SELECT count(*) FROM kb_gap_topics WHERE account_id = a_acct) <> 2 THEN
    failed := array_append(failed, format('replace with another account''s answer was not refused 23503: %s', r));
  END IF;
  js := jsonb_build_array(
    jsonb_build_object('label', 'dismissed without a date', 'status', 'dismissed',
      'question_count', 1, 'first_seen_at', '2026-10-05T00:00:00Z', 'last_seen_at', '2026-10-05T00:00:00Z'));
  r := pg_temp.kg_try('service_role', NULL,
    format('select public.kb_gap_topics_replace(%L, %L::jsonb)', a_acct, js));
  n := n + 1;
  IF r NOT LIKE 'ERROR: 23514%' OR (SELECT count(*) FROM kb_gap_topics WHERE account_id = a_acct) <> 2 THEN
    failed := array_append(failed, format('a dismissed topic without dismissed_at was not refused 23514: %s', r));
  END IF;
  r := pg_temp.kg_try('service_role', NULL,
    format($q$select public.kb_gap_topics_replace(%L, '{}'::jsonb)$q$, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR: 22023%' THEN
    failed := array_append(failed, format('a non-array p_topics was not refused 22023: %s', r));
  END IF;

  -- ---------- replace swaps the set and returns the count ----------
  js := jsonb_build_array(
    jsonb_build_object('label', 'POS licence', 'question_count', 2,
      'first_seen_at', '2026-10-01T00:00:00Z', 'last_seen_at', '2026-10-06T00:00:00Z',
      'coverage', 'full', 'covered_by_entry_id', e, 'coverage_p', 0.9,
      'status', 'dismissed', 'dismissed_at', '2026-10-06T12:00:00Z',
      'gap_ids', jsonb_build_array(g1, g2)),
    jsonb_build_object('label', 'Islamic accounts', 'question_count', 1,
      'first_seen_at', '2026-10-03T00:00:00Z', 'last_seen_at', '2026-10-03T00:00:00Z',
      'gap_ids', jsonb_build_array(g3)),
    jsonb_build_object('label', 'No members yet', 'question_count', 0,
      'first_seen_at', '2026-10-03T00:00:00Z', 'last_seen_at', '2026-10-03T00:00:00Z',
      'gap_ids', '[]'::jsonb));
  r := pg_temp.kg_try('service_role', NULL,
    format('select public.kb_gap_topics_replace(%L, %L::jsonb)', a_acct, js));
  n := n + 1;
  IF r IS DISTINCT FROM '3' THEN
    failed := array_append(failed, format('the swapping replace returned %s, not 3', r));
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM kb_gap_topics WHERE account_id = a_acct) <> 3
     OR EXISTS (SELECT 1 FROM kb_gap_topics WHERE id IN (t1, t2))
     OR (SELECT count(*) FROM kb_gap_topic_members WHERE account_id = a_acct) <> 3
     OR (SELECT count(*) FROM kb_gap_topics WHERE account_id = b_acct) <> 1
     OR (SELECT status = 'dismissed' AND dismissed_at = '2026-10-06T12:00:00Z'::timestamptz
           FROM kb_gap_topics WHERE account_id = a_acct AND label = 'POS licence') IS DISTINCT FROM true
  THEN
    failed := array_append(failed, 'replace did not swap A''s topics (or touched B''s)'::text);
  END IF;
  SELECT id INTO t1 FROM kb_gap_topics WHERE account_id = a_acct AND label = 'POS licence';

  -- ---------- deletes ----------
  DELETE FROM ai_knowledge_gaps WHERE id = g1;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM kb_gap_topic_members WHERE gap_id = g1)
     OR (SELECT count(*) FROM kb_gap_topic_members WHERE topic_id = t1) <> 1
     OR NOT EXISTS (SELECT 1 FROM kb_gap_topics WHERE id = t1) THEN
    failed := array_append(failed, 'deleting a gap did not drop exactly its member rows'::text);
  END IF;
  DELETE FROM kb_entries WHERE id = e;
  n := n + 1;
  IF (SELECT covered_by_entry_id IS NULL AND account_id = a_acct AND coverage = 'full'
        FROM kb_gap_topics WHERE id = t1) IS DISTINCT FROM true THEN
    failed := array_append(failed, 'deleting an answer did not null covered_by_entry_id only'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT152', MESSAGE = 'verify-kb-gap-topics rollback';
  EXCEPTION WHEN SQLSTATE 'ZT152' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'knowledge-gap topics verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'knowledge-gap topics verification passed (% checks)', n;
END
$verify$;
