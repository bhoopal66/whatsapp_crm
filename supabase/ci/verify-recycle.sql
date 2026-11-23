-- Behavioural regression suite for Declined recycling (migration 251).
--
-- recycle_candidates lists, for team leaders and up, the customers whose
-- case ended Declined / Withdrawn (or whose chat carries a declined-type
-- tag an admin picked) at least N days ago, and always leaves out
-- opted-out, do-not-contact, open-case and came-back customers.
-- recycle_create_tasks files one follow_up task each, once.
--
-- ONE statement on purpose (`supabase db query --file` rejects several).
-- Fixtures are rolled back by a closing sentinel exception; results
-- survive in plpgsql variables. Fixture emails use the prefix rc-.

DO $verify$
DECLARE
  u_admin  UUID := '00000000-0000-4000-8000-000000251001';
  u_agent  UUID := '00000000-0000-4000-8000-000000251002';
  u_other  UUID := '00000000-0000-4000-8000-000000251003';
  a_acct   UUID;
  b_acct   UUID;
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; c5 UUID; c6 UUID; c7 UUID; c8 UUID; c9 UUID;
  cv6 UUID; cv7 UUID;
  tag_no  UUID;
  tag_sub UUID;
  v_ids   UUID[];
  v_text  TEXT;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rc_try(p_role text, p_uid uuid, p_sql text)
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
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_admin, 'rc-admin@example.invalid'),
    (u_agent, 'rc-agent@example.invalid'),
    (u_other, 'rc-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_admin;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  -- u_admin is the owner of account A (the signup trigger): rank 5.
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500251001', 'RC declined 100d') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500251002', 'RC declined 30d') RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500251003', 'RC opted out') RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500251004', 'RC do not contact') RETURNING id INTO c4;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500251005', 'RC open lead') RETURNING id INTO c5;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500251006', 'RC came back') RETURNING id INTO c6;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500251007', 'RC chat declined') RETURNING id INTO c7;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_other, '971500251008', 'RC other account') RETURNING id INTO c8;
  UPDATE contacts SET opted_out_at = now() - interval '10 days' WHERE id = c3;
  UPDATE contacts SET do_not_contact_at = now() - interval '10 days', do_not_contact_reason = 'rc test' WHERE id = c4;

  -- Cases: Withdrawn needs no submission group (a lead withdrawn).
  INSERT INTO cases (account_id, agent_id, contact_id, stage, outcome, closed_at)
  SELECT a_acct, u_agent, x.cid, 'Withdrawn', 'Withdrawn', x.ended
    FROM (VALUES (c1, now() - interval '100 days'), (c2, now() - interval '30 days'),
                 (c3, now() - interval '100 days'), (c4, now() - interval '100 days'),
                 (c5, now() - interval '100 days'), (c6, now() - interval '100 days')) AS x(cid, ended);
  INSERT INTO cases (account_id, agent_id, contact_id, stage) VALUES (a_acct, u_agent, c5, 'Interested');
  INSERT INTO cases (account_id, agent_id, contact_id, stage, outcome, closed_at)
  VALUES (b_acct, u_other, c8, 'Withdrawn', 'Withdrawn', now() - interval '100 days');

  -- c6 wrote again 20 days ago.
  INSERT INTO conversations (account_id, user_id, contact_id, last_message_at)
  VALUES (a_acct, u_agent, c6, now() - interval '20 days') RETURNING id INTO cv6;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
  VALUES (cv6, 'customer', 'hello again', now() - interval '20 days');

  -- c7: a chat tagged "Not interested", last message 100 days ago.
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'RC not interested') RETURNING id INTO tag_no;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, tag_no, 'RC sub') RETURNING id INTO tag_sub;
  INSERT INTO conversations (account_id, user_id, contact_id, last_message_at, chat_tag_id)
  VALUES (a_acct, u_agent, c7, now() - interval '100 days', tag_no) RETURNING id INTO cv7;

  -- ---------- defaults: 90 days, cases only ----------
  v_text := pg_temp.rc_try('authenticated', u_admin,
    'SELECT coalesce(string_agg(name, '','' ORDER BY name), '''') FROM recycle_candidates()');
  n := n + 1;
  IF v_text <> 'RC declined 100d' THEN
    failed := array_append(failed, ('default list should be only the 100-day decline (not 30d, opted out, DNC, open lead, came back, other account, untagged chat): ' || v_text)::text);
  END IF;

  -- ---------- who may read ----------
  v_text := pg_temp.rc_try('authenticated', u_agent, 'SELECT count(*)::text FROM recycle_candidates()');
  n := n + 1;
  IF v_text <> '0' THEN failed := array_append(failed, ('an agent got rows: ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_other, format('SELECT count(*)::text FROM recycle_candidates() WHERE contact_id = %L', c1));
  n := n + 1;
  IF v_text <> '0' THEN failed := array_append(failed, ('another account''s owner saw rows of A: ' || v_text)::text); END IF;

  -- ---------- days override ----------
  v_text := pg_temp.rc_try('authenticated', u_admin, 'SELECT count(*)::text FROM recycle_candidates(20)');
  n := n + 1;
  IF v_text <> '2' THEN failed := array_append(failed, ('20-day override should list the 100d and 30d declines only: ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, 'SELECT count(*)::text FROM recycle_candidates(0)');
  n := n + 1;
  IF v_text NOT LIKE 'ERROR 22023:%' THEN failed := array_append(failed, ('days 0 was accepted: ' || v_text)::text); END IF;

  -- ---------- settings ----------
  v_text := pg_temp.rc_try('authenticated', u_agent, format(
    'SELECT recycle_settings_set(60, ARRAY[]::uuid[], ARRAY[''Declined'', ''Withdrawn'']::text[])::text'));
  n := n + 1;
  IF v_text NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('an agent changed the settings: ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, format(
    'SELECT recycle_settings_set(60, ARRAY[%L]::uuid[], ARRAY[''Declined'', ''Withdrawn'']::text[])::text', tag_sub));
  n := n + 1;
  IF v_text NOT LIKE 'ERROR 22023:%' THEN failed := array_append(failed, ('a sub-tag was accepted as declined-type: ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, 'SELECT recycle_settings_set(731, ARRAY[]::uuid[], NULL)::text');
  n := n + 1;
  IF v_text NOT LIKE 'ERROR 22023:%' THEN failed := array_append(failed, ('731 days was accepted: ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, format(
    'SELECT recycle_settings_set(20, ARRAY[%L]::uuid[], ARRAY[''Declined'', ''Withdrawn'']::text[])::text', tag_no));
  n := n + 1;
  IF v_text IS NULL OR v_text LIKE 'ERROR%' THEN failed := array_append(failed, ('admin could not save settings: ' || v_text)::text); END IF;

  -- Settings now: 20 days + the tag: the 100d case, the 30d case and the tagged chat.
  v_text := pg_temp.rc_try('authenticated', u_admin,
    'SELECT coalesce(string_agg(name, '','' ORDER BY name), '''') FROM recycle_candidates()');
  n := n + 1;
  IF v_text <> 'RC chat declined,RC declined 100d,RC declined 30d' THEN
    failed := array_append(failed, ('settings (20 days + tag) not respected: ' || v_text)::text);
  END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, 'SELECT count(*)::text FROM recycle_candidates(NULL, 1, 0)');
  n := n + 1;
  IF v_text <> '1' THEN failed := array_append(failed, ('limit 1 returned ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, 'SELECT max(total_count)::text FROM recycle_candidates(NULL, 1, 0)');
  n := n + 1;
  IF v_text <> '3' THEN failed := array_append(failed, ('total_count should stay 3 under a limit: ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, 'SELECT count(*)::text FROM recycle_candidates(NULL, 50, 0, ''971500251007'')');
  n := n + 1;
  IF v_text <> '1' THEN failed := array_append(failed, ('phone search: ' || v_text)::text); END IF;

  -- A newer ending keeps a customer out: c9 declined 100 and 5 days ago.
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500251009', 'RC declined twice') RETURNING id INTO c9;
  INSERT INTO cases (account_id, agent_id, contact_id, stage, outcome, closed_at) VALUES
    (a_acct, u_agent, c9, 'Withdrawn', 'Withdrawn', now() - interval '100 days'),
    (a_acct, u_agent, c9, 'Withdrawn', 'Withdrawn', now() - interval '5 days');
  v_text := pg_temp.rc_try('authenticated', u_admin, format(
    'SELECT count(*)::text FROM recycle_candidates() WHERE contact_id = %L', c9));
  n := n + 1;
  IF v_text <> '0' THEN failed := array_append(failed, ('a newer decline did not hide the older one: ' || v_text)::text); END IF;

  -- ---------- tasks ----------
  v_text := pg_temp.rc_try('authenticated', u_agent, format(
    'SELECT created::text FROM recycle_create_tasks(ARRAY[%L]::uuid[])', c1));
  n := n + 1;
  IF v_text NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('an agent filed recycling tasks: ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, format(
    'SELECT created || '','' || already_filed || '','' || not_eligible FROM recycle_create_tasks(ARRAY[%L, %L, %L]::uuid[])', c1, c3, c5));
  n := n + 1;
  IF v_text <> '1,0,2' THEN failed := array_append(failed, ('first run should create 1, skip 0, refuse the opted-out and open-lead contacts: ' || v_text)::text); END IF;
  v_text := pg_temp.rc_try('authenticated', u_admin, format(
    'SELECT created || '','' || already_filed || '','' || not_eligible FROM recycle_create_tasks(ARRAY[%L]::uuid[])', c1));
  n := n + 1;
  IF v_text <> '0,1,0' THEN failed := array_append(failed, ('second run must not duplicate: ' || v_text)::text); END IF;
  SELECT count(*)::text INTO v_text FROM tasks
   WHERE account_id = a_acct AND contact_id = c1 AND source = 'chat' AND kind = 'follow_up'
     AND source_ref LIKE 'recycle:%' AND assigned_to = u_agent AND created_by = u_admin
     AND title LIKE 'Follow up: RC declined 100d (declined %)';
  n := n + 1;
  IF v_text <> '1' THEN failed := array_append(failed, ('the task is not one follow_up on the owner, by the caller: ' || v_text)::text); END IF;

  -- Grants: no client write to settings, no anon.
  n := n + 1;
  IF has_table_privilege('authenticated', 'public.recycle_settings', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.recycle_settings', 'SELECT') THEN
    failed := array_append(failed, 'clients hold a write grant on recycle_settings, or anon can read it'::text);
  END IF;
  n := n + 1;
  IF has_function_privilege('anon', 'public.recycle_candidates(integer, integer, integer, text, uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.recycle_excluded_among(uuid[], timestamptz[])', 'EXECUTE') THEN
    failed := array_append(failed, 'anon may execute a recycling function'::text);
  END IF;

  -- 263: approved since the ending.
  DECLARE t_u uuid; t_0 int; t_1 int;
  BEGIN
    SELECT p.user_id INTO t_u FROM profiles p WHERE p.account_id = a_acct AND p.account_role = 'owner' AND p.is_active LIMIT 1;
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', t_u, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', t_u::text, true);
    SELECT count(*) INTO t_0 FROM recycle_excluded_among(ARRAY[c1], ARRAY[now() - interval '100 days']);
    INSERT INTO cases (account_id, agent_id, contact_id, stage, outcome, closed_at)
      VALUES (a_acct, u_agent, c1, 'Closed', 'Approved', now() - interval '50 days');
    SELECT count(*) INTO t_1 FROM recycle_excluded_among(ARRAY[c1], ARRAY[now() - interval '100 days']);
  n := n + 1;
  IF (t_0 = 0 AND t_1 = 1) IS NOT TRUE THEN failed := array_append(failed, '263: a customer approved after the ending was still offered'::text); END IF;
  END;

  RAISE EXCEPTION USING ERRCODE = 'ZT251', MESSAGE = 'verify-recycle rollback';
  EXCEPTION WHEN SQLSTATE 'ZT251' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'recycle verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'recycle verification passed (% checks)', n;
END
$verify$;
