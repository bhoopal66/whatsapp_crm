-- Behavioural regression suite for the Compass status -> case stage map
-- (migration 151).
--
-- case_apply_submission_status consults the account's map before 137's
-- name rule, and only when the mapped stage is in the case's own bank
-- list; otherwise 137's rule runs unchanged (same-named stage moves, an
-- unknown status is a no-op). A final status cannot be mapped
-- (STATUS_FINAL) and a pre-submission or final stage cannot be a target
-- (STAGE_NOT_ALLOWED, plus the table's CHECKs). case_status_map_apply
-- moves only the account's open cases holding the status, as the API.
-- case_status_map_overview lists statuses nothing resolves, counted per
-- open case. Only a live owner/admin of their active account reaches
-- the RPCs, and only that account's map; RLS shows the map to that
-- account's owner/admin alone.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000151001';
  u_admin  UUID := '00000000-0000-4000-8000-000000151002';
  u_agent  UUID := '00000000-0000-4000-8000-000000151003';
  u_other  UUID := '00000000-0000-4000-8000-000000151004';  -- owner of another account
  a_acct   UUID;
  o_acct   UUID;
  w1       UUID;
  ct       UUID;
  g        UUID[] := '{}';
  k        UUID[] := '{}';
  banks    TEXT[] := ARRAY['ENBD', 'ENBD', 'ADCB', 'ENBD', 'ENBD'];
  b1       BOOLEAN;
  b2       BOOLEAN;
  j        JSONB;
  e        JSONB;
  st       TEXT;
  i        INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- NULL when cs_try's result is LIKE p_like, else the check's name and
  -- the result (so `failed := failed || cs_check(…)` records failures only).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cs_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- case_bank_stages_set, then the deferred list check forced at once:
  -- 'ok:<n>' or 'ERROR <sqlstate> <hint>'. A refused list is rolled back.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_stages(p_actor uuid, p_account uuid, p_bank text, p_stages text[])
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v int; h text;
    BEGIN
      BEGIN
        v := public.case_bank_stages_set(p_actor, p_account, p_bank, p_stages);
        SET CONSTRAINTS public.case_bank_stages_valid IMMEDIATE;
        SET CONSTRAINTS public.case_bank_stages_valid DEFERRED;
        RETURN 'ok:' || v;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        SET CONSTRAINTS public.case_bank_stages_valid DEFERRED;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-');
      END;
    END $body$
  $fn$;
  -- The overview entry of p_list ('mapped' / 'unmapped') with p_key, or NULL.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ov_entry(p_ov jsonb, p_list text, p_key text)
    RETURNS jsonb LANGUAGE sql AS $body$
      SELECT x FROM jsonb_array_elements(p_ov -> p_list) x WHERE x ->> 'status_key' = p_key LIMIT 1
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'csm-owner@example.invalid'),
    (u_admin, 'csm-admin@example.invalid'),
    (u_agent, 'csm-agent@example.invalid'),
    (u_other, 'csm-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO o_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR o_acct IS NULL OR a_acct = o_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CSM-151-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ENBD', 'Emirates NBD'), (a_acct, 'ADCB', 'ADCB')
  ON CONFLICT DO NOTHING;
  -- ADCB has its own list: a 'Bank review' stage and no 'Bank acknowledged'.
  st := pg_temp.cs_stages(u_owner, a_acct, 'ADCB', ARRAY['Interested', 'Data collection', 'Review',
          'Submitted', 'Bank review', 'Under review', 'Approved', 'Declined', 'Withdrawn', 'Closed']);
  IF st NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'fixture: ADCB list refused (%)', st; END IF;

  FOR i IN 1 .. 5 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_agent, '97150015100' || i, 'CSM ' || i) RETURNING id INTO ct;
    g := g || (SELECT x.group_id FROM sg_open(a_acct, 'CSM-151-' || i, ct, w1, 'case ' || i, NULL,
                 jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
    k := k || (SELECT x.case_id FROM case_open(g[i], banks[i], NULL, 'Card', NULL, NULL) x);
  END LOOP;
  IF array_length(k, 1) IS DISTINCT FROM 5 OR array_position(k, NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM cases WHERE id = ANY (k) AND stage <> 'Submitted') THEN
    RAISE EXCEPTION 'fixture: five cases at Submitted were not opened';
  END IF;
  -- k5 closed, its group then reporting the awaited status.
  b1 := case_apply_submission_status(g[5], 'DECLINED');
  b1 := sg_note_submission_status(g[5], 'Awaiting_Customer_Response');
  b1 := sg_note_submission_status(g[2], 'Awaiting Customer Response');
  b1 := sg_note_submission_status(g[4], ' awaiting  customer response ');
  b1 := sg_note_submission_status(g[3], 'Bank Review');

  -- ---------- 1. no mapping: 137 unchanged ----------
  b1 := case_apply_submission_status(g[1], 'Under_Review');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND (SELECT stage FROM cases WHERE id = k[1]) = 'Under review',
    'with no map, UNDER_REVIEW did not move the case to Under review');
  b1 := case_apply_submission_status(g[1], 'Awaiting Customer Response');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT b1 AND (SELECT stage FROM cases WHERE id = k[1]) = 'Under review',
    'with no map, an unknown status was not a no-op');

  -- ---------- 2. overview before mapping ----------
  j := case_status_map_overview(u_admin);
  e := pg_temp.ov_entry(j, 'unmapped', 'AWAITING CUSTOMER RESPONSE');
  n := n + 1; failed := failed || pg_temp.cs_ok(e IS NOT NULL AND (e ->> 'open_cases')::int = 2
      AND e ->> 'sample_label' IN ('Awaiting Customer Response', ' awaiting  customer response '),
    format('overview did not list AWAITING CUSTOMER RESPONSE unmapped on 2 open cases (%s)', j));
  n := n + 1; failed := failed || pg_temp.cs_ok(pg_temp.ov_entry(j, 'unmapped', 'BANK REVIEW') IS NULL
      AND j -> 'mapped' = '[]'::jsonb,
    format('overview listed a status the name rule resolves, or a mapping that does not exist (%s)', j));
  n := n + 1; failed := failed || pg_temp.cs_ok(j -> 'stages' ->> 0 = 'Submitted'
      AND j -> 'stages' ? 'Bank review' AND j -> 'stages' ? 'Query answered'
      AND NOT (j -> 'stages' ? 'Review') AND NOT (j -> 'stages' ? 'Approved')
      AND NOT (j -> 'stages' ? 'Closed'),
    format('overview stages are not the allowed targets, default order first (%s)', j -> 'stages'));

  -- ---------- 3. refusals ----------
  failed := failed || pg_temp.cs_check('an agent mapped a status', NULL, NULL,
    format('SELECT case_status_map_set(%L, ''To Submit'', ''Submitted'', ''admin'', NULL)::text', u_agent),
    'ERROR % NOT_ALLOWED:%');
  failed := failed || pg_temp.cs_check('an agent read the overview', NULL, NULL,
    format('SELECT case_status_map_overview(%L)::text', u_agent), 'ERROR % NOT_ALLOWED:%');
  failed := failed || pg_temp.cs_check('an agent applied a status', NULL, NULL,
    format('SELECT case_status_map_apply(%L, ''To Submit'')::text', u_agent), 'ERROR % NOT_ALLOWED:%');
  failed := failed || pg_temp.cs_check('an agent deleted a mapping', NULL, NULL,
    format('SELECT case_status_map_delete(%L, ''To Submit'')::text', u_agent), 'ERROR % NOT_ALLOWED:%');
  failed := failed || pg_temp.cs_check('a final status was mapped', NULL, NULL,
    format('SELECT case_status_map_set(%L, ''approved'', ''Submitted'', ''admin'', NULL)::text', u_admin),
    'ERROR % STATUS_FINAL:%');
  failed := failed || pg_temp.cs_check('a final status (closed_) was mapped', NULL, NULL,
    format('SELECT case_status_map_set(%L, '' Closed_ '', ''Submitted'', ''admin'', NULL)::text', u_admin),
    'ERROR % STATUS_FINAL:%');
  failed := failed || pg_temp.cs_check('a blank status was mapped', NULL, NULL,
    format('SELECT case_status_map_set(%L, '' _ '', ''Submitted'', ''admin'', NULL)::text', u_admin),
    'ERROR % STATUS_INVALID:%');
  failed := failed || pg_temp.cs_check('a pre-submission stage was a target', NULL, NULL,
    format('SELECT case_status_map_set(%L, ''To Submit'', ''Review'', ''admin'', NULL)::text', u_admin),
    'ERROR % STAGE_NOT_ALLOWED:%');
  failed := failed || pg_temp.cs_check('a final stage was a target', NULL, NULL,
    format('SELECT case_status_map_set(%L, ''To Submit'', ''Withdrawn'', ''admin'', NULL)::text', u_admin),
    'ERROR % STAGE_NOT_ALLOWED:%');
  failed := failed || pg_temp.cs_check('a stage in no list was a target', NULL, NULL,
    format('SELECT case_status_map_set(%L, ''To Submit'', ''Nowhere'', ''admin'', NULL)::text', u_admin),
    'ERROR % STAGE_NOT_CONFIGURED:%');
  failed := failed || pg_temp.cs_check('an unknown source was stored', NULL, NULL,
    format('SELECT case_status_map_set(%L, ''To Submit'', ''Submitted'', ''robot'', NULL)::text', u_admin),
    'ERROR % SETTING_INVALID:%');
  failed := failed || pg_temp.cs_check('suggested_p 1.5 was stored', NULL, NULL,
    format('SELECT case_status_map_set(%L, ''To Submit'', ''Submitted'', ''suggestion'', 1.5)::text', u_admin),
    'ERROR % SETTING_INVALID:%');
  failed := failed || pg_temp.cs_check('a final status was applied', NULL, NULL,
    format('SELECT case_status_map_apply(%L, ''DECLINED'')::text', u_admin), 'ERROR % STATUS_FINAL:%');
  failed := failed || pg_temp.cs_check('the table took a final status key', NULL, NULL,
    format('INSERT INTO case_status_stage_map (account_id, status_key, status_label, stage, source) VALUES (%L, ''CLOSED'', ''closed'', ''Submitted'', ''admin'')', a_acct),
    'ERROR 23514 %');
  failed := failed || pg_temp.cs_check('the table took a pre-submission stage', NULL, NULL,
    format('INSERT INTO case_status_stage_map (account_id, status_key, status_label, stage, source) VALUES (%L, ''X'', ''x'', ''Interested'', ''admin'')', a_acct),
    'ERROR 23514 %');
  failed := failed || pg_temp.cs_check('the table took a key that is not its label''s', NULL, NULL,
    format('INSERT INTO case_status_stage_map (account_id, status_key, status_label, stage, source) VALUES (%L, ''X'', ''y'', ''Submitted'', ''admin'')', a_acct),
    'ERROR 23514 %');
  n := n + 17;

  -- ---------- 4. mapping ----------
  j := case_status_map_set(u_admin, 'Awaiting Customer Response', 'Documents requested', 'suggestion', 0.82);
  n := n + 1; failed := failed || pg_temp.cs_ok(j ->> 'status_key' = 'AWAITING CUSTOMER RESPONSE'
      AND j ->> 'stage' = 'Documents requested' AND j ->> 'source' = 'suggestion',
    format('case_status_map_set did not return the stored row (%s)', j));
  j := case_status_map_set(u_owner, 'Under Review', 'Query raised', 'admin', NULL);
  j := case_status_map_set(u_admin, 'Bank_Review', 'Bank acknowledged', 'admin', NULL);
  j := case_status_map_set(u_admin, 'Pending Bank', 'Bank acknowledged', 'admin', NULL);
  -- An upsert keeps one row per key.
  j := case_status_map_set(u_admin, 'PENDING_BANK', 'Bank acknowledged', 'admin', NULL);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_status_stage_map WHERE account_id = a_acct) = 4
    AND (SELECT status_label FROM case_status_stage_map WHERE account_id = a_acct AND status_key = 'PENDING BANK') = 'PENDING_BANK',
    'a second spelling of a status did not update its one row');

  -- ---------- 5. the map comes before the name rule ----------
  b1 := case_apply_submission_status(g[1], 'UNDER_REVIEW');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1
    AND (SELECT stage FROM cases WHERE id = k[1]) = 'Query raised'
    AND (SELECT from_stage = 'Under review' AND to_stage = 'Query raised' AND actor_id IS NULL AND actor_role = 'api'
           FROM case_stage_history WHERE case_id = k[1] ORDER BY id DESC LIMIT 1),
    'a mapped UNDER_REVIEW did not move the case to its mapped stage as the API');

  -- ---------- 6. a mapped stage outside the case's list ----------
  b1 := case_apply_submission_status(g[3], 'BANK_REVIEW');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND (SELECT stage FROM cases WHERE id = k[3]) = 'Bank review',
    'a mapping to a stage outside the bank''s list did not fall back to the name rule');
  b1 := case_apply_submission_status(g[3], 'Pending Bank');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT b1 AND (SELECT stage FROM cases WHERE id = k[3]) = 'Bank review',
    'a mapping to a stage outside the bank''s list, with no same-named stage, was not a no-op');

  -- ---------- 7. overview after mapping ----------
  j := case_status_map_overview(u_admin);
  e := pg_temp.ov_entry(j, 'mapped', 'AWAITING CUSTOMER RESPONSE');
  n := n + 1; failed := failed || pg_temp.cs_ok(e IS NOT NULL AND (e ->> 'open_cases')::int = 2
      AND e ->> 'stage' = 'Documents requested' AND e ->> 'source' = 'suggestion'
      AND (e ->> 'suggested_p')::real = 0.82::real AND (e ->> 'stage_known')::boolean
      AND e ->> 'status_label' = 'Awaiting Customer Response'
      AND jsonb_array_length(j -> 'mapped') = 4
      AND pg_temp.ov_entry(j, 'unmapped', 'AWAITING CUSTOMER RESPONSE') IS NULL,
    format('overview after mapping is wrong (%s)', j));

  -- ---------- 8. apply ----------
  j := case_status_map_apply(u_admin, 'awaiting_customer_response');
  n := n + 1; failed := failed || pg_temp.cs_ok(j = '{"moved": 2, "unchanged": 0}'::jsonb,
    format('case_status_map_apply did not move exactly the 2 open cases (%s)', j));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM cases WHERE id IN (k[2], k[4]) AND stage = 'Documents requested' AND closed_at IS NULL) = 2
    AND (SELECT count(*) FROM case_stage_history h WHERE h.case_id IN (k[2], k[4])
           AND h.from_stage = 'Submitted' AND h.to_stage = 'Documents requested'
           AND h.actor_id IS NULL AND h.actor_role = 'api') = 2
    AND (SELECT stage = 'Declined' AND closed_at IS NOT NULL FROM cases WHERE id = k[5])
    AND (SELECT stage FROM cases WHERE id = k[1]) = 'Query raised'
    AND (SELECT stage FROM cases WHERE id = k[3]) = 'Bank review',
    'case_status_map_apply moved the wrong cases or wrote no api history');
  j := case_status_map_apply(u_admin, 'Awaiting Customer Response');
  n := n + 1; failed := failed || pg_temp.cs_ok(j = '{"moved": 0, "unchanged": 2}'::jsonb,
    format('a second case_status_map_apply moved cases again (%s)', j));

  -- ---------- 9. another account ----------
  j := case_status_map_overview(u_other);
  n := n + 1; failed := failed || pg_temp.cs_ok(j -> 'mapped' = '[]'::jsonb AND j -> 'unmapped' = '[]'::jsonb,
    format('another account''s owner saw this account''s map or statuses (%s)', j));
  b1 := case_status_map_delete(u_other, 'Under Review');
  j := case_status_map_apply(u_other, 'Awaiting Customer Response');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT b1 AND j = '{"moved": 0, "unchanged": 0}'::jsonb
      AND EXISTS (SELECT 1 FROM case_status_stage_map WHERE account_id = a_acct AND status_key = 'UNDER REVIEW'),
    'another account''s owner changed this account''s map or cases');
  failed := failed || pg_temp.cs_check('the admin cannot read the map', 'authenticated', u_admin,
    'SELECT count(*)::text FROM case_status_stage_map', '4');
  failed := failed || pg_temp.cs_check('another account''s owner reads the map', 'authenticated', u_other,
    'SELECT count(*)::text FROM case_status_stage_map', '0');
  failed := failed || pg_temp.cs_check('an agent reads the map', 'authenticated', u_agent,
    'SELECT count(*)::text FROM case_status_stage_map', '0');
  failed := failed || pg_temp.cs_check('a signed-in admin wrote the map directly', 'authenticated', u_admin,
    format('INSERT INTO case_status_stage_map (account_id, status_key, status_label, stage, source) VALUES (%L, ''Y'', ''y'', ''Submitted'', ''admin'')', a_acct),
    'ERROR 42501 %');
  n := n + 4;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT has_function_privilege('authenticated', 'public.case_status_map_set(uuid, text, text, text, real)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.case_status_map_apply(uuid, text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.case_status_map_overview(uuid)', 'EXECUTE'),
    'the 151 RPCs are not service_role''s alone');

  -- ---------- 10. delete ----------
  b1 := case_status_map_delete(u_admin, 'under_review');
  b2 := case_status_map_delete(u_admin, 'under_review');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND NOT b2
      AND NOT EXISTS (SELECT 1 FROM case_status_stage_map WHERE account_id = a_acct AND status_key = 'UNDER REVIEW'),
    'case_status_map_delete did not remove the mapping once');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT151', MESSAGE = 'verify-case-status-map rollback';
  EXCEPTION WHEN SQLSTATE 'ZT151' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case status map verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case status map verification passed (% checks)', n;
END
$verify$;
