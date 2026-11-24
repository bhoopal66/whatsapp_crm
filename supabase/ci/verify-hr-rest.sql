-- Migration 317: an erasure and an export reach the tasks that name a
-- customer without pointing at them (an HR rule's, by its chat; a missed
-- call's, by its call or number), and never somebody else's; an HR template
-- is saved only over what the page had loaded. One statement, rolled back by
-- the sentinel at its end.
DO $verify$
DECLARE
  u_own uuid := gen_random_uuid();
  u_agt uuid := gen_random_uuid();
  a uuid; c_a uuid; c_b uuid; v_a uuid; v_b uuid;
  k_free uuid; k_b uuid; k_cand uuid; k_gone uuid := gen_random_uuid();
  t_hr uuid; t_free uuid; t_gone uuid; t_cand uuid;
  keep uuid[]; gone uuid[]; got uuid[];
  j jsonb; at1 text; r text; n int;
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_own, 'hrr-own@example.invalid'), (u_agt, 'hrr-agt@example.invalid');
  SELECT id INTO a FROM accounts WHERE owner_user_id = u_own;
  ASSERT a IS NOT NULL, 'fixture: auth.users trigger did not provision an account';
  UPDATE profiles SET is_active = false WHERE user_id = u_agt;
  INSERT INTO profiles (user_id, account_id, account_role, full_name, email, is_active)
  VALUES (u_agt, a, 'agent', 'hrr agent', 'hrr-agt@example.invalid', true);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_own, '971501117701', 'hrr A') RETURNING id INTO c_a;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, u_own, '971501117702', 'hrr B') RETURNING id INTO c_b;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a, u_own, c_a) RETURNING id INTO v_a;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a, u_own, c_b) RETURNING id INTO v_b;
  INSERT INTO calls (account_id, pbx_call_id, direction, status, remote_number, meta, started_at)
  VALUES (a, 'hrr-free', 'inbound', 'answered', '971501117701', '{}', now()) RETURNING id INTO k_free;
  INSERT INTO calls (account_id, pbx_call_id, direction, status, contact_id, remote_number, meta, started_at)
  VALUES (a, 'hrr-b', 'inbound', 'answered', c_b, '971501117701', '{}', now()) RETURNING id INTO k_b;
  INSERT INTO calls (account_id, pbx_call_id, direction, status, remote_number, meta, started_at)
  VALUES (a, 'hrr-cand', 'inbound', 'answered', '971509990009', jsonb_build_object('contact_candidates', jsonb_build_array(c_a, c_b)), now())
  RETURNING id INTO k_cand;

  -- What an erasure of A takes.
  INSERT INTO tasks (account_id, kind, title, conversation_id, source, source_ref)
  VALUES (a, 'follow_up', 'hrr A: interview notes', v_a, 'automation', 'hr:' || v_a || ':x:1') RETURNING id INTO t_hr;
  INSERT INTO tasks (account_id, kind, title, source, source_ref, meta)
  VALUES (a, 'missed_call', 'Call back +971501117701', 'pbx', 'call:' || k_free, jsonb_build_object('remote_number', '971501117701'))
  RETURNING id INTO t_free;
  INSERT INTO tasks (account_id, kind, title, source, source_ref, meta)
  VALUES (a, 'missed_call', 'Call back 971501117701 (its call is gone)', 'pbx', 'call:' || k_gone,
          jsonb_build_object('remote_number', '971501117701')) RETURNING id INTO t_gone;
  INSERT INTO tasks (account_id, kind, title, source, source_ref, meta)
  VALUES (a, 'missed_call', 'Call back a candidate', 'pbx', 'call:' || k_cand, jsonb_build_object('remote_number', '971509990009'))
  RETURNING id INTO t_cand;
  gone := ARRAY[t_hr, t_free, t_gone, t_cand];

  -- What it leaves: B's, nobody's, and another reference of the PBX.
  WITH x AS (
    INSERT INTO tasks (account_id, kind, title, conversation_id, source, source_ref, meta) VALUES
      (a, 'follow_up', 'hrr B: interview notes', v_b, 'automation', 'hr:' || v_b || ':x:1', '{}'),
      (a, 'missed_call', 'Call back B', NULL, 'pbx', 'call:' || k_b, jsonb_build_object('remote_number', '971501117701')),
      (a, 'missed_call', 'Call back somebody', NULL, 'pbx', 'call:not-a-uuid', jsonb_build_object('remote_number', '971501118888')),
      (a, 'follow_up', 'a private reminder', NULL, 'manual', NULL, '{}')
    RETURNING id)
  SELECT array_agg(id) INTO keep FROM x;

  j := privacy_subject_export(u_own, a, c_a) -> 'data';
  SELECT array_agg((e ->> 'id')::uuid) INTO got FROM jsonb_array_elements(j -> 'tasks_without_contact') e;
  ASSERT got @> gone AND gone @> got, format('the export: %s', j -> 'tasks_without_contact');
  ASSERT privacy_subject_export(u_own, a, c_b) -> 'data' -> 'tasks_without_contact' @> jsonb_build_array(jsonb_build_object('title', 'Call back B')),
    'B''s own export holds the missed call linked to them';

  j := privacy_subject_erase(u_own, a, c_a, true);
  ASSERT (j -> 'counts' ->> 'tasks_without_contact')::int = 4, format('the dry run: %s', j -> 'counts');
  SELECT count(*) INTO n FROM tasks WHERE id = ANY (gone);
  ASSERT n = 4, 'a dry run deletes nothing';
  j := privacy_subject_erase(u_own, a, c_a, false, 'ERASE ' || c_a::text);
  ASSERT (j -> 'counts' ->> 'tasks_without_contact')::int = 4, format('the erasure: %s', j -> 'counts');
  SELECT count(*) INTO n FROM tasks WHERE id = ANY (gone);
  ASSERT n = 0, 'the tasks are gone';
  SELECT count(*) INTO n FROM tasks WHERE id = ANY (keep);
  ASSERT n = 4, 'the others stay';

  -- ---------- an HR template ----------
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hrr_as(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $b$
    DECLARE v text; h text; st text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT;
        RESET ROLE;
        RETURN format('ERROR %s %s', st, h);
      END;
    END $b$ $fn$;
  r := pg_temp.hrr_as(u_agt, 'SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''cv_ack'', ''draft'', ''utility'', ''whatsapp'', NULL::timestamptz)::text');
  ASSERT r = 'ERROR 42501 NOT_ALLOWED', 'an agent: ' || r;
  r := pg_temp.hrr_as(u_agt, 'SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''cv_ack'', ''draft'', ''utility'', ''whatsapp'', now())::text');
  ASSERT r = 'ERROR 42501 NOT_ALLOWED', 'an agent with another version: ' || r;
  r := pg_temp.hrr_as(u_own, 'SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''cv_ack'', ''draft'', ''utility'', ''whatsapp'', now())::text');
  ASSERT r = 'ERROR 22023 STALE', 'nothing is stored, the page says something was: ' || r;
  r := pg_temp.hrr_as(u_own, 'SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''One'', ''cv_ack'', ''draft'', ''utility'', ''whatsapp'', NULL::timestamptz) #>> ''{templates,0,updated_at}''');
  ASSERT r NOT LIKE 'ERROR%', 'the first save: ' || r;
  at1 := r;
  r := pg_temp.hrr_as(u_own, 'SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Two'', ''cv_ack'', ''draft'', ''utility'', ''whatsapp'', NULL::timestamptz)::text');
  ASSERT r = 'ERROR 22023 STALE', 'a second first save: ' || r;
  -- now() stands still here: the stored row is aged by hand.
  UPDATE hr_automsg_templates SET updated_at = now() - interval '1 hour' WHERE account_id = a;
  r := pg_temp.hrr_as(u_own, format('SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Two'', ''cv_ack'', ''draft'', ''utility'', ''whatsapp'', %L::timestamptz)::text', at1));
  ASSERT r = 'ERROR 22023 STALE', 'over a newer row: ' || r;
  ASSERT (SELECT body FROM hr_automsg_templates WHERE account_id = a) = 'One', 'a refusal writes nothing';
  -- Another channel's row is not this one's version.
  r := pg_temp.hrr_as(u_own, 'SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Sms'', '''', ''draft'', ''utility'', ''sms'', NULL::timestamptz)::text');
  ASSERT r NOT LIKE 'ERROR%', 'another channel: ' || r;
  -- With the version the config answers, as text, microseconds and all.
  SELECT x.updated_at INTO at1 FROM hr_automsg_templates x WHERE x.account_id = a AND x.channel = 'whatsapp';
  SELECT e ->> 'updated_at' INTO at1
    FROM jsonb_array_elements(pg_temp.hrr_as(u_own, 'SELECT hr_automsg_config()::text')::jsonb -> 'templates') e
   WHERE e ->> 'channel' = 'whatsapp';
  r := pg_temp.hrr_as(u_own, format('SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Two'', ''cv_ack'', ''draft'', ''utility'', ''whatsapp'', %L::timestamptz)::text', at1));
  ASSERT r NOT LIKE 'ERROR%', 'the stored version: ' || r;
  ASSERT (SELECT body FROM hr_automsg_templates WHERE account_id = a AND channel = 'whatsapp') = 'Two', 'saved';
  -- The running build's call, without a version.
  r := pg_temp.hrr_as(u_own, 'SELECT hr_automsg_template_set(p_kind => ''cv_ack'', p_language => ''en'', p_body => ''Three'', p_meta_template_name => ''cv_ack'', p_approval_status => ''draft'', p_category => ''utility'', p_channel => ''whatsapp'')::text');
  ASSERT r NOT LIKE 'ERROR%', 'without a version: ' || r;

  ASSERT has_function_privilege('authenticated', 'public.hr_automsg_template_set(text,text,text,text,text,text,text,timestamptz)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.hr_automsg_template_set(text,text,text,text,text,text,text,timestamptz)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.privacy_unlinked_task_ids(uuid,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.privacy_unlinked_tasks_export(uuid,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.privacy_unlinked_tasks_erase(uuid,uuid)', 'EXECUTE')
     AND NOT has_function_privilege('service_role', 'public.privacy_unlinked_tasks_erase(uuid,uuid)', 'EXECUTE'), 'grants';
  RAISE EXCEPTION USING ERRCODE = 'ZT317', MESSAGE = 'verify-hr-rest rollback';
  EXCEPTION WHEN SQLSTATE 'ZT317' THEN
    NULL;
  END;
END $verify$;
