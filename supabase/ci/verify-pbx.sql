-- Behavioural regression suite for the phone system (migrations 089,
-- 090, 098's call report and 101's presence mapping and keepalive).
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
-- mapping, the token compare-and-set, pbx_purge, anon's grants and the
-- supervisor call report (pbx_call_report: who may run it, whose rows
-- they get, exact counts).
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

  -- ---------- when the call rang (094) ----------
  -- The default stamps the first frame (px-live was inserted without
  -- it), the people it rings read it, and later frames keep it: the
  -- processor's upsert leaves rang_at out of its payload, and ON
  -- CONFLICT DO UPDATE sets only the payload's columns. Dynamic SQL, so
  -- a database without 094 fails these checks by name.
  n := n + 1;
  IF NOT EXISTS (
       SELECT 1 FROM pg_attribute a
         JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'public.call_live'::regclass AND a.attname = 'rang_at'
          AND NOT a.attisdropped AND a.attnotnull
          AND a.atttypid = 'timestamptz'::regtype
          AND pg_get_expr(d.adbin, d.adrelid) = 'now()') THEN
    failed := array_append(failed, 'call_live.rang_at is a NOT NULL timestamptz defaulting to now()'::text);
  END IF;
  r := pg_temp.px_try('authenticated', u_agent,
    'SELECT (rang_at = now())::text FROM call_live WHERE pbx_call_id = ''px-live''');
  n := n + 1;
  IF r IS DISTINCT FROM 'true' THEN
    failed := array_append(failed, ('a ringing agent reads when the call first rang: ' || r)::text);
  END IF;
  r := pg_temp.px_try('service_role', NULL,
    'UPDATE call_live SET rang_at = now() - interval ''90 seconds'' WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('service_role', NULL, format(
    'INSERT INTO call_live (connection_id, pbx_call_id, account_id, ringing_user_ids, answered_by, state, updated_at) '
    'VALUES (%L, %L, %L, %L, %L, %L, now()) ON CONFLICT (connection_id, pbx_call_id) DO UPDATE SET '
    'account_id = EXCLUDED.account_id, ringing_user_ids = EXCLUDED.ringing_user_ids, '
    'answered_by = EXCLUDED.answered_by, state = EXCLUDED.state, updated_at = EXCLUDED.updated_at',
    conn, 'px-live', a_acct, ARRAY[u_agent], u_agent2, 'answered'));
  -- A later frame of the answered call (no new ring) keeps it too.
  r := r || '/' || pg_temp.px_try('service_role', NULL,
    'UPDATE call_live SET updated_at = now() WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('authenticated', u_agent2,
    'SELECT (rang_at = now() - interval ''90 seconds'')::text FROM call_live WHERE pbx_call_id = ''px-live''');
  n := n + 1;
  IF r IS DISTINCT FROM 'ok/ok/ok/true' THEN
    failed := array_append(failed, ('a later frame keeps when the call first rang: ' || r)::text);
  END IF;
  -- Answered, then ringing again (a blind transfer): the frame that
  -- clears answered_by stamps rang_at again; one that keeps it NULL
  -- does not.
  r := pg_temp.px_try('service_role', NULL, format(
    'INSERT INTO call_live (connection_id, pbx_call_id, account_id, ringing_user_ids, answered_by, state, updated_at) '
    'VALUES (%L, %L, %L, %L, NULL, %L, now()) ON CONFLICT (connection_id, pbx_call_id) DO UPDATE SET '
    'account_id = EXCLUDED.account_id, ringing_user_ids = EXCLUDED.ringing_user_ids, '
    'answered_by = EXCLUDED.answered_by, state = EXCLUDED.state, updated_at = EXCLUDED.updated_at',
    conn, 'px-live', a_acct, ARRAY[u_agent], 'ringing'));
  r := r || '/' || pg_temp.px_try('authenticated', u_agent,
    'SELECT (rang_at = now())::text FROM call_live WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('service_role', NULL,
    'UPDATE call_live SET rang_at = now() - interval ''90 seconds'' WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('service_role', NULL,
    'UPDATE call_live SET answered_by = NULL, state = ''ringing'' WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('authenticated', u_agent,
    'SELECT (rang_at = now() - interval ''90 seconds'')::text FROM call_live WHERE pbx_call_id = ''px-live''');
  n := n + 1;
  IF r IS DISTINCT FROM 'ok/true/ok/ok/true' THEN
    failed := array_append(failed, ('a call that rings again after an answer is timed from then: ' || r)::text);
  END IF;
  -- Answered by someone with no CRM login (answered_by stays NULL), or
  -- held, then ringing again: still timed from the new ring.
  r := pg_temp.px_try('service_role', NULL,
    'UPDATE call_live SET answered_by = NULL, state = ''answered'', rang_at = now() - interval ''90 seconds'' WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('service_role', NULL,
    'UPDATE call_live SET state = ''ringing'' WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('authenticated', u_agent,
    'SELECT (rang_at = now())::text FROM call_live WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('service_role', NULL,
    'UPDATE call_live SET state = ''in_progress'', rang_at = now() - interval ''90 seconds'' WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('service_role', NULL,
    'UPDATE call_live SET state = ''ringing'' WHERE pbx_call_id = ''px-live''');
  r := r || '/' || pg_temp.px_try('authenticated', u_agent,
    'SELECT (rang_at = now())::text FROM call_live WHERE pbx_call_id = ''px-live''');
  n := n + 1;
  IF r IS DISTINCT FROM 'ok/ok/true/ok/ok/true' THEN
    failed := array_append(failed, ('a call that rings again after a loginless answer or a hold is timed from then: ' || r)::text);
  END IF;
  UPDATE call_live SET answered_by = u_agent2, rang_at = now() WHERE pbx_call_id = 'px-live';
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication_tables
              WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'call_live'
                AND NOT ('rang_at' = ANY (attnames))) THEN
    failed := array_append(failed, 'realtime does not send call_live.rang_at'::text);
  END IF;

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

  -- ---------- erasure reaches the contact's number; leftover audio is swept (C-3) ----------
  DECLARE
    e_x UUID; e_y UUID; e_w UUID; e_n UUID; e_b UUID;
    k_amb UUID; k_same UUID; k_w UUID; k_nat UUID; k_b UUID; k_pend UUID;
    p_amb TEXT; p_w TEXT; o_old TEXT; o_fresh TEXT; o_pend TEXT;
    q_calls TEXT := 'INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, '
      'contact_id, remote_number, meta, recording_file, recording_state, notes) '
      'VALUES (%L, %L, %L, ''inbound'', ''101'', %L, %L, %L, %L, %L, %L, %L) RETURNING id';
  BEGIN
    INSERT INTO contacts (account_id, user_id, phone, name) VALUES
      (a_acct, u_agent, '971501234567', 'PX erase X') RETURNING id INTO e_x;
    -- Y: the same line with a trunk 0, so a call from it matched both.
    INSERT INTO contacts (account_id, user_id, phone, name) VALUES
      (a_acct, u_agent, '9710501234567', 'PX erase Y') RETURNING id INTO e_y;
    -- W: another country, the same last 8 digits.
    INSERT INTO contacts (account_id, user_id, phone, name) VALUES
      (a_acct, u_agent, '966501234567', 'PX erase W') RETURNING id INTO e_w;
    -- N: stored in national form; the processor matches it by the last 8.
    INSERT INTO contacts (account_id, user_id, phone, name) VALUES
      (a_acct, u_agent, '047654321', 'PX erase N') RETURNING id INTO e_n;
    INSERT INTO contacts (account_id, user_id, phone, name) VALUES
      (b_acct, u_other, '971501234567', 'PX erase B') RETURNING id INTO e_b;
    EXECUTE format(q_calls, a_acct, conn, 'px-e-amb', u_agent, NULL, '971501234567',
      jsonb_build_object('contact_candidates', jsonb_build_array(e_x, e_y), 'recording_error', 'PX 0501234567.wav'),
      'PX-0501234567.wav', 'fetched', 'PX note') INTO k_amb;
    EXECUTE format(q_calls, a_acct, conn, 'px-e-same', u_agent, NULL, '971501234567',
      '{"unrouted": true, "recording_attempts": 2}', NULL, 'none', NULL) INTO k_same;
    EXECUTE format(q_calls, a_acct, conn, 'px-e-w', u_agent, e_w, '966501234567', '{}', NULL, 'fetched', NULL) INTO k_w;
    EXECUTE format(q_calls, a_acct, conn, 'px-e-nat', u_agent, NULL, '97147654321', '{}', NULL, 'none', NULL) INTO k_nat;
    EXECUTE format(q_calls, b_acct, NULL, 'px-e-b', u_other, NULL, '971501234567', '{}', NULL, 'none', NULL) INTO k_b;
    EXECUTE format(q_calls, a_acct, conn, 'px-e-pend', u_agent, NULL, '971559990000', '{}', 'p.wav', 'pending', NULL) INTO k_pend;
    p_amb := format('account-%s/calls/%s.wav', a_acct, k_amb);
    p_w := format('account-%s/calls/%s.wav', a_acct, k_w);
    o_old := format('account-%s/calls/%s.wav', a_acct, gen_random_uuid());
    o_fresh := format('account-%s/calls/%s.wav', a_acct, gen_random_uuid());
    o_pend := format('account-%s/calls/%s.wav', a_acct, k_pend);
    INSERT INTO call_recordings (call_id, account_id, storage_path, announcement_played) VALUES
      (k_amb, a_acct, p_amb, true), (k_w, a_acct, p_w, true);
    INSERT INTO storage.objects (bucket_id, name, created_at, updated_at) VALUES
      ('call-recordings', o_old, now() - interval '2 days', now() - interval '2 days'),
      ('call-recordings', o_fresh, now(), now()),
      ('call-recordings', p_w, now() - interval '2 days', now() - interval '2 days'),
      ('call-recordings', o_pend, now() - interval '2 days', now() - interval '2 days');

    r := pg_temp.px_try('authenticated', u_other, format('SELECT pbx_erase_contact_calls(%L, %L)', e_x, 'PX request'));
    n := n + 1;
    IF r NOT LIKE 'ERROR P0002:%' OR EXISTS (SELECT 1 FROM calls WHERE id IN (k_amb, k_same, k_b) AND erased_at IS NOT NULL)
       OR NOT EXISTS (SELECT 1 FROM call_recordings WHERE call_id = k_amb) THEN
      failed := array_append(failed, ('another workspace''s owner erased this workspace''s contact: ' || r)::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_owner, format('SELECT pbx_erase_contact_calls(%L, %L)', e_x, 'PX request'));
    n := n + 1;
    IF r IS DISTINCT FROM ARRAY[p_amb]::text OR EXISTS (SELECT 1 FROM call_recordings WHERE call_id = k_amb)
       OR (SELECT count(*) FROM calls WHERE id IN (k_amb, k_same) AND recording_state = 'erased') <> 2 THEN
      failed := array_append(failed, ('erasure misses an ambiguous or never-matched call from the contact''s number: ' || r)::text);
    END IF;
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM calls WHERE id = k_amb AND remote_number IS NULL AND recording_file IS NULL
                     AND meta = '{}'::jsonb AND notes IS NULL AND extension = '101' AND direction = 'inbound')
       OR NOT EXISTS (SELECT 1 FROM calls WHERE id = k_same AND remote_number IS NULL AND meta = '{"unrouted": true}'::jsonb)
       OR NOT EXISTS (SELECT 1 FROM pbx_audit WHERE action = 'erase_contact_calls' AND contact_id = e_x
                        AND call_ids @> ARRAY[k_amb, k_same]) THEN
      failed := array_append(failed, 'an erased call keeps the number, the recording file or contact data in meta'::text);
    END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM calls WHERE id IN (k_w, k_b, k_nat) AND (erased_at IS NOT NULL OR remote_number IS NULL))
       OR NOT EXISTS (SELECT 1 FROM call_recordings WHERE call_id = k_w) THEN
      failed := array_append(failed, 'erasure took another workspace''s call, or a number only sharing the last 8 digits'::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_owner, format('SELECT pbx_erase_contact_calls(%L, %L)', e_n, 'PX request'));
    n := n + 1;
    IF r LIKE 'ERROR%' OR NOT EXISTS (SELECT 1 FROM calls WHERE id = k_nat AND erased_at IS NOT NULL AND remote_number IS NULL) THEN
      failed := array_append(failed, ('erasure misses a call matched by the last 8 digits: ' || r)::text);
    END IF;
    r := pg_temp.px_try('service_role', NULL, format(
      'UPDATE calls SET remote_number = %L, recording_file = %L, meta = %L WHERE id = %L',
      '971501234567', 'late.wav', jsonb_build_object('contact_candidates', jsonb_build_array(e_x), 'unrouted', true), k_same));
    n := n + 1;
    IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM calls WHERE id = k_same AND remote_number IS NULL
                                  AND recording_file IS NULL AND meta = '{"unrouted": true}'::jsonb) THEN
      failed := array_append(failed, ('a late write put the number back on an erased call: ' || r)::text);
    END IF;

    r := pg_temp.px_try('service_role', NULL,
      'SELECT coalesce(string_agg(x, '',''), ''none'') FROM pbx_orphan_recordings(''1 hour'', 100) x');
    n := n + 1;
    IF r IS DISTINCT FROM o_old THEN
      failed := array_append(failed, ('pbx_orphan_recordings lists exactly the old unreferenced object (not a fresh one, a referenced one or a pending call''s): ' || r)::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_owner, 'SELECT count(*)::text FROM pbx_orphan_recordings(''0'', 10)');
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%' OR has_function_privilege('anon', 'public.pbx_orphan_recordings(interval, integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pbx_phone_variants(text)', 'EXECUTE') THEN
      failed := array_append(failed, ('a client can list orphaned recordings or run the variants helper: ' || r)::text);
    END IF;
  END;

  -- ---------- 090: storing recordings can be paused ----------
  DECLARE
    c_ns UUID;   -- the customer of a call recorded while storing was paused
    k_ns UUID;
  BEGIN
    INSERT INTO pbx_settings (account_id) VALUES (b_acct) ON CONFLICT (account_id) DO NOTHING;
    r := pg_temp.px_try('service_role', NULL, format(
      'SELECT store_recordings::text FROM pbx_settings WHERE account_id = %L', b_acct));
    n := n + 1;
    IF r IS DISTINCT FROM 'true' THEN
      failed := array_append(failed, ('pbx_settings.store_recordings does not default to true: ' || r)::text);
    END IF;
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_agent, '971500089090', 'PX not stored') RETURNING id INTO c_ns;
    INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id,
                       contact_id, remote_number, recording_file, recording_state)
    VALUES (a_acct, conn, 'px-ns', 'inbound', '101', u_agent, c_ns, '971500089090', 'px-ns.wav', 'pending')
    RETURNING id INTO k_ns;
    r := pg_temp.px_try('service_role', NULL, format(
      'UPDATE calls SET recording_state = %L WHERE id = %L', 'not_stored', k_ns));
    n := n + 1;
    IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM calls WHERE id = k_ns
                                  AND recording_state = 'not_stored' AND recording_file = 'px-ns.wav') THEN
      failed := array_append(failed, ('a call cannot be marked not_stored, keeping its file name: ' || r)::text);
    END IF;
    r := pg_temp.px_try('service_role', NULL, format(
      'UPDATE calls SET recording_state = %L WHERE id = %L', 'bogus', k_ns));
    n := n + 1;
    IF r NOT LIKE 'ERROR 23514:%' THEN
      failed := array_append(failed, ('calls.recording_state took an unknown state: ' || r)::text);
    END IF;
    -- Even with a recording row (a fetch that raced the pause), a
    -- not_stored call never plays and the log refuses it.
    INSERT INTO call_recordings (call_id, account_id, storage_path, announcement_played)
    VALUES (k_ns, a_acct, format('account-%s/px-ns.wav', a_acct), true);
    r := pg_temp.px_try('service_role', NULL, format('SELECT pbx_recording_playable(%L)::text', k_ns));
    r := r || '/' || pg_temp.px_try('service_role', NULL, format(q_log, k_ns, a_acct, u_agent, 'play'));
    n := n + 1;
    IF r NOT LIKE 'false/ERROR 55000:%' THEN
      failed := array_append(failed, ('a not_stored call is playable: ' || r)::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_owner, format('SELECT pbx_erase_contact_calls(%L, %L)', c_ns, 'PX request'));
    n := n + 1;
    IF r LIKE 'ERROR%' OR NOT EXISTS (SELECT 1 FROM calls WHERE id = k_ns
         AND recording_state = 'erased' AND erased_at IS NOT NULL AND recording_file IS NULL)
       OR EXISTS (SELECT 1 FROM call_recordings WHERE call_id = k_ns) THEN
      failed := array_append(failed, ('erasing a not_stored call does not leave it erased: ' || r)::text);
    END IF;
  END;

  -- ---------- 098: the supervisor call report ----------
  -- One day, half open; the leader leads a team of the agent alone.
  -- Signatures: kind:who:in/out/missed/talk/talk calls/ring/ring calls:
  -- interested,docs,call back,not eligible,wrong number,none.
  DECLARE
    rp_from TEXT := '2025-01-06 00:00:00+00';
    rp_to   TEXT := '2025-01-07 00:00:00+00';
    t_team  UUID;
    q_rep   TEXT := $q$SELECT string_agg(format('%%s:%%s:%%s/%%s/%%s/%%s/%%s/%%s/%%s:%%s,%%s,%%s,%%s,%%s,%%s',
                     row_kind, CASE user_id WHEN %L THEN 'agent' WHEN %L THEN 'agent2'
                                            WHEN %L THEN 'lead' WHEN %L THEN 'other'
                                            ELSE coalesce(user_id::text, '-') END,
                     inbound_answered, outbound, missed, talk_seconds, talk_calls, ring_seconds, ring_calls,
                     outcomes->>'interested', outcomes->>'docs_requested', outcomes->>'call_back',
                     outcomes->>'not_eligible', outcomes->>'wrong_number', outcomes->>'none'), ' ')
                   FROM pbx_call_report(%L, %L)$q$;
  BEGIN
    INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'PX report team', u_lead)
    RETURNING id INTO t_team;
    INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_agent, a_acct);
    INSERT INTO calls (account_id, connection_id, pbx_call_id, direction, extension, user_id, status,
                       started_at, answered_at, talk_seconds, ring_seconds, disposition) VALUES
      -- the agent: two answered in, two out (one answered), one missed on their extension
      (a_acct, conn, 'rp-1', 'inbound', '101', u_agent, 'answered', '2025-01-06 08:00+00', '2025-01-06 08:00:10+00', 100, 10, 'interested'),
      (a_acct, conn, 'rp-2', 'inbound', '101', u_agent, 'answered', '2025-01-06 09:00+00', '2025-01-06 09:00:20+00', 50, 20, NULL),
      (a_acct, conn, 'rp-3', 'outbound', '101', u_agent, 'answered', '2025-01-06 10:00+00', '2025-01-06 10:00:05+00', 30, 5, 'call_back'),
      (a_acct, conn, 'rp-4', 'outbound', '101', u_agent, 'no_answer', '2025-01-06 11:00+00', NULL, 0, 25, NULL),
      -- (answered_at set by a live frame, final status no_answer: missed, never answered)
      (a_acct, conn, 'rp-5', 'inbound', '101', u_agent, 'no_answer', '2025-01-06 12:00+00', '2025-01-06 12:00:08+00', 0, 30, NULL),
      -- a ring group nobody answered: no person
      (a_acct, conn, 'rp-6', 'inbound', '6300', NULL, 'abandoned', '2025-01-06 13:00+00', NULL, 0, 40, NULL),
      -- the other agent, outside the leader's team
      (a_acct, conn, 'rp-7', 'inbound', '102', u_agent2, 'answered', '2025-01-06 14:00+00', '2025-01-06 14:00:06+00', 60, 6, 'wrong_number'),
      -- the leader, no extension
      (a_acct, conn, 'rp-8', 'outbound', NULL, u_lead, 'answered', '2025-01-06 15:00+00', '2025-01-06 15:00:03+00', 40, 3, 'docs_requested'),
      -- left out: an internal call, and one on the period's end
      (a_acct, conn, 'rp-9', 'internal', '101', u_agent, 'answered', '2025-01-06 16:00+00', '2025-01-06 16:00:01+00', 70, 1, NULL),
      (a_acct, conn, 'rp-10', 'inbound', '101', u_agent, 'answered', '2025-01-07 00:00+00', '2025-01-07 00:00:01+00', 90, 1, NULL);
    -- account B's call in the same period
    INSERT INTO calls (account_id, pbx_call_id, direction, user_id, status, started_at, answered_at, talk_seconds, ring_seconds)
    VALUES (b_acct, 'rp-b', 'inbound', u_other, 'answered', '2025-01-06 08:30+00', '2025-01-06 08:30:02+00', 15, 2);

    r := pg_temp.px_try('authenticated', u_admin, format(q_rep, u_agent, u_agent2, u_lead, u_other, rp_from, rp_to));
    n := n + 1;
    IF r IS DISTINCT FROM
       'person:lead:0/1/0/40/1/0/0:0,1,0,0,0,0 person:agent:2/2/1/180/3/30/2:1,0,1,0,0,1 '
       'person:agent2:1/0/0/60/1/6/1:0,0,0,0,1,0 none:-:0/0/1/0/0/0/0:0,0,0,0,0,0 '
       'total:-:3/3/2/280/5/36/3:1,1,1,0,1,1' THEN
      failed := array_append(failed, ('pbx_call_report for an admin: ' || coalesce(r, 'NULL'))::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_lead, format(q_rep, u_agent, u_agent2, u_lead, u_other, rp_from, rp_to));
    n := n + 1;
    IF r IS DISTINCT FROM
       'person:lead:0/1/0/40/1/0/0:0,1,0,0,0,0 person:agent:2/2/1/180/3/30/2:1,0,1,0,0,1 '
       'none:-:0/0/1/0/0/0/0:0,0,0,0,0,0 total:-:3/3/2/280/5/36/3:1,1,1,0,1,1' THEN
      failed := array_append(failed, ('pbx_call_report for a team leader is not their team plus themselves: ' || coalesce(r, 'NULL'))::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_other, format(q_rep, u_agent, u_agent2, u_lead, u_other, rp_from, rp_to));
    n := n + 1;
    IF r IS DISTINCT FROM
       'person:other:1/0/0/15/1/2/1:0,0,0,0,0,1 none:-:0/0/0/0/0/0/0:0,0,0,0,0,0 '
       'total:-:1/0/0/15/1/2/1:0,0,0,0,0,1' THEN
      failed := array_append(failed, ('pbx_call_report crosses workspaces: ' || coalesce(r, 'NULL'))::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_agent, format('SELECT count(*)::text FROM pbx_call_report(%L, %L)', rp_from, rp_to))
      || '/' || pg_temp.px_try('authenticated', u_viewer, format('SELECT count(*)::text FROM pbx_call_report(%L, %L)', rp_from, rp_to))
      || '/' || pg_temp.px_try('authenticated', u_guest, format('SELECT count(*)::text FROM pbx_call_report(%L, %L)', rp_from, rp_to));
    n := n + 1;
    IF r NOT LIKE 'ERROR 42501:%/ERROR 42501:%/ERROR 42501:%' THEN
      failed := array_append(failed, ('an agent, a viewer or a bank guest ran the call report: ' || r)::text);
    END IF;
    r := pg_temp.px_try('authenticated', u_admin, format('SELECT count(*)::text FROM pbx_call_report(%L, %L)', rp_to, rp_from))
      || '/' || pg_temp.px_try('authenticated', u_admin, 'SELECT count(*)::text FROM pbx_call_report(''2025-01-01'', ''2025-04-12'')');
    n := n + 1;
    IF r NOT LIKE 'ERROR 22023:%/ERROR 22023:%' THEN
      failed := array_append(failed, ('pbx_call_report took a reversed or over-100-day period: ' || r)::text);
    END IF;
    n := n + 1;
    IF has_function_privilege('anon', 'public.pbx_call_report(timestamptz, timestamptz)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.pbx_call_report(timestamptz, timestamptz)', 'EXECUTE') THEN
      failed := array_append(failed, 'pbx_call_report grants: anon may run it, or authenticated may not');
    END IF;
  END;

  -- ---------- 101: presence follows the mapping; a live call stays red ----------
  -- Fixture rows carry an old updated_at: set_updated_at fires on UPDATE
  -- only, and now() is this transaction's, so "refreshed" is = now().
  -- 110 is on a live call, 111 hung up in it, 112 rings but was written
  -- two minutes ago, 113 is idle, 101 (the agent's) is on no live call.
  INSERT INTO pbx_presence (connection_id, extension, account_id, user_id, presence, call_state, updated_at) VALUES
    (conn, '101', a_acct, u_agent, 'do_not_disturb', 'busy', now() - interval '20 minutes'),
    (conn, '110', a_acct, NULL, NULL, 'busy', now() - interval '20 minutes'),
    (conn, '111', a_acct, NULL, NULL, 'busy', now() - interval '20 minutes'),
    (conn, '112', a_acct, NULL, NULL, 'ringing', now() - interval '2 minutes'),
    (conn, '113', a_acct, NULL, 'away', 'idle', now() - interval '20 minutes'),
    (conn, '120', a_acct, NULL, 'lunch', NULL, now() - interval '20 minutes'),
    (conn, '114', a_acct, NULL, NULL, 'busy', now() - interval '20 minutes');
  -- 114's call lost its hang-up: its last frame is five hours old.
  INSERT INTO call_live (connection_id, pbx_call_id, account_id, members, updated_at) VALUES
    (conn, 'px-stale', a_acct, '[{"kind":"extension","number":"114","status":"ANSWERED"}]', now() - interval '5 hours');
  INSERT INTO call_live (connection_id, pbx_call_id, account_id, members) VALUES
    (conn, 'px-long', a_acct, '[{"kind":"inbound","from":"971500000000","status":"ANSWERED"},
                                {"kind":"extension","number":"110","status":"ANSWERED"},
                                {"kind":"extension","number":"111","status":"BYE"},
                                {"kind":"extension","number":"112","status":"RING"},
                                {"kind":"extension","number":"113","status":"ANSWERED"}]');
  -- Each read is a statement of its own: one in the same statement as
  -- the write would see the snapshot from before it.
  r := pg_temp.px_try('service_role', NULL, 'SELECT pbx_presence_keepalive()::text');
  r := r || '/' || (SELECT coalesce(string_agg(extension, ',' ORDER BY extension), '-')
                 FROM pbx_presence WHERE connection_id = conn AND updated_at = now());
  n := n + 1;
  IF r <> '1/110' THEN
    failed := array_append(failed, ('pbx_presence_keepalive refreshes only a ringing or busy row on a live call, older than 5 minutes: ' || r)::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('anon', 'public.pbx_presence_keepalive()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pbx_presence_keepalive()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pbx_presence_keepalive()', 'EXECUTE') THEN
    failed := array_append(failed, 'pbx_presence_keepalive grants: not the service role''s alone');
  END IF;

  -- A remap moves the row to the new person; unmapping leaves it no one's.
  r := pg_temp.px_try('service_role', NULL, format(
         'UPDATE pbx_extensions SET user_id = %L WHERE connection_id = %L AND extension = ''101''', u_agent3, conn));
  r := r || '/' || (SELECT coalesce(user_id::text, 'none') || ':' || presence
                 FROM pbx_presence WHERE connection_id = conn AND extension = '101');
  n := n + 1;
  IF r <> 'ok/' || u_agent3::text || ':do_not_disturb' THEN
    failed := array_append(failed, ('a remapped extension''s presence stayed on the old person: ' || r)::text);
  END IF;
  r := pg_temp.px_try('service_role', NULL, format(
         'UPDATE pbx_extensions SET user_id = NULL WHERE connection_id = %L AND extension = ''101''', conn));
  r := r || '/' || (SELECT coalesce(user_id::text, 'none') FROM pbx_presence WHERE connection_id = conn AND extension = '101');
  n := n + 1;
  IF r <> 'ok/none' THEN
    failed := array_append(failed, ('an unmapped extension''s presence kept its person: ' || r)::text);
  END IF;
  -- Monitoring off deletes it; a registration write leaves it alone.
  r := pg_temp.px_try('service_role', NULL, format(
         'UPDATE pbx_extensions SET registration_state = ''registered'' WHERE connection_id = %L AND extension = ''101''', conn));
  r := r || '/' || (SELECT count(*)::text FROM pbx_presence WHERE connection_id = conn AND extension = '101');
  r := r || '/' || pg_temp.px_try('service_role', NULL, format(
         'UPDATE pbx_extensions SET presence_monitor = false WHERE connection_id = %L AND extension = ''101''', conn));
  r := r || '/' || (SELECT count(*)::text FROM pbx_presence WHERE connection_id = conn AND extension = '101');
  n := n + 1;
  IF r <> 'ok/1/ok/0' THEN
    failed := array_append(failed, ('presence monitoring turned off kept the presence row: ' || r)::text);
  END IF;
  -- A new mapping takes the extension's row; deleting the extension drops it.
  r := pg_temp.px_try('service_role', NULL, format(q_ext, conn, '120', a_acct, u_agent2));
  r := r || '/' || (SELECT coalesce(user_id::text, 'none') FROM pbx_presence WHERE connection_id = conn AND extension = '120');
  r := r || '/' || pg_temp.px_try('service_role', NULL, format(
         'DELETE FROM pbx_extensions WHERE connection_id = %L AND extension = ''120''', conn));
  r := r || '/' || (SELECT count(*)::text FROM pbx_presence WHERE connection_id = conn AND extension = '120');
  n := n + 1;
  IF r <> 'ok/' || u_agent2::text || '/ok/0' THEN
    failed := array_append(failed, ('a new or deleted extension mapping left its presence row as it was: ' || r)::text);
  END IF;

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
