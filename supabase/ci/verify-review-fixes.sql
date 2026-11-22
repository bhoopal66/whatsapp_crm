-- Behavioural regression suite for migration 256 (review fixes for
-- 236-255):
--   1. broadcast drafts live in broadcast_drafts, owners/admins only,
--      deleted with their broadcast, in PDPL export and erase;
--   2. a note @mention never rings through a personal-number arm;
--   3. recycle_excluded_among: team leaders and up, company chats only;
--   4. the web form never renames an existing contact;
--   6. Compass assign refuses an engaged chat;
--   7. report grants end on deactivation and on leaving;
--   8. the tag report never names a number by its phone;
--   9. the escalation sweep is not starved by chats already rung;
--  10. 237's helpers are closed to PUBLIC and anon.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one. A
-- writing statement's effect is read in a later statement.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000256001';
  u_admin  UUID := '00000000-0000-4000-8000-000000256002';
  u_lead   UUID := '00000000-0000-4000-8000-000000256003';
  u_agent  UUID := '00000000-0000-4000-8000-000000256004';  -- has a personal number
  u_agent2 UUID := '00000000-0000-4000-8000-000000256005';  -- owns the company chats
  u_viewer UUID := '00000000-0000-4000-8000-000000256006';
  u_other  UUID := '00000000-0000-4000-8000-000000256007';  -- owner of another workspace
  a_acct   UUID;
  b_acct   UUID;
  b_id     UUID;
  w_pn     UUID;
  w_co     UUID;
  tag      UUID;
  ct       UUID;
  ct2      UUID;
  cv       UUID;
  cv2      UUID;
  cv_new   UUID;
  v_tok    TEXT := encode(gen_random_bytes(32), 'hex');
  v_state  JSONB := '{"v":1,"audience":{"type":"csv","csvContacts":[{"phone":"+971 50 025 6001","name":"Draft Person"},{"phone":"971500256999","name":"Someone Else"}]}}';
  all_day  JSONB := '{"mon":[["00:00","24:00"]],"tue":[["00:00","24:00"]],"wed":[["00:00","24:00"]],"thu":[["00:00","24:00"]],"fri":[["00:00","24:00"]],"sat":[["00:00","24:00"]],"sun":[["00:00","24:00"]]}';
  j        JSONB;
  r        TEXT;
  sig      TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rf_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- Run a statement as p_role signed in as p_uid: a SELECT's value,
  -- 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rf_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
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

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'rf256-owner@example.invalid'),
    (u_admin,  'rf256-admin@example.invalid'),
    (u_lead,   'rf256-lead@example.invalid'),
    (u_agent,  'rf256-agent@example.invalid'),
    (u_agent2, 'rf256-agent2@example.invalid'),
    (u_viewer, 'rf256-viewer@example.invalid'),
    (u_other,  'rf256-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2);
  UPDATE profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_agent AND account_id = a_acct;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;

  -- ======================================================================
  -- 1. Broadcast drafts
  -- ======================================================================
  n := n + 1; failed := failed || pg_temp.rf_ok(NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'broadcasts' AND column_name = 'draft_state'),
    '1: broadcasts.draft_state still exists');

  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '971500256001', 'Draft Person') RETURNING id INTO ct;
  INSERT INTO broadcasts (account_id, user_id, name, template_name, status)
    VALUES (a_acct, u_owner, 'RF draft', 'rf_tpl', 'draft') RETURNING id INTO b_id;

  r := pg_temp.rf_try('authenticated', u_admin, format(
    'INSERT INTO broadcast_drafts (broadcast_id, account_id, state) VALUES (%L, %L, %L::jsonb)',
    b_id, a_acct, v_state));
  n := n + 1; failed := failed || pg_temp.rf_ok(r = 'ok', '1: an admin could not save a draft (' || r || ')');
  r := pg_temp.rf_try('authenticated', u_admin, format(
    'UPDATE broadcast_drafts SET state = %L::jsonb WHERE broadcast_id = %L', v_state, b_id));
  n := n + 1; failed := failed || pg_temp.rf_ok(r = 'ok', '1: an admin could not update a draft (' || r || ')');
  r := pg_temp.rf_try('authenticated', u_admin, format(
    'SELECT count(*)::text FROM broadcast_drafts WHERE broadcast_id = %L', b_id));
  n := n + 1; failed := failed || pg_temp.rf_ok(r = '1', '1: an admin cannot read the draft (' || r || ')');
  r := pg_temp.rf_try('authenticated', u_owner, format(
    'SELECT (state->''audience''->''csvContacts''->0->>''name'') FROM broadcast_drafts WHERE broadcast_id = %L', b_id));
  n := n + 1; failed := failed || pg_temp.rf_ok(r = 'Draft Person', '1: the owner cannot read the draft (' || r || ')');
  FOREACH sig IN ARRAY ARRAY[u_viewer::text, u_agent::text, u_lead::text] LOOP
    r := pg_temp.rf_try('authenticated', sig::uuid, format(
      'SELECT count(*)::text FROM broadcast_drafts WHERE broadcast_id = %L', b_id));
    n := n + 1; failed := failed || pg_temp.rf_ok(r = '0', '1: a non-admin read the draft (' || sig || ': ' || r || ')');
  END LOOP;
  r := pg_temp.rf_try('authenticated', u_viewer, format(
    'INSERT INTO broadcast_drafts (broadcast_id, account_id, state) VALUES (%L, %L, ''{}''::jsonb)
       ON CONFLICT (broadcast_id) DO UPDATE SET state = excluded.state', b_id, a_acct));
  n := n + 1; failed := failed || pg_temp.rf_ok(r LIKE 'ERROR 42501%', '1: a viewer wrote a draft (' || r || ')');
  r := pg_temp.rf_try('authenticated', u_lead, format(
    'DELETE FROM broadcast_drafts WHERE broadcast_id = %L', b_id));
  n := n + 1; failed := failed || pg_temp.rf_ok(r = 'ok', '1: a team leader''s delete errored (' || r || ')');
  n := n + 1; failed := failed || pg_temp.rf_ok(
    (SELECT count(*) FROM broadcast_drafts WHERE broadcast_id = b_id) = 1,
    '1: a team leader deleted the draft');
  n := n + 1; failed := failed || pg_temp.rf_ok(
    NOT has_table_privilege('anon', 'public.broadcast_drafts', 'SELECT'),
    '1: anon may select broadcast_drafts');
  -- The state belongs to its own broadcast's account.
  r := pg_temp.rf_try('service_role', NULL, format(
    'INSERT INTO broadcast_drafts (broadcast_id, account_id, state) VALUES (%L, %L, ''{}''::jsonb)', b_id, b_acct));
  n := n + 1; failed := failed || pg_temp.rf_ok(r LIKE 'ERROR 23%', '1: a draft was filed under another account (' || r || ')');

  -- PDPL
  n := n + 1; failed := failed || pg_temp.rf_ok(EXISTS (
    SELECT 1 FROM privacy_extensions x WHERE x.name = 'broadcast_drafts'
       AND x.export_fn = 'privacy_broadcast_drafts_export' AND x.erase_fn = 'privacy_broadcast_drafts_erase'),
    '1: broadcast drafts are not registered in privacy_extensions');
  j := privacy_broadcast_drafts_export(a_acct, ct);
  n := n + 1; failed := failed || pg_temp.rf_ok(
    jsonb_array_length(j -> 'broadcast_drafts') = 1
      AND j -> 'broadcast_drafts' -> 0 -> 'csv_row' ->> 'name' = 'Draft Person',
    '1: the export lacks the draft''s CSV row (' || j::text || ')');
  j := privacy_broadcast_drafts_erase(a_acct, ct);
  n := n + 1; failed := failed || pg_temp.rf_ok((j -> 'counts' ->> 'broadcast_drafts')::int = 1,
    '1: the erase did not report one draft (' || j::text || ')');
  n := n + 1; failed := failed || pg_temp.rf_ok(
    NOT EXISTS (SELECT 1 FROM broadcast_drafts WHERE broadcast_id = b_id)
      AND EXISTS (SELECT 1 FROM broadcasts WHERE id = b_id),
    '1: the erase did not delete the draft state, or deleted the broadcast');
  r := pg_temp.rf_try('service_role', NULL, format(
    'SELECT privacy_broadcast_drafts_erase(%L, %L)::text', a_acct, ct));
  n := n + 1; failed := failed || pg_temp.rf_ok(r LIKE 'ERROR 42501%', '1: service_role called the erase hook (' || r || ')');

  -- Deleting the draft broadcast (what a send does) deletes its state.
  INSERT INTO broadcast_drafts (broadcast_id, account_id, state) VALUES (b_id, a_acct, v_state);
  DELETE FROM broadcasts WHERE id = b_id;
  n := n + 1; failed := failed || pg_temp.rf_ok(
    NOT EXISTS (SELECT 1 FROM broadcast_drafts WHERE broadcast_id = b_id),
    '1: the draft state outlived its broadcast');

  -- ======================================================================
  -- 2. Note mentions: no personal-number arm
  -- ======================================================================
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
    VALUES (u_agent, a_acct, 'openwa', 'rf256-sess-p', 't', true) RETURNING id INTO w_pn;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, waba_id)
    VALUES (u_owner, a_acct, 'openwa', 'rf256-sess-co', 't', '971500256088') RETURNING id INTO w_co;
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_agent2, '971500256002', 'Note customer') RETURNING id INTO ct2;
  -- A pre-191 company chat on a personal number (191's guard refuses
  -- new ones; it is lifted for this row only).
  ALTER TABLE public.conversations DISABLE TRIGGER conversations_personal_guard;
  INSERT INTO conversations (account_id, user_id, contact_id, channel_id)
    VALUES (a_acct, u_agent2, ct2, w_pn) RETURNING id INTO cv;
  ALTER TABLE public.conversations ENABLE TRIGGER conversations_personal_guard;

  n := n + 1; failed := failed || pg_temp.rf_ok(
    can_view_conversation_for_user(u_agent, a_acct, u_agent2, NULL, w_pn),
    '2: fixture: 190''s rule no longer shows the number''s owner the chat (test is moot)');
  n := n + 1; failed := failed || pg_temp.rf_ok(
    NOT conversation_note_user_can_see(u_agent, cv),
    '2: the personal number''s owner can see the company chat for notes');
  n := n + 1; failed := failed || pg_temp.rf_ok(
    conversation_note_user_can_see(u_agent2, cv) AND conversation_note_user_can_see(u_admin, cv),
    '2: the chat''s owner or an admin cannot see it for notes');
  r := pg_temp.rf_try('authenticated', u_agent2, format(
    'INSERT INTO conversation_notes (conversation_id, body, mention_ids) VALUES (%L, ''@them'', %L::uuid[])',
    cv, ARRAY[u_agent, u_admin]));
  n := n + 1; failed := failed || pg_temp.rf_ok(r = 'ok', '2: the chat''s owner could not add a note (' || r || ')');
  n := n + 1; failed := failed || pg_temp.rf_ok(
    (SELECT count(*) FROM notifications WHERE user_id = u_agent AND type = 'chat_note_mention' AND conversation_id = cv) = 0
      AND (SELECT count(*) FROM notifications WHERE user_id = u_admin AND type = 'chat_note_mention' AND conversation_id = cv) = 1,
    '2: the mention rang the personal number''s owner, or not the admin');

  -- ======================================================================
  -- 3. recycle_excluded_among
  -- ======================================================================
  -- ct2 wrote in a personal chat after its ending; ct (below) in a company chat.
  INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id)
    VALUES (a_acct, u_lead, ct2, u_lead) RETURNING id INTO cv2;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv2, 'customer', 'personal hello', now() - interval '1 day');
  INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES (a_acct, u_agent2, ct) RETURNING id INTO cv_new;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_new, 'customer', 'company hello', now() - interval '1 day');

  r := pg_temp.rf_try('authenticated', u_lead, format(
    'SELECT coalesce(string_agg(x::text, '',''), ''none'') FROM recycle_excluded_among(%L::uuid[], %L::timestamptz[]) x',
    ARRAY[ct, ct2], ARRAY[now() - interval '10 days', now() - interval '10 days']));
  n := n + 1; failed := failed || pg_temp.rf_ok(r = ct::text,
    '3: a team leader did not get exactly the company-chat return (' || r || ')');
  r := pg_temp.rf_try('authenticated', u_agent, format(
    'SELECT count(*)::text FROM recycle_excluded_among(%L::uuid[], %L::timestamptz[])',
    ARRAY[ct, ct2], ARRAY[now() - interval '10 days', now() - interval '10 days']));
  n := n + 1; failed := failed || pg_temp.rf_ok(r = '0', '3: an agent got an answer (' || r || ')');

  -- ======================================================================
  -- 4. web_form_submit never renames an existing contact
  -- ======================================================================
  INSERT INTO web_lead_forms (account_id, token, enabled) VALUES (a_acct, v_tok, true);
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_agent2, '971500256010', '971500256010');
  j := web_form_submit(v_tok, 'Web Rename', '971500256010', 'web@example.com', 'Hi', '{}');
  n := n + 1; failed := failed || pg_temp.rf_ok((j ->> 'contact_created') = 'false',
    '4: an existing number made a new contact (' || j::text || ')');
  n := n + 1; failed := failed || pg_temp.rf_ok(EXISTS (
    SELECT 1 FROM contacts WHERE account_id = a_acct AND phone_normalized = '971500256010'
       AND name = '971500256010' AND email IS NULL),
    '4: the form renamed an existing contact or filled its email');
  n := n + 1; failed := failed || pg_temp.rf_ok(EXISTS (
    SELECT 1 FROM tasks t JOIN contacts c ON c.id = t.contact_id
     WHERE c.account_id = a_acct AND c.phone_normalized = '971500256010'
       AND t.meta ->> 'submitted_name' = 'Web Rename'
       AND t.meta ->> 'submitted_email' = 'web@example.com'
       AND t.note LIKE 'Hi%Submitted name: Web Rename%Submitted email: web@example.com'),
    '4: the submitted name and email are not on the task');
  j := web_form_submit(v_tok, 'Web New', '971500256011', 'new@example.com', NULL, '{}');
  n := n + 1; failed := failed || pg_temp.rf_ok(EXISTS (
    SELECT 1 FROM contacts WHERE account_id = a_acct AND phone_normalized = '971500256011'
       AND name = 'Web New' AND email = 'new@example.com'),
    '4: a contact the form created lacks its name or email (' || j::text || ')');
  n := n + 1; failed := failed || pg_temp.rf_ok(NOT EXISTS (
    SELECT 1 FROM tasks t JOIN contacts c ON c.id = t.contact_id
     WHERE c.account_id = a_acct AND c.phone_normalized = '971500256011'
       AND t.meta ? 'submitted_name'),
    '4: a new contact''s task carries submitted values');

  -- ======================================================================
  -- 6. Compass assign refuses an engaged chat
  -- ======================================================================
  INSERT INTO assignment_settings (account_id, compass_assign_enabled) VALUES (a_acct, true)
    ON CONFLICT (account_id) DO UPDATE SET compass_assign_enabled = true;
  UPDATE conversations SET human_engaged_at = now(), assigned_agent_id = NULL WHERE id = cv_new;
  j := assignment_compass_assign(a_acct, cv_new, u_agent, NULL, NULL);
  n := n + 1; failed := failed || pg_temp.rf_ok(j ->> 'reason' = 'engaged' AND j -> 'assigned_to' = 'null'::jsonb,
    '6: an engaged chat was not refused as engaged (' || j::text || ')');
  n := n + 1; failed := failed || pg_temp.rf_ok(
    (SELECT assigned_agent_id IS NULL FROM conversations WHERE id = cv_new),
    '6: an engaged chat was assigned');
  -- A chat nobody is working is still assigned (human_engaged_at only
  -- moves forward, so a fresh chat).
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_agent2, '971500256020', 'Compass free') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES (a_acct, u_agent2, ct) RETURNING id INTO cv2;
  j := assignment_compass_assign(a_acct, cv2, u_agent, NULL, NULL);
  n := n + 1; failed := failed || pg_temp.rf_ok(j ->> 'reason' = 'assigned',
    '6: a free chat was not assigned (' || j::text || ')');

  -- ======================================================================
  -- 8. The tag report never names a number by its phone
  -- ======================================================================
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'RF tag') RETURNING id INTO tag;
  UPDATE conversations SET channel_id = w_co WHERE id = cv_new;
  UPDATE conversations SET chat_tag_id = tag WHERE id = cv_new;
  r := pg_temp.rf_try('authenticated', u_owner,
    'SELECT chat_tag_report(now() - interval ''1 day'', now() + interval ''1 day'', ''UTC'')::text');
  n := n + 1; failed := failed || pg_temp.rf_ok(r NOT LIKE 'ERROR%', '8: the owner could not run the report (' || r || ')');
  IF r NOT LIKE 'ERROR%' THEN
    j := r::jsonb;
    n := n + 1; failed := failed || pg_temp.rf_ok(EXISTS (
      SELECT 1 FROM jsonb_array_elements(j -> 'by_number') e
       WHERE e ->> 'key' = w_co::text AND e ->> 'name' = 'Unnamed number ending 88'),
      '8: an unlabelled number is not "Unnamed number ending 88" (' || (j -> 'by_number')::text || ')');
    n := n + 1; failed := failed || pg_temp.rf_ok(position('0256088' IN r) = 0,
      '8: the report carries the phone number');
  END IF;

  -- ======================================================================
  -- 9. The escalation sweep: chats already rung do not starve newer ones
  -- ======================================================================
  -- Target 24 h, open all day: 500 chats waiting 30 h, each already rung
  -- at 'target' (they reach 'escalated' at 48 h), then one waiting 25 h.
  INSERT INTO response_settings (account_id, enabled, timezone, hours, target_minutes)
    VALUES (a_acct, true, 'UTC', all_day, 1440)
    ON CONFLICT (account_id) DO UPDATE SET enabled = true, timezone = 'UTC', hours = all_day, target_minutes = 1440;
  INSERT INTO contacts (account_id, user_id, phone, name)
    SELECT a_acct, u_agent2, '97150257' || lpad(g::text, 4, '0'), 'RF wait ' || g
      FROM generate_series(1, 501) g;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    SELECT a_acct, u_agent2, c.id, u_agent2
      FROM contacts c WHERE c.account_id = a_acct AND c.name LIKE 'RF wait %';
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    SELECT cv.id, 'customer', 'waiting',
           CASE WHEN c.name = 'RF wait 501' THEN now() - interval '25 hours'
                ELSE now() - interval '30 hours' END
      FROM conversations cv JOIN contacts c ON c.id = cv.contact_id
     WHERE cv.account_id = a_acct AND c.name LIKE 'RF wait %';
  INSERT INTO response_escalations (account_id, conversation_id, waiting_since, level, recipient, business_minutes)
    SELECT a_acct, cv.id, cv.customer_waiting_since, 'target', u_agent2, 1800
      FROM conversations cv JOIN contacts c ON c.id = cv.contact_id
     WHERE cv.account_id = a_acct AND c.name LIKE 'RF wait %' AND c.name <> 'RF wait 501';
  n := n + 1; failed := failed || pg_temp.rf_ok(
    (SELECT count(*) FROM conversations cv JOIN contacts c ON c.id = cv.contact_id
      WHERE cv.account_id = a_acct AND c.name LIKE 'RF wait %' AND cv.customer_waiting_since IS NOT NULL) = 501,
    '9: fixture: the 501 chats are not waiting');
  PERFORM public.response_escalation_sweep();
  n := n + 1; failed := failed || pg_temp.rf_ok(EXISTS (
    SELECT 1 FROM notifications x JOIN conversations cv ON cv.id = x.conversation_id
      JOIN contacts c ON c.id = cv.contact_id
     WHERE c.account_id = a_acct AND c.name = 'RF wait 501'
       AND x.type = 'response_target_missed' AND x.user_id = u_agent2),
    '9: the newer wait was starved by 500 chats already rung');
  n := n + 1; failed := failed || pg_temp.rf_ok(NOT EXISTS (
    SELECT 1 FROM notifications x JOIN conversations cv ON cv.id = x.conversation_id
      JOIN contacts c ON c.id = cv.contact_id
     WHERE c.account_id = a_acct AND c.name LIKE 'RF wait %' AND c.name <> 'RF wait 501'
       AND x.type LIKE 'response_%'),
    '9: a chat already rung at its level rang again');

  -- ======================================================================
  -- 10. 237's helpers: no PUBLIC, no anon
  -- ======================================================================
  FOREACH sig IN ARRAY ARRAY[
    'public.response_default_hours()',
    'public.response_hours_valid(jsonb)',
    'public.conversation_waiting_since(public.conversations)',
    'public.response_business_minutes(jsonb, text, timestamptz, timestamptz)',
    'public.business_minutes_between(uuid, timestamptz, timestamptz)',
    'public.response_minutes_label(integer)'] LOOP
    n := n + 1; failed := failed || pg_temp.rf_ok(
      NOT has_function_privilege('anon', sig, 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                         WHERE p.oid = sig::regprocedure AND a.grantee = 0),
      '10: PUBLIC or anon may execute ' || sig);
    IF sig <> 'public.response_minutes_label(integer)' THEN
      n := n + 1; failed := failed || pg_temp.rf_ok(has_function_privilege('authenticated', sig, 'EXECUTE'),
        '10: authenticated lost ' || sig);
    END IF;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.rf_ok(
    NOT has_function_privilege('authenticated', 'public.response_minutes_label(integer)', 'EXECUTE'),
    '10: authenticated may execute response_minutes_label');

  -- ======================================================================
  -- 7. Report grants end with the membership (last: it moves people)
  -- ======================================================================
  INSERT INTO report_access (account_id, user_id, report_key) VALUES
    (a_acct, u_agent, 'chat_tags'), (a_acct, u_lead, 'chat_tags'), (a_acct, u_viewer, 'chat_tags');
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_agent AND account_id = a_acct;
  UPDATE profiles SET account_id = b_acct WHERE user_id = u_lead;
  DELETE FROM profiles WHERE user_id = u_viewer AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.rf_ok(NOT EXISTS (
    SELECT 1 FROM report_access WHERE account_id = a_acct AND user_id = u_agent),
    '7: a deactivated person kept a report grant');
  n := n + 1; failed := failed || pg_temp.rf_ok(NOT EXISTS (
    SELECT 1 FROM report_access WHERE account_id = a_acct AND user_id = u_lead),
    '7: a person who left kept a report grant');
  n := n + 1; failed := failed || pg_temp.rf_ok(NOT EXISTS (
    SELECT 1 FROM report_access WHERE account_id = a_acct AND user_id = u_viewer),
    '7: a deleted profile kept a report grant');
  -- Re-added: no grant comes back.
  UPDATE profiles SET account_id = a_acct WHERE user_id = u_lead;
  r := pg_temp.rf_try('authenticated', u_lead, 'SELECT report_can_open(''chat_tags'')::text');
  n := n + 1; failed := failed || pg_temp.rf_ok(r = 'false', '7: a re-added person''s grant came back (' || r || ')');

  RAISE EXCEPTION USING ERRCODE = 'ZT256', MESSAGE = 'verify-review-fixes rollback';
  EXCEPTION WHEN SQLSTATE 'ZT256' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'review fixes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'review fixes verification passed (% checks)', n;
END
$verify$;
