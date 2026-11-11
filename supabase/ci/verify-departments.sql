-- Behavioural regression suite for departments and department inboxes
-- (migration 192).
--
-- A person has a department in each workspace (profiles.department,
-- 'sales' by default), set only by an owner/admin through
-- set_member_department. A department with its own inbox (hr by
-- default, account_departments otherwise) pulls the chats its members
-- are assigned, or own unassigned, out of the main inbox:
-- conversations.inbox_department, derived by trigger for every writer
-- and recomputed when a person's department or a department's switch
-- changes. This asserts each of those through the real RLS, the
-- triggers and the RPCs, plus the defaults and the privileges.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000192001';
  u_admin  UUID := '00000000-0000-4000-8000-000000192002';
  u_h      UUID := '00000000-0000-4000-8000-000000192003';  -- becomes HR
  u_s      UUID := '00000000-0000-4000-8000-000000192004';  -- stays sales
  u_r      UUID := '00000000-0000-4000-8000-000000192005';  -- HR, then leaves
  u_out    UUID := '00000000-0000-4000-8000-000000192006';  -- another workspace
  a_acct   UUID;
  a_r_own  UUID;  -- R's own provisioned account
  w_pn     UUID;  -- H's personal number
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; c5 UUID; c6 UUID;
  cv1      UUID;  -- owned by H, unassigned
  cv2      UUID;  -- owned by S, assigned to H
  cv3      UUID;  -- owned by H, assigned to S
  cv4      UUID;  -- owned by S, unassigned (control)
  cv_pc    UUID;  -- H's personal chat
  cv_r     UUID;  -- owned by R, unassigned
  v_t      TEXT;
  v_n      INT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: 'ok' / the value, or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dp_try(p_uid uuid, p_sql text)
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

  -- The same as the table owner (no JWT role): the trigger binds every
  -- writer, the service role included.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dp_raw(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      IF p_sql ILIKE 'select%' THEN
        EXECUTE p_sql INTO v;
      ELSE
        EXECUTE p_sql;
      END IF;
      RETURN coalesce(nullif(v, ''), 'ok');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                              m = MESSAGE_TEXT;
      RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
    END $body$
  $fn$;

  -- Fixture: one account; the auth.users trigger provisions each person
  -- an account of their own, and everyone but the owner and u_out moves
  -- into the owner's.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'dp-owner@example.invalid'),
    (u_admin, 'dp-admin@example.invalid'),
    (u_h,     'dp-h@example.invalid'),
    (u_s,     'dp-s@example.invalid'),
    (u_r,     'dp-r@example.invalid'),
    (u_out,   'dp-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO a_r_own FROM accounts WHERE owner_user_id = u_r;
  IF a_acct IS NULL OR a_r_own IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_h, u_s, u_r);
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_h;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
    VALUES (u_h, a_acct, 'openwa', 'dp-sess-h', 't', true) RETURNING id INTO w_pn;

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_h, '971500192001', 'DP 1') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_s, '971500192002', 'DP 2') RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_h, '971500192003', 'DP 3') RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_s, '971500192004', 'DP 4') RETURNING id INTO c4;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_h, '971500192005', 'DP 5') RETURNING id INTO c5;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_r, '971500192006', 'DP 6') RETURNING id INTO c6;

  INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES (a_acct, u_h, c1) RETURNING id INTO cv1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_s, c2, u_h) RETURNING id INTO cv2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_h, c3, u_s) RETURNING id INTO cv3;
  INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES (a_acct, u_s, c4) RETURNING id INTO cv4;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id, personal_owner_id)
    VALUES (a_acct, u_h, c5, w_pn, u_h) RETURNING id INTO cv_pc;
  INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES (a_acct, u_r, c6) RETURNING id INTO cv_r;

  -- ---- Defaults ------------------------------------------------------
  SELECT department INTO v_t FROM profiles WHERE user_id = u_h AND account_id = a_acct;
  n := n + 1;
  IF v_t IS DISTINCT FROM 'sales' THEN
    failed := array_append(failed, ('a new member''s department is ' || coalesce(v_t, 'NULL'))::text);
  END IF;
  SELECT count(*) INTO v_n FROM conversations
   WHERE account_id = a_acct AND inbox_department IS NOT NULL;
  n := n + 1;
  IF v_n <> 0 THEN
    failed := array_append(failed, ('sales chats sit in a department inbox: ' || v_n)::text);
  END IF;
  n := n + 1;
  IF NOT (department_own_inbox(a_acct, 'hr') AND department_restricted(a_acct, 'hr'))
     OR department_own_inbox(a_acct, 'sales') OR department_restricted(a_acct, 'sales')
     OR department_own_inbox(a_acct, 'it') OR department_restricted(a_acct, 'it')
     OR department_own_inbox(a_acct, 'accounts') OR department_restricted(a_acct, 'accounts') THEN
    failed := array_append(failed, 'built-in defaults are not hr on/on, the rest off/off'::text);
  END IF;

  -- ---- Who may set a department -------------------------------------
  r := pg_temp.dp_try(u_h, format(
    'UPDATE profiles SET department = ''hr'' WHERE user_id = %L AND account_id = %L', u_h, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 :%' THEN
    failed := array_append(failed, ('a person set their own department: ' || r)::text);
  END IF;
  SELECT department INTO v_t FROM profiles WHERE user_id = u_h AND account_id = a_acct;
  n := n + 1;
  IF v_t IS DISTINCT FROM 'sales' THEN
    failed := array_append(failed, ('self-update changed the department to ' || coalesce(v_t, 'NULL'))::text);
  END IF;
  r := pg_temp.dp_try(u_s, format('SELECT set_member_department(%L, ''hr'')', u_h));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 not_admin%' THEN
    failed := array_append(failed, ('an agent set a department: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, format('SELECT set_member_department(%L, ''legal'')', u_h));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 bad_department%' THEN
    failed := array_append(failed, ('an unknown department was accepted: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, format('SELECT set_member_department(%L, ''hr'')', u_out));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0002 no_member%' THEN
    failed := array_append(failed, ('a person outside the workspace was given a department: ' || r)::text);
  END IF;

  -- ---- Setting H to HR moves H's chats -------------------------------
  r := pg_temp.dp_try(u_admin, format('SELECT set_member_department(%L, ''hr'')', u_h));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the admin could not set HR: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT inbox_department FROM conversations WHERE id = cv1) IS DISTINCT FROM 'hr' THEN
    failed := array_append(failed, 'a chat owned by an HR person (unassigned) is not in the HR inbox'::text);
  END IF;
  n := n + 1;
  IF (SELECT inbox_department FROM conversations WHERE id = cv2) IS DISTINCT FROM 'hr' THEN
    failed := array_append(failed, 'a sales chat assigned to an HR person is not in the HR inbox'::text);
  END IF;
  n := n + 1;
  IF (SELECT inbox_department FROM conversations WHERE id = cv3) IS NOT NULL THEN
    failed := array_append(failed, 'an HR-owned chat assigned to sales left the main inbox (assignee must win)'::text);
  END IF;
  n := n + 1;
  IF (SELECT inbox_department FROM conversations WHERE id = cv4) IS NOT NULL THEN
    failed := array_append(failed, 'control: an untouched sales chat moved'::text);
  END IF;
  n := n + 1;
  IF (SELECT inbox_department FROM conversations WHERE id = cv_pc) IS DISTINCT FROM 'hr' THEN
    failed := array_append(failed, 'an HR person''s personal chat is not in the HR inbox'::text);
  END IF;

  -- ---- Assignment changes recompute ---------------------------------
  r := pg_temp.dp_raw(format('UPDATE conversations SET assigned_agent_id = NULL WHERE id = %L', cv2));
  n := n + 1;
  IF r <> 'ok' OR (SELECT inbox_department FROM conversations WHERE id = cv2) IS NOT NULL THEN
    failed := array_append(failed, ('unassigning a sales-owned chat from HR left it in the HR inbox: ' || r)::text);
  END IF;
  r := pg_temp.dp_raw(format('UPDATE conversations SET assigned_agent_id = NULL WHERE id = %L', cv3));
  n := n + 1;
  IF r <> 'ok' OR (SELECT inbox_department FROM conversations WHERE id = cv3) IS DISTINCT FROM 'hr' THEN
    failed := array_append(failed, ('unassigning an HR-owned chat did not fall back to the owner: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, format('UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_h, cv4));
  n := n + 1;
  IF r <> 'ok' OR (SELECT inbox_department FROM conversations WHERE id = cv4) IS DISTINCT FROM 'hr' THEN
    failed := array_append(failed, ('assigning a chat to an HR person did not move it: ' || r)::text);
  END IF;

  -- ---- inbox_department is derived, never written -------------------
  r := pg_temp.dp_try(u_admin, format('UPDATE conversations SET inbox_department = NULL WHERE id = %L', cv1));
  n := n + 1;
  IF r <> 'ok' OR (SELECT inbox_department FROM conversations WHERE id = cv1) IS DISTINCT FROM 'hr' THEN
    failed := array_append(failed, ('a client took a chat out of the HR inbox directly: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, format('UPDATE conversations SET inbox_department = ''hr'' WHERE id = %L', cv2));
  n := n + 1;
  IF r <> 'ok' OR (SELECT inbox_department FROM conversations WHERE id = cv2) IS NOT NULL THEN
    failed := array_append(failed, ('a client put a sales chat in the HR inbox directly: ' || r)::text);
  END IF;
  r := pg_temp.dp_raw(format('UPDATE conversations SET inbox_department = ''it'' WHERE id = %L', cv2));
  n := n + 1;
  IF r <> 'ok' OR (SELECT inbox_department FROM conversations WHERE id = cv2) IS NOT NULL THEN
    failed := array_append(failed, ('the table owner wrote inbox_department directly: ' || r)::text);
  END IF;
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_s, '971500192007', 'DP 7') RETURNING id INTO c2;
  INSERT INTO conversations (account_id, user_id, contact_id, inbox_department)
    VALUES (a_acct, u_s, c2, 'it') RETURNING inbox_department INTO v_t;
  n := n + 1;
  IF v_t IS NOT NULL THEN
    failed := array_append(failed, ('an INSERT kept a supplied inbox_department: ' || v_t)::text);
  END IF;

  -- ---- Department switches -------------------------------------------
  r := pg_temp.dp_try(u_s, 'SELECT set_department_settings(''hr'', false, true)');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 not_admin%' THEN
    failed := array_append(failed, ('an agent changed department settings: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, 'SELECT set_department_settings(''legal'', false, true)');
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 bad_department%' THEN
    failed := array_append(failed, ('settings for an unknown department were accepted: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, 'SELECT set_department_settings(''hr'', NULL, true)');
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023 bad_settings%' THEN
    failed := array_append(failed, ('a NULL switch was accepted: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, 'SELECT set_department_settings(''hr'', false, true)');
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the admin could not switch the HR inbox off: ' || r)::text);
  END IF;
  SELECT count(*) INTO v_n FROM conversations WHERE account_id = a_acct AND inbox_department = 'hr';
  n := n + 1;
  IF v_n <> 0 THEN
    failed := array_append(failed, ('switching the HR inbox off left chats in it: ' || v_n)::text);
  END IF;
  n := n + 1;
  IF department_own_inbox(a_acct, 'hr') OR NOT department_restricted(a_acct, 'hr') THEN
    failed := array_append(failed, 'the saved HR row is not what department_own_inbox/restricted answer'::text);
  END IF;
  r := pg_temp.dp_try(u_admin, 'SELECT set_department_settings(''hr'', true, true)');
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the admin could not switch the HR inbox on: ' || r)::text);
  END IF;
  SELECT count(*) INTO v_n FROM conversations
   WHERE id IN (cv1, cv3, cv4, cv_pc, cv_r) AND inbox_department = 'hr';
  n := n + 1;
  IF v_n <> 4 OR (SELECT inbox_department FROM conversations WHERE id = cv2) IS NOT NULL THEN
    failed := array_append(failed, ('switching the HR inbox back on restored ' || v_n || ' of 4 chats')::text);
  END IF;

  -- ---- A person leaving or changing department -----------------------
  r := pg_temp.dp_try(u_admin, format('SELECT set_member_department(%L, ''hr'')', u_r));
  n := n + 1;
  IF r <> 'ok' OR (SELECT inbox_department FROM conversations WHERE id = cv_r) IS DISTINCT FROM 'hr' THEN
    failed := array_append(failed, ('R''s chat did not follow R into HR: ' || r)::text);
  END IF;
  UPDATE profiles SET account_id = a_r_own WHERE user_id = u_r;
  n := n + 1;
  IF (SELECT inbox_department FROM conversations WHERE id = cv_r) IS NOT NULL THEN
    failed := array_append(failed, 'a chat stayed in the HR inbox after its owner left the workspace'::text);
  END IF;
  r := pg_temp.dp_try(u_admin, format('SELECT set_member_department(%L, ''sales'')', u_h));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('the admin could not set H back to sales: ' || r)::text);
  END IF;
  SELECT count(*) INTO v_n FROM conversations WHERE account_id = a_acct AND inbox_department IS NOT NULL;
  n := n + 1;
  IF v_n <> 0 THEN
    failed := array_append(failed, ('chats stayed in a department inbox after H went back to sales: ' || v_n)::text);
  END IF;

  -- ---- account_departments: members read, nobody writes --------------
  r := pg_temp.dp_try(u_s, format('SELECT count(*) FROM account_departments WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('a member cannot read the department settings: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_out, format('SELECT count(*) FROM account_departments WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('another workspace reads the department settings: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, format(
    'INSERT INTO account_departments (account_id, department, own_inbox, restricted) VALUES (%L, ''it'', true, true)', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin inserted department settings directly: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, format(
    'UPDATE account_departments SET own_inbox = false WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin updated department settings directly: ' || r)::text);
  END IF;
  r := pg_temp.dp_try(u_admin, format('DELETE FROM account_departments WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin deleted department settings directly: ' || r)::text);
  END IF;

  -- ---- Privileges --------------------------------------------------
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.refresh_inbox_departments(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refresh_inbox_departments(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.conversation_inbox_department(uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.conversation_inbox_department(uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_member_department(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_department_settings(text, boolean, boolean)', 'EXECUTE') THEN
    failed := array_append(failed, 'clients may execute the department internals'::text);
  END IF;
  n := n + 1;
  IF NOT has_function_privilege('authenticated', 'public.set_member_department(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_department_settings(text, boolean, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.department_restricted(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.department_own_inbox(uuid, text)', 'EXECUTE') THEN
    failed := array_append(failed, 'signed-in users cannot execute the department RPCs'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT192', MESSAGE = 'verify-departments rollback';
  EXCEPTION WHEN SQLSTATE 'ZT192' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'departments verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'departments verification passed (% checks)', n;
END
$verify$;
