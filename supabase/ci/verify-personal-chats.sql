-- Behavioural regression suite for separate personal chats
-- (migration 191).
--
-- A chat on an agent's personal number is that agent's personal chat
-- (conversations.personal_owner_id), kept apart from the company chat
-- with the same customer: both may exist side by side, one of each per
-- contact. A personal chat belongs to its owner, is never assigned to
-- anyone else, lives only on the owner's personal number, never turns
-- into a company chat (or back), and is seen only by admins, its owner
-- and the owner's team leaders. It is never shared with a coordinator,
-- never moves the contact's owner (169), and history is imported into
-- it only through import_history_rows. This asserts each of those
-- through the real RLS and the guard, plus the import job claim and
-- the privileges.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000191001';
  u_admin  UUID := '00000000-0000-4000-8000-000000191002';
  u_p      UUID := '00000000-0000-4000-8000-000000191003';  -- has a personal number
  u_lead   UUID := '00000000-0000-4000-8000-000000191004';  -- leads P's team
  u_x      UUID := '00000000-0000-4000-8000-000000191005';  -- owns the company chat
  u_y      UUID := '00000000-0000-4000-8000-000000191006';  -- unrelated agent
  u_v      UUID := '00000000-0000-4000-8000-000000191007';  -- viewer
  a_acct   UUID;
  t_team   UUID;
  w_pn     UUID;  -- P's personal number
  w_co     UUID;  -- a company number
  c_ct     UUID;  -- customer C, X's contact
  c_ct2    UUID;  -- a second customer, P's contact
  cv_co    UUID;  -- C's company chat (X's)
  cv_pc    UUID;  -- C's personal chat on P's number
  v_n      INT;
  v_at     TIMESTAMPTZ;
  v_unread INT;
  v_owner  UUID;
  v_cfg    UUID;
  u        UUID;
  who      TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: 'ok' / the value, or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pc_try(p_uid uuid, p_sql text)
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

  -- The same as the table owner (no JWT role): triggers and constraints
  -- bind every writer, so these refusals must hold here too.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pc_raw(p_sql text)
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
  -- an account of their own, and everyone but the owner moves into the
  -- owner's.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'pc-owner@example.invalid'),
    (u_admin, 'pc-admin@example.invalid'),
    (u_p,     'pc-p@example.invalid'),
    (u_lead,  'pc-lead@example.invalid'),
    (u_x,     'pc-x@example.invalid'),
    (u_y,     'pc-y@example.invalid'),
    (u_v,     'pc-v@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_p, u_x, u_y);
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_v;
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_p;
  INSERT INTO teams (account_id, name, leader_user_id)
    VALUES (a_acct, 'PC team', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_p, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
    VALUES (u_p, a_acct, 'openwa', 'pc-sess-p', 't', true) RETURNING id INTO w_pn;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token)
    VALUES (u_owner, a_acct, 'openwa', 'pc-sess-co', 't') RETURNING id INTO w_co;

  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_x, '971500191001', 'PC customer') RETURNING id INTO c_ct;
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_p, '971500191002', 'PC customer 2') RETURNING id INTO c_ct2;

  -- ---- Company and personal chats side by side ---------------------
  PERFORM set_config('request.jwt.claim.sub', u_owner::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
    VALUES (a_acct, u_x, c_ct, w_co) RETURNING id INTO cv_co;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id, personal_owner_id)
    VALUES (a_acct, u_p, c_ct, w_pn, u_p) RETURNING id INTO cv_pc;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_type, content_text)
    VALUES (cv_co, 'agent', u_x, 'text', 'company hello'),
           (cv_pc, 'agent', u_p, 'text', 'personal hello');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  n := n + 1;
  IF cv_co IS NULL OR cv_pc IS NULL THEN
    failed := array_append(failed, 'the company and the personal chat of one contact cannot coexist'::text);
  END IF;

  r := pg_temp.pc_raw(format(
    'INSERT INTO conversations (account_id, user_id, contact_id, channel_id, personal_owner_id)
     VALUES (%L, %L, %L, %L, %L)', a_acct, u_p, c_ct, w_pn, u_p));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505%' THEN
    failed := array_append(failed, ('a second personal chat for (C, P): ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'INSERT INTO conversations (account_id, user_id, contact_id) VALUES (%L, %L, %L)',
    a_acct, u_y, c_ct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505%' THEN
    failed := array_append(failed, ('a second company chat for C: ' || r)::text);
  END IF;

  -- ---- The guard ---------------------------------------------------
  r := pg_temp.pc_raw(format(
    'UPDATE conversations SET assigned_agent_id = %L WHERE id = %L', u_x, cv_pc));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a personal chat assigned to someone else: ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'UPDATE conversations SET user_id = %L WHERE id = %L', u_x, cv_pc));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a personal chat handed to another user_id: ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'UPDATE conversations SET channel_id = %L WHERE id = %L', w_pn, cv_co));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a company chat moved onto a personal number: ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'UPDATE conversations SET channel_id = %L WHERE id = %L', w_co, cv_pc));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a personal chat moved onto a company number: ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'UPDATE conversations SET personal_owner_id = NULL WHERE id = %L', cv_pc));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a personal chat became a company chat: ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'UPDATE conversations SET personal_owner_id = %L WHERE id = %L', u_x, cv_co));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a company chat became a personal chat: ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id)
     VALUES (%L, %L, %L, %L)', a_acct, u_v, c_ct2, u_v));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a personal chat owned by a viewer: ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id)
     VALUES (%L, %L, %L, %L)', a_acct, u_x, c_ct2, u_p));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a personal chat whose user_id is not its owner: ' || r)::text);
  END IF;

  -- ---- Who sees what (the real RLS) --------------------------------
  -- personal chat rows, its messages, company chat rows
  FOR u, who IN SELECT * FROM (VALUES (u_owner, 'owner'), (u_admin, 'admin'),
                                      (u_p, 'number owner'), (u_lead, 'owner''s leader'),
                                      (u_x, 'company chat owner'), (u_y, 'unrelated agent')) s
  LOOP
    r := pg_temp.pc_try(u, format(
      'SELECT concat_ws('','',
         (SELECT count(*) FROM conversations WHERE id = %1$L),
         (SELECT count(*) FROM messages WHERE conversation_id = %1$L),
         (SELECT count(*) FROM conversations WHERE id = %2$L))', cv_pc, cv_co));
    n := n + 1;
    IF r <> (CASE WHEN u IN (u_owner, u_admin) THEN '1,1,1'
                  WHEN u IN (u_p, u_lead) THEN '1,1,0'
                  WHEN u = u_x THEN '0,0,1'
                  ELSE '0,0,0' END) THEN
      failed := array_append(failed, (who || ' sees (personal, its messages, company) = ' || r)::text);
    END IF;
  END LOOP;

  -- ---- Opening a personal chat (insert policy) ---------------------
  r := pg_temp.pc_try(u_p, format(
    'INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id)
     VALUES (%L, %L, %L, %L)', a_acct, u_y, c_ct2, u_y));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an agent opened someone else''s personal chat: ' || r)::text);
  END IF;
  r := pg_temp.pc_try(u_p, format(
    'INSERT INTO conversations (account_id, user_id, contact_id, channel_id, personal_owner_id)
     VALUES (%L, %L, %L, %L, %L)', a_acct, u_p, c_ct2, w_pn, u_p));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('an agent could not open their own personal chat: ' || r)::text);
  END IF;

  -- ---- Coordinator shares ------------------------------------------
  r := pg_temp.pc_try(u_p, format(
    'SELECT share_conversation_with_coordinator(%L, %L, ''ADCB'')::text', cv_pc, u_lead));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a personal chat shared with a coordinator: ' || r)::text);
  END IF;
  r := pg_temp.pc_raw(format(
    'INSERT INTO conversation_coordinator_shares (account_id, conversation_id, coordinator_user_id, bank_code)
     VALUES (%L, %L, %L, ''ADCB'')', a_acct, cv_pc, u_lead));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('a share row on a personal chat: ' || r)::text);
  END IF;

  -- ---- 169: a personal chat never moves the contact's owner --------
  UPDATE conversations SET assigned_agent_id = u_p WHERE id = cv_pc;
  SELECT user_id INTO v_owner FROM contacts WHERE id = c_ct;
  n := n + 1;
  IF v_owner IS DISTINCT FROM u_x THEN
    failed := array_append(failed, ('assigning the personal chat moved the contact''s owner to ' || coalesce(v_owner::text, 'NULL'))::text);
  END IF;

  -- ---- import_history_rows -----------------------------------------
  UPDATE conversations
     SET unread_count = 3, last_message_at = '2026-01-01T00:00:00Z'
   WHERE id = cv_pc;
  v_n := import_history_rows(cv_pc, jsonb_build_array(
    jsonb_build_object('sender_type', 'agent', 'sender_id', u_p, 'content_text', 'old one',
                       'message_id', 'pc-h1', 'created_at', '2026-01-02T00:00:00Z'),
    jsonb_build_object('sender_type', 'agent', 'sender_id', u_p, 'content_text', 'old two',
                       'message_id', 'pc-h2', 'created_at', '2026-01-03T00:00:00Z')));
  n := n + 1;
  IF v_n IS DISTINCT FROM 2 THEN
    failed := array_append(failed, ('import_history_rows inserted ' || coalesce(v_n::text, 'NULL') || ', not 2')::text);
  END IF;
  SELECT last_message_at, unread_count INTO v_at, v_unread FROM conversations WHERE id = cv_pc;
  n := n + 1;
  IF v_at IS DISTINCT FROM '2026-01-03T00:00:00Z'::timestamptz OR v_unread IS DISTINCT FROM 3 THEN
    failed := array_append(failed, format('after an import: last_message_at %s, unread %s', v_at, v_unread));
  END IF;

  v_n := import_history_rows(cv_pc, jsonb_build_array(
    jsonb_build_object('sender_type', 'agent', 'sender_id', u_p, 'content_text', 'old one',
                       'message_id', 'pc-h1', 'created_at', '2026-01-02T00:00:00Z'),
    jsonb_build_object('sender_type', 'agent', 'sender_id', u_p, 'content_text', 'old two',
                       'message_id', 'pc-h2', 'created_at', '2026-01-03T00:00:00Z')));
  n := n + 1;
  IF v_n IS DISTINCT FROM 0 THEN
    failed := array_append(failed, ('a replayed import inserted ' || coalesce(v_n::text, 'NULL'))::text);
  END IF;

  -- An older batch (and a row with a blank message_id, skipped) does
  -- not move the summary back.
  v_n := import_history_rows(cv_pc, jsonb_build_array(
    jsonb_build_object('sender_type', 'agent', 'sender_id', u_p, 'content_text', 'older',
                       'message_id', 'pc-h0', 'created_at', '2025-06-01T00:00:00Z'),
    jsonb_build_object('sender_type', 'agent', 'sender_id', u_p, 'content_text', 'no id',
                       'message_id', '  ', 'created_at', '2025-06-02T00:00:00Z')));
  n := n + 1;
  IF v_n IS DISTINCT FROM 1 THEN
    failed := array_append(failed, ('an older batch with one blank id inserted ' || coalesce(v_n::text, 'NULL') || ', not 1')::text);
  END IF;
  SELECT last_message_at, unread_count INTO v_at, v_unread FROM conversations WHERE id = cv_pc;
  n := n + 1;
  IF v_at IS DISTINCT FROM '2026-01-03T00:00:00Z'::timestamptz OR v_unread IS DISTINCT FROM 3 THEN
    failed := array_append(failed, format('an older batch moved the chat: last_message_at %s, unread %s', v_at, v_unread));
  END IF;

  r := pg_temp.pc_raw(format('SELECT import_history_rows(%L, ''[]''::jsonb)::text', cv_co));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514 PERSONAL_CHAT%' THEN
    failed := array_append(failed, ('history imported into a company chat: ' || r)::text);
  END IF;

  -- ---- claim_personal_history_import -------------------------------
  INSERT INTO personal_history_imports (config_id, account_id, user_id)
    VALUES (w_pn, a_acct, u_p);
  SELECT count(*), max(config_id::text)::uuid INTO v_n, v_cfg FROM claim_personal_history_import(60);
  n := n + 1;
  IF v_n IS DISTINCT FROM 1 OR v_cfg IS DISTINCT FROM w_pn THEN
    failed := array_append(failed, format('the first claim returned %s rows (%s)', v_n, v_cfg));
  END IF;
  SELECT count(*) INTO v_n FROM claim_personal_history_import(60);
  n := n + 1;
  IF v_n IS DISTINCT FROM 0 THEN
    failed := array_append(failed, ('a leased import was claimed again: ' || v_n)::text);
  END IF;
  r := pg_temp.pc_raw('SELECT count(*)::text FROM claim_personal_history_import(0)');
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023%' THEN
    failed := array_append(failed, ('a zero-second lease: ' || r)::text);
  END IF;

  -- ---- 169 still moves a company chat's contact (control) ----------
  UPDATE conversations SET assigned_agent_id = u_y WHERE id = cv_co;
  SELECT user_id INTO v_owner FROM contacts WHERE id = c_ct;
  n := n + 1;
  IF v_owner IS DISTINCT FROM u_y THEN
    failed := array_append(failed, ('control: assigning the company chat left the contact with ' || coalesce(v_owner::text, 'NULL'))::text);
  END IF;

  -- ---- Privileges --------------------------------------------------
  n := n + 1;
  IF has_table_privilege('anon', 'public.personal_history_imports', 'SELECT')
     OR has_table_privilege('authenticated', 'public.personal_history_imports', 'SELECT')
     OR has_table_privilege('anon', 'public.personal_history_import_chats', 'SELECT')
     OR has_table_privilege('authenticated', 'public.personal_history_import_chats', 'SELECT') THEN
    failed := array_append(failed, 'clients may read the history import tables'::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('anon', 'public.claim_personal_history_import(int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_personal_history_import(int)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.import_history_rows(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.import_history_rows(uuid, jsonb)', 'EXECUTE') THEN
    failed := array_append(failed, 'clients may execute the history import RPCs'::text);
  END IF;
  n := n + 1;
  IF NOT has_function_privilege('service_role', 'public.claim_personal_history_import(int)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.import_history_rows(uuid, jsonb)', 'EXECUTE') THEN
    failed := array_append(failed, 'the service role cannot execute the history import RPCs'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT191', MESSAGE = 'verify-personal-chats rollback';
  EXCEPTION WHEN SQLSTATE 'ZT191' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'personal chats verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'personal chats verification passed (% checks)', n;
END
$verify$;
