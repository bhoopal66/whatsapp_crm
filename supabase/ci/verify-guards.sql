-- Behavioural regression suite for migration 265 (five guards).
-- ONE statement on purpose (the pinned CLI rejects several); fixtures are
-- rolled back through a sentinel.

DO $verify$
DECLARE
  u_own  UUID := '00000000-0000-4000-8000-000000265001';  -- owner of A
  u_adm  UUID := '00000000-0000-4000-8000-000000265002';  -- admin of A: the caller
  u_adm2 UUID := '00000000-0000-4000-8000-000000265003';  -- another admin of A
  u_agt  UUID := '00000000-0000-4000-8000-000000265004';  -- agent of A
  a_acct UUID;
  p_acct UUID;
  v_contact UUID;
  v_other   UUID;
  v_conv UUID;
  v_cfg  UUID;
  v_grp  UUID;
  j      JSONB;
  r      RECORD;
  t      TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- 322 revokes the hash-taking invitation calls from every session; their
  -- bodies are what peek_invitation_token / redeem_invitation_token run,
  -- so they are exercised directly under a grant the rollback below undoes.
  GRANT EXECUTE ON FUNCTION public.peek_invitation(text) TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.redeem_invitation(text) TO authenticated;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.gd_ok(p_ok boolean, p_what text) RETURNS text
    LANGUAGE sql AS $b$ SELECT CASE WHEN p_ok IS TRUE THEN NULL ELSE p_what END $b$
  $fn$;
  -- A statement as a signed-in user; 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.gd_try(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
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

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'gd-owner@example.test'), (u_adm, 'gd-admin@example.test'),
    (u_adm2, 'gd-admin2@example.test'), (u_agt, 'gd-agent@example.test');
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('gd-acct', u_own) RETURNING id INTO a_acct;
  UPDATE public.profiles SET account_id = a_acct, account_role = 'owner' WHERE user_id = u_own;
  UPDATE public.profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id IN (u_adm, u_adm2);
  UPDATE public.profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agt;

  -- 1. Grants do not travel with a moved row.
  UPDATE public.profiles SET may_review_all_calls = true, may_connect_personal_whatsapp = true, department = 'hr'
   WHERE user_id = u_agt;
  t := pg_temp.gd_try(u_adm, format('SELECT public.remove_account_member(%L)', u_agt));
  SELECT * INTO r FROM public.profiles WHERE user_id = u_agt;
  failed := array_append(failed, pg_temp.gd_ok(t = 'ok' AND r.account_id <> a_acct, 'removed: ' || t)); n := n + 1;
  failed := array_append(failed, pg_temp.gd_ok(
    NOT r.may_review_all_calls AND NOT r.may_connect_personal_whatsapp AND r.department = 'sales',
    'grants left on the row after removal')); n := n + 1;
  p_acct := r.account_id;
  INSERT INTO public.account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
  VALUES (a_acct, 'gd-token', 'agent', u_adm, now() + interval '1 day');
  t := pg_temp.gd_try(u_agt, 'SELECT public.redeem_invitation(''gd-token'')');
  SELECT * INTO r FROM public.profiles WHERE user_id = u_agt AND account_id = a_acct;
  failed := array_append(failed, pg_temp.gd_ok(t = 'ok' AND r.user_id IS NOT NULL
    AND NOT r.may_review_all_calls AND NOT r.may_connect_personal_whatsapp AND r.department = 'sales',
    'grants after being invited back: ' || t)); n := n + 1;
  -- A change that keeps the workspace keeps the grants.
  UPDATE public.profiles SET may_review_all_calls = true, department = 'hr' WHERE user_id = u_agt;
  UPDATE public.profiles SET account_role = 'viewer' WHERE user_id = u_agt;
  UPDATE public.profiles SET account_id = a_acct WHERE user_id = u_agt;
  SELECT * INTO r FROM public.profiles WHERE user_id = u_agt;
  failed := array_append(failed, pg_temp.gd_ok(r.may_review_all_calls AND r.department = 'hr',
    'grants lost without a move')); n := n + 1;
  UPDATE public.profiles SET account_role = 'agent' WHERE user_id = u_agt;

  -- 2. The locks: each setter reads the target FOR UPDATE.
  FOR t IN SELECT unnest(ARRAY['set_member_role', 'set_member_active', 'transfer_account_ownership']) LOOP
    failed := array_append(failed, pg_temp.gd_ok(
      (SELECT p.prosrc ~ 'INTO v_target_role[^;]*FOR UPDATE' FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = t), t || ': target not locked')); n := n + 1;
  END LOOP;
  t := pg_temp.gd_try(u_adm, format('SELECT public.set_member_role(%L, ''agent'')', u_own));
  failed := array_append(failed, pg_temp.gd_ok(t LIKE 'ERROR 22023:%', 'an owner demoted: ' || t)); n := n + 1;

  -- 3. An admin just lowered keeps their login for a week.
  t := pg_temp.gd_try(u_adm, format('SELECT public.authorize_member_password_change(%L)', u_adm2));
  failed := array_append(failed, pg_temp.gd_ok(t LIKE 'ERROR 42501: You can change the password only%', 'a peer admin: ' || t)); n := n + 1;
  t := pg_temp.gd_try(u_adm, format('SELECT public.set_member_role(%L, ''team_leader'')', u_adm2));
  t := t || pg_temp.gd_try(u_adm, format('SELECT public.set_member_role(%L, ''agent'')', u_adm2));
  failed := array_append(failed, pg_temp.gd_ok(t = 'okok', 'lowering a peer admin is still allowed: ' || t)); n := n + 1;
  t := pg_temp.gd_try(u_adm, format('SELECT public.authorize_member_password_change(%L)', u_adm2));
  failed := array_append(failed, pg_temp.gd_ok(t LIKE 'ERROR 42501: This person was an admin%', 'password of a lowered admin: ' || t)); n := n + 1;
  t := pg_temp.gd_try(u_adm, format('SELECT public.authorize_member_details_change(%L)', u_adm2));
  failed := array_append(failed, pg_temp.gd_ok(t LIKE 'ERROR 42501: This person was an admin%', 'details of a lowered admin: ' || t)); n := n + 1;
  t := pg_temp.gd_try(u_own, format('SELECT public.authorize_member_password_change(%L)', u_adm2))
    || pg_temp.gd_try(u_own, format('SELECT public.authorize_member_details_change(%L)', u_adm2));
  failed := array_append(failed, pg_temp.gd_ok(t = 'okok', 'the owner may: ' || t)); n := n + 1;
  t := pg_temp.gd_try(u_adm, format('SELECT public.authorize_member_password_change(%L)', u_agt))
    || pg_temp.gd_try(u_adm, format('SELECT public.authorize_member_details_change(%L)', u_agt));
  failed := array_append(failed, pg_temp.gd_ok(t = 'okok', 'an ordinary agent: ' || t)); n := n + 1;
  -- A week later, or after stepping down oneself, it is an ordinary member.
  -- (The audit is append-only, so a fresh person with an old row stands in.)
  INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail, at)
  VALUES (a_acct, u_own, 'role_changed', u_agt, '{"from": "admin", "to": "agent"}', now() - interval '8 days'),
         (a_acct, u_agt, 'role_changed', u_agt, '{"from": "owner", "to": "agent"}', now());
  t := pg_temp.gd_try(u_adm, format('SELECT public.authorize_member_password_change(%L)', u_agt));
  failed := array_append(failed, pg_temp.gd_ok(t = 'ok', 'lowered 8 days ago: ' || t)); n := n + 1;
  failed := array_append(failed, pg_temp.gd_ok(
    NOT has_function_privilege('authenticated', 'public.member_lately_admin(uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.member_lately_admin(uuid,uuid)', 'EXECUTE'),
    'member_lately_admin is callable')); n := n + 1;

  -- 4. The files an erased customer sent in groups are collected.
  INSERT INTO public.contacts (user_id, account_id, phone, name) VALUES (u_own, a_acct, '+971 50 265 0001', 'gd one') RETURNING id INTO v_contact;
  INSERT INTO public.contacts (user_id, account_id, phone, name) VALUES (u_own, a_acct, '+971 50 265 0002', 'gd two') RETURNING id INTO v_other;
  INSERT INTO public.whatsapp_config (user_id, account_id, phone_number_id, access_token, provider, status)
  VALUES (u_own, a_acct, 'gd-session', 'x', 'openwa', 'connected') RETURNING id INTO v_cfg;
  INSERT INTO public.whatsapp_groups (account_id, channel_id, wa_group_id, name)
  VALUES (a_acct, v_cfg, '120363000000265001@g.us', 'gd') RETURNING id INTO v_grp;
  INSERT INTO public.whatsapp_group_messages (account_id, group_id, wa_message_id, direction, sender_wa_id, type, media, status, created_at)
  VALUES
    (a_acct, v_grp, 'gd-1', 'in', '971502650001', 'image', jsonb_build_object('link', 'https://x.test/storage/v1/object/public/chat-media/account-' || a_acct || '/inbound/one.jpg'), NULL, now()),
    (a_acct, v_grp, 'gd-2', 'in', '971502650001', 'document', jsonb_build_object('link', 'https://gateway.test/files/two.pdf'), NULL, now()),
    (a_acct, v_grp, 'gd-3', 'in', '971502650002', 'image', jsonb_build_object('link', 'https://x.test/storage/v1/object/public/chat-media/account-' || a_acct || '/inbound/three.jpg'), NULL, now());
  j := public.privacy_whatsapp_group_files_erase(a_acct, v_contact);
  failed := array_append(failed, pg_temp.gd_ok(
    jsonb_array_length(j->'objects') = 1 AND j->'objects'->0->>'bucket' = 'chat-media'
    AND j->'objects'->0->>'url' LIKE '%/inbound/one.jpg', 'group files of one customer: ' || j::text)); n := n + 1;
  failed := array_append(failed, pg_temp.gd_ok(
    public.privacy_whatsapp_group_files_erase(gen_random_uuid(), v_contact)->'objects' = '[]'::jsonb
    AND public.privacy_whatsapp_group_files_erase(a_acct, gen_random_uuid())->'objects' = '[]'::jsonb,
    'another workspace or person')); n := n + 1;
  failed := array_append(failed, pg_temp.gd_ok(
    (SELECT e.erase_fn = 'privacy_whatsapp_group_files_erase' FROM public.privacy_extensions e WHERE e.name = 'whatsapp_group_files'),
    'not registered')); n := n + 1;
  failed := array_append(failed, pg_temp.gd_ok(
    NOT has_function_privilege('authenticated', 'public.privacy_whatsapp_group_files_erase(uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.privacy_whatsapp_group_files_erase(uuid,uuid)', 'EXECUTE'),
    'the erase is callable')); n := n + 1;

  -- 5. A late message counts as unread but is not the newest.
  INSERT INTO public.conversations (user_id, account_id, contact_id, last_message_text, last_message_at, unread_count)
  VALUES (u_own, a_acct, v_contact, 'start', now() - interval '1 day', 0) RETURNING id INTO v_conv;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at)
  VALUES (v_conv, 'customer', 'text', 'late', 'gd-m1', 'delivered', now() - interval '10 minutes');
  PERFORM public.bump_conversation_on_inbound(v_conv, 'late', now() - interval '10 minutes');
  SELECT * INTO r FROM public.conversations WHERE id = v_conv;
  failed := array_append(failed, pg_temp.gd_ok(r.unread_count = 1 AND r.last_message_text = 'late'
    AND r.last_message_at > now() - interval '1 minute', 'alone, an old message is the newest')); n := n + 1;
  INSERT INTO public.messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at)
  VALUES (v_conv, 'agent', 'text', 'answer', 'gd-m2', 'sent', now() - interval '1 minute');
  UPDATE public.conversations SET last_message_text = 'answer', last_message_at = now() - interval '1 minute' WHERE id = v_conv;
  PERFORM public.bump_conversation_on_inbound(v_conv, 'later still', now() - interval '5 minutes');
  SELECT * INTO r FROM public.conversations WHERE id = v_conv;
  failed := array_append(failed, pg_temp.gd_ok(r.unread_count = 2 AND r.last_message_text = 'answer'
    AND r.last_message_at < now() - interval '30 seconds', 'a late message took the preview: ' || r.last_message_text)); n := n + 1;
  -- The previous build's two-argument call still works, by name too.
  PERFORM public.bump_conversation_on_inbound(p_conversation_id := v_conv, p_last_message_text := 'old call');
  SELECT * INTO r FROM public.conversations WHERE id = v_conv;
  failed := array_append(failed, pg_temp.gd_ok(r.unread_count = 3 AND r.last_message_text = 'old call', 'two-argument call')); n := n + 1;
  failed := array_append(failed, pg_temp.gd_ok(
    (SELECT count(*) = 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'bump_conversation_on_inbound')
    AND has_function_privilege('service_role', 'public.bump_conversation_on_inbound(uuid,text,timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.bump_conversation_on_inbound(uuid,text,timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.bump_conversation_on_inbound(uuid,text,timestamptz)', 'EXECUTE'),
    'bump: one overload, service role only')); n := n + 1;

  RAISE EXCEPTION 'GD_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'GD_ROLLBACK' THEN RAISE; END IF;
  END;

  failed := array_remove(failed, NULL);
  IF n < 24 THEN RAISE EXCEPTION 'verify-guards: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-guards: % of % failed: %', cardinality(failed), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-guards: % checks passed', n;
END $verify$;
