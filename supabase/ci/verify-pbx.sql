-- Behavioural regression suite for the phone system (migration 089).
--
-- Who sees a call is RLS through pbx_can_view_call(): the caller's
-- active account, and team leader or above, a party to the call (its
-- person or, on an internal call, the peer) or someone who can see its
-- contact; a bank guest sees nothing. The screen pop (call_live) shows
-- the people it rings, the answerer and leaders. Writes are the service
-- role's, except three SECURITY DEFINER functions that re-check the
-- caller: the disposition, re-linking a contact and the owner's
-- erasure. A recording is playable only when fetched, not erased and
-- announced, call_access_log refuses a row otherwise and is
-- append-only. Secrets, the token cache and the recordings bucket are
-- the service role's alone. This asserts those rules, extension
-- mapping, the token compare-and-set, pbx_purge and anon's grants.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000089001';
  u_admin  UUID := '00000000-0000-4000-8000-000000089002';
  u_lead   UUID := '00000000-0000-4000-8000-000000089003';
  u_agent  UUID := '00000000-0000-4000-8000-000000089004';
  u_agent2 UUID := '00000000-0000-4000-8000-000000089005';
  u_agent3 UUID := '00000000-0000-4000-8000-000000089006';
  u_viewer UUID := '00000000-0000-4000-8000-000000089007';
  u_guest  UUID := '00000000-0000-4000-8000-000000089008';
  u_other  UUID := '00000000-0000-4000-8000-000000089009';
  a_acct   UUID;
  b_acct   UUID;
  conn     UUID;
  c_agent  UUID;   -- the agent's customer
  c_agent2 UUID;   -- the other agent's customer: the agent cannot see it
  c_x      UUID;   -- another of the other agent's customers
  c_hold   UUID;   -- the agent's customer whose recording is under legal hold
  cv_agent UUID;
  cv_x     UUID;
  k_cust   UUID;   -- the agent's customer, taken by the other agent; recorded
  k_int    UUID;   -- internal: the agent called the other agent
  k_other  UUID;   -- the other agent's customer
  k_mis    UUID;   -- the agent's call, matched to the wrong customer
  k_hold   UUID;   -- recorded, under legal hold
  k_held   UUID;   -- recorded, the announcement not confirmed played
  path_cust TEXT;
  q_ext    TEXT := 'INSERT INTO pbx_extensions (connection_id, extension, account_id, user_id) VALUES (%L, %L, %L, %L)';
  q_log    TEXT := 'INSERT INTO call_access_log (call_id, account_id, user_id, action) VALUES (%L, %L, %L, %L)';
  q_live   TEXT := 'SELECT count(*)::text FROM call_live WHERE pbx_call_id = ''px-live''';
  q_swap   TEXT := 'SELECT pbx_token_swap(%L, %L, %L)::text';
  ts1      TIMESTAMPTZ;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given): a
  -- SELECT's value ('ok' when it is void), 'ok', or the error as
  -- 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.px_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(NULLIF(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: account A (owner, admin, team leader, three agents, a
  -- viewer, a bank guest), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'px-owner@example.invalid'),
    (u_admin,  'px-admin@example.invalid'),
    (u_lead,   'px-lead@example.invalid'),
    (u_agent,  'px-agent@example.invalid'),
    (u_agent2, 'px-agent2@example.invalid'),
    (u_agent3, 'px-agent3@example.invalid'),
    (u_viewer, 'px-viewer@example.invalid'),
    (u_guest,  'px-guest@example.invalid'),
    (u_other,  'px-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_agent3);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500089001', 'PX agent customer') RETURNING id INTO c_agent;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent2, '971500089002', 'PX agent2 customer') RETURNING id INTO c_agent2;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent2, '971500089003', 'PX wrong match') RETURNING id INTO c_x;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500089004', 'PX legal hold') RETURNING id INTO c_hold;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c_agent) RETURNING id INTO cv_agent;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent2, c_agent2);
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent2, c_x) RETURNING id INTO cv_x;

  INSERT INTO pbx_connections (account_id, label, edition, base_url)
  VALUES (a_acct, 'PX PBX', 'cloud', 'https://px.example.invalid') RETURNING id INTO conn;
  INSERT INTO pbx_connection_secrets (connection_id, client_id_enc) VALUES (conn, 'px-enc');

  INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id,
                     contact_id, conversation_id, status, started_at, talk_seconds, recording_state)
  VALUES (a_acct, conn, 'px-cust', 'inbound', '102', u_agent2, c_agent, cv_agent, 'answered',
          '2026-10-01 09:00:00+00', 120, 'fetched') RETURNING id INTO k_cust;
  INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, peer_user_id)
  VALUES (a_acct, conn, 'px-int', 'internal', '101', u_agent, u_agent2) RETURNING id INTO k_int;
  INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, contact_id)
  VALUES (a_acct, conn, 'px-other', 'inbound', '102', u_agent2, c_agent2) RETURNING id INTO k_other;
  INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, contact_id, conversation_id)
  VALUES (a_acct, conn, 'px-mis', 'outbound', '101', u_agent, c_x, cv_x) RETURNING id INTO k_mis;
  INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, contact_id, recording_state)
  VALUES (a_acct, conn, 'px-hold', 'inbound', '101', u_agent, c_hold, 'fetched') RETURNING id INTO k_hold;
  INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, recording_state)
  VALUES (a_acct, conn, 'px-held', 'inbound', '101', u_agent, 'fetched') RETURNING id INTO k_held;
  path_cust := format('account-%s/px-cust.wav', a_acct);
  INSERT INTO call_recordings (call_id, account_id, storage_path, announcement_played, legal_hold) VALUES
    (k_cust, a_acct, path_cust, true, false),
    (k_hold, a_acct, format('account-%s/px-hold.wav', a_acct), true, true),
    (k_held, a_acct, format('account-%s/px-held.wav', a_acct), false, false);
  INSERT INTO storage.objects (bucket_id, name) VALUES ('call-recordings', path_cust);

  INSERT INTO call_live (connection_id, pbx_call_id, account_id, ringing_user_ids, answered_by)
  VALUES (conn, 'px-live', a_acct, ARRAY[u_agent], u_agent2);
  INSERT INTO call_live (connection_id, pbx_call_id, account_id, updated_at)
  VALUES (conn, 'px-stale', a_acct, now() - interval '2 days');
  INSERT INTO pbx_events_raw (connection_id, payload, hash, received_at, processed_at) VALUES
    (conn, '{}', 'px-old', now() - interval '40 days', now() - interval '31 days'),
    (conn, '{}', 'px-recent', now() - interval '2 days', now() - interval '1 day'),
    (conn, '{}', 'px-pending', now() - interval '40 days', NULL);
  INSERT INTO pbx_events_raw (connection_id, payload, hash, received_at, error, attempts) VALUES
    (conn, '{}', 'px-dead', now() - interval '40 days', 'boom', 3),
    (conn, '{}', 'px-retrying', now() - interval '40 days', 'boom', 2),
    (conn, '{}', 'px-dead-recent', now() - interval '2 days', 'boom', 3);
  INSERT INTO pbx_bank_numbers (account_id, number, bank_code) VALUES (a_acct, '97142089000', 'ADCB');

  -- ---------- extension mapping (the processor writes, as the service role) ----------
  r := pg_temp.px_try('service_role', NULL, format(q_ext, conn, '101', a_acct, u_agent));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('an agent is mapped to an extension: ' || r)::text); END IF;
  r := pg_temp.px_try('service_role', NULL, format(q_ext, conn, '201', a_acct, u_guest));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('a bank guest was mapped: ' || r)::text); END IF;
  r := pg_temp.px_try('service_role', NULL, format(q_ext, conn, '202', a_acct, u_viewer));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('a viewer was mapped: ' || r)::text); END IF;
  r := pg_temp.px_try('service_role', NULL, format(q_ext, conn, '203', a_acct, u_other));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('another account''s user was mapped: ' || r)::text); END IF;
  r := pg_temp.px_try('service_role', NULL, format(q_ext, conn, '105', a_acct, u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505:%' THEN failed := array_append(failed, ('a second extension for one person in one workspace: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_agent, 'SELECT string_agg(extension, '','') FROM pbx_my_extension()');
  n := n + 1;
  IF r <> '101' THEN failed := array_append(failed, ('pbx_my_extension() for the agent: ' || r)::text); END IF;

  -- ---------- who sees a call ----------
  r := pg_temp.px_try('authenticated', u_agent, format('SELECT count(*)::text FROM calls WHERE id = %L', k_cust));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('agent sees a call with their own customer: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_agent, format('SELECT count(*)::text FROM calls WHERE id = %L', k_int));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('agent sees their own internal call: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_agent, format('SELECT count(*)::text FROM calls WHERE id = %L', k_other));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('agent sees another agent''s customer call: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_agent2, format('SELECT count(*)::text FROM calls WHERE id = %L', k_int));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('the peer sees the internal call: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_lead, 'SELECT count(*)::text FROM calls');
  n := n + 1;
  IF r IS DISTINCT FROM (SELECT count(*)::text FROM calls WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('team leader sees every call of the account: ' || r)::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_admin, 'SELECT count(*)::text FROM calls');
  n := n + 1;
  IF r IS DISTINCT FROM (SELECT count(*)::text FROM calls WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('admin sees every call of the account: ' || r)::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_guest, 'SELECT count(*)::text FROM calls');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('a bank guest sees calls: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_other, format('SELECT count(*)::text FROM calls WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('another account sees A''s calls: ' || r)::text); END IF;

  -- ---------- the screen pop ----------
  r := pg_temp.px_try('authenticated', u_agent, q_live);
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('a ringing agent sees the screen pop: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_agent2, q_live);
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('the answerer sees the screen pop: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_agent3, q_live);
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('an agent it does not ring sees the screen pop: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_lead, q_live);
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, ('a team leader sees the screen pop: ' || r)::text); END IF;

  -- ---------- the disposition ----------
  r := pg_temp.px_try('authenticated', u_agent2, format(
    'SELECT pbx_set_disposition(%L, %L, %L)', k_cust, 'interested', '  Wants a card  '));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM calls WHERE id = k_cust AND disposition = 'interested'
       AND notes = 'Wants a card' AND notes_updated_by = u_agent2) THEN
    failed := array_append(failed, ('the call''s person records its outcome: ' || r)::text);
  END IF;
  -- The agent sees this call (their customer) but was not on it.
  r := pg_temp.px_try('authenticated', u_agent, format(
    'SELECT pbx_set_disposition(%L, %L, %L)', k_cust, 'call_back', 'PX overwritten'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' OR (SELECT disposition FROM calls WHERE id = k_cust) <> 'interested' THEN
    failed := array_append(failed, ('another agent recorded a call''s outcome: ' || r)::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_agent2, format(
    'SELECT pbx_set_disposition(%L, %L, %L)', k_cust, 'px_not_a_disposition', NULL));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023:%' THEN failed := array_append(failed, ('an unknown disposition: ' || r)::text); END IF;

  -- ---------- re-linking a call to a contact ----------
  r := pg_temp.px_try('authenticated', u_agent, format('SELECT pbx_link_call_contact(%L, %L)', k_mis, c_agent2));
  n := n + 1;
  IF r NOT LIKE 'ERROR P0002:%' OR (SELECT contact_id FROM calls WHERE id = k_mis) <> c_x THEN
    failed := array_append(failed, ('linked to a contact the agent cannot see: ' || r)::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_agent, format('SELECT pbx_link_call_contact(%L, %L)', k_mis, c_agent));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM calls WHERE id = k_mis
       AND contact_id = c_agent AND conversation_id = cv_agent) THEN
    failed := array_append(failed, ('linking to a visible contact moves the call and its chat: ' || r)::text);
  END IF;

  -- ---------- playback is logged, and only a playable recording ----------
  r := pg_temp.px_try('service_role', NULL, format(q_log, k_cust, a_acct, u_agent2, 'play'));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('a playable recording''s play is logged: ' || r)::text); END IF;
  r := pg_temp.px_try('service_role', NULL, format(q_log, k_held, a_acct, u_agent, 'play'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 55000:%' THEN
    failed := array_append(failed, ('a play of a held recording (announcement not played) was logged: ' || r)::text);
  END IF;
  -- Append-only: the service role has no UPDATE grant, and even the
  -- owner's DELETE is refused by the trigger while the call exists.
  r := pg_temp.px_try('service_role', NULL, format(
    'UPDATE call_access_log SET action = %L WHERE call_id = %L', 'download', k_cust));
  BEGIN
    DELETE FROM call_access_log WHERE call_id = k_cust;
    r := r || ' / ok';
  EXCEPTION WHEN OTHERS THEN
    r := r || ' / ERROR ' || SQLSTATE || ': ' || SQLERRM;
  END;
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:% / ERROR 42501:%'
     OR (SELECT count(*) FROM call_access_log WHERE call_id = k_cust AND action = 'play') <> 1 THEN
    failed := array_append(failed, ('call_access_log is not append-only: ' || r)::text);
  END IF;

  -- ---------- erasure ----------
  r := pg_temp.px_try('authenticated', u_admin, format('SELECT pbx_erase_contact_calls(%L, %L)', c_agent, 'PX request'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' OR NOT EXISTS (SELECT 1 FROM call_recordings WHERE call_id = k_cust) THEN
    failed := array_append(failed, ('an admin erased call records: ' || r)::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_owner, format('SELECT pbx_erase_contact_calls(%L, %L)', c_hold, 'PX request'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 55000:%' OR NOT EXISTS (SELECT 1 FROM call_recordings WHERE call_id = k_hold)
     OR (SELECT erased_at FROM calls WHERE id = k_hold) IS NOT NULL THEN
    failed := array_append(failed, ('erased under legal hold: ' || r)::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_owner, format('SELECT pbx_erase_contact_calls(%L, %L)', c_agent, 'PX request'));
  n := n + 1;
  IF r IS DISTINCT FROM ARRAY[path_cust]::text OR EXISTS (SELECT 1 FROM call_recordings WHERE call_id = k_cust) THEN
    failed := array_append(failed, ('the owner''s erasure deletes the recording row and returns its path: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM calls WHERE id = k_cust
       AND notes IS NULL AND disposition IS NULL AND notes_updated_by IS NULL
       AND recording_state = 'erased' AND erased_at IS NOT NULL
       AND talk_seconds = 120 AND started_at = '2026-10-01 09:00:00+00'::timestamptz
       AND contact_id = c_agent AND direction = 'inbound')
     OR NOT EXISTS (SELECT 1 FROM pbx_audit WHERE account_id = a_acct AND action = 'erase_contact_calls'
       AND actor_id = u_owner AND contact_id = c_agent AND k_cust = ANY (call_ids)) THEN
    failed := array_append(failed, 'erasure clears notes and disposition, keeps duration and time, and is audited'::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_agent2, format(
    'SELECT pbx_set_disposition(%L, %L, %L)', k_cust, 'interested', 'PX after erasure'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 55000:%' THEN failed := array_append(failed, ('an erased call took a disposition: ' || r)::text); END IF;
  r := pg_temp.px_try('service_role', NULL, format(q_log, k_cust, a_acct, u_agent2, 'play'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 55000:%' THEN failed := array_append(failed, ('a play of an erased recording was logged: ' || r)::text); END IF;

  -- ---------- secrets, the token cache and the recordings bucket ----------
  r := pg_temp.px_try('authenticated', u_admin, 'SELECT count(*)::text FROM pbx_connection_secrets');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('an admin read pbx_connection_secrets: ' || r)::text); END IF;
  r := pg_temp.px_try('authenticated', u_admin, 'SELECT count(*)::text FROM storage.objects WHERE bucket_id = ''call-recordings''');
  n := n + 1;
  IF r <> '0' OR (SELECT public FROM storage.buckets WHERE id = 'call-recordings') IS DISTINCT FROM false THEN
    failed := array_append(failed, ('an admin reads call-recordings objects, or the bucket is public: ' || r)::text);
  END IF;
  r := pg_temp.px_try('service_role', NULL, format(q_swap, conn, NULL, 'px-token-1'));
  SELECT token_cache_updated_at INTO ts1 FROM pbx_connection_secrets WHERE connection_id = conn;
  r := r || '/' || pg_temp.px_try('service_role', NULL, format(q_swap, conn, NULL, 'px-token-stale'));
  n := n + 1;
  IF r <> 'true/false' OR (SELECT token_cache_enc FROM pbx_connection_secrets WHERE connection_id = conn) <> 'px-token-1' THEN
    failed := array_append(failed, ('pbx_token_swap with a stale stamp (first write, then the same stamp again): ' || r)::text);
  END IF;
  r := pg_temp.px_try('service_role', NULL, format(q_swap, conn, ts1, 'px-token-2'));
  n := n + 1;
  IF r <> 'true' OR NOT EXISTS (SELECT 1 FROM pbx_connection_secrets WHERE connection_id = conn
       AND token_cache_enc = 'px-token-2' AND token_cache_updated_at > ts1) THEN
    failed := array_append(failed, ('pbx_token_swap with the current stamp: ' || r)::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_admin, format(q_swap, conn, NULL, 'px-token-x'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('authenticated called pbx_token_swap: ' || r)::text); END IF;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.pbx_token_lock(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pbx_recording_playable(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pbx_purge()', 'EXECUTE') THEN
    failed := array_append(failed, 'authenticated may call a service-role 089 function'::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_agent, 'SELECT count(*)::text FROM pbx_bank_numbers')
       || '/' || pg_temp.px_try('authenticated', u_admin, 'SELECT count(*)::text FROM pbx_bank_numbers');
  n := n + 1;
  IF r <> '0/1' THEN failed := array_append(failed, ('bank numbers (agent/admin): ' || r)::text); END IF;

  -- ---------- one bell per missed call ----------
  r := pg_temp.px_try('service_role', NULL, format(
    'INSERT INTO tasks (account_id, kind, title, assigned_to, source, source_ref) VALUES (%L, %L, %L, %L, %L, %L)',
    a_acct, 'missed_call', 'PX missed call bell', u_agent, 'pbx', 'px-call-bell'));
  n := n + 1;
  IF r LIKE 'ERROR%' OR EXISTS (SELECT 1 FROM notifications WHERE type = 'task_assigned' AND title = 'PX missed call bell') THEN
    failed := array_append(failed, ('a missed-call task rang task_assigned beside call_missed: ' || r)::text);
  END IF;

  -- ---------- pbx_purge ----------
  r := pg_temp.px_try('service_role', NULL, 'SELECT pbx_purge()::text');
  n := n + 1;
  IF r LIKE 'ERROR%' OR EXISTS (SELECT 1 FROM pbx_events_raw WHERE hash = 'px-old')
     OR (SELECT count(*) FROM pbx_events_raw WHERE hash IN ('px-recent', 'px-pending')) <> 2 THEN
    failed := array_append(failed, ('pbx_purge drops only processed raw events older than 30 days: ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM call_live WHERE pbx_call_id = 'px-stale')
     OR NOT EXISTS (SELECT 1 FROM call_live WHERE pbx_call_id = 'px-live') THEN
    failed := array_append(failed, ('pbx_purge drops only screen-pop rows older than a day: ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pbx_events_raw WHERE hash = 'px-dead') THEN
    failed := array_append(failed, ('pbx_purge drops a raw event that failed 3 times, after 30 days: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM pbx_events_raw WHERE hash IN ('px-retrying', 'px-dead-recent')) <> 2 THEN
    failed := array_append(failed, ('pbx_purge keeps a failed event still retried, or failed within 30 days: ' || r)::text);
  END IF;

  -- ---------- anon ----------
  SELECT count(*) || '/' || count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE'))
    INTO r
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('pbx_token_lock', 'pbx_token_swap', 'pbx_extensions_guard', 'calls_guard',
       'call_recordings_guard', 'pbx_recording_playable', 'call_access_log_guard',
       'pbx_audit_append_only', 'pbx_settings_stamp', 'pbx_can_view_call', 'pbx_my_extension',
       'pbx_set_disposition', 'pbx_link_call_contact', 'pbx_erase_contact_calls', 'pbx_purge');
  r := r || ' / ' || pg_temp.px_try('anon', NULL, 'SELECT pbx_purge()::text')
         || ' / ' || pg_temp.px_try('anon', NULL, 'SELECT count(*)::text FROM calls');
  n := n + 1;
  IF r NOT LIKE '15/0 / ERROR 42501:% / ERROR 42501:%' THEN
    failed := array_append(failed, ('anon executes an 089 function or reads calls (functions/anon-executable): ' || r)::text);
  END IF;

  -- ---------- review fixes: C-1 basis, re-link, C-2 bank numbers, C-8 log ----------
  DECLARE
    k_nr    UUID;   -- fetched while the notice was switched off (not_required)
    k_rel   UUID;   -- the other agent's call with the agent's customer
    k_bank  UUID;   -- a listed bank number's call, recorded
    k_bank0 UUID;   -- the same, the number listed in its local "0" form
    c_lead  UUID;   -- the team leader's own customer
    q_play  TEXT := 'SELECT pbx_recording_playable(%L)::text';
    q_link  TEXT := 'SELECT pbx_link_call_contact(%L, %L)';
  BEGIN
    INSERT INTO pbx_settings (account_id, announcement_required, exclude_bank_numbers)
    VALUES (a_acct, true, true)
    ON CONFLICT (account_id) DO UPDATE SET announcement_required = true, exclude_bank_numbers = true;
    INSERT INTO pbx_bank_numbers (account_id, number, bank_code) VALUES (a_acct, '042089111', 'FAB');
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_lead, '971500089006', 'PX lead customer') RETURNING id INTO c_lead;
    INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id,
                       remote_number, recording_state, meta)
    VALUES (a_acct, conn, 'px-nr', 'inbound', '101', u_agent, '971500089005', 'fetched',
            '{"announcement_basis": "not_required"}') RETURNING id INTO k_nr;
    INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, contact_id)
    VALUES (a_acct, conn, 'px-rel', 'inbound', '102', u_agent2, c_agent) RETURNING id INTO k_rel;
    INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id,
                       remote_number, recording_state)
    VALUES (a_acct, conn, 'px-bank', 'inbound', '101', u_agent, '97142089000', 'fetched') RETURNING id INTO k_bank;
    INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id,
                       remote_number, recording_state)
    VALUES (a_acct, conn, 'px-bank0', 'outbound', '101', u_agent, '97142089111', 'fetched') RETURNING id INTO k_bank0;
    INSERT INTO call_recordings (call_id, account_id, storage_path, announcement_played) VALUES
      (k_nr, a_acct, format('account-%s/px-nr.wav', a_acct), false),
      (k_bank, a_acct, format('account-%s/px-bank.wav', a_acct), true),
      (k_bank0, a_acct, format('account-%s/px-bank0.wav', a_acct), true);

    -- C-1: the fetcher marks a not_required recording unannounced; it is
    -- held while the notice is required and plays while it is not.
    r := pg_temp.px_try('service_role', NULL, format(q_play, k_nr));
    UPDATE pbx_settings SET announcement_required = false WHERE account_id = a_acct;
    r := r || '/' || pg_temp.px_try('service_role', NULL, format(q_play, k_nr));
    UPDATE pbx_settings SET announcement_required = true WHERE account_id = a_acct;
    n := n + 1;
    IF r <> 'false/true' THEN
      failed := array_append(failed, ('a not_required recording (required on/off): ' || r)::text);
    END IF;

    -- Re-link: the disposition's rule. The agent sees k_rel through
    -- their customer but was not on it.
    r := pg_temp.px_try('authenticated', u_agent, format(q_link, k_rel, c_hold));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' OR (SELECT contact_id FROM calls WHERE id = k_rel) <> c_agent THEN
      failed := array_append(failed, ('an agent re-linked another person''s call seen through their customer: ' || r)::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_agent2, format(q_link, k_rel, c_x));
    n := n + 1;
    IF r <> 'ok' OR (SELECT contact_id FROM calls WHERE id = k_rel) <> c_x THEN
      failed := array_append(failed, ('the person on the call re-links it: ' || r)::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_lead, format(q_link, k_rel, c_lead));
    n := n + 1;
    IF r <> 'ok' OR (SELECT contact_id FROM calls WHERE id = k_rel) <> c_lead THEN
      failed := array_append(failed, ('a team leader re-links a call they were not on: ' || r)::text);
    END IF;

    -- C-2: a bank number's recording (listed internationally, or in the
    -- local "0" form) is held while the workspace excludes bank numbers.
    r := pg_temp.px_try('service_role', NULL, format(q_play, k_bank))
         || '/' || pg_temp.px_try('service_role', NULL, format(q_play, k_bank0))
         || '/' || pg_temp.px_try('service_role', NULL, format(q_log, k_bank, a_acct, u_agent, 'play'));
    n := n + 1;
    IF r NOT LIKE 'false/false/ERROR 55000:%' THEN
      failed := array_append(failed, ('a bank number''s recording while excluded (intl/local/logged play): ' || r)::text);
    END IF;
    UPDATE pbx_settings SET exclude_bank_numbers = false WHERE account_id = a_acct;
    r := pg_temp.px_try('service_role', NULL, format(q_play, k_bank));
    UPDATE pbx_settings SET exclude_bank_numbers = true WHERE account_id = a_acct;
    n := n + 1;
    IF r <> 'true' THEN
      failed := array_append(failed, ('a bank number''s recording once exclusion is off: ' || r)::text);
    END IF;

    -- C-8: the log names an active agent-or-above of the call's account,
    -- and a download is a team leader's (k_hold is playable).
    r := pg_temp.px_try('service_role', NULL, format(q_log, k_hold, a_acct, u_agent, 'download'))
         || ' / ' || pg_temp.px_try('service_role', NULL, format(q_log, k_hold, a_acct, u_other, 'play'))
         || ' / ' || pg_temp.px_try('service_role', NULL, format(q_log, k_hold, a_acct, u_guest, 'play'));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:% / ERROR 42501:% / ERROR 42501:%' THEN
      failed := array_append(failed, ('access log rows (an agent''s download / another account''s user / a bank guest): ' || r)::text);
    END IF;
    r := pg_temp.px_try('service_role', NULL, format(q_log, k_hold, a_acct, u_lead, 'download'))
         || '/' || pg_temp.px_try('service_role', NULL, format(q_log, k_hold, a_acct, u_agent, 'play'));
    n := n + 1;
    IF r <> 'ok/ok' THEN
      failed := array_append(failed, ('a team leader''s download and an agent''s play are logged: ' || r)::text);
    END IF;
  END;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT089', MESSAGE = 'verify-pbx rollback';
  EXCEPTION WHEN SQLSTATE 'ZT089' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'pbx verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'pbx verification passed (% checks)', n;
END
$verify$;
