-- Behavioural regression suite for team chat DM rules (migration 143).
--
-- With no rules every live non-guest member may DM every other (087).
-- An owner / admin replaces the workspace's rule set with
-- chat_set_dm_rules (agents refused 42501, a bad class or a duplicate
-- pair 22023). A 'none' pair refuses chat_open_dm (new and reopen) with
-- the phrase the TS error mapper keys on, hides an existing DM from its
-- members (the read gate and RLS: channel and messages read 0 rows) and
-- refuses posting there; owner/admin's audited read still works. A
-- 'team' pair admits only one's own team leader. The coordinator class
-- is a second class of an agent, and the most permissive class pair
-- wins. Owners are always reachable. chat_dm_peers lists exactly whom
-- the caller may DM. Only owners / admins read chat_dm_rules. Clearing
-- the rules shows the hidden DM again.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.
-- A writing RPC's result is assigned first and its effect read in a
-- later statement.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000143001';
  u_admin  UUID := '00000000-0000-4000-8000-000000143002';
  u_ag1    UUID := '00000000-0000-4000-8000-000000143003';  -- team T1
  u_ag2    UUID := '00000000-0000-4000-8000-000000143004';  -- team T1
  u_ag3    UUID := '00000000-0000-4000-8000-000000143005';  -- team T2
  u_lead1  UUID := '00000000-0000-4000-8000-000000143006';  -- leads T1
  u_lead2  UUID := '00000000-0000-4000-8000-000000143007';  -- leads T2
  u_coord  UUID := '00000000-0000-4000-8000-000000143008';  -- agent, coordinator of ADCB, no team
  u_viewer UUID := '00000000-0000-4000-8000-000000143009';
  u_guest  UUID := '00000000-0000-4000-8000-000000143010';
  u_out    UUID := '00000000-0000-4000-8000-000000143011';  -- another workspace only
  a_acct   UUID;
  t1       UUID;
  t2       UUID;
  dm1      UUID;  -- ag1 + ag2, opened before any rule
  r        TEXT;
  open_sql TEXT := 'SELECT public.chat_open_dm(%L, %L::uuid[])::text';
  set_sql  TEXT := 'SELECT 1 FROM public.chat_set_dm_rules(%L, %L::jsonb)';
  phrase   TEXT := '%direct messages between these people are turned off%';
  uuid_re  TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dm_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dm_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.dm_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dm_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'ci-dm-owner@example.invalid'),
    (u_admin,  'ci-dm-admin@example.invalid'),
    (u_ag1,    'ci-dm-ag1@example.invalid'),
    (u_ag2,    'ci-dm-ag2@example.invalid'),
    (u_ag3,    'ci-dm-ag3@example.invalid'),
    (u_lead1,  'ci-dm-lead1@example.invalid'),
    (u_lead2,  'ci-dm-lead2@example.invalid'),
    (u_coord,  'ci-dm-coord@example.invalid'),
    (u_viewer, 'ci-dm-viewer@example.invalid'),
    (u_guest,  'ci-dm-guest@example.invalid'),
    (u_out,    'ci-dm-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a_acct;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_ag1, u_ag2, u_ag3, u_coord);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id IN (u_lead1, u_lead2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ADCB', 'ADCB Bank');
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a_acct, u_coord, 'ADCB');
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CI DM T1', u_lead1) RETURNING id INTO t1;
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CI DM T2', u_lead2) RETURNING id INTO t2;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES
    (t1, u_ag1, a_acct), (t1, u_ag2, a_acct), (t2, u_ag3, a_acct);

  -- ---------- no rules: 087's open DMs ----------
  r := pg_temp.dm_try('authenticated', u_ag1, format(open_sql, a_acct, ARRAY[u_ag2]));
  n := n + 1; failed := failed || pg_temp.dm_ok(r ~ uuid_re, 'no rules: agent-agent DM did not open (' || r || ')');
  IF r ~ uuid_re THEN dm1 := r::uuid; END IF;
  n := n + 1; failed := failed || pg_temp.dm_check('no rules: agent cannot post in the DM',
    'authenticated', u_ag1, format('SELECT public.chat_post_message(%L, %L)::text', dm1, 'hello'), '________-%');
  n := n + 1; failed := failed || pg_temp.dm_ok(public.chat_user_can_read_channel(dm1, u_ag2, true),
    'no rules: the other agent cannot read the DM');
  n := n + 1; failed := failed || pg_temp.dm_check('no rules: the other agent reads no message',
    'authenticated', u_ag2, format('SELECT count(*)::text FROM internal_messages WHERE channel_id = %L', dm1), '1');

  -- ---------- who may set rules ----------
  n := n + 1; failed := failed || pg_temp.dm_check('an agent could set DM rules',
    'authenticated', u_ag1, format(set_sql, a_acct, '[{"class_a":"agent","class_b":"agent","scope":"none"}]'), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.dm_check('a bad class was accepted',
    'authenticated', u_admin, format(set_sql, a_acct, '[{"class_a":"agent","class_b":"owner","scope":"none"}]'), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.dm_check('a bad scope was accepted',
    'authenticated', u_admin, format(set_sql, a_acct, '[{"class_a":"agent","class_b":"agent","scope":"some"}]'), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.dm_check('a non-array was accepted',
    'authenticated', u_admin, format(set_sql, a_acct, '{"class_a":"agent","class_b":"agent","scope":"none"}'), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.dm_check('a duplicate pair (either order) was accepted',
    'authenticated', u_admin, format(set_sql, a_acct,
      '[{"class_a":"agent","class_b":"admin","scope":"none"},{"class_a":"admin","class_b":"agent","scope":"all"}]'), 'ERROR 22023%');
  n := n + 1; failed := failed || pg_temp.dm_check('a refused save still wrote rows',
    NULL, NULL, format('SELECT count(*)::text FROM chat_dm_rules WHERE account_id = %L', a_acct), '0');

  -- ---------- agent <-> agent: none ----------
  r := pg_temp.dm_try('authenticated', u_admin, format(set_sql, a_acct,
    '[{"class_a":"agent","class_b":"agent","scope":"none"},{"class_a":"admin","class_b":"viewer","scope":"all"}]'));
  n := n + 1; failed := failed || pg_temp.dm_ok(r = '1', 'admin could not set DM rules (' || r || ')');
  n := n + 1; failed := failed || pg_temp.dm_check('the admin does not read exactly the restricting row (all rows dropped)',
    'authenticated', u_admin, format('SELECT string_agg(class_a || ''/'' || class_b || ''/'' || scope || ''/'' || (updated_by = %L)::text, '','') FROM chat_dm_rules WHERE account_id = %L', u_admin, a_acct),
    'agent/agent/none/true');
  n := n + 1; failed := failed || pg_temp.dm_check('an agent reads chat_dm_rules',
    'authenticated', u_ag1, format('SELECT count(*)::text FROM chat_dm_rules WHERE account_id = %L', a_acct), '0');
  n := n + 1; failed := failed || pg_temp.dm_check('reopening a blocked agent DM was not refused with the phrase',
    'authenticated', u_ag1, format(open_sql, a_acct, ARRAY[u_ag2]), 'ERROR 42501: chat_open_dm: ' || substr(phrase, 2));
  n := n + 1; failed := failed || pg_temp.dm_check('a new blocked agent DM was not refused with the phrase',
    'authenticated', u_ag2, format(open_sql, a_acct, ARRAY[u_ag3]), 'ERROR 42501:' || phrase);
  n := n + 1; failed := failed || pg_temp.dm_check('a group DM with two agents and a leader was not refused',
    'authenticated', u_lead1, format(open_sql, a_acct, ARRAY[u_ag1, u_ag2]), 'ERROR 42501:' || phrase);
  n := n + 1; failed := failed || pg_temp.dm_ok(NOT public.chat_user_can_read_channel(dm1, u_ag1, true)
                                                AND NOT public.chat_user_can_read_channel(dm1, u_ag2, true)
                                                AND NOT public.chat_user_can_read_channel(dm1, u_ag1, false),
    'the blocked DM is still readable by its agents (read gate)');
  n := n + 1; failed := failed || pg_temp.dm_check('the blocked DM still shows to an agent (RLS)',
    'authenticated', u_ag1, format('SELECT ((SELECT count(*) FROM chat_channels WHERE id = %L)'
      || ' + (SELECT count(*) FROM chat_channel_members WHERE channel_id = %L)'
      || ' + (SELECT count(*) FROM internal_messages WHERE channel_id = %L))::text', dm1, dm1, dm1), '0');
  n := n + 1; failed := failed || pg_temp.dm_check('the blocked DM still shows to the other agent (RLS)',
    'authenticated', u_ag2, format('SELECT ((SELECT count(*) FROM chat_channels WHERE id = %L)'
      || ' + (SELECT count(*) FROM internal_messages WHERE channel_id = %L))::text', dm1, dm1), '0');
  n := n + 1; failed := failed || pg_temp.dm_check('the blocked DM still counts unread',
    'authenticated', u_ag2, format('SELECT count(*)::text FROM public.chat_unread_counts(%L) WHERE channel_id = %L', a_acct, dm1), '0');
  n := n + 1; failed := failed || pg_temp.dm_check('posting in the blocked DM was not refused with the phrase',
    'authenticated', u_ag1, format('SELECT public.chat_post_message(%L, %L)::text', dm1, 'still there?'),
    'ERROR 42501: chat: ' || substr(phrase, 2));
  n := n + 1; failed := failed || pg_temp.dm_check('the admin''s audited read lost the hidden DM',
    'authenticated', u_admin, format('SELECT count(*)::text FROM public.chat_admin_read_private(%L, %L)', dm1, 'CI check of DM rules'), '1');
  n := n + 1; failed := failed || pg_temp.dm_check('the hidden DM was deleted',
    NULL, NULL, format('SELECT count(*)::text FROM internal_messages WHERE channel_id = %L', dm1), '1');

  -- ---------- agent <-> team_leader: team; admin <-> agent: none ----------
  r := pg_temp.dm_try('authenticated', u_owner, format(set_sql, a_acct,
    '[{"class_a":"agent","class_b":"agent","scope":"none"},{"class_a":"team_leader","class_b":"agent","scope":"team"},'
    || '{"class_a":"agent","class_b":"admin","scope":"none"},{"class_a":"coordinator","class_b":"agent","scope":"none"}]'));
  n := n + 1; failed := failed || pg_temp.dm_ok(r = '1', 'owner could not set DM rules (' || r || ')');
  n := n + 1; failed := failed || pg_temp.dm_check('the rules are not stored in canonical order',
    NULL, NULL, format('SELECT string_agg(class_a || ''/'' || class_b || ''/'' || scope, '','' ORDER BY class_a, class_b) FROM chat_dm_rules WHERE account_id = %L', a_acct),
    'admin/agent/none,agent/agent/none,agent/coordinator/none,agent/team_leader/team');
  n := n + 1; failed := failed || pg_temp.dm_check('an agent could not DM their own team leader',
    'authenticated', u_ag1, format(open_sql, a_acct, ARRAY[u_lead1]), '________-%');
  n := n + 1; failed := failed || pg_temp.dm_check('an agent could DM another team''s leader',
    'authenticated', u_ag1, format(open_sql, a_acct, ARRAY[u_lead2]), 'ERROR 42501:' || phrase);
  n := n + 1; failed := failed || pg_temp.dm_check('a leader could DM another team''s agent',
    'authenticated', u_lead2, format(open_sql, a_acct, ARRAY[u_ag1]), 'ERROR 42501:' || phrase);
  n := n + 1; failed := failed || pg_temp.dm_check('an agent could DM an admin under admin/agent none',
    'authenticated', u_ag1, format(open_sql, a_acct, ARRAY[u_admin]), 'ERROR 42501:' || phrase);
  n := n + 1; failed := failed || pg_temp.dm_check('an agent could not DM the owner',
    'authenticated', u_ag1, format(open_sql, a_acct, ARRAY[u_owner]), '________-%');
  n := n + 1; failed := failed || pg_temp.dm_check('the owner could not DM an agent',
    'authenticated', u_owner, format(open_sql, a_acct, ARRAY[u_ag3]), '________-%');
  n := n + 1; failed := failed || pg_temp.dm_check('agent/coordinator none still let an agent DM a coordinator',
    'authenticated', u_ag1, format(open_sql, a_acct, ARRAY[u_coord]), 'ERROR 42501:' || phrase);

  -- ---------- agent <-> coordinator: all ----------
  r := pg_temp.dm_try('authenticated', u_admin, format(set_sql, a_acct,
    '[{"class_a":"agent","class_b":"agent","scope":"none"},{"class_a":"team_leader","class_b":"agent","scope":"team"},'
    || '{"class_a":"agent","class_b":"admin","scope":"none"},{"class_a":"coordinator","class_b":"agent","scope":"all"}]'));
  n := n + 1; failed := failed || pg_temp.dm_ok(r = '1', 'admin could not replace DM rules (' || r || ')');
  n := n + 1; failed := failed || pg_temp.dm_check('agent/coordinator all did not make the coordinator reachable',
    'authenticated', u_ag1, format(open_sql, a_acct, ARRAY[u_coord]), '________-%');
  -- ag1 may DM: owner, own leader, the coordinator, the viewer (no rule).
  -- Not: the admin, other agents, another team's leader, the guest, themselves.
  n := n + 1; failed := failed || pg_temp.dm_check('chat_dm_peers is not the expected set',
    'authenticated', u_ag1, format('SELECT string_agg(x::text, '','' ORDER BY x) FROM public.chat_dm_peers(%L) x', a_acct),
    (SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(ARRAY[u_owner, u_lead1, u_coord, u_viewer]) x));
  n := n + 1; failed := failed || pg_temp.dm_check('chat_dm_peers answers a non-member',
    'authenticated', u_out, format('SELECT count(*)::text FROM public.chat_dm_peers(%L)', a_acct), '0');
  n := n + 1; failed := failed || pg_temp.dm_check('chat_dm_peers answers a bank guest',
    'authenticated', u_guest, format('SELECT count(*)::text FROM public.chat_dm_peers(%L)', a_acct), '0');
  n := n + 1; failed := failed || pg_temp.dm_check('an internal helper is executable by a client',
    NULL, NULL, 'SELECT (has_function_privilege(''authenticated'', ''public.chat_dm_pair_allowed(uuid,uuid,uuid)'', ''EXECUTE'')'
      || ' OR has_function_privilege(''authenticated'', ''public.chat_dm_user_allowed(uuid,uuid)'', ''EXECUTE'')'
      || ' OR has_function_privilege(''service_role'', ''public.chat_set_dm_rules(uuid,jsonb)'', ''EXECUTE'')'
      || ' OR has_table_privilege(''authenticated'', ''public.chat_dm_rules'', ''INSERT''))::text', 'false');

  -- ---------- cleared: hidden, not deleted ----------
  r := pg_temp.dm_try('authenticated', u_admin, format(set_sql, a_acct, '[]'));
  n := n + 1; failed := failed || pg_temp.dm_ok(r = '1', 'admin could not clear DM rules (' || r || ')');
  n := n + 1; failed := failed || pg_temp.dm_check('the hidden DM did not come back once the rules were cleared',
    'authenticated', u_ag2, format('SELECT count(*)::text FROM internal_messages WHERE channel_id = %L', dm1), '1');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT143', MESSAGE = 'verify-chat-dm-rules rollback';
  EXCEPTION WHEN SQLSTATE 'ZT143' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat DM rules verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat DM rules verification passed (% checks)', n;
END
$verify$;
