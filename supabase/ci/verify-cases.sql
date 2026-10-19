-- Behavioural regression suite for Cases (migration 122).
--
-- One case per submission group, opened idempotently by case_open;
-- roles resolved live by case_role (owner -> super_admin, admin, a
-- team leader leading the agent's team -> team_lead, the named
-- coordinator, the named agent; nobody else); reads (case_can_read and
-- RLS in the caller's active workspace), writes (case_set_stage /
-- case_set_details) and reassigns follow the pure case_rule_* functions.
-- Stage lists per bank are validated at commit; final stages close the
-- case and the first final move alone takes the group-end claim, whose
-- value is the token release / finish need. view_case audits supervisor
-- views; only case_audit_list reads that audit. The history tables and
-- the audit are append-only for every writer, the owner included; no
-- API role writes a case table or reads the audit. A repeat case_open
-- (the v1 API) never fails over a bank it cannot fill.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000122001';
  u_admin  UUID := '00000000-0000-4000-8000-000000122002';
  u_lead   UUID := '00000000-0000-4000-8000-000000122003';  -- leads team T (u_agent, u_agent3)
  u_lead2  UUID := '00000000-0000-4000-8000-000000122004';  -- leads team T2 (u_agent2)
  u_coord  UUID := '00000000-0000-4000-8000-000000122005';  -- agent, coordinator on g1 / g3
  u_agent  UUID := '00000000-0000-4000-8000-000000122006';  -- agent, the agent of every case
  u_agent2 UUID := '00000000-0000-4000-8000-000000122007';
  u_agent3 UUID := '00000000-0000-4000-8000-000000122008';
  u_viewer UUID := '00000000-0000-4000-8000-000000122009';
  u_guest  UUID := '00000000-0000-4000-8000-000000122010';
  u_gone   UUID := '00000000-0000-4000-8000-000000122011';  -- agent, deactivated
  u_bown   UUID := '00000000-0000-4000-8000-000000122012';  -- owner of account B
  u_badmin UUID := '00000000-0000-4000-8000-000000122013';  -- admin of account B
  u_multi  UUID := '00000000-0000-4000-8000-000000122014';  -- active in its own account, agent in A
  a_acct   UUID;
  b_acct   UUID;
  w1       UUID;
  c1       UUID;
  team1    UUID;
  team2    UUID;
  g        UUID[] := '{}';
  k        UUID[] := '{}';
  acc      JSONB;
  i        INT;
  u        UUID;
  lbl      TEXT[];
  usr      UUID[];
  exp      TEXT[];
  b1       BOOLEAN;
  b2       BOOLEAN;
  t1       TIMESTAMPTZ;
  t2       TIMESTAMPTZ;
  t_old    TIMESTAMPTZ;
  st       TEXT;
  r        TEXT;
  rd       TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
  defaults TEXT[] := ARRAY['Submitted', 'Bank acknowledged', 'Documents requested', 'Documents received',
    'Under review', 'Query raised', 'Query answered', 'Approved', 'Declined', 'Withdrawn', 'Closed'];
  l1       TEXT[] := ARRAY['Received', 'In progress', 'Approved', 'Declined', 'Withdrawn', 'Closed'];
  l2       TEXT[] := ARRAY['Received', 'Assessing', 'Approved', 'Declined', 'Withdrawn', 'Closed'];
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

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cs-owner@example.invalid'),
    (u_admin,  'cs-admin@example.invalid'),
    (u_lead,   'cs-lead@example.invalid'),
    (u_lead2,  'cs-lead2@example.invalid'),
    (u_coord,  'cs-coord@example.invalid'),
    (u_agent,  'cs-agent@example.invalid'),
    (u_agent2, 'cs-agent2@example.invalid'),
    (u_agent3, 'cs-agent3@example.invalid'),
    (u_viewer, 'cs-viewer@example.invalid'),
    (u_guest,  'cs-guest@example.invalid'),
    (u_gone,   'cs-gone@example.invalid'),
    (u_bown,   'cs-bown@example.invalid'),
    (u_badmin, 'cs-badmin@example.invalid'),
    (u_multi,  'cs-multi@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id IN (u_lead, u_lead2);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_coord, u_agent, u_agent2, u_agent3, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  UPDATE profiles SET account_id = b_acct, account_role = 'admin' WHERE user_id = u_badmin;
  -- u_multi keeps its own account active and holds a second, inactive
  -- agent row in A.
  INSERT INTO profiles (user_id, account_id, account_role, full_name, email, is_active)
  VALUES (u_multi, a_acct, 'agent', 'CS multi', 'cs-multi@example.invalid', false);

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CS T', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct), (team1, u_agent3, a_acct);
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CS T2', u_lead2) RETURNING id INTO team2;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team2, u_agent2, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CS-122-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500122001', 'CS one')
    RETURNING id INTO c1;

  -- g1: coordinator u_coord + agent u_agent; g3: coordinator only (no
  -- agent); g4: coordinator u_lead (who leads u_agent) + agent u_agent;
  -- every other group: agent u_agent.
  FOR i IN 1 .. 11 LOOP
    acc := CASE i
      WHEN 1 THEN jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                                    jsonb_build_object('user_id', u_agent, 'label', 'agent'))
      WHEN 3 THEN jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'))
      WHEN 4 THEN jsonb_build_array(jsonb_build_object('user_id', u_lead, 'label', 'coordinator'),
                                    jsonb_build_object('user_id', u_agent, 'label', 'agent'))
      ELSE jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')) END;
    g[i] := (SELECT x.group_id FROM sg_open(a_acct, 'CS-122-' || i, c1, w1, 'case ' || i, NULL, acc, NULL) x);
    IF g[i] IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group %', i; END IF;
  END LOOP;
  -- Cases with no bank: k1, k4 .. k9 (k2, k10, k11 are opened by the checks).
  FOREACH i IN ARRAY ARRAY[1, 4, 5, 6, 7, 8, 9] LOOP
    k[i] := (SELECT x.case_id FROM case_open(g[i], NULL, NULL, NULL, NULL, NULL) x);
  END LOOP;

  -- ---------- case_open ----------
  r := pg_temp.cs_try('service_role', NULL, format(
    'SELECT case_id::text || '','' || created::text FROM case_open(%L, NULL, NULL, NULL, NULL, NULL)', g[2]));
  IF r LIKE 'ERROR%' THEN RAISE EXCEPTION 'fixture: service role case_open failed: %', r; END IF;
  k[2] := split_part(r, ',', 1)::uuid;
  n := n + 1; failed := failed || pg_temp.cs_ok(split_part(r, ',', 2) = 'true', 'the first case_open did not report created');
  n := n + 1; failed := failed || pg_temp.cs_check('a repeat case_open created or returned another case',
    'service_role', NULL, format('SELECT case_id::text || '','' || created::text FROM case_open(%L, NULL, NULL, NULL, NULL, NULL)', g[2]),
    k[2] || ',false');
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT count(*) FROM cases WHERE group_id = g[2]) = 1,
    'two case_open calls left more than one case');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_stage_history WHERE case_id = k[2] AND from_stage IS NULL AND to_stage = 'Submitted'
       AND actor_id IS NULL AND actor_role = 'api') = 1
    AND (SELECT count(*) FROM case_stage_history WHERE case_id = k[2]) = 1,
    'an API open did not record one initial history row (actor NULL, role api)');
  n := n + 1; failed := failed || pg_temp.cs_check('case_open of a group with no agent was not NO_AGENT',
    'service_role', NULL, format('SELECT created::text FROM case_open(%L, NULL, NULL, NULL, NULL, NULL)', g[3]),
    'ERROR 55000 NO_AGENT:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_open of an unknown group was not GROUP_NOT_FOUND',
    'service_role', NULL, format('SELECT created::text FROM case_open(%L, NULL, NULL, NULL, NULL, NULL)', gen_random_uuid()),
    'ERROR P0002 GROUP_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cs_check('an agent actor opened a case',
    'service_role', NULL, format('SELECT created::text FROM case_open(%L, NULL, NULL, NULL, NULL, %L)', g[11], u_agent),
    'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('another workspace''s admin opened a case',
    'service_role', NULL, format('SELECT created::text FROM case_open(%L, NULL, NULL, NULL, NULL, %L)', g[11], u_badmin),
    'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT EXISTS (SELECT 1 FROM cases WHERE group_id = g[11]),
    'a refused case_open left a case');
  r := pg_temp.cs_try('service_role', NULL, format(
    'SELECT case_id::text FROM case_open(%L, ''NEWBANK'', '' New Bank PJSC '', ''Card'', 50, NULL)', g[11]));
  IF r LIKE 'ERROR%' THEN RAISE EXCEPTION 'fixture: case_open with a new bank failed: %', r; END IF;
  k[11] := r::uuid;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT name FROM case_banks WHERE account_id = a_acct AND code = 'NEWBANK') = 'New Bank PJSC'
    AND (SELECT bank_code || '/' || product || '/' || amount || '/' || stage FROM cases WHERE id = k[11])
        = 'NEWBANK/Card/50.00/Submitted',
    'case_open with an unknown bank code did not add the bank (with its name) and open the case on it');

  -- A repeat call fills only the NULL fields, logs each fill, overwrites nothing.
  r := pg_temp.cs_try('service_role', NULL, format(
    'SELECT created::text FROM case_open(%L, ''NEWBANK'', NULL, ''Loan'', 1000, NULL)', g[2]));
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'false'
    AND (SELECT bank_code || '/' || product || '/' || amount FROM cases WHERE id = k[2]) = 'NEWBANK/Loan/1000.00'
    AND (SELECT count(*) FROM case_detail_log WHERE case_id = k[2] AND from_value IS NULL
           AND actor_id IS NULL AND actor_role = 'api'
           AND (field, to_value) IN (('bank_code', 'NEWBANK'), ('product', 'Loan'), ('amount', '1000.00'))) = 3
    AND (SELECT count(*) FROM case_detail_log WHERE case_id = k[2]) = 3,
    format('a repeat case_open did not fill the NULL bank / product / amount with one api log row each (%s)', r));
  r := pg_temp.cs_try('service_role', NULL, format(
    'SELECT created::text FROM case_open(%L, ''OTHERBK'', NULL, ''Card'', 5, NULL)', g[2]));
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'false'
    AND (SELECT bank_code || '/' || product || '/' || amount FROM cases WHERE id = k[2]) = 'NEWBANK/Loan/1000.00'
    AND (SELECT count(*) FROM case_detail_log WHERE case_id = k[2]) = 3,
    format('a repeat case_open overwrote a filled detail (%s)', r));

  -- ---------- roles ----------
  lbl := ARRAY['owner', 'admin', 'leader of the agent''s team', 'coordinator', 'agent', 'viewer', 'bank guest',
               'deactivated agent', 'another agent', 'leader of another team', 'another workspace''s admin',
               'another workspace''s owner', 'NULL user'];
  usr := ARRAY[u_owner, u_admin, u_lead, u_coord, u_agent, u_viewer, u_guest, u_gone, u_agent2, u_lead2, u_badmin,
               u_bown, NULL];
  exp := ARRAY['super_admin', 'admin', 'team_lead', 'coordinator', 'agent', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL];
  FOR i IN 1 .. array_length(lbl, 1) LOOP
    n := n + 1; failed := failed || pg_temp.cs_ok(
      case_role(k[1], usr[i]) IS NOT DISTINCT FROM exp[i]
      AND case_can_read(k[1], usr[i]) = (exp[i] IS NOT NULL)
      AND case_can_write(k[1], usr[i]) = (exp[i] IS NOT NULL),
      format('case role of the %s is %s, expected %s', lbl[i], coalesce(case_role(k[1], usr[i]), 'NULL'),
             coalesce(exp[i], 'NULL')));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(case_role(k[4], u_lead) = 'team_lead',
    'a team lead who is also the coordinator did not resolve as team_lead');

  -- ---------- stage moves: who ----------
  lbl := ARRAY['owner', 'admin', 'team lead', 'coordinator', 'agent'];
  usr := ARRAY[u_owner, u_admin, u_lead, u_coord, u_agent];
  exp := ARRAY['Bank acknowledged', 'Documents requested', 'Documents received', 'Under review', 'Query raised'];
  FOR i IN 1 .. 5 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s could not move the stage', lbl[i]),
      'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, %L)', k[1], usr[i], exp[i]), 'true');
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s could not set details', lbl[i]),
      'service_role', NULL, format('SELECT case_set_details(%L, %L, NULL, %L, NULL)::text', k[1], usr[i], 'P-' || lbl[i]),
      '{product}');
  END LOOP;
  lbl := ARRAY['viewer', 'another agent', 'leader of another team', 'another workspace''s admin', 'NULL actor'];
  usr := ARRAY[u_viewer, u_agent2, u_lead2, u_badmin, NULL];
  FOR i IN 1 .. 5 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s moved the stage', lbl[i]),
      'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Query answered'')', k[1], usr[i]),
      'ERROR 42501 NOT_ALLOWED:%');
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s set details', lbl[i]),
      'service_role', NULL, format('SELECT case_set_details(%L, %L, NULL, ''X'', NULL)::text', k[1], usr[i]),
      'ERROR 42501 NOT_ALLOWED:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT stage FROM cases WHERE id = k[1]) = 'Query raised'
    AND (SELECT count(*) FROM case_stage_history WHERE case_id = k[1]) = 6
    AND (SELECT closed_at FROM cases WHERE id = k[1]) IS NULL,
    'k1 is not at Query raised with 6 history rows and no closed_at');

  -- ---------- priority and due date ----------
  lbl := ARRAY['owner', 'admin', 'team lead', 'coordinator', 'agent'];
  usr := ARRAY[u_owner, u_admin, u_lead, u_coord, u_agent];
  exp := ARRAY['low', 'high', 'urgent', 'low', 'high'];
  FOR i IN 1 .. 5 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s could not set the priority', lbl[i]),
      'service_role', NULL, format('SELECT case_set_priority(%L, %L, %L)::text', k[1], usr[i], exp[i]), 'true');
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s could not set the due date', lbl[i]),
      'service_role', NULL, format('SELECT case_set_due(%L, %L, %L)::text', k[1], usr[i],
        '2031-01-0' || i || ' 09:00:00+00'), 'true');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_detail_log WHERE case_id = k[1] AND field = 'priority') = 5
    AND (SELECT count(*) FROM case_detail_log WHERE case_id = k[1] AND field = 'due_at') = 5
    AND (SELECT priority FROM cases WHERE id = k[1]) = 'high'
    AND (SELECT due_at FROM cases WHERE id = k[1]) = '2031-01-05 09:00:00+00',
    'priority / due changes did not write exactly one detail-log row each');
  lbl := ARRAY['viewer', 'another agent', 'NULL actor'];
  usr := ARRAY[u_viewer, u_agent2, NULL];
  FOR i IN 1 .. 3 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s set the priority (not NOT_ALLOWED)', lbl[i]),
      'service_role', NULL, format('SELECT case_set_priority(%L, %L, ''low'')::text', k[1], usr[i]),
      'ERROR 42501 NOT_ALLOWED:%');
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s set the due date (not NOT_ALLOWED)', lbl[i]),
      'service_role', NULL, format('SELECT case_set_due(%L, %L, now())::text', k[1], usr[i]),
      'ERROR 42501 NOT_ALLOWED:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('an unknown case was not CASE_NOT_FOUND for priority',
    'service_role', NULL, format('SELECT case_set_priority(%L, %L, ''low'')::text', gen_random_uuid(), u_admin),
    'ERROR P0002 CASE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cs_check('priority critical was not PRIORITY_INVALID',
    'service_role', NULL, format('SELECT case_set_priority(%L, %L, ''critical'')::text', k[1], u_admin),
    'ERROR 23514 PRIORITY_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a NULL priority was not PRIORITY_INVALID',
    'service_role', NULL, format('SELECT case_set_priority(%L, %L, NULL)::text', k[1], u_admin),
    'ERROR 23514 PRIORITY_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('an infinite due date was not DUE_INVALID',
    'service_role', NULL, format('SELECT case_set_due(%L, %L, ''infinity'')::text', k[1], u_admin),
    'ERROR 23514 DUE_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a -infinity due date was not DUE_INVALID',
    'service_role', NULL, format('SELECT case_set_due(%L, %L, ''-infinity'')::text', k[1], u_admin),
    'ERROR 23514 DUE_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a repeated priority was not a no-op',
    'service_role', NULL, format('SELECT case_set_priority(%L, %L, ''high'')::text', k[1], u_admin), 'false');
  n := n + 1; failed := failed || pg_temp.cs_check('a repeated due date was not a no-op',
    'service_role', NULL, format('SELECT case_set_due(%L, %L, %L)::text', k[1], u_admin, '2031-01-05 09:00:00+00'),
    'false');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_detail_log WHERE case_id = k[1] AND field IN ('priority', 'due_at')) = 10,
    'a refused or no-op priority / due call wrote a detail-log row');
  n := n + 1; failed := failed || pg_temp.cs_check('a NULL due date did not clear it',
    'service_role', NULL, format('SELECT case_set_due(%L, %L, NULL)::text', k[1], u_coord), 'true');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT due_at IS NULL FROM cases WHERE id = k[1])
    AND (SELECT count(*) FROM case_detail_log WHERE case_id = k[1] AND field = 'due_at'
           AND from_value = '2031-01-05T09:00:00.000000Z' AND to_value IS NULL
           AND actor_id = u_coord AND actor_role = 'coordinator') = 1,
    'clearing the due date did not log ISO from and NULL to with the coordinator');
  n := n + 1; failed := failed || pg_temp.cs_check('clearing an already-clear due date was not a no-op',
    'service_role', NULL, format('SELECT case_set_due(%L, %L, NULL)::text', k[1], u_admin), 'false');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_detail_log WHERE case_id = k[1] AND field = 'priority'
        AND from_value = 'low' AND to_value = 'high' AND actor_id = u_agent AND actor_role = 'agent') = 1
    AND (SELECT count(*) FROM case_detail_log WHERE case_id = k[1] AND field = 'priority'
        AND from_value = 'normal' AND to_value = 'low' AND actor_id = u_owner) = 1,
    'a priority log row has the wrong from / to / actor');
  n := n + 1; failed := failed || pg_temp.cs_check('a move to the current stage was not a no-op',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Query raised'')', k[1], u_agent), 'false');
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT count(*) FROM case_stage_history WHERE case_id = k[1]) = 6,
    'a no-op move wrote history');

  -- ---------- stage moves: what ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(case_stages_for_bank(a_acct, NULL) = defaults
    AND case_stages_for_bank(a_acct, 'NEWBANK') = defaults AND case_default_stages() = defaults,
    'a case with no bank, or a bank with no rows, does not use the default list');
  n := n + 1; failed := failed || pg_temp.cs_check('an unknown stage was not STAGE_NOT_CONFIGURED',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Nope'')', k[1], u_agent),
    'ERROR 23514 STAGE_NOT_CONFIGURED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a non-outcome was not OUTCOME_INVALID',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Approved'', ''Maybe'')', k[1], u_agent),
    'ERROR 23514 OUTCOME_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('an outcome at another stage was not OUTCOME_STAGE_MISMATCH',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Declined'', ''Approved'')', k[1], u_agent),
    'ERROR 23514 OUTCOME_STAGE_MISMATCH:%');
  n := n + 1; failed := failed || pg_temp.cs_check('an outcome at a non-final stage was not OUTCOME_STAGE_MISMATCH',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Under review'', ''Approved'')', k[1], u_agent),
    'ERROR 23514 OUTCOME_STAGE_MISMATCH:%');

  -- k8: first final move takes the claim; the second does not.
  SELECT x.moved, x.end_group, x.claim_token INTO b1, b2, t1
    FROM case_set_stage(k[8], u_agent, 'Approved', 'Approved') x;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND b2 AND t1 IS NOT NULL
    AND (SELECT stage || '/' || outcome FROM cases WHERE id = k[8]) = 'Approved/Approved'
    AND (SELECT closed_at IS NOT NULL AND group_end_claimed_at = t1 AND group_ended_at IS NULL FROM cases WHERE id = k[8]),
    'the first final move did not close the case, set the outcome and take the claim with its token');
  n := n + 1; failed := failed || pg_temp.cs_check('a final case moved to another outcome was not FINAL_STAGE',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Declined'')', k[8], u_agent),
    'ERROR 23514 FINAL_STAGE:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a final case moved back to an open stage was not FINAL_STAGE',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Under review'')', k[8], u_agent),
    'ERROR 23514 FINAL_STAGE:%');
  SELECT x.moved, x.end_group INTO b1, b2 FROM case_set_stage(k[8], u_agent, 'Closed') x;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND NOT b2
    AND (SELECT stage || '/' || outcome FROM cases WHERE id = k[8]) = 'Closed/Approved'
    AND (SELECT closed_at IS NOT NULL AND group_end_claimed_at = t1 FROM cases WHERE id = k[8]),
    'Approved -> Closed did not keep the outcome and claim, or reported end_group again');
  n := n + 1; failed := failed || pg_temp.cs_check('a Closed case was reopened (not CASE_CLOSED)',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Submitted'')', k[8], u_agent),
    'ERROR 23514 CASE_CLOSED:%');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT EXISTS (SELECT 1 FROM cases WHERE account_id = a_acct
      AND (closed_at IS NOT NULL) <> (stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed'))),
    'closed_at is not set exactly at the final stages');

  -- ---------- group-end claim tokens (k8) ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT case_release_group_end(k[8], t1 + interval '1 second') AND NOT case_release_group_end(k[8], NULL)
    AND NOT case_finish_group_end(k[8], t1 - interval '1 second') AND NOT case_finish_group_end(k[8], NULL),
    'release / finish with a wrong or NULL token acted');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT group_end_claimed_at = t1 AND group_ended_at IS NULL FROM cases WHERE id = k[8]),
    'release / finish with a wrong or NULL token changed the claim');
  SELECT x.state INTO st FROM case_claim_group_end_system(k[8]) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'CLAIM_HELD'
    AND NOT EXISTS (SELECT 1 FROM case_pending_group_end() x WHERE x.case_id = k[8]),
    format('a fresh claim was re-taken or listed as pending (%s)', st));
  t_old := t1 - interval '1 hour';
  UPDATE cases SET group_end_claimed_at = t_old WHERE id = k[8];
  n := n + 1; failed := failed || pg_temp.cs_ok(EXISTS (SELECT 1 FROM case_pending_group_end() x WHERE x.case_id = k[8]),
    'a stale claim is not listed by case_pending_group_end');
  n := n + 1; failed := failed || pg_temp.cs_check('a viewer re-took a group-end claim',
    'service_role', NULL, format('SELECT state FROM case_claim_group_end(%L, %L)', k[8], u_viewer),
    'ERROR 42501 NOT_ALLOWED:%');
  SELECT x.claimed, x.state, x.claim_token INTO b1, st, t2 FROM case_claim_group_end(k[8], u_agent) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND st = 'CLAIMED' AND t2 IS NOT NULL AND t2 <> t_old,
    format('case_claim_group_end did not re-take a stale claim (%s)', st));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT case_release_group_end(k[8], t_old) AND NOT case_finish_group_end(k[8], t_old),
    'the stale token released or finished after case_claim_group_end re-took the claim');
  t_old := t2 - interval '2 hours';
  UPDATE cases SET group_end_claimed_at = t_old WHERE id = k[8];
  SELECT x.claimed, x.state, x.claim_token INTO b1, st, t2 FROM case_claim_group_end_system(k[8]) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND st = 'CLAIMED' AND t2 IS NOT NULL,
    format('case_claim_group_end_system did not re-take a stale claim (%s)', st));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT case_release_group_end(k[8], t_old) AND NOT case_finish_group_end(k[8], t_old),
    'the stale token released or finished after case_claim_group_end_system re-took the claim');
  b1 := case_finish_group_end(k[8], t2);
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND (SELECT group_ended_at IS NOT NULL FROM cases WHERE id = k[8]),
    'finish with the right token did not set group_ended_at');
  b1 := case_release_group_end(k[8], t2);
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT b1
    AND (SELECT group_end_claimed_at = t2 AND group_ended_at IS NOT NULL FROM cases WHERE id = k[8])
    AND NOT EXISTS (SELECT 1 FROM case_pending_group_end(interval '0 seconds') x WHERE x.case_id = k[8]),
    'a finished end was released or is still pending');
  SELECT x.state INTO st FROM case_claim_group_end_system(k[8], interval '0 seconds') x;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'ALREADY_ENDED', format('an ended case was claimed again (%s)', st));
  SELECT x.state INTO st FROM case_claim_group_end_system(k[1]) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'NOT_FINAL', format('an open case was claimed (%s)', st));

  -- ---------- case_apply_submission_status ----------
  lbl := ARRAY['APPROVED', 'DECLINED', 'WITHDRAWN'];
  FOR i IN 1 .. 3 LOOP
    b1 := case_apply_submission_status(g[3 + i], lbl[i]);
    n := n + 1; failed := failed || pg_temp.cs_ok(b1
      AND (SELECT stage = initcap(lbl[i]) AND outcome = initcap(lbl[i]) AND closed_at IS NOT NULL
                  AND group_ended_at IS NOT NULL AND group_end_claimed_at IS NULL FROM cases WHERE id = k[3 + i])
      AND (SELECT actor_id IS NULL AND actor_role = 'api' AND to_stage = initcap(lbl[i])
             FROM case_stage_history WHERE case_id = k[3 + i] ORDER BY id DESC LIMIT 1),
      format('submission status %s did not close the case with its outcome and group_ended_at, claim-free', lbl[i]));
  END LOOP;
  b1 := case_apply_submission_status(g[7], 'PENDING');
  b2 := case_apply_submission_status(gen_random_uuid(), 'APPROVED');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT b1 AND NOT b2 AND NOT case_apply_submission_status(g[3], 'APPROVED')
    AND (SELECT stage = 'Submitted' AND closed_at IS NULL AND group_ended_at IS NULL FROM cases WHERE id = k[7]),
    'a non-final status, or a group with no case, was not a no-op');
  b1 := case_apply_submission_status(g[7], ' closed ');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1
    AND (SELECT stage = 'Closed' AND outcome IS NULL AND closed_at IS NOT NULL AND group_ended_at IS NOT NULL
                AND group_end_claimed_at IS NULL FROM cases WHERE id = k[7]),
    'submission status CLOSED did not close the case without an outcome');
  b1 := case_apply_submission_status(g[4], 'CLOSED');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT b1 AND (SELECT stage FROM cases WHERE id = k[4]) = 'Approved',
    'a submission status moved an already-final case');
  n := n + 1; failed := failed || pg_temp.cs_ok(NOT EXISTS (SELECT 1 FROM case_pending_group_end(interval '0 seconds') x
      WHERE x.case_id IN (k[4], k[5], k[6], k[7])),
    'a case ended by its submission status is listed as pending');

  -- ---------- reassign ----------
  lbl := ARRAY['coordinator', 'agent', 'viewer'];
  usr := ARRAY[u_coord, u_agent, u_viewer];
  FOR i IN 1 .. 3 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s reassigned', lbl[i]),
      'service_role', NULL, format('SELECT changed::text FROM case_reassign(%L, %L, ''agent'', %L)', k[1], usr[i], u_agent3),
      'ERROR 42501 NOT_ALLOWED:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('a team lead made agent someone outside their teams',
    'service_role', NULL, format('SELECT changed::text FROM case_reassign(%L, %L, ''agent'', %L)', k[1], u_lead, u_agent2),
    'ERROR 23514 ASSIGNEE_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a team lead could not make agent a member of their team',
    'service_role', NULL, format('SELECT changed::text FROM case_reassign(%L, %L, ''agent'', %L)', k[1], u_lead, u_agent3),
    'true');
  n := n + 1; failed := failed || pg_temp.cs_check('an admin could not reassign the agent',
    'service_role', NULL, format('SELECT changed::text FROM case_reassign(%L, %L, ''agent'', %L)', k[1], u_admin, u_agent),
    'true');
  lbl := ARRAY['viewer', 'bank guest', 'deactivated agent', 'another workspace''s admin', 'NULL user'];
  usr := ARRAY[u_viewer, u_guest, u_gone, u_badmin, NULL];
  FOR i IN 1 .. 5 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the owner made a %s coordinator', lbl[i]),
      'service_role', NULL, format('SELECT changed::text FROM case_reassign(%L, %L, ''coordinator'', %L)', k[1], u_owner, usr[i]),
      'ERROR 23514 ASSIGNEE_INVALID:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_reassign_history WHERE case_id = k[1]) = 2
    AND (SELECT count(*) FROM case_reassign_history WHERE case_id = k[1] AND field = 'agent'
           AND ((from_user, to_user, actor_id, actor_role) = (u_agent, u_agent3, u_lead, 'team_lead')
             OR (from_user, to_user, actor_id, actor_role) = (u_agent3, u_agent, u_admin, 'admin'))) = 2
    AND (SELECT agent_id FROM cases WHERE id = k[1]) = u_agent,
    'two reassigns did not leave exactly two matching history rows');
  n := n + 1; failed := failed || pg_temp.cs_check('the owner could not make a team leader the coordinator',
    'service_role', NULL, format('SELECT changed::text FROM case_reassign(%L, %L, ''coordinator'', %L)', k[2], u_owner, u_lead2),
    'true');
  n := n + 1; failed := failed || pg_temp.cs_ok(case_role(k[2], u_lead2) = 'coordinator',
    'a team leader named coordinator (not leading the agent) did not resolve as coordinator');

  -- ---------- details ----------
  n := n + 1; failed := failed || pg_temp.cs_check('case_set_details accepted an unknown bank',
    'service_role', NULL, format('SELECT case_set_details(%L, %L, ''ZZBANK'', NULL, NULL)::text', k[1], u_owner),
    'ERROR 23514 BANK_UNKNOWN:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_set_details did not report bank and amount',
    'service_role', NULL, format('SELECT case_set_details(%L, %L, ''NEWBANK'', ''P-agent'', 1234.5)::text', k[1], u_owner),
    '{bank_code,amount}');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_detail_log WHERE case_id = k[1] AND field IN ('bank_code', 'product', 'amount')) = 7
    AND (SELECT count(*) FROM case_detail_log WHERE case_id = k[1] AND field = 'amount' AND to_value = '1234.50'
           AND actor_id = u_owner AND actor_role = 'super_admin') = 1,
    'case_set_details did not log exactly one row per changed field');

  -- ---------- stage lists ----------
  n := n + 1; failed := failed || pg_temp.cs_check('an agent added a bank',
    'service_role', NULL, format('SELECT (case_bank_upsert(%L, %L, ''ADCB'', ''x'')).name', u_agent, a_acct),
    'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('another workspace''s admin added a bank',
    'service_role', NULL, format('SELECT (case_bank_upsert(%L, %L, ''ADCB'', ''x'')).name', u_badmin, a_acct),
    'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('the owner could not add a bank',
    'service_role', NULL, format('SELECT (case_bank_upsert(%L, %L, ''ADCB'', ''ADCB'')).name', u_owner, a_acct), 'ADCB');
  n := n + 1; failed := failed || pg_temp.cs_check('an admin could not rename a bank',
    'service_role', NULL, format('SELECT (case_bank_upsert(%L, %L, ''ADCB'', ''ADCB Bank'')).name', u_admin, a_acct),
    'ADCB Bank');
  PERFORM case_bank_upsert(u_owner, a_acct, 'FAB', 'FAB');
  n := n + 1; failed := failed || pg_temp.cs_check('an agent set a stage list',
    'service_role', NULL, format('SELECT case_bank_stages_set(%L, %L, ''ADCB'', %L)::text', u_agent, a_acct, l1),
    'ERROR 42501 NOT_ALLOWED:%');
  r := pg_temp.cs_stages(u_admin, a_acct, 'ADCB', l1);
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'ok:6' AND case_stages_for_bank(a_acct, 'ADCB') = l1,
    format('a valid stage list was refused or not stored (%s)', r));
  r := pg_temp.cs_stages(u_owner, a_acct, 'ADCB', l2);
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'ok:6' AND case_stages_for_bank(a_acct, 'ADCB') = l2
    AND (SELECT count(*) FROM case_bank_stages WHERE account_id = a_acct AND bank_code = 'ADCB') = 6,
    format('a second list did not replace the first exactly (%s)', r));
  r := pg_temp.cs_stages(u_admin, a_acct, 'ADCB', ARRAY['Approved', 'Received', 'Declined', 'Withdrawn', 'Closed']);
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'ERROR 23514 BANK_STAGES_FIRST_FINAL',
    format('a list starting with a final stage was not refused (%s)', r));
  r := pg_temp.cs_stages(u_admin, a_acct, 'ADCB', ARRAY['Received', 'Approved', 'Declined', 'Withdrawn']);
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'ERROR 23514 BANK_STAGES_MISSING_FINAL',
    format('a list missing Closed was not refused (%s)', r));
  r := pg_temp.cs_stages(u_admin, a_acct, 'ADCB', ARRAY['Received', 'Approved', 'Declined', 'withdrawn', 'Closed']);
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'ERROR 23514 BANK_STAGES_FINAL_SPELLING',
    format('a list misspelling Withdrawn was not refused (%s)', r));
  n := n + 1; failed := failed || pg_temp.cs_ok(case_stages_for_bank(a_acct, 'ADCB') = l2,
    'a refused list changed the stored one');
  r := pg_temp.cs_stages(u_admin, a_acct, 'FAB', l1);
  r := r || ',' || pg_temp.cs_stages(u_admin, a_acct, 'FAB', '{}');
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'ok:6,ok:0'
    AND case_stages_for_bank(a_acct, 'FAB') = defaults
    AND NOT EXISTS (SELECT 1 FROM case_bank_stages WHERE account_id = a_acct AND bank_code = 'FAB'),
    format('an empty list did not return the bank to the defaults (%s)', r));

  -- A repeat case_open (v1 API) whose bank lacks the case's stage: the
  -- bank is skipped, the other gaps are still filled, nothing fails.
  r := pg_temp.cs_try('service_role', NULL, format(
    'SELECT created::text FROM case_open(%L, ''ADCB'', NULL, ''Mortgage'', 500, NULL)', g[9]));
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'false'
    AND (SELECT bank_code IS NULL AND product = 'Mortgage' AND amount = 500 FROM cases WHERE id = k[9])
    AND (SELECT count(*) FROM case_detail_log WHERE case_id = k[9]) = 2
    AND NOT EXISTS (SELECT 1 FROM case_detail_log WHERE case_id = k[9] AND field = 'bank_code'),
    format('repeat case_open with a bank lacking the case''s stage failed or filled the bank (%s)', r));
  n := n + 1; failed := failed || pg_temp.cs_check('case_set_details accepted a bank lacking the case''s stage',
    'service_role', NULL, format('SELECT case_set_details(%L, %L, ''ADCB'', NULL, NULL)::text', k[9], u_owner),
    'ERROR 23514 STAGE_NOT_IN_LIST:%');

  -- k10 opens on ADCB (by an admin): its first stage, then STAGE_IN_USE.
  k[10] := (SELECT x.case_id FROM case_open(g[10], 'ADCB', NULL, NULL, NULL, u_admin) x);
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT stage FROM cases WHERE id = k[10]) = 'Received'
    AND (SELECT actor_id = u_admin AND actor_role = 'admin' FROM case_stage_history WHERE case_id = k[10]),
    'a case opened on a configured bank did not start at its first stage with the admin as actor');
  n := n + 1; failed := failed || pg_temp.cs_check('a stage outside the bank''s list was accepted',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Under review'')', k[10], u_agent),
    'ERROR 23514 STAGE_NOT_CONFIGURED:%');
  r := pg_temp.cs_stages(u_admin, a_acct, 'ADCB', ARRAY['Assessing', 'Approved', 'Declined', 'Withdrawn', 'Closed']);
  n := n + 1; failed := failed || pg_temp.cs_ok(r = 'ERROR 23514 STAGE_IN_USE' AND case_stages_for_bank(a_acct, 'ADCB') = l2,
    format('a list dropping an open case''s stage was not STAGE_IN_USE (%s)', r));

  -- ---------- view audit ----------
  usr := ARRAY[u_coord, u_lead, u_admin, u_owner];
  FOREACH u IN ARRAY usr LOOP
    SELECT array_agg(x) INTO rd FROM view_case(u, ARRAY[k[1], k[1], k[11]]) x;
  END LOOP;
  SELECT array_agg(x)::text INTO rd FROM view_case(u_agent, ARRAY[k[1]]) x;
  SELECT coalesce(array_agg(x)::text, '{}') INTO r FROM view_case(u_agent2, ARRAY[k[1]]) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_view_audit WHERE case_id = k[1]) = 4
    AND (SELECT array_agg(viewer_role ORDER BY id) FROM case_view_audit WHERE case_id = k[1])
        = ARRAY['coordinator', 'team_lead', 'admin', 'super_admin']
    AND (SELECT count(*) FROM case_view_audit WHERE case_id = k[11]) = 3  -- lead, admin, owner; not the coordinator
    AND rd = '{' || k[1] || '}' AND r = '{}',
    format('view_case did not write one row per readable supervisor view (agent %s, outsider %s)', rd, r));
  lbl := ARRAY['agent', 'coordinator', 'team lead', 'another workspace''s admin', 'NULL actor'];
  usr := ARRAY[u_agent, u_coord, u_lead, u_badmin, NULL];
  FOR i IN 1 .. 5 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s read the view audit', lbl[i]),
      'service_role', NULL, format('SELECT count(*)::text FROM case_audit_list(%L, %L)', usr[i], k[1]),
      'ERROR 42501 NOT_ALLOWED:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('the owner could not read the view audit',
    'service_role', NULL, format('SELECT count(*)::text FROM case_audit_list(%L, %L)', u_owner, k[1]), '4');
  -- One answer for an unknown case and another account's (no existence oracle).
  n := n + 1; failed := failed || pg_temp.cs_check('case_audit_list of an unknown case was not NOT_ALLOWED',
    'service_role', NULL, format('SELECT count(*)::text FROM case_audit_list(%L, %L)', u_owner, gen_random_uuid()),
    'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_audit_list limit 0 was not LIMIT_INVALID',
    'service_role', NULL, format('SELECT count(*)::text FROM case_audit_list(%L, %L, 0)', u_admin, k[1]),
    'ERROR 23514 LIMIT_INVALID:%');
  FOR i IN 1 .. 510 LOOP
    PERFORM view_case(u_admin, ARRAY[k[1]]);
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_audit_list(u_admin, k[1])) = 100
    AND (SELECT count(*) FROM case_audit_list(u_admin, k[1], 501)) = 500
    AND (SELECT count(*) FROM case_audit_list(u_admin, k[1], 2)) = 2,
    'case_audit_list limits are not 100 by default, at most 500');

  -- ---------- reads (RLS, active workspace) ----------
  PERFORM case_reassign(k[8], u_owner, 'coordinator', u_multi);
  lbl := ARRAY['owner', 'admin', 'team lead', 'coordinator', 'agent'];
  usr := ARRAY[u_owner, u_admin, u_lead, u_coord, u_agent];
  FOR i IN 1 .. 5 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s cannot read k1 and its history through RLS', lbl[i]),
      'authenticated', usr[i], format(
      'SELECT ((SELECT count(*) FROM cases WHERE id = %1$L) = 1
           AND (SELECT count(*) FROM case_stage_history WHERE case_id = %1$L) > 0
           AND (SELECT count(*) FROM case_reassign_history WHERE case_id = %1$L) > 0
           AND (SELECT count(*) FROM case_detail_log WHERE case_id = %1$L) > 0)::text', k[1]), 'true');
  END LOOP;
  lbl := ARRAY['viewer', 'bank guest', 'deactivated agent', 'another agent', 'leader of another team',
               'another workspace''s admin', 'another workspace''s owner'];
  usr := ARRAY[u_viewer, u_guest, u_gone, u_agent2, u_lead2, u_badmin, u_bown];
  FOR i IN 1 .. 7 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s reads k1 or its history through RLS', lbl[i]),
      'authenticated', usr[i], format(
      'SELECT ((SELECT count(*) FROM cases WHERE id = %1$L)
           + (SELECT count(*) FROM case_stage_history WHERE case_id = %1$L)
           + (SELECT count(*) FROM case_reassign_history WHERE case_id = %1$L)
           + (SELECT count(*) FROM case_detail_log WHERE case_id = %1$L))::text', k[1]), '0');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(case_can_read(k[8], u_multi), 'fixture: u_multi is not k8''s coordinator');
  n := n + 1; failed := failed || pg_temp.cs_check('a coordinator active in another workspace reads the case through RLS',
    'authenticated', u_multi, format(
    'SELECT ((SELECT count(*) FROM cases WHERE id = %1$L) + (SELECT count(*) FROM case_stage_history WHERE case_id = %1$L))::text',
    k[8]), '0');
  n := n + 1; failed := failed || pg_temp.cs_check('the agent sees cases of the account it has no role on',
    'authenticated', u_agent2, format('SELECT count(*)::text FROM cases WHERE account_id = %L', a_acct), '0');

  -- ---------- live: demotion and deactivation take effect at once ----------
  UPDATE profiles SET account_role = 'viewer' WHERE user_id = u_coord AND account_id = a_acct;
  UPDATE profiles SET account_role = 'agent' WHERE user_id = u_lead AND account_id = a_acct;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_agent AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    case_role(k[1], u_coord) IS NULL AND case_role(k[1], u_lead) IS NULL AND case_role(k[1], u_agent) IS NULL,
    'a demoted or deactivated person kept a case role');
  n := n + 1; failed := failed || pg_temp.cs_check('a demoted coordinator still moves the stage',
    'service_role', NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Query answered'')', k[1], u_coord),
    'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a deactivated agent still reads the case through RLS',
    'authenticated', u_agent, format('SELECT count(*)::text FROM cases WHERE id = %L', k[1]), '0');

  -- ---------- locks ----------
  lbl := ARRAY['service_role', 'authenticated', 'anon'];
  FOREACH r IN ARRAY lbl LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s read case_view_audit', r),
      r, u_owner, 'SELECT count(*)::text FROM case_view_audit', 'ERROR 42501%');
    n := n + 1; failed := failed || pg_temp.cs_ok(NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['case_banks', 'case_bank_stages', 'cases', 'case_stage_history',
                                 'case_reassign_history', 'case_detail_log', 'case_view_audit']) t
       WHERE has_table_privilege(r, 'public.' || t, 'INSERT') OR has_table_privilege(r, 'public.' || t, 'UPDATE')
          OR has_table_privilege(r, 'public.' || t, 'DELETE') OR has_table_privilege(r, 'public.' || t, 'TRUNCATE')),
      format('%s holds a write privilege on a case table', r));
  END LOOP;
  FOREACH r IN ARRAY ARRAY['case_stage_history', 'case_reassign_history', 'case_view_audit', 'case_detail_log'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s accepted UPDATE as the owner (append-only)', r),
      NULL, NULL, format('UPDATE public.%I SET account_id = account_id', r), 'ERROR 42501 %append-only%');
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s accepted DELETE as the owner (append-only)', r),
      NULL, NULL, format('DELETE FROM public.%I', r), 'ERROR 42501 %append-only%');
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s accepted TRUNCATE as the owner (append-only)', r),
      NULL, NULL, format('TRUNCATE public.%I', r), 'ERROR 42501 %append-only%');
  END LOOP;
  -- cases is referenced by the history tables, so a plain TRUNCATE stops
  -- at the foreign keys; CASCADE reaches the triggers, and cases has its own.
  n := n + 1; failed := failed || pg_temp.cs_check('cases accepted TRUNCATE CASCADE as the owner',
    NULL, NULL, 'TRUNCATE public.cases CASCADE', 'ERROR 42501 %append-only%');
  n := n + 1; failed := failed || pg_temp.cs_ok(EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'public.cases'::regclass AND tgenabled <> 'D' AND (tgtype & 32) <> 0
        AND tgfoid = 'public.case_append_only()'::regprocedure),
    'cases has no enabled TRUNCATE trigger');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM cases WHERE account_id = a_acct) = 10 AND (SELECT count(*) FROM case_view_audit) = 517,
    'an append-only probe removed rows');
  SELECT string_agg(p.proname, ',' ORDER BY p.proname) INTO r FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'case\_%' OR p.proname = 'view_case')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(r IS NULL, format('anon may execute case functions (%s)', r));
  SELECT string_agg(p.proname, ',' ORDER BY p.proname) INTO r FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'case\_%' OR p.proname = 'view_case')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    r = 'case_default_stages,case_rls_can_read,case_rule_can_read,case_rule_can_reassign,case_rule_can_write',
    format('authenticated may execute other case functions (%s)', r));

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT122', MESSAGE = 'verify-cases rollback';
  EXCEPTION WHEN SQLSTATE 'ZT122' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'cases verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'cases verification passed (% checks)', n;
END
$verify$;
