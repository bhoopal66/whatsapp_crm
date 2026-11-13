-- Behavioural regression suite for call reviewers (migration 198).
--
-- An owner or admin may let a person review every call of the
-- workspace (profiles.may_review_all_calls, written only through
-- set_member_call_review). A reviewer is treated like an admin for
-- calls: the calls / call_live policies and pbx_can_view_call go
-- through pbx_sees_all_calls(), the access-log guard lets them play and
-- download a playable recording, pbx_call_stats gives them the
-- workspace scope (calls with no person included) and pbx_call_report
-- admits them. Everyone else keeps 089/113's rules, the access log
-- stays admin-only to read, and nothing reaches another workspace.
-- This asserts each of those through the real RLS, triggers and RPCs.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000198001';
  u_admin  UUID := '00000000-0000-4000-8000-000000198002';
  u_lead   UUID := '00000000-0000-4000-8000-000000198003';  -- leads team T
  u_tm     UUID := '00000000-0000-4000-8000-000000198004';  -- agent in T
  u_ag     UUID := '00000000-0000-4000-8000-000000198005';  -- agent, no flag
  u_rev    UUID := '00000000-0000-4000-8000-000000198006';  -- agent, reviewer
  u_vrev   UUID := '00000000-0000-4000-8000-000000198007';  -- viewer, reviewer
  u_view   UUID := '00000000-0000-4000-8000-000000198008';  -- viewer, no flag
  u_guest  UUID := '00000000-0000-4000-8000-000000198009';  -- bank guest
  u_dead   UUID := '00000000-0000-4000-8000-000000198010';  -- deactivated
  u_out    UUID := '00000000-0000-4000-8000-000000198011';  -- workspace B
  a_acct   UUID;
  a_out    UUID;
  t_team   UUID;
  pc_a     UUID;
  k_ag     UUID;  -- u_ag's call, recording fetched and playable
  k_tm     UUID;  -- u_tm's call
  k_none   UUID;  -- a call with no person
  k_b      UUID;  -- workspace B's call
  j_tm     TEXT;
  j_b      TEXT;
  v_stats  TEXT;
  v_from   TEXT := quote_literal((now() - interval '1 day')::text);
  v_to     TEXT := quote_literal((now() + interval '1 hour')::text);
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: 'ok' / the value, or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');  -- a void RPC casts to ''
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                                m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
      END;
    END $body$
  $fn$;

  -- The same as the service role with no signed-in user: the playback
  -- route writes call_access_log this way.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_svc(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE st text; h text; m text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('role', 'service_role')::text, true);
        SET LOCAL ROLE service_role;
        EXECUTE p_sql;
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                                m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
      END;
    END $body$
  $fn$;

  -- Fixture: workspace A (u_owner's) and B (u_out's). The auth.users
  -- trigger provisions each person an account of their own; everyone
  -- but the two owners moves into A.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cr-owner@example.invalid'),
    (u_admin, 'cr-admin@example.invalid'),
    (u_lead,  'cr-lead@example.invalid'),
    (u_tm,    'cr-tm@example.invalid'),
    (u_ag,    'cr-ag@example.invalid'),
    (u_rev,   'cr-rev@example.invalid'),
    (u_vrev,  'cr-vrev@example.invalid'),
    (u_view,  'cr-view@example.invalid'),
    (u_guest, 'cr-guest@example.invalid'),
    (u_dead,  'cr-dead@example.invalid'),
    (u_out,   'cr-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_out FROM accounts WHERE owner_user_id = u_out;
  IF a_acct IS NULL OR a_out IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_tm, u_ag, u_rev, u_dead);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id IN (u_vrev, u_view);
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'CRTEST'
   WHERE user_id = u_guest;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_dead;

  INSERT INTO teams (account_id, name, leader_user_id)
  VALUES (a_acct, 'cr-team', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_tm, a_acct);

  INSERT INTO pbx_connections (account_id, label, edition, base_url, webhook_path_token)
  VALUES (a_acct, 'cr', 'cloud', 'https://pbx.example.invalid', 'cr-198-token-00000000000000000000000')
  RETURNING id INTO pc_a;

  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status,
                     started_at, answered_at, talk_seconds, recording_state)
  VALUES (a_acct, 'cr-ag', 'outbound', u_ag, 'answered',
          now() - interval '2 hours', now() - interval '2 hours', 60, 'fetched')
  RETURNING id INTO k_ag;
  INSERT INTO call_recordings (call_id, account_id, storage_path, announcement_played)
  VALUES (k_ag, a_acct, 'account-' || a_acct || '/cr-ag.ogg', true);
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, started_at)
  VALUES (a_acct, 'cr-tm', 'outbound', u_tm, 'no_answer', now() - interval '2 hours')
  RETURNING id INTO k_tm;
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status,
                     started_at, answered_at, talk_seconds)
  VALUES (a_acct, 'cr-none', 'inbound', NULL, 'answered',
          now() - interval '2 hours', now() - interval '2 hours', 30)
  RETURNING id INTO k_none;
  INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, started_at)
  VALUES (a_out, 'cr-b', 'inbound', u_out, 'no_answer', now() - interval '2 hours')
  RETURNING id INTO k_b;
  INSERT INTO call_live (connection_id, pbx_call_id, account_id, answered_by)
  VALUES (pc_a, 'cr-live', a_acct, u_ag);
  SELECT to_jsonb(c)::text INTO j_tm FROM calls c WHERE c.id = k_tm;
  SELECT to_jsonb(c)::text INTO j_b FROM calls c WHERE c.id = k_b;

  -- ---------- The column and its guard ----------
  n := n + 1;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'may_review_all_calls' AND data_type = 'boolean'
       AND is_nullable = 'NO' AND column_default = 'false') THEN
    failed := array_append(failed, 'profiles.may_review_all_calls is not boolean NOT NULL DEFAULT false'::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_ag, format(
    'UPDATE public.profiles SET may_review_all_calls = true WHERE user_id = %L', u_ag));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an agent set their own may_review_all_calls directly: ' || r)::text);
  END IF;

  -- ---------- set_member_call_review ----------
  n := n + 1;
  r := pg_temp.cr_try(u_ag, format('SELECT public.set_member_call_review(%L, true)', u_rev));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an agent allowed a call reviewer: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_lead, format('SELECT public.set_member_call_review(%L, true)', u_rev));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('a team leader allowed a call reviewer: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, 'SELECT public.set_member_call_review(NULL, true)');
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('a NULL person was not 22023: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, format('SELECT public.set_member_call_review(%L, NULL)', u_rev));
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('a NULL choice was not 22023: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, format('SELECT public.set_member_call_review(%L, true)', gen_random_uuid()));
  IF r NOT LIKE 'ERROR P0002%' THEN
    failed := array_append(failed, ('an unknown person was not P0002: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, format('SELECT public.set_member_call_review(%L, true)', u_out));
  IF r NOT LIKE 'ERROR P0002%' THEN
    failed := array_append(failed, ('another workspace''s person was not P0002: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, format('SELECT public.set_member_call_review(%L, true)', u_guest));
  IF r NOT LIKE 'ERROR 22023 not_eligible%' THEN
    failed := array_append(failed, ('a bank guest was allowed to review calls: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, format('SELECT public.set_member_call_review(%L, true)', u_dead));
  IF r NOT LIKE 'ERROR 22023 not_eligible%' THEN
    failed := array_append(failed, ('a deactivated person was allowed to review calls: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, format('SELECT public.set_member_call_review(%L, false)', u_dead));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('forbidding a deactivated person was refused: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, format('SELECT public.set_member_call_review(%L, false)', u_guest));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('forbidding a bank guest was refused: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, format('SELECT public.set_member_call_review(%L, true)', u_rev));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the owner could not allow an agent: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_admin, format('SELECT public.set_member_call_review(%L, true)', u_vrev));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('an admin could not allow a viewer: ' || r)::text);
  END IF;
  -- Read the effect in its own statement.
  n := n + 1;
  IF (SELECT count(*) FROM profiles
       WHERE user_id IN (u_rev, u_vrev) AND may_review_all_calls) <> 2
     OR EXISTS (SELECT 1 FROM profiles
                 WHERE user_id IN (u_ag, u_dead, u_guest, u_view, u_lead)
                   AND may_review_all_calls) THEN
    failed := array_append(failed, 'set_member_call_review did not set exactly the two reviewers'::text);
  END IF;

  -- ---------- pbx_call_reviewer / pbx_sees_all_calls ----------
  n := n + 1;
  IF NOT pbx_call_reviewer(u_rev, a_acct) OR pbx_call_reviewer(u_ag, a_acct)
     OR pbx_call_reviewer(u_rev, a_out) THEN
    failed := array_append(failed, 'pbx_call_reviewer answered wrongly for the service role'::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_out, format('SELECT public.pbx_call_reviewer(%L, %L)', u_rev, a_acct));
  IF r <> 'false' THEN
    failed := array_append(failed, ('pbx_call_reviewer answered about another workspace: ' || r)::text);
  END IF;
  n := n + 1;
  IF pg_temp.cr_try(u_rev, 'SELECT public.pbx_sees_all_calls()') <> 'true'
     OR pg_temp.cr_try(u_vrev, 'SELECT public.pbx_sees_all_calls()') <> 'true'
     OR pg_temp.cr_try(u_owner, 'SELECT public.pbx_sees_all_calls()') <> 'true'
     OR pg_temp.cr_try(u_ag, 'SELECT public.pbx_sees_all_calls()') <> 'false'
     OR pg_temp.cr_try(u_lead, 'SELECT public.pbx_sees_all_calls()') <> 'false'
     OR pg_temp.cr_try(u_guest, 'SELECT public.pbx_sees_all_calls()') <> 'false' THEN
    failed := array_append(failed, 'pbx_sees_all_calls answered wrongly'::text);
  END IF;

  -- ---------- Seeing calls ----------
  n := n + 1;
  r := pg_temp.cr_try(u_rev, 'SELECT count(*) FROM public.calls');
  IF r <> '3' THEN
    failed := array_append(failed, ('an agent call reviewer does not see every call of the workspace: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_vrev, 'SELECT count(*) FROM public.calls');
  IF r <> '3' THEN
    failed := array_append(failed, ('a viewer call reviewer does not see every call of the workspace: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_rev, format(
    'SELECT public.pbx_can_view_call(jsonb_populate_record(NULL::public.calls, %L::jsonb))', j_tm));
  IF r <> 'true' THEN
    failed := array_append(failed, ('pbx_can_view_call refused a reviewer: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_rev, 'SELECT count(*) FROM public.call_live');
  IF r <> '1' THEN
    failed := array_append(failed, ('a call reviewer does not see the live call: ' || r)::text);
  END IF;
  -- Non-reviewers keep 113's rules.
  n := n + 1;
  r := pg_temp.cr_try(u_ag, 'SELECT string_agg(pbx_call_id, '','') FROM public.calls');
  IF r <> 'cr-ag' THEN
    failed := array_append(failed, ('an agent without the flag sees more than their own calls: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_ag, format(
    'SELECT public.pbx_can_view_call(jsonb_populate_record(NULL::public.calls, %L::jsonb))', j_tm));
  IF r <> 'false' THEN
    failed := array_append(failed, ('pbx_can_view_call let an agent see another''s call: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_lead, 'SELECT string_agg(pbx_call_id, '','') FROM public.calls');
  IF r <> 'cr-tm' THEN
    failed := array_append(failed, ('a team leader without the flag sees calls outside their team: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_tm, 'SELECT count(*) FROM public.call_live');
  IF r <> '0' THEN
    failed := array_append(failed, ('an agent without the flag sees another''s live call: ' || r)::text);
  END IF;
  -- Another workspace stays shut.
  n := n + 1;
  r := pg_temp.cr_try(u_rev, format('SELECT count(*) FROM public.calls WHERE account_id = %L', a_out));
  IF r <> '0' THEN
    failed := array_append(failed, ('a reviewer of A sees B''s calls: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_rev, format(
    'SELECT public.pbx_can_view_call(jsonb_populate_record(NULL::public.calls, %L::jsonb))', j_b));
  IF r <> 'false' THEN
    failed := array_append(failed, ('pbx_can_view_call let a reviewer of A see B''s call: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_out, 'SELECT count(*) FROM public.calls');
  IF r <> '1' THEN
    failed := array_append(failed, ('B''s owner does not see exactly B''s call: ' || r)::text);
  END IF;

  -- ---------- The access log ----------
  n := n + 1;
  r := pg_temp.cr_svc(format(
    'INSERT INTO public.call_access_log (call_id, account_id, user_id, action) VALUES (%L, %L, %L, ''play'')',
    k_ag, a_acct, u_vrev));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('a viewer call reviewer could not play a recording: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_svc(format(
    'INSERT INTO public.call_access_log (call_id, account_id, user_id, action) VALUES (%L, %L, %L, ''download'')',
    k_ag, a_acct, u_rev));
  IF r <> 'ok' THEN
    failed := array_append(failed, ('an agent call reviewer could not download a recording: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_svc(format(
    'INSERT INTO public.call_access_log (call_id, account_id, user_id, action) VALUES (%L, %L, %L, ''download'')',
    k_ag, a_acct, u_ag));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an agent without the flag downloaded a recording: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_svc(format(
    'INSERT INTO public.call_access_log (call_id, account_id, user_id, action) VALUES (%L, %L, %L, ''play'')',
    k_ag, a_acct, u_view));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('a viewer without the flag played a recording: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_svc(format(
    'INSERT INTO public.call_access_log (call_id, account_id, user_id, action) VALUES (%L, %L, %L, ''play'')',
    k_tm, a_acct, u_rev));
  IF r NOT LIKE 'ERROR 55000%' THEN
    failed := array_append(failed, ('a reviewer played a call with no playable recording: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_rev, 'SELECT count(*) FROM public.call_access_log');
  IF r <> '0' THEN
    failed := array_append(failed, ('a call reviewer reads the access log: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_owner, 'SELECT count(*) FROM public.call_access_log');
  IF r <> '2' THEN
    failed := array_append(failed, ('the owner does not read the two access rows: ' || r)::text);
  END IF;

  -- ---------- The Call report ----------
  n := n + 1;
  v_stats := pg_temp.cr_try(u_rev, format('SELECT public.pbx_call_stats(%s, %s, ''UTC'')::text', v_from, v_to));
  IF v_stats LIKE 'ERROR%'
     OR v_stats::jsonb ->> 'scope' IS DISTINCT FROM 'workspace'
     OR v_stats::jsonb -> 'summary' ->> 'calls' IS DISTINCT FROM '3'
     OR NOT jsonb_path_exists(v_stats::jsonb, '$.people[*] ? (@.kind == "none" && @.calls == 1)') THEN
    failed := array_append(failed, ('pbx_call_stats does not give a reviewer the whole workspace: ' || left(v_stats, 300))::text);
  END IF;
  n := n + 1;
  v_stats := pg_temp.cr_try(u_ag, format('SELECT public.pbx_call_stats(%s, %s, ''UTC'')::text', v_from, v_to));
  IF v_stats LIKE 'ERROR%'
     OR v_stats::jsonb ->> 'scope' IS DISTINCT FROM 'self'
     OR v_stats::jsonb -> 'summary' ->> 'calls' IS DISTINCT FROM '1' THEN
    failed := array_append(failed, ('pbx_call_stats widened an agent without the flag: ' || left(v_stats, 300))::text);
  END IF;
  n := n + 1;
  v_stats := pg_temp.cr_try(u_lead, format('SELECT public.pbx_call_stats(%s, %s, ''UTC'')::text', v_from, v_to));
  IF v_stats LIKE 'ERROR%'
     OR v_stats::jsonb ->> 'scope' IS DISTINCT FROM 'team'
     OR v_stats::jsonb -> 'summary' ->> 'calls' IS DISTINCT FROM '1' THEN
    failed := array_append(failed, ('pbx_call_stats widened a team leader without the flag: ' || left(v_stats, 300))::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_rev, format('SELECT count(*) FROM public.pbx_call_report(%s, %s)', v_from, v_to));
  IF r LIKE 'ERROR%' THEN
    failed := array_append(failed, ('pbx_call_report refused a call reviewer: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.cr_try(u_ag, format('SELECT count(*) FROM public.pbx_call_report(%s, %s)', v_from, v_to));
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('pbx_call_report admitted an agent without the flag: ' || r)::text);
  END IF;

  -- ---------- Privileges ----------
  n := n + 1;
  IF has_function_privilege('anon', 'public.set_member_call_review(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_call_reviewer(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pbx_sees_all_calls()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_member_call_review(uuid, boolean)', 'EXECUTE') THEN
    failed := array_append(failed, 'call reviewer function grants are wrong'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT198', MESSAGE = 'verify-call-reviewers rollback';
  EXCEPTION WHEN SQLSTATE 'ZT198' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'call reviewers verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'call reviewers verification passed (% checks)', n;
END
$verify$;
