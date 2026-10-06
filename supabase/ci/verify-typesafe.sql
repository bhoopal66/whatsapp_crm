-- Behavioural regression suite for the TypeSafe decision layer (063).
--
-- `verify-schema.sql` asserts the objects EXIST. This file asserts the
-- rules they enforce, which the vitest suite cannot reach because they
-- live in SQL: four-eyes activation on every path, threshold validation,
-- per-account isolation, the append-only log (retention, erasure and an
-- account deletion being the only ways a row changes or goes), TRUNCATE
-- blocked for everyone, the minimum grants, and the reply-slot re-check.
--
-- ONE statement on purpose: `supabase db query --file` (CLI 2.113.0)
-- sends the file as a single prepared statement and rejects several.
-- The helpers are created with EXECUTE inside it, and because the CLI
-- drops NOTICE/WARNING output, the names of failing assertions go into
-- the final exception.
--
-- Runs against the clean database `supabase db reset` builds, after
-- every migration has replayed. It writes rows; that database is
-- thrown away.

DO $verify$
DECLARE
  -- account A: owner, admin, two agents; account B and C: their own owners
  u_owner  UUID := '00000000-0000-4000-8000-0000000ad001';
  u_admin  UUID := '00000000-0000-4000-8000-0000000ad002';
  u_agent1 UUID := '00000000-0000-4000-8000-0000000ad003';
  u_agent2 UUID := '00000000-0000-4000-8000-0000000ad004';
  u_other  UUID := '00000000-0000-4000-8000-0000000ad005';
  u_gone   UUID := '00000000-0000-4000-8000-0000000ad006';
  a_acct   UUID;
  b_acct   UUID;
  c_acct   UUID;
  c1       UUID;
  c2       UUID;
  c3       UUID;
  conv1    UUID;
  p1       UUID;
  p2       UUID;
  p3       UUID;
  d1       UUID;
  d2       UUID;
  d3       UUID;
  r        TEXT;
  ok       BOOLEAN;
  n        INT := 0;
  failed   TEXT[] := '{}';
  tri      TEXT := '{"intentConfidenceMin":0.5,"possibleComplaintMin":0.25,"wantsHumanMin":0.7,"complaintConfidenceMin":0.5,"instructsAssistantMin":0.7,"nonPartnerBankMin":0.7,"dissatisfiedMin":0.7,"leadTemperatureMin":2,"leadTemperatureConfMin":0.5,"urgencyHighMin":1,"urgencyUrgentMin":1.6,"optOutRecordMin":0.8,"optOutReviewMin":0.4}';
  gua      TEXT := '{"actionMin":0.7,"reviewMin":0.35,"severityBlock":2}';
  ins      TEXT := $q$INSERT INTO ts_policy (account_id, check_name, version, model_id, question_set_version, thresholds, shadow, proposed_by)
                     VALUES (%L, %L, %s, 'jev-1.13.0', 'qs-013-v0.2', %L::jsonb, false, %L)$q$;
