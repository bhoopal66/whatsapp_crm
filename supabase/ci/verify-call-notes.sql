-- ============================================================
-- Migration 294: after a transfer, everyone who answered a leg of a call
-- (calls.meta.answered_user_ids) may see it and write its note, in their
-- active account; nobody else gains anything, a leader of one of them
-- included. Leaves nothing behind (everything in one rolled-back block).
-- ============================================================
DO $verify$
DECLARE
  u_own uuid := gen_random_uuid();
  u_a uuid := gen_random_uuid();
  u_b uuid := gen_random_uuid();
  u_c uuid := gen_random_uuid();
  u_lead uuid := gen_random_uuid();
  u_view uuid := gen_random_uuid();
  u_x uuid := gen_random_uuid();
  a_acct uuid; a_x uuid; t_team uuid; k uuid; k_bad uuid; k_json text;
  failed text[] := '{}'; n int := 0; r text;
  what text; who uuid; want text; seen text;
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pcn_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
        RETURN st;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'pcn-own@example.invalid'), (u_a, 'pcn-a@example.invalid'),
    (u_b, 'pcn-b@example.invalid'), (u_c, 'pcn-c@example.invalid'),
    (u_lead, 'pcn-lead@example.invalid'), (u_view, 'pcn-view@example.invalid'),
    (u_x, 'pcn-x@example.invalid');
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_own;
  SELECT id INTO a_x FROM accounts WHERE owner_user_id = u_x;
  IF a_acct IS NULL OR a_x IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_a, u_b, u_c);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;
  INSERT INTO teams (account_id, name, leader_user_id)
  VALUES (a_acct, 'pcn-team', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_b, a_acct);

  -- An outbound call of A's, transferred to B (and, wrongly, to a
  -- viewer's and an outsider's id): nobody rang by an inbound leg.
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, meta)
  VALUES (a_acct, 'pcn-1', 'outbound', u_a, 'answered',
          jsonb_build_object('answered_user_ids', jsonb_build_array(u_a, u_b, u_view, u_x)))
  RETURNING id INTO k;
  -- A malformed list (an object) opens nothing.
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, meta)
  VALUES (a_acct, 'pcn-2', 'outbound', u_a, 'answered',
          jsonb_build_object('answered_user_ids', jsonb_build_object(u_b::text, true)))
  RETURNING id INTO k_bad;
  SELECT to_jsonb(c)::text INTO k_json FROM calls c WHERE c.id = k;

  FOR what, who, want, seen IN VALUES
    ('the call''s person', u_a, 'ok', '1'),
    ('the one it was transferred to', u_b, 'ok', '1'),
    ('a colleague who did not answer', u_c, 'P0002', '0'),
    ('the leader of one who answered', u_lead, 'P0002', '0'),
    ('a viewer in the list', u_view, '42501', '1'),
    ('another account''s person in the list', u_x, 'P0002', '0')
  LOOP
    r := pg_temp.pcn_try(who, format('SELECT pbx_set_disposition(%L, ''call_back'', ''pcn note'')', k));
    n := n + 1;
    IF r <> want THEN failed := array_append(failed, format('%s saves: %s, not %s', what, r, want)); END IF;
    r := pg_temp.pcn_try(who, format('SELECT count(*) FROM calls WHERE id = %L', k));
    n := n + 1;
    IF r <> seen THEN failed := array_append(failed, format('%s sees: %s, not %s', what, r, seen)); END IF;
    -- The policy and the one-call function agree.
    r := pg_temp.pcn_try(who, format(
      'SELECT pbx_can_view_call(jsonb_populate_record(NULL::calls, %L::jsonb))::text', k_json));
    n := n + 1;
    IF r IS DISTINCT FROM (seen = '1')::text THEN
      failed := array_append(failed, format('%s: pbx_can_view_call says %s', what, r));
    END IF;
  END LOOP;
  r := pg_temp.pcn_try(u_b, format('SELECT count(*) FROM calls WHERE id = %L', k_bad))
    || pg_temp.pcn_try(u_b, format('SELECT pbx_set_disposition(%L, NULL, ''x'')', k_bad));
  n := n + 1;
  IF r <> '0P0002' THEN failed := array_append(failed, ('a list that is an object opens the call: ' || r)::text); END IF;

  -- The list grants writing, so no session may write it.
  r := pg_temp.pcn_try(u_c, format(
    'UPDATE calls SET meta = jsonb_build_object(''answered_user_ids'', jsonb_build_array(%L)) WHERE id = %L RETURNING id', u_c, k));
  n := n + 1;
  IF (SELECT meta -> 'answered_user_ids' ? u_c::text FROM calls WHERE id = k)
     OR has_column_privilege('authenticated', 'public.calls', 'meta', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.calls', 'meta', 'INSERT') THEN
    failed := array_append(failed, ('a session can write calls.meta: ' || r)::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.pbx_answered_call(public.calls)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_set_disposition(uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_can_view_call(public.calls)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pbx_set_disposition(uuid, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pbx_can_view_call(public.calls)', 'EXECUTE') THEN
    failed := array_append(failed, 'function grants'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT294', MESSAGE = 'verify-call-notes rollback';
  EXCEPTION WHEN SQLSTATE 'ZT294' THEN
    NULL;
  END;
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'call notes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'call notes verification passed (% checks)', n;
END
$verify$;
