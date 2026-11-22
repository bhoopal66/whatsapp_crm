-- Behavioural regression suite for migration 236: the assignment
-- rotation engine, chat limits, assignment settings and Compass
-- assignment.
--
-- Asserts: a real rotation order A -> B -> C -> A across calls (default
-- pool, by user id); offline, deactivated, bank guest, viewer and
-- at-limit people are skipped; nobody eligible assigns nothing and
-- leaves the pool's state as it was; an assigned, engaged, personal,
-- unknown or other-account chat is left alone; a person's own limit
-- overrides the default both ways; no settings row reads as the
-- defaults (limits off, Compass off, member_loads' chat_limit NULL);
-- the *_set functions refuse an agent and validate their input;
-- Compass assignment changes nothing while off, and when on assigns the
-- case's agent and opens the coordinator's share (one bell); the
-- grants.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too: the checks run inside a block that ends
-- by raising a sentinel, which undoes every write while the collected
-- results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner   UUID := '00000000-0000-4000-8000-000000236001';
  u_admin   UUID := '00000000-0000-4000-8000-000000236002';
  u_a1      UUID := '00000000-0000-4000-8000-000000236101';
  u_a2      UUID := '00000000-0000-4000-8000-000000236102';
  u_a3      UUID := '00000000-0000-4000-8000-000000236103';
  u_offline UUID := '00000000-0000-4000-8000-000000236104';
  u_gone    UUID := '00000000-0000-4000-8000-000000236105';
  u_viewer  UUID := '00000000-0000-4000-8000-000000236106';
  u_guest   UUID := '00000000-0000-4000-8000-000000236107';
  u_other   UUID := '00000000-0000-4000-8000-000000236201';
  a_acct    UUID;
  b_acct    UUID;
  cv        UUID[] := '{}';
  cv_x      UUID;
  cv_b      UUID;
  j         JSONB;
  r         TEXT;
  v_uuid    UUID;
  v_int     INT;
  i         INT;
  n         INT := 0;
  failed    TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tb_try(p_role text, p_uid uuid, p_sql text)
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
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- A fresh company chat (its own contact) in an account.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tb_chat(p_acct uuid, p_owner uuid, p_phone text)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE v_ct uuid; v_cv uuid;
    BEGIN
      INSERT INTO contacts (account_id, user_id, phone, name)
      VALUES (p_acct, p_owner, p_phone, 'TB236 ' || p_phone) RETURNING id INTO v_ct;
      INSERT INTO conversations (account_id, user_id, contact_id)
      VALUES (p_acct, p_owner, v_ct) RETURNING id INTO v_cv;
      RETURN v_cv;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner,   'tb236-owner@example.invalid'),
    (u_admin,   'tb236-admin@example.invalid'),
    (u_a1,      'tb236-a1@example.invalid'),
    (u_a2,      'tb236-a2@example.invalid'),
    (u_a3,      'tb236-a3@example.invalid'),
    (u_offline, 'tb236-offline@example.invalid'),
    (u_gone,    'tb236-gone@example.invalid'),
    (u_viewer,  'tb236-viewer@example.invalid'),
    (u_guest,   'tb236-guest@example.invalid'),
    (u_other,   'tb236-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_a1, u_a2, u_offline, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_a3;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB'
   WHERE user_id = u_guest;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  -- Present: everyone but u_offline, whose heartbeat is stale.
  DELETE FROM member_presence WHERE user_id IN
    (u_a1, u_a2, u_a3, u_offline, u_gone, u_viewer, u_guest);
  INSERT INTO member_presence (user_id, account_id, status, last_seen_at) VALUES
    (u_a1,      a_acct, 'online', now()),
    (u_a2,      a_acct, 'away',   now()),
    (u_a3,      a_acct, 'online', now()),
    (u_offline, a_acct, 'online', now() - interval '10 minutes'),
    (u_gone,    a_acct, 'online', now()),
    (u_viewer,  a_acct, 'online', now()),
    (u_guest,   a_acct, 'online', now());

  FOR i IN 1..12 LOOP
    cv := cv || pg_temp.tb_chat(a_acct, u_owner, '9715002360' || lpad(i::text, 2, '0'));
  END LOOP;

  -- ---------- no settings row = the defaults ----------
  n := n + 1;
  IF EXISTS (SELECT 1 FROM assignment_settings WHERE account_id = a_acct) THEN
    failed := array_append(failed, 'fixture already has a settings row'::text);
  END IF;
  j := assignment_compass_assign(a_acct, cv[12], u_a1, u_a3, NULL);
  n := n + 1;
  IF j->>'reason' <> 'off'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[12]) IS NOT NULL THEN
    failed := array_append(failed, ('compass ran with no settings row: ' || j::text)::text);
  END IF;

  -- ---------- default pool: A1 -> A2 -> A3 -> A1 ----------
  -- Candidates are live agents / team leaders by user id: a1, a2, a3,
  -- offline (skipped: stale heartbeat); gone is deactivated.
  FOR i IN 1..4 LOOP
    j := assignment_rotate_assign(a_acct, cv[i], 'automation:tb:default', NULL);
    v_uuid := (j->>'assigned_to')::uuid;
    n := n + 1;
    IF j->>'reason' <> 'assigned'
       OR v_uuid IS DISTINCT FROM (ARRAY[u_a1, u_a2, u_a3, u_a1])[i]
       OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[i]) IS DISTINCT FROM v_uuid THEN
      failed := array_append(failed, ('default rotation call ' || i || ': ' || j::text)::text);
    END IF;
  END LOOP;
  n := n + 1;
  IF (SELECT last_user_id FROM assignment_rotation_state
       WHERE account_id = a_acct AND pool_key = 'automation:tb:default') IS DISTINCT FROM u_a1 THEN
    failed := array_append(failed, 'rotation state not at the last pick'::text);
  END IF;

  -- ---------- an explicit pool skips everyone ineligible ----------
  j := assignment_rotate_assign(a_acct, cv[5], 'tb:explicit',
         ARRAY[u_viewer, u_guest, u_gone, u_offline, u_other, u_a2]);
  n := n + 1;
  IF j->>'reason' <> 'assigned' OR (j->>'assigned_to')::uuid IS DISTINCT FROM u_a2 THEN
    failed := array_append(failed, ('explicit pool did not skip to a2: ' || j::text)::text);
  END IF;
  -- Order is the caller's: after a2 wraps to the start, a3 first.
  j := assignment_rotate_assign(a_acct, cv[6], 'tb:explicit', ARRAY[u_a3, u_a1, u_a2]);
  n := n + 1;
  IF (j->>'assigned_to')::uuid IS DISTINCT FROM u_a3 THEN
    failed := array_append(failed, ('explicit order not followed: ' || j::text)::text);
  END IF;

  -- ---------- nobody eligible ----------
  j := assignment_rotate_assign(a_acct, cv[7], 'tb:explicit', ARRAY[u_viewer, u_guest, u_offline, u_gone]);
  n := n + 1;
  IF j->>'reason' <> 'nobody_eligible' OR j->>'assigned_to' IS NOT NULL
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[7]) IS NOT NULL
     OR (SELECT last_user_id FROM assignment_rotation_state
          WHERE account_id = a_acct AND pool_key = 'tb:explicit') IS DISTINCT FROM u_a3 THEN
    failed := array_append(failed, ('nobody eligible changed something: ' || j::text)::text);
  END IF;
  j := assignment_rotate_assign(a_acct, cv[7], 'tb:empty', ARRAY[u_viewer]);
  n := n + 1;
  IF j->>'reason' <> 'nobody_eligible'
     OR EXISTS (SELECT 1 FROM assignment_rotation_state WHERE account_id = a_acct AND pool_key = 'tb:empty') THEN
    failed := array_append(failed, ('nobody eligible wrote a new state: ' || j::text)::text);
  END IF;

  -- ---------- chats left alone ----------
  j := assignment_rotate_assign(a_acct, cv[1], 'tb:alone', NULL);
  n := n + 1;
  IF j->>'reason' <> 'already_assigned'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[1]) IS DISTINCT FROM u_a1 THEN
    failed := array_append(failed, ('assigned chat was taken: ' || j::text)::text);
  END IF;
  UPDATE conversations SET human_engaged_at = now() WHERE id = cv[8];
  j := assignment_rotate_assign(a_acct, cv[8], 'tb:alone', NULL);
  n := n + 1;
  IF j->>'reason' <> 'engaged'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[8]) IS NOT NULL THEN
    failed := array_append(failed, ('engaged chat was taken: ' || j::text)::text);
  END IF;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500236099', 'TB236 personal') RETURNING id INTO v_uuid;
  INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id)
  VALUES (a_acct, u_a1, v_uuid, u_a1) RETURNING id INTO cv_x;
  j := assignment_rotate_assign(a_acct, cv_x, 'tb:alone', NULL);
  n := n + 1;
  IF j->>'reason' <> 'personal'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv_x) IS NOT NULL THEN
    failed := array_append(failed, ('personal chat was assigned: ' || j::text)::text);
  END IF;
  j := assignment_rotate_assign(a_acct, gen_random_uuid(), 'tb:alone', NULL);
  n := n + 1;
  IF j->>'reason' <> 'not_found' THEN
    failed := array_append(failed, ('unknown chat: ' || j::text)::text);
  END IF;
  cv_b := pg_temp.tb_chat(b_acct, u_other, '971500236098');
  j := assignment_rotate_assign(a_acct, cv_b, 'tb:alone', NULL);
  n := n + 1;
  IF j->>'reason' <> 'not_found'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv_b) IS NOT NULL THEN
    failed := array_append(failed, ('another account''s chat: ' || j::text)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM assignment_rotation_state WHERE account_id = a_acct AND pool_key = 'tb:alone') THEN
    failed := array_append(failed, 'a refused chat wrote rotation state'::text);
  END IF;

  -- ---------- member loads with no settings row ----------
  -- Loads now: a1 2 (cv1, cv4), a2 2 (cv2, cv5), a3 2 (cv3, cv6).
  r := pg_temp.tb_try('authenticated', u_admin,
    'CREATE TEMP TABLE IF NOT EXISTS tb_loads AS SELECT * FROM public.assignment_member_loads()');
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('member_loads as admin: ' || r)::text);
  ELSE
    n := n + 1;
    IF (SELECT open_count FROM tb_loads WHERE user_id = u_a1) IS DISTINCT FROM 2
       OR EXISTS (SELECT 1 FROM tb_loads WHERE chat_limit IS NOT NULL)
       OR EXISTS (SELECT 1 FROM tb_loads WHERE user_id IN (u_guest, u_gone, u_other)) THEN
      failed := array_append(failed, 'member_loads wrong with no settings row'::text);
    END IF;
  END IF;

  -- ---------- the *_set functions ----------
  r := pg_temp.tb_try('authenticated', u_a1,
    'SELECT public.assignment_settings_set(p_limits_enabled => true)');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%'
     OR EXISTS (SELECT 1 FROM assignment_settings WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('settings_set let an agent in: ' || r)::text);
  END IF;
  r := pg_temp.tb_try('authenticated', u_a1,
    format('SELECT public.assignment_chat_limit_set(%L, 5)', u_a2));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('chat_limit_set let an agent in: ' || r)::text);
  END IF;
  r := pg_temp.tb_try('authenticated', u_admin,
    format('SELECT public.assignment_settings_set(p_broadcast_pool => ARRAY[%L, %L]::uuid[])', u_a1, u_viewer));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('a viewer was accepted into the pool: ' || r)::text);
  END IF;
  r := pg_temp.tb_try('authenticated', u_admin,
    'SELECT public.assignment_settings_set(p_default_chat_limit => 0)');
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('limit 0 accepted: ' || r)::text);
  END IF;
  -- Limits on, default 2: a1 / a2 / a3 are all at 2 now.
  r := pg_temp.tb_try('authenticated', u_admin,
    'SELECT public.assignment_settings_set(p_limits_enabled => true, p_default_chat_limit => 2)');
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (
       SELECT 1 FROM assignment_settings
        WHERE account_id = a_acct AND limits_enabled AND default_chat_limit = 2
          AND NOT broadcast_rotation_enabled AND NOT compass_assign_enabled
          AND broadcast_pool = '{}' AND updated_by = u_admin) THEN
    failed := array_append(failed, ('settings_set as admin: ' || r)::text);
  END IF;

  -- ---------- limits ----------
  j := assignment_rotate_assign(a_acct, cv[9], 'tb:limits', ARRAY[u_a1, u_a2, u_a3]);
  n := n + 1;
  IF j->>'reason' <> 'nobody_eligible' THEN
    failed := array_append(failed, ('everyone at the default limit, still assigned: ' || j::text)::text);
  END IF;
  -- a3's own limit (3) lifts them over the default.
  r := pg_temp.tb_try('authenticated', u_admin,
    format('SELECT public.assignment_chat_limit_set(%L, 3)', u_a3));
  j := assignment_rotate_assign(a_acct, cv[9], 'tb:limits', ARRAY[u_a1, u_a2, u_a3]);
  n := n + 1;
  IF r <> 'ok' OR (j->>'assigned_to')::uuid IS DISTINCT FROM u_a3 THEN
    failed := array_append(failed, ('own limit above the default ignored: ' || r || ' ' || j::text)::text);
  END IF;
  -- A closed chat does not count: a1 drops to 1 and takes the next.
  UPDATE conversations SET status = 'closed' WHERE id = cv[4];
  j := assignment_rotate_assign(a_acct, cv[10], 'tb:limits', ARRAY[u_a1, u_a2, u_a3]);
  n := n + 1;
  IF (j->>'assigned_to')::uuid IS DISTINCT FROM u_a1 THEN
    failed := array_append(failed, ('closed chat counted toward the limit: ' || j::text)::text);
  END IF;
  -- Default raised to 10, but a2's own limit of 1 holds them back.
  r := pg_temp.tb_try('authenticated', u_admin,
    'SELECT public.assignment_settings_set(p_default_chat_limit => 10)');
  r := r || pg_temp.tb_try('authenticated', u_admin,
    format('SELECT public.assignment_chat_limit_set(%L, 1)', u_a2));
  j := assignment_rotate_assign(a_acct, cv[11], 'tb:limits2', ARRAY[u_a2, u_a1]);
  n := n + 1;
  IF r <> 'okok' OR (j->>'assigned_to')::uuid IS DISTINCT FROM u_a1 THEN
    failed := array_append(failed, ('own limit below the default ignored: ' || r || ' ' || j::text)::text);
  END IF;
  -- Removing it brings the default back.
  r := pg_temp.tb_try('authenticated', u_admin,
    format('SELECT public.assignment_chat_limit_set(%L, NULL)', u_a2));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM assignment_chat_limits WHERE account_id = a_acct AND user_id = u_a2) THEN
    failed := array_append(failed, ('removing a limit: ' || r)::text);
  END IF;
  -- Earlier values kept when a call leaves them out.
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM assignment_settings
                  WHERE account_id = a_acct AND limits_enabled AND default_chat_limit = 10) THEN
    failed := array_append(failed, 'settings_set lost a value it was not given'::text);
  END IF;
  DROP TABLE IF EXISTS tb_loads;
  r := pg_temp.tb_try('authenticated', u_admin,
    'CREATE TEMP TABLE tb_loads AS SELECT * FROM public.assignment_member_loads()');
  n := n + 1;
  IF r <> 'ok'
     OR (SELECT chat_limit FROM tb_loads WHERE user_id = u_a3) IS DISTINCT FROM 3
     OR (SELECT chat_limit FROM tb_loads WHERE user_id = u_a2) IS DISTINCT FROM 10 THEN
    failed := array_append(failed, ('member_loads limits: ' || r)::text);
  END IF;
  DROP TABLE IF EXISTS tb_loads;

  -- ---------- Compass ----------
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'TBK', 'TB236 Bank')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (a_acct, u_a3, 'TBK');
  -- Still off: nothing changes.
  j := assignment_compass_assign(a_acct, cv[12], u_a2, u_a3, 'TBK');
  n := n + 1;
  IF j->>'reason' <> 'off'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[12]) IS NOT NULL
     OR EXISTS (SELECT 1 FROM conversation_coordinator_shares WHERE conversation_id = cv[12]) THEN
    failed := array_append(failed, ('compass off changed something: ' || j::text)::text);
  END IF;
  r := pg_temp.tb_try('authenticated', u_admin,
    'SELECT public.assignment_settings_set(p_compass_assign_enabled => true)');
  j := assignment_compass_assign(a_acct, cv[12], u_a2, u_a3, NULL);
  n := n + 1;
  IF r <> 'ok' OR j->>'reason' <> 'assigned'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[12]) IS DISTINCT FROM u_a2
     OR NOT EXISTS (SELECT 1 FROM conversation_coordinator_shares
                     WHERE conversation_id = cv[12] AND coordinator_user_id = u_a3
                       AND bank_code = 'TBK' AND revoked_at IS NULL AND shared_by IS NULL)
     OR (SELECT count(*) FROM notifications
          WHERE conversation_id = cv[12] AND user_id = u_a3 AND type = 'conversation_shared') <> 1 THEN
    failed := array_append(failed, ('compass on did not assign and share: ' || r || ' ' || j::text)::text);
  END IF;
  -- Again: the chat is held now, nothing more happens.
  j := assignment_compass_assign(a_acct, cv[12], u_a1, u_a3, 'TBK');
  n := n + 1;
  IF j->>'reason' <> 'already_assigned'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[12]) IS DISTINCT FROM u_a2
     OR (SELECT count(*) FROM notifications
          WHERE conversation_id = cv[12] AND user_id = u_a3 AND type = 'conversation_shared') <> 1 THEN
    failed := array_append(failed, ('compass touched a held chat: ' || j::text)::text);
  END IF;
  -- A deactivated agent is not assigned; a non-coordinator gets no share.
  j := assignment_compass_assign(a_acct, cv[7], u_gone, u_a1, 'TBK');
  n := n + 1;
  IF j->>'assigned_to' IS NOT NULL OR j->>'share_reason' <> 'not_coordinator'
     OR (SELECT assigned_agent_id FROM conversations WHERE id = cv[7]) IS NOT NULL
     OR EXISTS (SELECT 1 FROM conversation_coordinator_shares WHERE conversation_id = cv[7]) THEN
    failed := array_append(failed, ('compass assigned a deactivated agent or shared with a non-coordinator: ' || j::text)::text);
  END IF;

  -- ---------- grants ----------
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.assignment_rotate_assign(uuid, uuid, text, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.assignment_rotate_assign(uuid, uuid, text, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assignment_compass_assign(uuid, uuid, uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assignment_open_load(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assignment_is_eligible(uuid, uuid, boolean, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.assignment_rotate_assign(uuid, uuid, text, uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.assignment_compass_assign(uuid, uuid, uuid, uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.assignment_member_loads()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.assignment_settings_set(boolean, uuid[], boolean, boolean, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.assignment_chat_limit_set(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.assignment_settings_set(boolean, uuid[], boolean, boolean, integer)', 'EXECUTE') THEN
    failed := array_append(failed, 'function grants are wrong'::text);
  END IF;
  n := n + 1;
  IF has_table_privilege('authenticated', 'public.assignment_rotation_state', 'SELECT')
     OR has_table_privilege('authenticated', 'public.assignment_settings', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.assignment_chat_limits', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.assignment_settings', 'SELECT') THEN
    failed := array_append(failed, 'table grants are wrong'::text);
  END IF;
  -- A direct client write is refused.
  r := pg_temp.tb_try('authenticated', u_admin,
    format('UPDATE public.assignment_settings SET limits_enabled = false WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('a client wrote assignment_settings directly: ' || r)::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT236', MESSAGE = 'verify-assignment-rotation rollback';
  EXCEPTION WHEN SQLSTATE 'ZT236' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'assignment rotation verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'assignment rotation verification passed (% checks)', n;
END
$verify$;
