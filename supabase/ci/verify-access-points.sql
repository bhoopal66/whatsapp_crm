-- Migration 289: each access point, the refusal and the legitimate path,
-- by role. Fixtures (prefix ap289) are rolled back by a sentinel.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000289001';
  u_admin UUID := '00000000-0000-4000-8000-000000289002';
  u_lead  UUID := '00000000-0000-4000-8000-000000289003';
  u_a     UUID := '00000000-0000-4000-8000-000000289004';
  u_b     UUID := '00000000-0000-4000-8000-000000289005';
  u_guest UUID := '00000000-0000-4000-8000-000000289006';
  u_none  UUID := '00000000-0000-4000-8000-000000289007';  -- a login with no live membership
  acct UUID;
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; c5 UUID;
  cu UUID; k1 UUID; k2 UUID;
  cv UUID; cp UUID;
  ch UUID;
  p_own TEXT; p_other TEXT; p_srv TEXT;
  q TEXT; v TEXT; j JSONB;
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- A statement as a person (NULL: the current user): a SELECT's value,
  -- 'ok', or 'ERROR <sqlstate> <hint>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ap_try(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_uid IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
          PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
          SET LOCAL ROLE authenticated;
        END IF;
        IF p_sql ILIKE 'select%' THEN EXECUTE p_sql INTO v; ELSE EXECUTE p_sql; END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$ $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ap_is(p_name text, p_uid uuid, p_sql text, p_like text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.ap_try(p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$ $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ap289-owner@example.invalid'), (u_admin, 'ap289-admin@example.invalid'),
    (u_lead, 'ap289-lead@example.invalid'), (u_a, 'ap289-a@example.invalid'),
    (u_b, 'ap289-b@example.invalid'), (u_guest, 'ap289-guest@example.invalid'),
    (u_none, 'ap289-none@example.invalid');
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id IN (u_a, u_b);
  UPDATE profiles SET account_id = acct, account_role = 'bank_guest', bank_code = 'ENBD' WHERE user_id = u_guest;
  DELETE FROM profiles WHERE user_id = u_none;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_a, '971500289001', 'Amina Khan') RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_b, '971500289002', 'Bilal Two') RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_b, '971500289003', 'Bilal Three') RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_lead, '971500289004', 'Lead Four') RETURNING id INTO c4;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (acct, u_a, '971500289005', '+971500289005') RETURNING id INTO c5;
  INSERT INTO case_banks (account_id, code, name) VALUES (acct, 'ENBD', 'Emirates NBD') ON CONFLICT DO NOTHING;
  PERFORM desk_bank_code_set(u_owner, acct, 'ENBD', 'ENB');

  -- ---------- 1. case desk ----------
  SELECT x.case_id, x.customer_id INTO k1, cu
    FROM desk_case_open(acct, 'AP-1', 'Kite General Trading', 'ENBD', 'Account', c1, u_a, NULL, now()) x;
  q := 'SELECT x.state || ''|'' || coalesce(x.queue_reason, ''-'') || ''|'' || (x.case_id IS NOT NULL)::text
          FROM intake_submit(%L, %L, gen_random_uuid(), %L, ''new_case'', ''ENBD'', NULL, %L, %L, ''Account'', %L,
                             NULL, NULL, NULL, NULL, NULL, NULL, NULL) x';
  n := n + 1; failed := failed || pg_temp.ap_is('desk: a stranger attached to a company by its licence typed loosely', NULL,
    format(q, u_b, acct, 'ap289-0001', 'Kite General Trading', 'ap 1', c2), 'untagged|COMPANY_RESTRICTED|false');
  n := n + 1; failed := failed || pg_temp.ap_is('desk: a stranger attached to a company by its exact licence', NULL,
    format(q, u_b, acct, 'ap289-0002', 'Kite General Trading', 'AP-1', c2), 'untagged|COMPANY_RESTRICTED|false');
  n := n + 1; failed := failed || pg_temp.ap_is('desk: the refused upload left a case or a link', NULL,
    format('SELECT count(*)::text FROM cases WHERE contact_id = %L', c2), '0');
  n := n + 1; failed := failed || pg_temp.ap_is('desk: an uploader could not open a new company', NULL,
    format(q, u_b, acct, 'ap289-0003', 'Maro Trading', 'AP-2', c3), 'filed|-|true');
  n := n + 1; failed := failed || pg_temp.ap_is('desk: the case''s own agent could not upload again', NULL,
    format(q, u_a, acct, 'ap289-0004', 'Kite General Trading', 'AP-1', c1), 'filed|-|true');
  n := n + 1; failed := failed || pg_temp.ap_is('desk: a team leader was held back from a company', NULL,
    format(q, u_lead, acct, 'ap289-0005', 'Kite General Trading', 'AP-1', c4), 'filed|-|true');
  -- A sorter files the waiting upload as before.
  n := n + 1; failed := failed || pg_temp.ap_is('desk: a sorter could not file the waiting upload', NULL,
    format('SELECT x.state FROM intake_items i, intake_file_new_case(%L, %L, i.id, ''AP-1'', ''Kite General Trading'',
              ''ENBD'', ''Account'', %L) x WHERE i.idem_key = ''ap289-0002''', u_lead, acct, c2), 'filed');
  SELECT id INTO k2 FROM cases WHERE contact_id = c2;
  n := n + 1; failed := failed || pg_temp.ap_is('desk: an uploader joined the open case of a contact they cannot see', NULL,
    format(q, u_b, acct, 'ap289-0006', 'Kite General Trading', 'AP-1', c1), 'untagged|COMPANY_RESTRICTED|false');
  PERFORM desk_customer_contact_set(u_owner, acct, cu, c5, 'pro', false);
  n := n + 1; failed := failed || pg_temp.ap_is('desk: a contact the reader may not see kept its name or phone', NULL,
    format('SELECT string_agg(coalesce(name, ''-'') || '':'' || coalesce(phone, ''-''), '','' ORDER BY phone NULLS FIRST, name NULLS FIRST)
              FROM desk_customer_contacts_list(%L, %L, %L) WHERE contact_id <> %L', u_b, acct, cu, c4),
    '%-:-,Amina:-,Bilal Two:971500289002');
  n := n + 1; failed := failed || pg_temp.ap_is('desk: an owner lost a contact''s phone', NULL,
    format('SELECT name || phone FROM desk_customer_contacts_list(%L, %L, %L) WHERE contact_id = %L', u_owner, acct, cu, c1),
    'Amina Khan971500289001');
  n := n + 1; failed := failed || pg_temp.ap_is('desk: an agent''s overview named another''s case', NULL,
    format('SELECT jsonb_path_query_array(desk_company_overview(%L, %L, %L), ''$.cases[*].case_id'')::text', u_b, acct, cu),
    format('["%s"]', k2));
  n := n + 1; failed := failed || pg_temp.ap_is('desk: a team leader lost cases from the overview', NULL,
    format('SELECT jsonb_array_length(desk_company_overview(%L, %L, %L) -> ''cases'')::text', u_lead, acct, cu), '3');

  -- ---------- 2. team chat ----------
  UPDATE accounts SET internal_chat_enabled = true WHERE id = acct;
  v := pg_temp.ap_try(u_owner, format('SELECT chat_create_channel(%L, ''private'', ''ap289'', NULL, ARRAY[%L]::uuid[])', acct, u_admin));
  ch := v::uuid;
  q := format('SELECT chat_add_members(%L, ARRAY[%L]::uuid[])', ch, u_guest);
  n := n + 1; failed := failed || pg_temp.ap_is('chat: an admin who is no channel admin added a guest', u_admin, q, 'ERROR 42501%channel admins%');
  n := n + 1; failed := failed || pg_temp.ap_is('chat: an outsider added a guest', u_b, q, 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.ap_is('chat: the channel admin could not add a guest', u_owner, q, '1');

  -- ---------- 9. attachments ----------
  p_own := format('account-%s/channel-%s/%s-a.pdf', acct, ch, gen_random_uuid());
  p_other := format('account-%s/channel-%s/%s-b.pdf', acct, ch, gen_random_uuid());
  p_srv := format('account-%s/channel-%s/%s-c.pdf', acct, ch, gen_random_uuid());
  INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
    ('chat-files', p_own, NULL, u_admin::text), ('chat-files', p_other, u_owner, NULL), ('chat-files', p_srv, NULL, NULL);
  q := 'SELECT (chat_post_message(%L, ''x'', NULL, NULL, jsonb_build_array(jsonb_build_object(''storage_path'', %L::text, ''name'', ''f.pdf'', ''mime'', ''application/pdf'', ''bytes'', 5))) IS NOT NULL)::text';
  n := n + 1; failed := failed || pg_temp.ap_is('chat: a post carried another person''s upload', u_admin, format(q, ch, p_other), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.ap_is('chat: one''s own upload was refused', u_admin, format(q, ch, p_own), 'true');
  n := n + 1; failed := failed || pg_temp.ap_is('chat: the uploader (owner column) was refused', u_owner, format(q, ch, p_other), 'true');
  n := n + 1; failed := failed || pg_temp.ap_is('chat: a server copy was refused', u_admin, format(q, ch, p_srv), 'true');

  -- ---------- 3. webhooks ----------
  q := 'INSERT INTO webhook_endpoints (account_id, created_by, url, secret) VALUES (%L, %L, ''https://example.invalid/ap289'', ''s'')';
  n := n + 1; failed := failed || pg_temp.ap_is('webhook: made in another''s name', u_admin, format(q, acct, u_owner), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.ap_is('webhook: one''s own was refused', u_admin, format(q, acct, u_admin), 'ok');
  n := n + 1; failed := failed || pg_temp.ap_is('webhook: an agent made one', u_a, format(q, acct, u_a), 'ERROR 42501%');
  FOREACH v IN ARRAY ARRAY['created_by = created_by', 'account_id = account_id', 'secret = ''t'''] LOOP
    n := n + 1; failed := failed || pg_temp.ap_is('webhook: a session set ' || v, u_admin, 'UPDATE webhook_endpoints SET ' || v, 'ERROR 42501%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.ap_is('webhook: switching off was refused', u_admin, 'UPDATE webhook_endpoints SET is_active = false', 'ok');

  -- ---------- 4. quick replies ----------
  q := 'INSERT INTO quick_replies (account_id, user_id, title, kind, content_text) VALUES (%L, %L, ''ap289'', ''text'', ''x'')';
  n := n + 1; failed := failed || pg_temp.ap_is('quick reply: written in another''s name', u_a, format(q, acct, u_b), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.ap_is('quick reply: one''s own was refused', u_a, format(q, acct, u_a), 'ok');
  n := n + 1; failed := failed || pg_temp.ap_is('quick reply: its author was changed', u_b, 'UPDATE quick_replies SET user_id = user_id', 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.ap_is('quick reply: a colleague could not edit it', u_b, 'UPDATE quick_replies SET title = ''ap289b'' WHERE title = ''ap289''', 'ok');
  n := n + 1; failed := failed || pg_temp.ap_is('quick reply: a colleague''s edit was lost', u_b, 'SELECT count(*)::text FROM quick_replies WHERE title = ''ap289b''', '1');

  -- ---------- 5. recycle: c1 and c4 have an open case ----------
  q := format('SELECT coalesce(string_agg(x::text, '',''), ''none'') FROM recycle_excluded_among(%L::uuid[], %L::timestamptz[]) x',
              ARRAY[c1], ARRAY[now()]);
  n := n + 1; failed := failed || pg_temp.ap_is('recycle: a leader learned of a contact they cannot see', u_lead, q, 'none');
  n := n + 1; failed := failed || pg_temp.ap_is('recycle: an owner lost a contact', u_owner, q, c1::text);
  n := n + 1; failed := failed || pg_temp.ap_is('recycle: a leader lost their own contact', u_lead,
    format('SELECT x::text FROM recycle_excluded_among(%L::uuid[], %L::timestamptz[]) x', ARRAY[c4], ARRAY[now()]), c4::text);

  -- ---------- 6. start check, 7. insight actions ----------
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id) VALUES (acct, u_a, c1, u_a) RETURNING id INTO cv;
  q := format('SELECT team_activity_start_check(%L, NULL, NULL)::text', cv);
  n := n + 1; failed := failed || pg_temp.ap_is('start check: answered for a chat the caller cannot see', u_b, q, '{"blocked": false}');
  n := n + 1; failed := failed || pg_temp.ap_is('start check: did not answer the chat''s agent', u_a, q, '%"is_start"%');
  n := n + 1; failed := failed || pg_temp.ap_is('start check/2: answered for a chat the caller cannot see', u_b,
    format('SELECT team_activity_start_check(%L, NULL)::text', cv), '{"blocked": false}');
  n := n + 1; failed := failed || pg_temp.ap_is('start check: did not answer an admin', u_admin, q, '%"is_start"%');
  -- A's own personal chat, on a number B holds today.
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id) VALUES (acct, u_b, c2, u_b) RETURNING id INTO cp;
  q := 'SELECT %s(%L)::text';
  FOREACH v IN ARRAY ARRAY['acknowledge_insight_attention', 'dismiss_tag_suggestion'] LOOP
    n := n + 1; failed := failed || pg_temp.ap_is(v || ': refused a company chat''s agent', u_b, format(q, v, cp), '');
    n := n + 1; failed := failed || pg_temp.ap_is(v || ': a stranger passed', u_a, format(q, v, cp), 'ERROR 42501%');
  END LOOP;
  ALTER TABLE conversations DISABLE TRIGGER USER;
  ALTER TABLE whatsapp_config DISABLE TRIGGER USER;
  INSERT INTO whatsapp_config (account_id, user_id, is_personal, is_primary, provider, phone_number_id, access_token) VALUES (acct, u_b, true, false, 'openwa', 'ap289', 'x') RETURNING id INTO c5;
  UPDATE conversations SET personal_owner_id = u_a, user_id = u_a, assigned_agent_id = u_a, channel_id = c5 WHERE id = cp;
  ALTER TABLE conversations ENABLE TRIGGER USER;
  ALTER TABLE whatsapp_config ENABLE TRIGGER USER;
  FOREACH v IN ARRAY ARRAY['acknowledge_insight_attention', 'dismiss_tag_suggestion'] LOOP
    n := n + 1; failed := failed || pg_temp.ap_is(v || ': wrote another''s personal chat', u_b, format(q, v, cp), 'ERROR 42501%');
    n := n + 1; failed := failed || pg_temp.ap_is(v || ': refused the personal number''s owner', u_a, format(q, v, cp), '');
    n := n + 1; failed := failed || pg_temp.ap_is(v || ': refused an admin', u_admin, format(q, v, cp), '');
  END LOOP;

  -- ---------- 8. deal room roster ----------
  IF pg_get_viewdef('public.deal_room_roster'::regclass) !~ 'strpos\(regexp_replace\(p\.display_name.*"right"\(p\.phone, 7\)'
     OR NOT coalesce((SELECT 'security_barrier=true' = ANY (reloptions) FROM pg_class WHERE oid = 'public.deal_room_roster'::regclass), false) THEN
    failed := failed || 'roster: a name with the number in local form is not masked'::text;
  END IF;
  n := n + 1;

  -- ---------- 10. the rate card and the tag filter ----------
  INSERT INTO whatsapp_rate_card (market, category, rate_usd, effective_from)
  SELECT market, category, 1, DATE '2031-01-01' FROM whatsapp_rate_card LIMIT 1;
  FOREACH v IN ARRAY ARRAY['whatsapp_market_prefix', 'whatsapp_rate_card'] LOOP
    q := format('SELECT (count(*) > 0)::text FROM %I', v);
    n := n + 1; failed := failed || pg_temp.ap_is(v || ': a bank guest read it', u_guest, q, 'false');
    n := n + 1; failed := failed || pg_temp.ap_is(v || ': a login without a membership read it', u_none, q, 'false');
    EXECUTE q INTO p_srv;
    n := n + 1; failed := failed || pg_temp.ap_is(v || ': an agent lost it', u_a, q, p_srv);
  END LOOP;
  IF has_function_privilege('anon', 'public.filter_contacts_by_tags(uuid[], text, integer, integer, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.filter_contacts_by_tags(uuid[], text, integer, integer, uuid)', 'EXECUTE') THEN
    failed := failed || 'filter_contacts_by_tags: grants'::text;
  END IF;
  n := n + 1;

  failed := array_remove(failed, NULL);
  RAISE EXCEPTION 'ap289 rollback' USING ERRCODE = 'P0289';
  EXCEPTION WHEN SQLSTATE 'P0289' THEN NULL;
  END;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION '289: % of % checks failed: %', cardinality(failed), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE '289: % checks passed', n;
END
$verify$;
