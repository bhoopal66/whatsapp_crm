-- Behavioural regression suite for migration 266 (handing over the work
-- of a person who leaves). ONE statement on purpose (the pinned CLI
-- rejects several); fixtures are rolled back through a sentinel.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000266001';
  u_adm UUID := '00000000-0000-4000-8000-000000266002';  -- the caller
  u_lv  UUID := '00000000-0000-4000-8000-000000266003';  -- the leaver
  u_to  UUID := '00000000-0000-4000-8000-000000266004';  -- takes over
  u_oth UUID := '00000000-0000-4000-8000-000000266005';  -- another agent
  u_vw  UUID := '00000000-0000-4000-8000-000000266006';
  u_gst UUID := '00000000-0000-4000-8000-000000266007';
  u_off UUID := '00000000-0000-4000-8000-000000266008';  -- deactivated
  u_hr  UUID := '00000000-0000-4000-8000-000000266009';  -- restricted department
  u_b   UUID := '00000000-0000-4000-8000-000000266010';  -- owner of B
  a UUID; b UUID;
  k UUID[] := '{}'; v UUID[] := '{}'; d UUID[] := '{}';
  v_personal UUID; v_free UUID; v_task UUID; v_done UUID; v_task_oth UUID;
  b_contact UUID; b_chat UUID; b_task UUID; b_deal UUID;
  p_lv UUID; p_oth UUID; p_to UUID;
  pipe UUID; st UUID; bpipe UUID; bst UUID;
  x UUID; t TEXT; r RECORD; i INT;
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mh_ok(p_ok boolean, p_what text) RETURNS text
    LANGUAGE sql AS $b$ SELECT CASE WHEN p_ok IS TRUE THEN NULL ELSE p_what END $b$
  $fn$;
  -- A query as a signed-in user: its first value, or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mh(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'NULL');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'mh-owner@example.test'), (u_adm, 'mh-admin@example.test'), (u_lv, 'mh-leaver@example.test'),
    (u_to, 'mh-to@example.test'), (u_oth, 'mh-other@example.test'), (u_vw, 'mh-viewer@example.test'),
    (u_gst, 'mh-guest@example.test'), (u_off, 'mh-off@example.test'), (u_hr, 'mh-hr@example.test'),
    (u_b, 'mh-b@example.test');
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('mh-a', u_own) RETURNING id INTO a;
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('mh-b', u_b) RETURNING id INTO b;
  UPDATE public.profiles SET account_id = a, account_role = 'owner' WHERE user_id = u_own;
  UPDATE public.profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_adm;
  UPDATE public.profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_lv, u_to, u_oth, u_off, u_hr);
  UPDATE public.profiles SET account_id = a, account_role = 'viewer' WHERE user_id = u_vw;
  UPDATE public.profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_gst;
  UPDATE public.profiles SET account_id = b, account_role = 'owner' WHERE user_id = u_b;
  UPDATE public.profiles SET full_name = 'Mh Leaver' WHERE user_id = u_lv;
  UPDATE public.profiles SET department = 'hr' WHERE user_id = u_hr;
  UPDATE public.profiles SET deactivated_at = now() WHERE user_id = u_off;
  -- The leaver works in B too.
  INSERT INTO public.profiles (user_id, account_id, account_role, full_name, email, is_active)
  VALUES (u_lv, b, 'agent', 'Mh Leaver', 'mh-leaver@example.test', false);
  SELECT id INTO p_lv FROM public.profiles WHERE user_id = u_lv AND account_id = a;
  SELECT id INTO p_oth FROM public.profiles WHERE user_id = u_oth;
  SELECT id INTO p_to FROM public.profiles WHERE user_id = u_to;

  -- Contacts 1-8 (7 is another's). The leaver's chats: 1 open, 2 closed.
  -- 5's chat is unassigned, 6's another agent's, 8's is personal.
  FOR i IN 1..8 LOOP
    INSERT INTO public.contacts (user_id, account_id, phone, name)
    VALUES (CASE WHEN i = 7 THEN u_oth ELSE u_lv END, a, '+97150266000' || i, 'mh ' || i) RETURNING id INTO x;
    k := k || x;
  END LOOP;
  INSERT INTO public.conversations (user_id, account_id, contact_id, assigned_agent_id, status)
  VALUES (u_own, a, k[1], u_lv, 'open') RETURNING id INTO x; v := v || x;
  INSERT INTO public.conversations (user_id, account_id, contact_id, assigned_agent_id, status)
  VALUES (u_own, a, k[2], u_lv, 'closed') RETURNING id INTO x; v := v || x;
  INSERT INTO public.conversations (user_id, account_id, contact_id)
  VALUES (u_own, a, k[5]) RETURNING id INTO v_free;
  INSERT INTO public.conversations (user_id, account_id, contact_id, assigned_agent_id)
  VALUES (u_own, a, k[6], u_oth) RETURNING id INTO x; v := v || x;
  UPDATE public.contacts SET user_id = u_lv WHERE id = k[6];
  INSERT INTO public.conversations (user_id, account_id, contact_id, assigned_agent_id, personal_owner_id)
  VALUES (u_lv, a, k[8], u_lv, u_lv) RETURNING id INTO v_personal;
  INSERT INTO public.tasks (account_id, title, kind, source, assigned_to, created_by) VALUES (a, 'mh', 'manual', 'manual', u_lv, u_lv) RETURNING id INTO v_task;
  INSERT INTO public.tasks (account_id, title, kind, source, assigned_to, created_by, status) VALUES (a, 'mh', 'manual', 'manual', u_lv, u_lv, 'done') RETURNING id INTO v_done;
  INSERT INTO public.tasks (account_id, title, kind, source, assigned_to, created_by) VALUES (a, 'mh', 'manual', 'manual', u_oth, u_lv) RETURNING id INTO v_task_oth;
  INSERT INTO public.pipelines (user_id, account_id, name) VALUES (u_own, a, 'mh') RETURNING id INTO pipe;
  INSERT INTO public.pipeline_stages (pipeline_id, name, position) VALUES (pipe, 'mh', 0) RETURNING id INTO st;
  -- Deals 1 (assignee) and 2 (creator) are the leaver's; 3 was given away, 4 is won.
  INSERT INTO public.deals (user_id, account_id, pipeline_id, stage_id, title, assigned_to) VALUES (u_own, a, pipe, st, 'mh', p_lv) RETURNING id INTO x; d := d || x;
  INSERT INTO public.deals (user_id, account_id, pipeline_id, stage_id, title) VALUES (u_lv, a, pipe, st, 'mh') RETURNING id INTO x; d := d || x;
  INSERT INTO public.deals (user_id, account_id, pipeline_id, stage_id, title, assigned_to) VALUES (u_lv, a, pipe, st, 'mh', p_oth) RETURNING id INTO x; d := d || x;
  INSERT INTO public.deals (user_id, account_id, pipeline_id, stage_id, title, assigned_to, status) VALUES (u_own, a, pipe, st, 'mh', p_lv, 'won') RETURNING id INTO x; d := d || x;
  -- The same person's work in B.
  INSERT INTO public.contacts (user_id, account_id, phone, name) VALUES (u_lv, b, '+971502660099', 'mh b') RETURNING id INTO b_contact;
  INSERT INTO public.conversations (user_id, account_id, contact_id, assigned_agent_id) VALUES (u_b, b, b_contact, u_lv) RETURNING id INTO b_chat;
  INSERT INTO public.tasks (account_id, title, kind, source, assigned_to, created_by) VALUES (b, 'mh', 'manual', 'manual', u_lv, u_b) RETURNING id INTO b_task;
  INSERT INTO public.pipelines (user_id, account_id, name) VALUES (u_b, b, 'mh') RETURNING id INTO bpipe;
  INSERT INTO public.pipeline_stages (pipeline_id, name, position) VALUES (bpipe, 'mh', 0) RETURNING id INTO bst;
  INSERT INTO public.deals (user_id, account_id, pipeline_id, stage_id, title) VALUES (u_lv, b, bpipe, bst, 'mh') RETURNING id INTO b_deal;

  -- 1. Counts; only the deactivated are listed.
  t := pg_temp.mh(u_adm, format('SELECT public.member_work_counts(%L)', u_lv));
  failed := array_append(failed, pg_temp.mh_ok(t = '{"chats": 2, "deals": 2, "tasks": 1, "contacts": 4}', 'counts: ' || t)); n := n + 1;
  t := pg_temp.mh(u_adm, 'SELECT count(*) FROM public.members_left_work()');
  failed := array_append(failed, pg_temp.mh_ok(t = '0', 'live people listed: ' || t)); n := n + 1;
  UPDATE public.profiles SET deactivated_at = now() WHERE id = p_lv;
  t := pg_temp.mh(u_adm, 'SELECT string_agg(w::text, '';'') FROM public.members_left_work() w');
  failed := array_append(failed, pg_temp.mh_ok(t = format('(%s,2,1,2,4)', u_lv), 'left work: ' || t)); n := n + 1;

  -- 2. Refusals.
  FOR r IN SELECT * FROM (VALUES
    (u_oth, u_lv, u_to, '{chats}', '42501', 'an agent'),
    (u_vw, u_lv, u_to, '{chats}', '42501', 'a viewer'),
    (u_gst, u_lv, u_to, '{chats}', '42501', 'a guest'),
    (u_lv, u_lv, u_to, '{chats}', '42501', 'the deactivated leaver'),
    (u_adm, u_lv, u_to, '{}', '22023', 'empty list'),
    (u_adm, u_lv, u_to, NULL, '22023', 'no list'),
    (u_adm, u_lv, u_to, '{chats,NULL}', '22023', 'a NULL kind'),
    (u_adm, u_lv, u_to, '{chats,cases}', '22023', 'an unknown kind'),
    (u_adm, u_lv, u_lv, '{chats}', '22023', 'the same person'),
    (u_adm, u_lv, u_gst, '{tasks}', '22023', 'a guest target'),
    (u_adm, u_lv, u_vw, '{tasks}', '22023', 'a viewer target'),
    (u_adm, u_lv, u_off, '{tasks}', '22023', 'a deactivated target'),
    (u_adm, u_lv, u_hr, '{chats}', '22023', 'chats to a restricted department'),
    (u_adm, u_lv, u_hr, '{tasks,deals}', '22023', 'deals to a restricted department'),
    (u_adm, u_lv, u_hr, '{contacts}', '22023', 'contacts to a restricted department'),
    (u_adm, u_lv, u_b, '{tasks}', '42501', 'another workspace''s person'),
    (u_adm, u_b, u_to, '{tasks}', '42501', 'from another workspace''s person'),
    (u_b, u_to, u_lv, '{tasks}', '42501', 'B''s owner over A''s person'),
    (u_adm, gen_random_uuid(), u_to, '{tasks}', '22023', 'an unknown person'),
    (u_adm, u_gst, u_to, '{tasks}', '22023', 'from a guest')) AS c(caller, f, target, what, code, label)
  LOOP
    t := pg_temp.mh(r.caller, format('SELECT public.member_handover(%L, %L, %L)', r.f, r.target, r.what));
    failed := array_append(failed, pg_temp.mh_ok(t LIKE 'ERROR ' || r.code || ':%', r.label || ': ' || t)); n := n + 1;
  END LOOP;
  t := pg_temp.mh(u_oth, format('SELECT public.member_work_counts(%L)', u_lv))
    || pg_temp.mh(u_oth, 'SELECT count(*) FROM public.members_left_work()');
  failed := array_append(failed, pg_temp.mh_ok(t LIKE 'ERROR 42501:%ERROR 42501:%', 'an agent reads counts: ' || t)); n := n + 1;
  t := pg_temp.mh(u_adm, format('SELECT public.member_work_counts(%L)', u_b));
  failed := array_append(failed, pg_temp.mh_ok(t LIKE 'ERROR 42501:%', 'counts of another workspace''s person: ' || t)); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    NOT has_function_privilege('anon', 'public.member_handover(uuid,uuid,text[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.member_work_counts(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.members_left_work()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.member_work(uuid,uuid[])', 'EXECUTE'), 'grants')); n := n + 1;

  -- 3. Each kind moves, and only it.
  t := pg_temp.mh(u_adm, format('SELECT public.member_handover(%L, %L, ''{tasks}'')', u_lv, u_to));
  failed := array_append(failed, pg_temp.mh_ok(t = '{"chats": 0, "deals": 0, "tasks": 1, "contacts": 0}', 'tasks: ' || t)); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT assigned_to FROM public.tasks WHERE id = v_task) = u_to
    AND (SELECT assigned_to FROM public.tasks WHERE id = v_done) = u_lv
    AND (SELECT assigned_to FROM public.tasks WHERE id = v_task_oth) = u_oth
    AND pg_temp.mh(u_adm, format('SELECT public.member_work_counts(%L)', u_lv)) = '{"chats": 2, "deals": 2, "tasks": 0, "contacts": 4}',
    'tasks moved something else')); n := n + 1;
  t := pg_temp.mh(u_adm, format('SELECT public.member_handover(%L, %L, ''{deals}'')', u_lv, u_to));
  failed := array_append(failed, pg_temp.mh_ok(t = '{"chats": 0, "deals": 2, "tasks": 0, "contacts": 0}', 'deals: ' || t)); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT array_agg(assigned_to ORDER BY array_position(d, id)) FROM public.deals WHERE id = ANY (d)) = ARRAY[p_to, p_to, p_oth, p_lv]
    AND (SELECT user_id FROM public.deals WHERE id = d[2]) = u_lv
    AND pg_temp.mh(u_adm, format('SELECT public.member_work_counts(%L)', u_lv)) = '{"chats": 2, "deals": 0, "tasks": 0, "contacts": 4}',
    'deals moved something else')); n := n + 1;
  t := pg_temp.mh(u_adm, format('SELECT public.member_handover(%L, %L, ''{contacts}'')', u_lv, u_to));
  failed := array_append(failed, pg_temp.mh_ok(t = '{"chats": 0, "deals": 0, "tasks": 0, "contacts": 4}', 'contacts: ' || t)); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT array_agg(user_id ORDER BY array_position(k, id)) FROM public.contacts WHERE id = ANY (k))
      = ARRAY[u_lv, u_lv, u_to, u_to, u_to, u_lv, u_oth, u_to]
    AND (SELECT count(*) FROM public.conversations WHERE id = ANY (v) AND assigned_agent_id = u_lv) = 2,
    'contacts moved something else')); n := n + 1;
  t := pg_temp.mh(u_adm, format('SELECT public.member_handover(%L, %L, ''{chats,chats}'')', u_lv, u_to));
  failed := array_append(failed, pg_temp.mh_ok(t = '{"chats": 2, "deals": 0, "tasks": 0, "contacts": 0}', 'chats: ' || t)); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT array_agg(assigned_agent_id ORDER BY array_position(v, id)) FROM public.conversations WHERE id = ANY (v)) = ARRAY[u_to, u_to, u_oth]
    AND (SELECT array_agg(status ORDER BY array_position(v, id)) FROM public.conversations WHERE id = ANY (v)) = ARRAY['open', 'closed', 'open']
    AND (SELECT assigned_agent_id IS NULL FROM public.conversations WHERE id = v_free),
    'chats moved something else')); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT count(*) FROM public.contacts WHERE id IN (k[1], k[2]) AND user_id = u_to) = 2
    AND (SELECT user_id FROM public.contacts WHERE id = k[6]) = u_lv
    AND (SELECT user_id FROM public.contacts WHERE id = k[7]) = u_oth, 'contact owner follows the chat')); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT assigned_agent_id = u_lv AND personal_owner_id = u_lv FROM public.conversations WHERE id = v_personal),
    'a personal chat moved')); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT user_id FROM public.contacts WHERE id = b_contact) = u_lv
    AND (SELECT assigned_agent_id FROM public.conversations WHERE id = b_chat) = u_lv
    AND (SELECT assigned_to FROM public.tasks WHERE id = b_task) = u_lv
    AND (SELECT assigned_to IS NULL AND user_id = u_lv FROM public.deals WHERE id = b_deal),
    'another workspace''s rows moved')); n := n + 1;
  t := pg_temp.mh(u_adm, 'SELECT count(*) FROM public.members_left_work()');
  failed := array_append(failed, pg_temp.mh_ok(t = '0', 'still listed: ' || t)); n := n + 1;

  -- 4. One bell per handover, none per row; pressing again does nothing.
  t := pg_temp.mh(u_adm, format('SELECT public.member_handover(%L, %L, ''{chats,tasks,deals,contacts}'')', u_lv, u_to));
  failed := array_append(failed, pg_temp.mh_ok(t = '{"chats": 0, "deals": 0, "tasks": 0, "contacts": 0}', 'pressed twice: ' || t)); n := n + 1;
  SELECT string_agg(body, ';' ORDER BY body COLLATE "C") INTO t FROM public.notifications
   WHERE user_id = u_to AND type = 'work_handed_over' AND actor_user_id = u_adm AND account_id = a;
  failed := array_append(failed, pg_temp.mh_ok(
    t = '1 task from Mh Leaver;2 chats from Mh Leaver;2 deals from Mh Leaver;4 customers from Mh Leaver',
    'bells: ' || coalesce(t, 'none'))); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT count(*) FROM public.notifications WHERE user_id = u_to) = 4, 'per-row bells')); n := n + 1;

  -- 5. The switch is off afterwards: an ordinary assignment rings.
  failed := array_append(failed, pg_temp.mh_ok(
    coalesce(current_setting('app.member_handover', true), '') = '', 'app.member_handover left on')); n := n + 1;
  t := pg_temp.mh(u_adm, format('UPDATE public.conversations SET assigned_agent_id = %L WHERE id = %L RETURNING id', u_to, v_free))
    || pg_temp.mh(u_adm, format('UPDATE public.tasks SET assigned_to = %L WHERE id = %L RETURNING id', u_to, v_task_oth));
  failed := array_append(failed, pg_temp.mh_ok(
    (SELECT array_agg(type ORDER BY type) FROM public.notifications
      WHERE user_id = u_to AND type <> 'work_handed_over') = ARRAY['conversation_assigned', 'task_assigned'],
    'an ordinary assignment is silent: ' || t)); n := n + 1;

  -- 6. One audit row per handover that moved something.
  SELECT count(*) INTO i FROM public.workspace_audit
   WHERE account_id = a AND action = 'work_handed_over' AND actor_id = u_adm AND target_user_id = u_lv;
  failed := array_append(failed, pg_temp.mh_ok(i = 4, 'audit rows: ' || i)); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(EXISTS (
    SELECT 1 FROM public.workspace_audit WHERE account_id = a AND action = 'work_handed_over'
     AND detail = jsonb_build_object('to', u_to, 'name', 'Mh Leaver', 'chats', 2, 'tasks', 0, 'deals', 0, 'contacts', 0)),
    'audit detail')); n := n + 1;

  -- 7. All kinds at once, from a live person, to oneself: no bell.
  t := pg_temp.mh(u_adm, format('SELECT public.member_handover(%L, %L, ''{chats,tasks,deals,contacts}'')', u_to, u_adm));
  failed := array_append(failed, pg_temp.mh_ok(t = '{"chats": 3, "deals": 2, "tasks": 2, "contacts": 3}', 'all at once: ' || t)); n := n + 1;
  failed := array_append(failed, pg_temp.mh_ok(
    NOT EXISTS (SELECT 1 FROM public.notifications WHERE user_id = u_adm), 'rang the caller')); n := n + 1;
  -- A restricted department may take tasks.
  t := pg_temp.mh(u_adm, format('SELECT public.member_handover(%L, %L, ''{tasks}'')', u_adm, u_hr));
  failed := array_append(failed, pg_temp.mh_ok(t LIKE '%"tasks": 2%', 'tasks to HR: ' || t)); n := n + 1;

  RAISE EXCEPTION 'MH_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'MH_ROLLBACK' THEN RAISE; END IF;
  END;

  failed := array_remove(failed, NULL);
  IF n < 48 THEN RAISE EXCEPTION 'verify-member-handover: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-member-handover: % of % failed: %', cardinality(failed), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-member-handover: % checks passed', n;
END $verify$;
