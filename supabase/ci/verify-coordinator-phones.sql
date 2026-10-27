-- Behavioural regression suite for coordinators' WhatsApp numbers
-- (migration 142).
--
-- Only an owner / admin sets a number, only for a live agent or team
-- leader of their active account, only 5-25 digits (the RPC and the
-- table's CHECK both refuse anything else); a blank or NULL number
-- clears it; an upsert replaces it. Owners and admins read the table,
-- an agent reads nothing.
--
-- Submission groups (also 142): sg_bank_coordinators lists a bank's
-- live agent / team_leader coordinators with their number or NULL, for
-- the service role only; submission_groups.coordinator_phones holds at
-- most 5 numbers of 5-25 digits, is stored by sg_open and is fixed once
-- the row exists.
--
-- ONE statement on purpose, as verify-coordinators.sql: the fixtures
-- are rolled back by a sentinel exception and the collected results
-- survive. A writing RPC's result is assigned first and its effect
-- read in a later statement.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000142001';
  u_admin  UUID := '00000000-0000-4000-8000-000000142002';
  u_agent  UUID := '00000000-0000-4000-8000-000000142003';
  u_lead   UUID := '00000000-0000-4000-8000-000000142004';
  u_viewer UUID := '00000000-0000-4000-8000-000000142005';
  u_guest  UUID := '00000000-0000-4000-8000-000000142006';
  u_away   UUID := '00000000-0000-4000-8000-000000142007';  -- owner of another account
  u_lead2  UUID := '00000000-0000-4000-8000-000000142008';
  u_off    UUID := '00000000-0000-4000-8000-000000142009';  -- deactivated agent
  u_enbd   UUID := '00000000-0000-4000-8000-000000142010';  -- another bank's coordinator
  c1       UUID;
  g1       UUID;
  g2       UUID;
  k1       UUID;
  a_acct   UUID;
  q_phone  TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cp_try(p_role text, p_uid uuid, p_sql text)
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
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cp_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cp_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cp_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'ci-cp-owner@example.invalid'),
    (u_admin,  'ci-cp-admin@example.invalid'),
    (u_agent,  'ci-cp-agent@example.invalid'),
    (u_lead,   'ci-cp-lead@example.invalid'),
    (u_viewer, 'ci-cp-viewer@example.invalid'),
    (u_guest,  'ci-cp-guest@example.invalid'),
    (u_away,   'ci-cp-away@example.invalid'),
    (u_lead2,  'ci-cp-lead2@example.invalid'),
    (u_off,    'ci-cp-off@example.invalid'),
    (u_enbd,   'ci-cp-enbd@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead2;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_off, u_enbd);
  -- u_away keeps the account its own sign-up provisioned.

  q_phone := 'SELECT coalesce(string_agg(phone, '','' ORDER BY phone), ''none'') FROM coordinator_phones WHERE user_id = %L';

  -- ---------- 1. refused callers and targets ----------
  n := n + 1; failed := failed || pg_temp.cp_check('an agent could set a coordinator number',
    'authenticated', u_agent, format('SELECT set_coordinator_phone(%L, ''971501420001'')', u_agent), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cp_check('a team leader could set a coordinator number',
    'authenticated', u_lead, format('SELECT set_coordinator_phone(%L, ''971501420001'')', u_agent), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cp_check('anon could set a coordinator number',
    'anon', NULL, format('SELECT set_coordinator_phone(%L, ''971501420001'')', u_agent), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cp_check('a viewer was given a coordinator number',
    'authenticated', u_admin, format('SELECT set_coordinator_phone(%L, ''971501420001'')', u_viewer),
    'ERROR 22023 not_eligible:%');
  n := n + 1; failed := failed || pg_temp.cp_check('a bank guest was given a coordinator number',
    'authenticated', u_admin, format('SELECT set_coordinator_phone(%L, ''971501420001'')', u_guest),
    'ERROR 22023 not_eligible:%');
  n := n + 1; failed := failed || pg_temp.cp_check('another account''s person was given a coordinator number',
    'authenticated', u_admin, format('SELECT set_coordinator_phone(%L, ''971501420001'')', u_away),
    'ERROR 22023 not_eligible:%');
  n := n + 1; failed := failed || pg_temp.cp_check('an admin could be given a coordinator number',
    'authenticated', u_owner, format('SELECT set_coordinator_phone(%L, ''971501420001'')', u_admin),
    'ERROR 22023 not_eligible:%');
  n := n + 1; failed := failed || pg_temp.cp_check('the RPC accepted a number that is not 5-25 digits',
    'authenticated', u_admin, format('SELECT set_coordinator_phone(%L, ''+971 50 142 0001'')', u_agent),
    'ERROR 22023 invalid_phone:%');
  n := n + 1; failed := failed || pg_temp.cp_check('the table accepted a number that is not 5-25 digits',
    NULL, NULL, format('INSERT INTO coordinator_phones (account_id, user_id, phone) VALUES (%L, %L, ''1234'')',
      a_acct, u_agent), 'ERROR 23514 %');
  n := n + 1; failed := failed || pg_temp.cp_check('a refused call stored a number',
    NULL, NULL, 'SELECT count(*)::text FROM coordinator_phones WHERE user_id IN ('
      || quote_literal(u_agent) || ', ' || quote_literal(u_viewer) || ', ' || quote_literal(u_guest) || ', '
      || quote_literal(u_away) || ', ' || quote_literal(u_admin) || ')', '0');

  -- ---------- 2. set, replace, clear ----------
  r := pg_temp.cp_try('authenticated', u_admin, format('SELECT set_coordinator_phone(%L, ''971501420001'')', u_agent));
  n := n + 1; failed := failed || pg_temp.cp_ok(r = '971501420001', format('the admin could not set the agent''s number (%s)', r));
  n := n + 1; failed := failed || pg_temp.cp_check('the agent''s number was not stored',
    NULL, NULL, format(q_phone, u_agent), '971501420001');
  r := pg_temp.cp_try('authenticated', u_owner, format('SELECT set_coordinator_phone(%L, ''971501420002'')', u_lead));
  n := n + 1; failed := failed || pg_temp.cp_ok(r = '971501420002', format('the owner could not set the team leader''s number (%s)', r));
  r := pg_temp.cp_try('authenticated', u_admin, format('SELECT set_coordinator_phone(%L, ''971501420009'')', u_agent));
  n := n + 1; failed := failed || pg_temp.cp_ok(r = '971501420009', format('the admin could not replace the number (%s)', r));
  n := n + 1; failed := failed || pg_temp.cp_check('replacing the number did not leave one row with the new number',
    NULL, NULL, format(q_phone, u_agent), '971501420009');
  n := n + 1; failed := failed || pg_temp.cp_check('the row does not name its writer',
    NULL, NULL, format('SELECT updated_by::text FROM coordinator_phones WHERE user_id = %L', u_agent), u_admin::text);

  -- ---------- 3. who reads ----------
  n := n + 1; failed := failed || pg_temp.cp_check('an admin cannot read the numbers',
    'authenticated', u_admin, format('SELECT count(*)::text FROM coordinator_phones WHERE account_id = %L', a_acct), '2');
  n := n + 1; failed := failed || pg_temp.cp_check('an agent can read the numbers',
    'authenticated', u_agent, 'SELECT count(*)::text FROM coordinator_phones', '0');
  n := n + 1; failed := failed || pg_temp.cp_check('a team leader can read the numbers',
    'authenticated', u_lead, 'SELECT count(*)::text FROM coordinator_phones', '0');
  n := n + 1; failed := failed || pg_temp.cp_check('another account''s owner can read the numbers',
    'authenticated', u_away, 'SELECT count(*)::text FROM coordinator_phones', '0');
  n := n + 1; failed := failed || pg_temp.cp_check('an admin could write the table directly',
    'authenticated', u_admin, format('UPDATE coordinator_phones SET phone = ''971500000000'' WHERE user_id = %L', u_agent),
    'ERROR 42501 %');

  -- ---------- 4. clearing ----------
  r := pg_temp.cp_try('authenticated', u_admin, format('SELECT coalesce(set_coordinator_phone(%L, E'' \t\n''), ''null'')', u_agent));
  n := n + 1; failed := failed || pg_temp.cp_ok(r = 'null', format('a blank number did not clear (%s)', r));
  n := n + 1; failed := failed || pg_temp.cp_check('a blank number left the row',
    NULL, NULL, format(q_phone, u_agent), 'none');
  -- A person demoted since keeps the row until it is cleared; clearing
  -- needs no eligibility.
  UPDATE profiles SET account_role = 'viewer' WHERE user_id = u_lead;
  r := pg_temp.cp_try('authenticated', u_admin, format('SELECT coalesce(set_coordinator_phone(%L, NULL), ''null'')', u_lead));
  n := n + 1; failed := failed || pg_temp.cp_ok(r = 'null', format('a NULL number did not clear a demoted person''s row (%s)', r));
  n := n + 1; failed := failed || pg_temp.cp_check('a NULL number left the row',
    NULL, NULL, format(q_phone, u_lead), 'none');

  -- ---------- 5. a bank's coordinators (sg_bank_coordinators) ----------
  -- Here u_agent has no number (cleared above) and u_lead is a viewer.
  r := pg_temp.cp_try('authenticated', u_admin, format('SELECT set_coordinator_phone(%L, ''971501420011'')', u_agent));
  n := n + 1; failed := failed || pg_temp.cp_ok(r = '971501420011', format('fixture: agent number (%s)', r));
  r := pg_temp.cp_try('authenticated', u_admin, format('SELECT set_coordinator_phone(%L, ''971501420012'')', u_off));
  n := n + 1; failed := failed || pg_temp.cp_ok(r = '971501420012', format('fixture: deactivated agent number (%s)', r));
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_off;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ADCB', 'ADCB Bank'), (a_acct, 'ENBD', 'Emirates NBD')
    ON CONFLICT DO NOTHING;
  -- Direct rows: 133 keeps a row for a person deactivated or demoted since.
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES
    (a_acct, u_agent, 'ADCB'), (a_acct, u_lead2, 'ADCB'), (a_acct, u_lead, 'ADCB'),
    (a_acct, u_off, 'ADCB'), (a_acct, u_admin, 'ADCB'), (a_acct, u_enbd, 'ENBD');
  n := n + 1; failed := failed || pg_temp.cp_check(
    'sg_bank_coordinators did not return exactly the bank''s live agent / team leader coordinators with their numbers',
    NULL, NULL, format('SELECT coalesce(string_agg(x.user_id::text || '':'' || coalesce(x.phone, ''null''), '','' ORDER BY x.user_id), ''none'') FROM sg_bank_coordinators(%L, ''ADCB'') x', a_acct),
    format('%s:971501420011,%s:null', u_agent, u_lead2));
  n := n + 1; failed := failed || pg_temp.cp_check('sg_bank_coordinators did not order by user id',
    NULL, NULL, format('SELECT string_agg(x.user_id::text, '','') FROM sg_bank_coordinators(%L, ''ADCB'') x', a_acct),
    format('%s,%s', u_agent, u_lead2));
  n := n + 1; failed := failed || pg_temp.cp_check('sg_bank_coordinators crossed into another account',
    NULL, NULL, format('SELECT count(*)::text FROM sg_bank_coordinators(%L, ''ADCB'')',
      (SELECT account_id FROM profiles WHERE user_id = u_away)), '0');
  n := n + 1; failed := failed || pg_temp.cp_ok(
    NOT has_function_privilege('authenticated', 'public.sg_bank_coordinators(uuid,text)', 'EXECUTE'),
    'authenticated may execute sg_bank_coordinators');
  n := n + 1; failed := failed || pg_temp.cp_ok(
    NOT has_function_privilege('anon', 'public.sg_bank_coordinators(uuid,text)', 'EXECUTE'),
    'anon may execute sg_bank_coordinators');
  n := n + 1; failed := failed || pg_temp.cp_ok(
    has_function_privilege('service_role', 'public.sg_bank_coordinators(uuid,text)', 'EXECUTE'),
    'service_role may not execute sg_bank_coordinators');

  -- ---------- 6. submission_groups.coordinator_phones ----------
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500142001', 'CP customer')
    RETURNING id INTO c1;
  -- Assigned first: a subquery in the same expression would read the
  -- snapshot taken before the call.
  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CN-142-1', c1, NULL, 'one', NULL, '[]', NULL, 'none', NULL,
    p_coordinator_phones => ARRAY['971501420011', '971501420013']) x);
  g2 := (SELECT x.group_id FROM sg_open(a_acct, 'CN-142-2', c1, NULL, 'two', NULL, '[]', NULL, 'none') x);
  IF g1 IS NULL OR g2 IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group'; END IF;
  n := n + 1; failed := failed || pg_temp.cp_ok(
    (SELECT coordinator_phones FROM submission_groups WHERE id = g1) = ARRAY['971501420011', '971501420013'],
    'sg_open did not store p_coordinator_phones');
  n := n + 1; failed := failed || pg_temp.cp_ok(
    (SELECT coordinator_phones FROM submission_groups WHERE id = g2) = '{}'::text[],
    'sg_open without p_coordinator_phones did not store an empty list');
  k1 := (SELECT x.group_id FROM sg_open(a_acct, 'CN-142-1', c1, NULL, 'one', NULL, '[]', NULL, 'none', NULL,
    p_coordinator_phones => ARRAY['971501420099']) x);
  n := n + 1; failed := failed || pg_temp.cp_ok(
    k1 = g1 AND (SELECT coordinator_phones FROM submission_groups WHERE id = g1) = ARRAY['971501420011', '971501420013'],
    'a repeat sg_open changed the existing row''s coordinator numbers');
  n := n + 1; failed := failed || pg_temp.cp_check('five coordinator numbers were refused',
    NULL, NULL, format('SELECT (x.group_id IS NOT NULL)::text FROM sg_open(%L, ''CN-142-3'', %L, NULL, ''three'', NULL, ''[]'', NULL, ''none'', NULL, ARRAY[''97150142001'',''97150142002'',''97150142003'',''97150142004'',''97150142005'']) x', a_acct, c1),
    'true');
  n := n + 1; failed := failed || pg_temp.cp_check('six coordinator numbers were accepted',
    NULL, NULL, format('SELECT x.group_id::text FROM sg_open(%L, ''CN-142-4'', %L, NULL, ''four'', NULL, ''[]'', NULL, ''none'', NULL, ARRAY[''97150142001'',''97150142002'',''97150142003'',''97150142004'',''97150142005'',''97150142006'']) x', a_acct, c1),
    'ERROR 23514 %');
  n := n + 1; failed := failed || pg_temp.cp_check('a coordinator number that is not 5-25 digits was accepted',
    NULL, NULL, format('SELECT x.group_id::text FROM sg_open(%L, ''CN-142-5'', %L, NULL, ''five'', NULL, ''[]'', NULL, ''none'', NULL, ARRAY[''971501420011'', ''+971501420012'']) x', a_acct, c1),
    'ERROR 23514 %');
  n := n + 1; failed := failed || pg_temp.cp_check('a NULL coordinator number was accepted',
    NULL, NULL, format('SELECT x.group_id::text FROM sg_open(%L, ''CN-142-6'', %L, NULL, ''six'', NULL, ''[]'', NULL, ''none'', NULL, ARRAY[''971501420011'', NULL]) x', a_acct, c1),
    'ERROR 23514 %');
  n := n + 1; failed := failed || pg_temp.cp_check('a coordinator number holding a comma was accepted',
    NULL, NULL, format('SELECT x.group_id::text FROM sg_open(%L, ''CN-142-7'', %L, NULL, ''seven'', NULL, ''[]'', NULL, ''none'', NULL, ARRAY[''97150142001,97150142002'']) x', a_acct, c1),
    'ERROR 23514 %');
  n := n + 1; failed := failed || pg_temp.cp_check('an empty coordinator number was accepted',
    NULL, NULL, format('SELECT x.group_id::text FROM sg_open(%L, ''CN-142-8'', %L, NULL, ''eight'', NULL, ''[]'', NULL, ''none'', NULL, ARRAY['''']) x', a_acct, c1),
    'ERROR 23514 %');
  n := n + 1; failed := failed || pg_temp.cp_ok(
    (SELECT status FROM submission_groups WHERE id = g1)::text = 'ACTIVE', 'fixture: the group is not ACTIVE');
  n := n + 1; failed := failed || pg_temp.cp_check('the guard let an ACTIVE group''s coordinator numbers change',
    NULL, NULL, format('UPDATE submission_groups SET coordinator_phones = ''{971501420099}'' WHERE id = %L', g1),
    'ERROR 42501 %coordinator_phones%');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT142', MESSAGE = 'verify-coordinator-phones rollback';
  EXCEPTION WHEN SQLSTATE 'ZT142' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'coordinator phones verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'coordinator phones verification passed (% checks)', n;
END
$verify$;