BEGIN
  -- ---------------------------------------------------------------
  -- Helpers: run a statement as a role (and signed-in user) and report
  -- 'ok' or the error text. The inner block is a subtransaction, so on
  -- error the role switch and any writes roll back with it.
  -- ---------------------------------------------------------------
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.try_as(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RETURN SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.value_as(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN v;
      EXCEPTION WHEN OTHERS THEN
        RETURN 'ERROR: ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- Same, as the connecting (owner) role, for statements expected to fail.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.try_sql(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        EXECUTE p_sql;
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RETURN SQLERRM;
      END;
    END $body$
  $fn$;

  -- ---------------------------------------------------------------
  -- Fixture. A trigger on auth.users provisions an account + owner
  -- profile per user; the admin and agents are then moved into A.
  -- ---------------------------------------------------------------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'ts-owner@example.invalid'),
    (u_admin,  'ts-admin@example.invalid'),
    (u_agent1, 'ts-agent1@example.invalid'),
    (u_agent2, 'ts-agent2@example.invalid'),
    (u_other,  'ts-other@example.invalid'),
    (u_gone,   'ts-gone@example.invalid')
  ON CONFLICT DO NOTHING;

  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  SELECT account_id INTO c_acct FROM profiles WHERE user_id = u_gone;
  IF a_acct IS NULL OR b_acct IS NULL OR c_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent1, u_agent2);

  INSERT INTO contacts (account_id, user_id, phone, name)
       VALUES (a_acct, u_agent1, '971500000001', 'TS one') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name)
       VALUES (a_acct, u_agent2, '971500000002', 'TS two') RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name)
       VALUES (a_acct, u_owner, '971500000003', 'TS three') RETURNING id INTO c3;

  -- ---------------------------------------------------------------
  -- ts_policy — four-eyes on every path
  -- ---------------------------------------------------------------

  r := pg_temp.try_as('authenticated', u_agent1, format(ins, a_acct, 'triage', 1, tri, u_agent1));
  n := n + 1;
  -- Refused by the proposer trigger (it fires before RLS) or by RLS.
  IF r NOT LIKE '%row-level security%' AND r NOT LIKE '%owner or admin%' THEN
    failed := array_append(failed, ('agent proposed: ' || r)::text);
  END IF;

  r := pg_temp.try_as('authenticated', u_admin, format(ins, a_acct, 'triage', 1, tri, u_admin));
  SELECT id INTO p1 FROM ts_policy WHERE account_id = a_acct AND check_name = 'triage' AND version = 1;
  n := n + 1;
  IF r <> 'ok' OR p1 IS NULL THEN failed := array_append(failed, ('admin could not propose: ' || r)::text); END IF;

  r := pg_temp.try_as('authenticated', u_other, format(ins, a_acct, 'triage', 9, tri, u_other));
  n := n + 1;
  IF r NOT LIKE '%row-level security%' AND r NOT LIKE '%owner or admin%' THEN
    failed := array_append(failed, ('cross-account proposal: ' || r)::text);
  END IF;

  -- The operator's psql bypasses RLS; the trigger still checks the proposer.
  r := pg_temp.try_sql(format(ins, a_acct, 'triage', 10, tri, u_agent1));
  n := n + 1;
  IF r NOT LIKE '%owner or admin%' THEN failed := array_append(failed, ('operator proposal naming an agent: ' || r)::text); END IF;

  r := pg_temp.try_sql(format(ins, a_acct, 'triage', 11, tri, gen_random_uuid()));
  n := n + 1;
  IF r NOT LIKE '%owner or admin%' THEN failed := array_append(failed, ('operator proposal naming a stranger: ' || r)::text); END IF;

  r := pg_temp.try_sql(format(ins, a_acct, 'triage', 12, '{"intentConfidenceMin":0.5}', u_admin));
  n := n + 1;
  IF r NOT LIKE '%missing or not a number%' THEN failed := array_append(failed, ('incomplete thresholds accepted: ' || r)::text); END IF;

  r := pg_temp.try_sql(format(ins, a_acct, 'triage', 13,
         replace(tri, '"urgencyUrgentMin":1.6', '"urgencyUrgentMin":2.5'), u_admin));
  n := n + 1;
  IF r NOT LIKE '%out of range%' THEN failed := array_append(failed, ('urgency above its 3-level Score accepted: ' || r)::text); END IF;

  r := pg_temp.try_sql(format(ins, a_acct, 'guardrail', 14, replace(gua, '}', ',"extra":1}'), u_admin));
  n := n + 1;
  IF r NOT LIKE '%unknown key%' THEN failed := array_append(failed, ('unknown threshold key accepted: ' || r)::text); END IF;

  r := pg_temp.try_sql(format(ins, a_acct, 'guardrail', 15, '{"actionMin":0.3,"reviewMin":0.6,"severityBlock":2}', u_admin));
  n := n + 1;
  IF r NOT LIKE '%reviewMin > actionMin%' THEN failed := array_append(failed, ('inverted guardrail thresholds accepted: ' || r)::text); END IF;

  r := pg_temp.try_sql(format(
    $q$INSERT INTO ts_policy (account_id, check_name, version, model_id, question_set_version, thresholds, proposed_by, retired_by, retired_at)
       VALUES (%L, 'guardrail', 19, 'jev-1.13.0', 'qs-013-v0.2', %L::jsonb, %L, %L, now())$q$,
    a_acct, gua, u_admin, u_owner));
  n := n + 1;
  IF r NOT LIKE '%retired_by / retired_at%' THEN
    failed := array_append(failed, ('forged retirement fields accepted: ' || r)::text);
  END IF;

  PERFORM pg_temp.try_sql(format(
    $q$INSERT INTO ts_policy (account_id, check_name, version, model_id, question_set_version, thresholds, proposed_by, proposed_at)
       VALUES (%L, 'guardrail', 20, 'jev-1.13.0', 'qs-013-v0.2', %L::jsonb, %L, '2020-01-01')$q$,
    a_acct, gua, u_admin));
  n := n + 1;
  IF (SELECT proposed_at < now() - interval '1 minute' FROM ts_policy
       WHERE account_id = a_acct AND check_name = 'guardrail' AND version = 20) IS DISTINCT FROM false THEN
    failed := array_append(failed, 'a backdated proposed_at was kept'::text);
  END IF;

  r := pg_temp.try_sql(replace(format(ins, a_acct, 'triage', 16, tri, u_admin), 'jev-1.13.0', 'jev-latest'));
  n := n + 1;
  IF r NOT LIKE '%pinned version%' THEN failed := array_append(failed, ('model alias accepted: ' || r)::text); END IF;

  r := pg_temp.try_sql(format(
    $q$INSERT INTO ts_policy (account_id, check_name, version, model_id, question_set_version, thresholds, status, proposed_by, approved_by, approved_at)
       VALUES (%L, 'guardrail', 17, 'jev-1.13.0', 'qs-013-v0.2', %L::jsonb, 'active', %L, %L, now())$q$,
    a_acct, gua, u_admin, u_owner));
  n := n + 1;
  IF r NOT LIKE '%inserted as proposed%' THEN failed := array_append(failed, ('active row inserted directly: ' || r)::text); END IF;

  r := pg_temp.try_as('authenticated', u_admin, format(
    $q$INSERT INTO ts_policy (account_id, check_name, version, model_id, question_set_version, thresholds, status, proposed_by, approved_by, approved_at)
       VALUES (%L, 'guardrail', 18, 'jev-1.13.0', 'qs-013-v0.2', %L::jsonb, 'active', %L, %L, now())$q$,
    a_acct, gua, u_admin, u_owner));
  n := n + 1;
  IF r NOT LIKE '%row-level security%' AND r NOT LIKE '%inserted as proposed%' THEN
    failed := array_append(failed, ('active row smuggled through RLS: ' || r)::text);
  END IF;

  r := pg_temp.try_as('authenticated', u_admin, format('SELECT ts_approve_policy(%L)', p1));
  n := n + 1;
  IF r NOT LIKE '%four-eyes%' THEN failed := array_append(failed, ('self-approval: ' || r)::text); END IF;

  r := pg_temp.try_as('authenticated', u_agent1, format('SELECT ts_approve_policy(%L)', p1));
  n := n + 1;
  IF r NOT LIKE '%admin role required%' THEN failed := array_append(failed, ('agent approval: ' || r)::text); END IF;

  r := pg_temp.try_as('authenticated', u_other, format('SELECT ts_approve_policy(%L)', p1));
  n := n + 1;
  IF r NOT LIKE '%admin role required%' THEN failed := array_append(failed, ('cross-account approval: ' || r)::text); END IF;

  r := pg_temp.try_as('authenticated', u_owner, format('SELECT ts_approve_policy(%L)', p1));
  n := n + 1;
  IF r <> 'ok' OR (SELECT status FROM ts_policy WHERE id = p1) <> 'active' THEN
    failed := array_append(failed, ('second-person approval: ' || r)::text);
  END IF;

  PERFORM pg_temp.try_as('authenticated', u_owner, format(ins, a_acct, 'triage', 2, tri, u_owner));
  SELECT id INTO p2 FROM ts_policy WHERE account_id = a_acct AND check_name = 'triage' AND version = 2;
  r := pg_temp.try_as('authenticated', u_admin, format('SELECT ts_approve_policy(%L)', p2));
  n := n + 1;
  IF r <> 'ok'
     OR (SELECT status FROM ts_policy WHERE id = p1) <> 'retired'
     OR (SELECT status FROM ts_policy WHERE id = p2) <> 'active'
     OR (SELECT approved_by FROM ts_policy WHERE id = p2) <> u_admin
     OR (SELECT retired_by FROM ts_policy WHERE id = p1) IS DISTINCT FROM u_admin THEN
    failed := array_append(failed, ('retire-on-approve: ' || r)::text);
  END IF;

  -- A proposer who has since lost the admin role no longer counts.
  PERFORM pg_temp.try_as('authenticated', u_admin, format(ins, a_acct, 'guardrail', 1, gua, u_admin));
  SELECT id INTO p3 FROM ts_policy WHERE account_id = a_acct AND check_name = 'guardrail' AND version = 1;
  UPDATE profiles SET account_role = 'agent' WHERE user_id = u_admin;
  r := pg_temp.try_as('authenticated', u_owner, format('SELECT ts_approve_policy(%L)', p3));
  UPDATE profiles SET account_role = 'admin' WHERE user_id = u_admin;
  n := n + 1;
  IF r NOT LIKE '%no longer an owner or admin%' THEN failed := array_append(failed, ('demoted proposer still counted: ' || r)::text); END IF;

  r := pg_temp.value_as('authenticated', u_other, 'SELECT count(*) FROM ts_policy');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('cross-account policy read: ' || r)::text); END IF;

  r := pg_temp.try_sql(format($q$UPDATE ts_policy SET thresholds = '{}'::jsonb WHERE id = %L$q$, p2));
  n := n + 1;
  IF r NOT LIKE '%UPDATE blocked%' THEN failed := array_append(failed, ('owner edited a policy: ' || r)::text); END IF;

  r := pg_temp.try_sql(format($q$SELECT set_config('ts.policy_write', 'on', true); UPDATE ts_policy SET thresholds = '{}'::jsonb WHERE id = %L$q$, p2));
  n := n + 1;
  IF r NOT LIKE '%UPDATE blocked%' THEN failed := array_append(failed, ('the write flag let thresholds change: ' || r)::text); END IF;

  r := pg_temp.try_sql(format('DELETE FROM ts_policy WHERE id = %L', p1));
  n := n + 1;
  IF r NOT LIKE '%DELETE blocked%' THEN failed := array_append(failed, ('owner deleted a policy: ' || r)::text); END IF;

  -- Per-account emergency stop: one admin, no second pair of eyes.
  r := pg_temp.try_as('authenticated', u_agent1, format('SELECT ts_retire_policy(%L)', p2));
  n := n + 1;
  IF r NOT LIKE '%admin role required%' THEN failed := array_append(failed, ('agent retired a policy: ' || r)::text); END IF;

  r := pg_temp.try_as('authenticated', u_admin, format('SELECT ts_retire_policy(%L)', p2));
  n := n + 1;
  IF r <> 'ok' OR (SELECT status FROM ts_policy WHERE id = p2) <> 'retired'
     OR (SELECT retired_by FROM ts_policy WHERE id = p2) IS DISTINCT FROM u_admin
     OR (SELECT retired_at FROM ts_policy WHERE id = p2) IS NULL
     OR EXISTS (SELECT 1 FROM ts_policy WHERE account_id = a_acct AND check_name = 'triage' AND status = 'active') THEN
    failed := array_append(failed, ('single-admin retire: ' || r)::text);
  END IF;

  r := pg_temp.try_as('authenticated', u_admin, format('SELECT ts_retire_policy(%L)', p3));
  n := n + 1;
  IF r NOT LIKE '%not active%' THEN failed := array_append(failed, ('retired a proposal: ' || r)::text); END IF;

  -- ---------------------------------------------------------------
  -- ts_decision_log — RLS, append-only, retention, erasure, views
  -- ---------------------------------------------------------------

  INSERT INTO ts_decision_log (account_id, contact_id, conversation_id, message_id, state_hash, check_name, question_set_version, decision, acted, shadow, answers, input_tokens, latency_ms, created_at)
  VALUES (a_acct, c1, 'conv-1', 'mh-1', 'sh-1', 'triage', 'qs-013-v0.2', 'bot', false, true, '{"x":1}', 2000, 120, now() - interval '200 days')
  RETURNING id INTO d1;
  INSERT INTO ts_decision_log (account_id, contact_id, check_name, question_set_version, decision, acted, shadow, answers, input_tokens, latency_ms)
  VALUES (a_acct, c2, 'triage', 'qs-013-v0.2', 'rm', false, true, '{"x":2}', 3000, 150)
  RETURNING id INTO d2;
  INSERT INTO ts_decision_log (account_id, check_name, question_set_version, decision, acted, shadow, answers)
  VALUES (b_acct, 'guardrail', 'qs-013-v0.2', 'send', false, true, '{"x":3}');

  r := pg_temp.value_as('authenticated', u_agent1, 'SELECT string_agg(contact_id::text, '','') FROM ts_decision_log');
  n := n + 1;
  IF r IS DISTINCT FROM c1::text THEN failed := array_append(failed, ('agent log visibility: ' || coalesce(r, 'null'))::text); END IF;

  r := pg_temp.value_as('authenticated', u_admin, 'SELECT count(*) FROM ts_decision_log');
  n := n + 1;
  IF r <> '2' THEN failed := array_append(failed, ('admin log visibility: ' || r)::text); END IF;

  r := pg_temp.value_as('anon', NULL, 'SELECT count(*) FROM ts_decision_log');
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN failed := array_append(failed, ('anon log read: ' || r)::text); END IF;

  r := pg_temp.try_as('authenticated', u_admin, format(
    $q$INSERT INTO ts_decision_log (account_id, check_name, question_set_version, decision, acted, shadow)
       VALUES (%L, 'triage', 'x', 'bot', false, true)$q$, a_acct));
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN failed := array_append(failed, ('user log write: ' || r)::text); END IF;

  r := pg_temp.value_as('service_role', NULL, format(
    $q$INSERT INTO ts_decision_log (account_id, check_name, question_set_version, decision, acted, shadow)
       VALUES (%L, 'triage', 'qs-013-v0.2', 'bot', false, true) RETURNING id$q$, b_acct));
  n := n + 1;
  IF r IS NULL OR r LIKE 'ERROR:%' THEN failed := array_append(failed, ('service-role log write: ' || coalesce(r, 'null'))::text); END IF;

  r := pg_temp.try_sql('UPDATE ts_decision_log SET decision = ''x''');
  n := n + 1;
  IF r NOT LIKE '%append-only%' THEN failed := array_append(failed, ('owner update: ' || r)::text); END IF;

  r := pg_temp.try_sql('DELETE FROM ts_decision_log');
  n := n + 1;
  IF r NOT LIKE '%append-only%' THEN failed := array_append(failed, ('owner delete: ' || r)::text); END IF;

  r := pg_temp.try_sql($q$SELECT set_config('ts.purge', 'on', true);
    UPDATE ts_decision_log SET decision = 'FORGED', answers = NULL, message_id = NULL, state_hash = NULL, answers_purged_at = now()
     WHERE answers IS NOT NULL$q$);
  n := n + 1;
  IF r NOT LIKE '%append-only%' THEN failed := array_append(failed, ('purge flag forgery: ' || r)::text); END IF;

  r := pg_temp.try_sql($q$SELECT set_config('ts.erase', 'on', true);
    UPDATE ts_decision_log SET decision = 'FORGED', contact_id = NULL, conversation_id = NULL, message_id = NULL, state_hash = NULL, answers = NULL$q$);
  n := n + 1;
  IF r NOT LIKE '%append-only%' THEN failed := array_append(failed, ('erase flag forgery: ' || r)::text); END IF;

  r := pg_temp.value_as('service_role', NULL, 'SELECT ts_purge_answers(180)');
  n := n + 1;
  IF r <> '1'
     OR NOT (SELECT answers IS NULL AND message_id IS NULL AND state_hash IS NULL
                    AND answers_purged_at IS NOT NULL AND decision = 'bot'
               FROM ts_decision_log WHERE id = d1)
     OR (SELECT answers IS NULL FROM ts_decision_log WHERE id = d2) THEN
    failed := array_append(failed, ('purge: ' || r)::text);
  END IF;

  r := pg_temp.try_sql('SELECT ts_purge_answers(1)');
  n := n + 1;
  IF r NOT LIKE '%>= 30%' THEN failed := array_append(failed, ('purge floor: ' || r)::text); END IF;

  r := pg_temp.value_as('authenticated', u_agent1, 'SELECT ts_purge_answers(30)');
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN failed := array_append(failed, ('user purge: ' || r)::text); END IF;

  r := pg_temp.value_as('anon', NULL, 'SELECT ts_purge_answers(30)');
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN failed := array_append(failed, ('anon purge: ' || r)::text); END IF;

  r := pg_temp.value_as('authenticated', u_admin,
    'SELECT (sum(est_usd) = sum(input_tokens) * 0.042 / 1000000)::text FROM v_ts_daily_usage');
  n := n + 1;
  IF r <> 'true' THEN failed := array_append(failed, ('usage view: ' || r)::text); END IF;

  -- Deleting a contact erases its identifiers; the decision row stays.
  INSERT INTO ts_decision_log (account_id, contact_id, conversation_id, message_id, state_hash, check_name, question_set_version, decision, acted, shadow, answers)
  VALUES (a_acct, c3, 'conv-3', 'mh-3', 'sh-3', 'guardrail', 'qs-013-v0.2', 'hold', true, false, '{"x":4}')
  RETURNING id INTO d3;
  DELETE FROM contacts WHERE id = c3;
  n := n + 1;
  IF NOT EXISTS (
    SELECT 1 FROM ts_decision_log
     WHERE id = d3 AND contact_id IS NULL AND conversation_id IS NULL
       AND message_id IS NULL AND state_hash IS NULL AND answers IS NULL
       AND decision = 'hold' AND acted
  ) THEN
    failed := array_append(failed, ('contact deletion did not erase its log identifiers')::text);
  END IF;

  -- A decision logged after its contact was deleted arrives erased.
  INSERT INTO ts_decision_log (account_id, contact_id, conversation_id, message_id, state_hash, check_name, question_set_version, decision, acted, shadow, answers)
  VALUES (a_acct, c3, 'conv-3', 'mh-late', 'sh-late', 'guardrail', 'qs-013-v0.2', 'send', false, true, '{"x":6}')
  RETURNING id INTO d3;
  n := n + 1;
  IF NOT EXISTS (
    SELECT 1 FROM ts_decision_log
     WHERE id = d3 AND contact_id IS NULL AND conversation_id IS NULL
       AND message_id IS NULL AND state_hash IS NULL AND answers IS NULL
  ) THEN
    failed := array_append(failed, 'a late decision for a deleted contact kept its identifiers'::text);
  END IF;

  -- The append-only guard lists every column by name; a new column must
  -- be added there (and here). 064's `intervened` is the exception: it
  -- is GENERATED from acted, check_name and decision, which the guard
  -- already freezes, and no role can write it.
  n := n + 1;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ts_decision_log') <> 23 THEN
    failed := array_append(failed, 'ts_decision_log columns changed: update ts_decision_log_guard'::text);
  END IF;

  -- ---------------------------------------------------------------
  -- ts_label
  -- ---------------------------------------------------------------

  r := pg_temp.try_as('authenticated', u_agent1, format(
    $q$INSERT INTO ts_label (account_id, decision_id, correct_decision) VALUES (%L, %L, 'bot')$q$, a_acct, d1));
  n := n + 1;
  IF r <> 'ok' OR (SELECT labeled_by FROM ts_label WHERE decision_id = d1) <> u_agent1 THEN
    failed := array_append(failed, ('agent label: ' || r)::text);
  END IF;

  r := pg_temp.value_as('authenticated', u_admin,
    $q$SELECT agreed FROM v_ts_label_agreement WHERE check_name = 'triage'$q$);
  n := n + 1;
  IF r IS DISTINCT FROM '1' THEN failed := array_append(failed, ('agreement view: ' || coalesce(r, 'null'))::text); END IF;

  r := pg_temp.try_as('authenticated', u_agent1, format(
    $q$INSERT INTO ts_label (account_id, decision_id, correct_decision) VALUES (%L, %L, 'bot')$q$, a_acct, d2));
  n := n + 1;
  IF r NOT LIKE '%row-level security%' THEN failed := array_append(failed, ('hidden-decision label: ' || r)::text); END IF;

  r := pg_temp.try_as('authenticated', u_other, format(
    $q$INSERT INTO ts_label (account_id, decision_id, correct_decision) VALUES (%L, %L, 'bot')$q$, b_acct, d1));
  n := n + 1;
  IF r NOT LIKE '%row-level security%' AND r NOT LIKE '%foreign key%' THEN
    failed := array_append(failed, ('cross-account label: ' || r)::text);
  END IF;

  -- The service role bypasses RLS; the composite FK still holds.
  r := pg_temp.try_as('service_role', NULL, format(
    $q$INSERT INTO ts_label (account_id, decision_id, labeled_by, correct_decision) VALUES (%L, %L, %L, 'bot')$q$,
    b_acct, d1, u_other));
  n := n + 1;
  IF r NOT LIKE '%foreign key%' THEN failed := array_append(failed, ('service-role cross-account label: ' || r)::text); END IF;

  -- ---------------------------------------------------------------
  -- Privileges
  -- ---------------------------------------------------------------

  r := pg_temp.try_as('anon', NULL, 'SELECT ts_approve_policy(gen_random_uuid())');
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN failed := array_append(failed, ('anon approval: ' || r)::text); END IF;

  r := pg_temp.try_as('anon', NULL, 'SELECT ts_retire_policy(gen_random_uuid())');
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN failed := array_append(failed, ('anon retire: ' || r)::text); END IF;

  r := pg_temp.try_as('service_role', NULL, $q$UPDATE ts_decision_log SET decision = 'x'$q$);
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN failed := array_append(failed, ('service-role log update: ' || r)::text); END IF;

  r := pg_temp.try_as('service_role', NULL, $q$UPDATE ts_policy SET status = 'active'$q$);
  n := n + 1;
  IF r NOT LIKE '%permission denied%' THEN failed := array_append(failed, ('service-role policy update: ' || r)::text); END IF;

  -- Re-approve something so the service role has an active policy to read.
  PERFORM pg_temp.try_as('authenticated', u_owner, format(ins, a_acct, 'triage', 3, tri, u_owner));
  PERFORM pg_temp.try_as('authenticated', u_admin, format(
    'SELECT ts_approve_policy(id) FROM ts_policy WHERE account_id = %L AND check_name = ''triage'' AND version = 3', a_acct));
  r := pg_temp.value_as('service_role', NULL, format(
    $q$SELECT version FROM ts_policy WHERE account_id = %L AND check_name = 'triage' AND status = 'active'$q$, a_acct));
  n := n + 1;
  IF r IS DISTINCT FROM '3' THEN failed := array_append(failed, ('service-role policy read: ' || coalesce(r, 'null'))::text); END IF;

  FOR r IN SELECT unnest(ARRAY['ts_decision_log', 'ts_policy', 'ts_label']) LOOP
    n := n + 1;
    IF pg_temp.try_as('authenticated', u_owner, format('TRUNCATE %I CASCADE', r)) NOT LIKE '%permission denied%'
       OR pg_temp.try_as('service_role', NULL, format('TRUNCATE %I CASCADE', r)) NOT LIKE '%permission denied%'
       OR pg_temp.try_sql(format('TRUNCATE %I CASCADE', r)) NOT LIKE '%cannot be truncated%' THEN
      failed := array_append(failed, ('TRUNCATE ' || r)::text);
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------
  -- Deleting an account takes its policies, log and labels with it;
  -- nothing else can (the contact-erase trigger runs in the cascade).
  -- ---------------------------------------------------------------

  INSERT INTO contacts (account_id, user_id, phone, name)
       VALUES (c_acct, u_gone, '971500000009', 'TS gone') RETURNING id INTO c3;
  INSERT INTO ts_decision_log (account_id, contact_id, check_name, question_set_version, decision, acted, shadow, answers)
  VALUES (c_acct, c3, 'triage', 'qs-013-v0.2', 'bot', false, true, '{"x":5}') RETURNING id INTO d3;
  INSERT INTO ts_label (account_id, decision_id, labeled_by, correct_decision)
  VALUES (c_acct, d3, u_gone, 'bot');
  EXECUTE format(ins, c_acct, 'triage', 1, tri, u_gone);
  r := pg_temp.try_sql(format('DELETE FROM accounts WHERE id = %L', c_acct));
  n := n + 1;
  IF r <> 'ok'
     OR EXISTS (SELECT 1 FROM ts_decision_log WHERE account_id = c_acct)
     OR EXISTS (SELECT 1 FROM ts_policy WHERE account_id = c_acct) THEN
    failed := array_append(failed, ('account deletion: ' || r)::text);
  END IF;

  -- ---------------------------------------------------------------
  -- The AI reply slot re-checks who owns the thread
  -- ---------------------------------------------------------------

  INSERT INTO conversations (account_id, user_id, contact_id, ai_reply_count)
       VALUES (a_acct, u_owner, c1, 0) RETURNING id INTO conv1;
  UPDATE conversations SET ai_autoreply_disabled = true WHERE id = conv1;
  n := n + 1;
  IF claim_ai_reply_slot(conv1, 5) THEN failed := array_append(failed, ('slot claimed on a handed-off thread')::text); END IF;
  UPDATE conversations SET ai_autoreply_disabled = false, assigned_agent_id = u_agent1 WHERE id = conv1;
  n := n + 1;
  IF claim_ai_reply_slot(conv1, 5) THEN failed := array_append(failed, ('slot claimed on an assigned thread')::text); END IF;
  UPDATE conversations SET assigned_agent_id = NULL WHERE id = conv1;
  n := n + 1;
  -- Two statements: in one expression the count would be read from a
  -- snapshot taken before the claim's UPDATE.
  ok := claim_ai_reply_slot(conv1, 5);
  IF NOT ok OR (SELECT ai_reply_count FROM conversations WHERE id = conv1) <> 1 THEN
    failed := array_append(failed, ('slot not claimed on a bot-owned thread')::text);
  END IF;

  -- ---------------------------------------------------------------
  -- Hand-off reasons
  -- ---------------------------------------------------------------

  n := n + 1;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname = 'conversations_ai_handoff_reason_check') NOT LIKE '%''guardrail''%' THEN
    failed := array_append(failed, ('handoff-reason CHECK not widened')::text);
  END IF;

  -- ---------------------------------------------------------------
  -- 064: per-account switches (ts_account_settings)
  -- ---------------------------------------------------------------

  n := n + 1;
  r := pg_temp.try_as('authenticated', u_admin, format(
    $q$INSERT INTO ts_account_settings (account_id, enabled, mode, languages, updated_by)
       VALUES (%L, true, 'live', 'all', %L)$q$, a_acct, u_owner));
  IF r <> 'ok' THEN failed := array_append(failed, ('admin cannot save switches: ' || r)::text); END IF;

  n := n + 1;
  IF (SELECT updated_by FROM ts_account_settings WHERE account_id = a_acct) IS DISTINCT FROM u_admin THEN
    failed := array_append(failed, ('updated_by not stamped from auth.uid()')::text);
  END IF;

  n := n + 1;
  IF pg_temp.value_as('authenticated', u_admin, format(
       $q$SELECT mode FROM ts_account_settings WHERE account_id = %L$q$, a_acct)) IS DISTINCT FROM 'live' THEN
    failed := array_append(failed, ('admin cannot read own switches')::text);
  END IF;

  n := n + 1;
  r := pg_temp.try_as('authenticated', u_admin, format(
    $q$UPDATE ts_account_settings SET mode = 'monitor' WHERE account_id = %L$q$, a_acct));
  IF r <> 'ok' OR (SELECT mode FROM ts_account_settings WHERE account_id = a_acct) <> 'monitor' THEN
    failed := array_append(failed, ('admin cannot update switches: ' || r)::text);
  END IF;

  n := n + 1;
  IF pg_temp.value_as('authenticated', u_agent1, format(
       $q$SELECT count(*)::text FROM ts_account_settings WHERE account_id = %L$q$, a_acct)) IS DISTINCT FROM '0' THEN
    failed := array_append(failed, ('an agent can read the switches')::text);
  END IF;

  n := n + 1;
  r := pg_temp.try_as('authenticated', u_agent1, format(
    $q$UPDATE ts_account_settings SET enabled = false WHERE account_id = %L$q$, a_acct));
  IF NOT (SELECT enabled FROM ts_account_settings WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('an agent switched the layer off')::text);
  END IF;

  n := n + 1;
  r := pg_temp.try_as('authenticated', u_other, format(
    $q$INSERT INTO ts_account_settings (account_id, enabled) VALUES (%L, false)
       ON CONFLICT (account_id) DO UPDATE SET enabled = false$q$, a_acct));
  IF r = 'ok' OR NOT (SELECT enabled FROM ts_account_settings WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('another account''s owner wrote the switches')::text);
  END IF;

  n := n + 1;
  r := pg_temp.try_as('authenticated', u_admin, format(
    $q$UPDATE ts_account_settings SET mode = 'shadow' WHERE account_id = %L$q$, a_acct));
  IF r = 'ok' THEN failed := array_append(failed, ('mode accepts an unknown value')::text); END IF;

  n := n + 1;
  r := pg_temp.try_as('authenticated', u_admin, format(
    $q$DELETE FROM ts_account_settings WHERE account_id = %L$q$, a_acct));
  IF NOT EXISTS (SELECT 1 FROM ts_account_settings WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('an admin deleted the switches row')::text);
  END IF;

  n := n + 1;
  IF pg_temp.value_as('service_role', NULL, format(
       $q$SELECT enabled::text FROM ts_account_settings WHERE account_id = %L$q$, a_acct)) IS DISTINCT FROM 'true' THEN
    failed := array_append(failed, ('service_role cannot read the switches')::text);
  END IF;

  n := n + 1;
  r := pg_temp.try_as('service_role', NULL, format(
    $q$UPDATE ts_account_settings SET enabled = false WHERE account_id = %L$q$, a_acct));
  IF r = 'ok' THEN failed := array_append(failed, ('service_role can write the switches')::text); END IF;

  n := n + 1;
  r := pg_temp.try_as('anon', NULL, $q$SELECT count(*) FROM ts_account_settings$q$);
  IF r = 'ok' THEN failed := array_append(failed, ('anon can read the switches')::text); END IF;

  -- The activity summary (064): one row, the caller's account only.
  INSERT INTO ts_decision_log (account_id, check_name, question_set_version, decision, reason_codes, acted, shadow, fallback_used, input_tokens, latency_ms)
  VALUES
    (b_acct, 'triage',    'qs-013-v0.2', 'opted_out', '{OPT_OUT_RECORD}',       true,  false, false, 1000000, 100),
    (b_acct, 'triage',    'qs-013-v0.2', 'opted_out', '{WATCH,OPT_OUT_RECORD}', true,  false, false, NULL,    200),
    (b_acct, 'triage',    'qs-013-v0.2', 'bot',       '{}',                     true,  false, false, NULL,    300),
    (b_acct, 'triage',    'qs-013-v0.2', 'rm',        '{WATCH,HUMAN_REQUEST}',  false, true,  false, NULL,    400),
    (b_acct, 'guardrail', 'qs-013-v0.2', 'hold',      '{}',                     true,  false, false, NULL,    500),
    (b_acct, 'guardrail', 'qs-013-v0.2', 'block',     '{}',                     true,  false, false, NULL,    600),
    (b_acct, 'guardrail', 'qs-013-v0.2', 'send',      '{}',                     true,  false, false, NULL,    700),
    (b_acct, 'passages',  'qs-013-v0.2', 'include=2;conflict=1;drop=3', '{}',   true,  false, false, NULL,    800),
    (b_acct, 'passages',  'qs-013-v0.2', 'include=4;conflict=0;drop=0', '{}',   true,  false, false, NULL,    900),
    (b_acct, 'triage',    'qs-013-v0.2', 'host_default', '{FALLBACK}',          false, true,  true,  NULL,    NULL);

  n := n + 1;
  IF (SELECT count(*) FROM ts_decision_log WHERE account_id = b_acct AND intervened) <> 5 THEN
    failed := array_append(failed, ('intervened: expected 5 interventions, got '
      || (SELECT count(*) FROM ts_decision_log WHERE account_id = b_acct AND intervened))::text);
  END IF;

  n := n + 1;
  r := pg_temp.value_as('authenticated', u_other, $q$
    SELECT concat_ws('/', decisions, interventions, triage_handoffs, opt_outs, replies_held,
                     replies_blocked, passages_dropped, fallbacks, round(est_usd, 3),
                     p95_latency_ms, (last_decision_at IS NOT NULL))
    FROM ts_activity_summary(now() - interval '1 day')$q$);
  -- b_acct also holds two rows from the log section above (a guardrail
  -- 'send' and a triage 'bot', neither acted).
  IF r IS DISTINCT FROM '12/5/1/2/1/1/3/1/0.042/860/t' THEN
    failed := array_append(failed, ('activity summary: ' || coalesce(r, 'null'))::text);
  END IF;

  n := n + 1;
  r := pg_temp.try_sql(format(
    $q$INSERT INTO ts_decision_log (account_id, check_name, question_set_version, decision, acted, shadow, intervened)
       VALUES (%L, 'triage', 'qs-013-v0.2', 'bot', false, true, true)$q$, b_acct));
  IF r = 'ok' THEN failed := array_append(failed, ('intervened is writable')::text); END IF;

  n := n + 1;
  r := pg_temp.value_as('authenticated', u_admin, $q$
    SELECT concat_ws('/', passages_dropped, opt_outs) FROM ts_activity_summary(now() - interval '1 day')$q$);
  IF r IS DISTINCT FROM '0/0' THEN
    failed := array_append(failed, ('activity summary crosses accounts: ' || coalesce(r, 'null'))::text);
  END IF;

  n := n + 1;
  r := pg_temp.try_as('anon', NULL, $q$SELECT * FROM ts_activity_summary(now())$q$);
  IF r = 'ok' THEN failed := array_append(failed, ('anon can run the activity summary')::text); END IF;

  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ts_decision_log_message_idx') THEN
    failed := array_append(failed, ('ts_decision_log_message_idx missing')::text);
  END IF;

  RAISE NOTICE 'typesafe decision layer: % assertions, % failed', n, cardinality(failed);
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'typesafe: % of % assertion(s) failed: %', cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
END $verify$;
