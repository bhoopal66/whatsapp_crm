-- Behavioural regression suite for migration 165 (security lows).
--
-- 1. chat_forward_message accepts a copy only when its storage object
--    has the source file's size and the source object's stored mimetype;
--    an object with other metadata, or none, is refused (22023) even for
--    someone allowed send_voice but denied upload_files.
-- 2. ai_insight_settings_guard refuses another workspace's tag as the
--    interested-reply tag (23514, before 147's FK), still refuses a
--    sub-tag, and stamps updated_by with a signed-in writer while a
--    write with no auth.uid() keeps what it set.
-- 3. chat_set_member_role: a channel admin's role is changed only by a
--    workspace owner / admin or by that person (42501 for an agent
--    channel admin of a team channel), a non-admin member may still be
--    promoted by a channel admin, and a bank guest is never promoted to
--    channel admin (22023).
-- 4. chat_remove_member: another channel admin is removed only by a
--    workspace owner / admin (42501 for an agent channel admin); a plain
--    member is still removed by a channel admin, and removing yourself
--    is still refused (22023, use chat_leave_channel).
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Fixtures are
-- rolled back by a sentinel exception; failures are named in the final
-- exception. A writing RPC's result is assigned first and its effect
-- read in a later statement.

DO $verify$
DECLARE
  u_own  UUID := '00000000-0000-4000-8000-000000165101';  -- owner of a
  u_ag   UUID := '00000000-0000-4000-8000-000000165102';  -- agent, channel admin of tm
  u_ag2  UUID := '00000000-0000-4000-8000-000000165103';  -- agent, channel admin of tm
  u_tl   UUID := '00000000-0000-4000-8000-000000165104';  -- team leader, plain member of tm
  u_g    UUID := '00000000-0000-4000-8000-000000165105';  -- bank guest, member row in pv
  u_b    UUID := '00000000-0000-4000-8000-000000165106';  -- owner of workspace b
  u_adm  UUID := '00000000-0000-4000-8000-000000165107';  -- workspace admin of a, member of tm
  a      UUID;
  b      UUID;
  tm     UUID;  -- team channel: own ag ag2 tl adm
  pv     UUID;  -- private channel: own g
  src    UUID;  -- owner's message in tm with one PDF
  t_a    UUID;  -- main tag of a
  t_sub  UUID;  -- sub-tag of a
  t_b    UUID;  -- main tag of b
  sp     TEXT;
  r      TEXT;
  ub     UUID;
  uuidp  TEXT := '________-____-____-____-____________';
  fwd    TEXT := 'SELECT public.chat_forward_message(%L, %L, %L::jsonb)::text';
  smr    TEXT := 'SELECT public.chat_set_member_role(%L, %L, %L)::text';
  rmm    TEXT := 'SELECT public.chat_remove_member(%L, %L)::text';
  pdf    JSONB := jsonb_build_object('size', 10, 'mimetype', 'application/pdf');
  f      TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '{}', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '{}', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_check(p_name text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.tc_try(CASE WHEN p_uid IS NULL THEN NULL ELSE 'authenticated' END, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- A chat-files object under the channel's prefix with the given
  -- storage metadata (NULL: none): its path.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_up(p_ws uuid, p_ch uuid, p_name text, p_meta jsonb)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := 'account-' || p_ws || '/channel-' || p_ch || '/' || gen_random_uuid() || '-' || p_name;
    BEGIN
      INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('chat-files', v, p_meta);
      RETURN v;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.tc_pdf(p_path text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT jsonb_build_array(jsonb_build_object('storage_path', p_path, 'name', 'd.pdf',
               'mime', 'application/pdf', 'bytes', 10))::text
    $body$
  $fn$;

  -- ---------- fixture ----------
  PERFORM set_config('request.jwt.claims', '{}', true);
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'ci-lows-own@example.invalid'), (u_ag, 'ci-lows-ag@example.invalid'),
    (u_ag2, 'ci-lows-ag2@example.invalid'), (u_tl, 'ci-lows-tl@example.invalid'),
    (u_g, 'ci-lows-g@example.invalid'), (u_b, 'ci-lows-b@example.invalid'),
    (u_adm, 'ci-lows-adm@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  SELECT account_id INTO b FROM profiles WHERE user_id = u_b;
  IF a IS NULL OR b IS NULL OR a = b THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_ag, u_ag2);
  UPDATE profiles SET account_id = a, account_role = 'team_leader' WHERE user_id = u_tl;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_adm;
  INSERT INTO case_banks (account_id, code, name) VALUES (a, 'ADCB', 'ADCB Bank') ON CONFLICT DO NOTHING;
  UPDATE profiles SET account_id = a, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_g;

  tm := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'team', 'Lows team', ARRAY[u_ag, u_ag2, u_tl, u_adm]));
  pv := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text', a, 'private', 'Lows private', ARRAY[]::uuid[]));
  r := pg_temp.tc_try('authenticated', u_own, format(smr, tm, u_ag, 'admin'))
    || pg_temp.tc_try('authenticated', u_own, format(smr, tm, u_ag2, 'admin'));
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: channel admin roles (%)', r; END IF;
  INSERT INTO chat_channel_members (channel_id, user_id, role) VALUES (pv, u_g, 'member');
  -- agents may send voice notes but not upload files
  r := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_set_permissions(%L, %L::jsonb)::text',
         a, '[{"role_class":"agent","capability":"upload_files"}]'));
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: permissions (%)', r; END IF;
  src := pg_temp.tc_try('authenticated', u_own, format('SELECT public.chat_post_message(%L, %L, NULL, NULL, %L::jsonb)::text',
           tm, 'the pdf', pg_temp.tc_pdf(pg_temp.tc_up(a, tm, 'd.pdf', pdf))));

  -- ---------- 1. forwarded copies are checked against storage ----------
  n := n + 1; failed := failed || pg_temp.tc_check('1a forward of a true copy was refused', u_ag,
    format(fwd, src, tm, pg_temp.tc_pdf(pg_temp.tc_up(a, tm, 'd.pdf', pdf))), uuidp);
  n := n + 1; failed := failed || pg_temp.tc_check('1b copy whose object has another mimetype was accepted', u_ag,
    format(fwd, src, tm, pg_temp.tc_pdf(pg_temp.tc_up(a, tm, 'd.pdf',
      jsonb_build_object('size', 10, 'mimetype', 'application/zip')))),
    'ERROR 22023:%stored object does not match the source file%');
  n := n + 1; failed := failed || pg_temp.tc_check('1c copy whose object has another size was accepted', u_ag,
    format(fwd, src, tm, pg_temp.tc_pdf(pg_temp.tc_up(a, tm, 'd.pdf',
      jsonb_build_object('size', 5000000, 'mimetype', 'application/pdf')))),
    'ERROR 22023:%stored object does not match the source file%');
  n := n + 1; failed := failed || pg_temp.tc_check('1d copy whose object has no metadata was accepted', u_ag,
    format(fwd, src, tm, pg_temp.tc_pdf(pg_temp.tc_up(a, tm, 'd.pdf', NULL))),
    'ERROR 22023:%stored object does not match the source file%');
  n := n + 1; failed := failed || pg_temp.tc_check('1e copy whose object has a non-numeric size was accepted', u_ag,
    format(fwd, src, tm, pg_temp.tc_pdf(pg_temp.tc_up(a, tm, 'd.pdf',
      jsonb_build_object('size', 'ten', 'mimetype', 'application/pdf')))),
    'ERROR 22023:%stored object does not match the source file%');

  -- ---------- 2. the interested-reply tag ----------
  INSERT INTO chat_tags (account_id, name) VALUES (a, 'Interested') RETURNING id INTO t_a;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a, t_a, 'ADCB') RETURNING id INTO t_sub;
  INSERT INTO chat_tags (account_id, name) VALUES (b, 'Other') RETURNING id INTO t_b;
  n := n + 1; failed := failed || pg_temp.tc_check('2a another workspace''s tag was accepted', u_own,
    format('INSERT INTO ai_insight_settings (account_id, reply_interested_tag_id) VALUES (%L, %L) RETURNING ''ins''', a, t_b),
    'ERROR 23514:%of this workspace%');
  r := pg_temp.tc_try('authenticated', u_own,
    format('INSERT INTO ai_insight_settings (account_id, reply_interested_tag_id) VALUES (%L, %L) RETURNING ''ins''', a, t_a));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ins', '2b own main tag was refused (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('2c update to another workspace''s tag was accepted', u_own,
    format('UPDATE ai_insight_settings SET reply_interested_tag_id = %L WHERE account_id = %L RETURNING ''upd''', t_b, a),
    'ERROR 23514:%of this workspace%');
  n := n + 1; failed := failed || pg_temp.tc_check('2d a sub-tag was accepted', u_own,
    format('UPDATE ai_insight_settings SET reply_interested_tag_id = %L WHERE account_id = %L RETURNING ''upd''', t_sub, a),
    'ERROR 23514:%main tag%');
  SELECT updated_by INTO ub FROM ai_insight_settings WHERE account_id = a;
  n := n + 1; failed := failed || pg_temp.tc_ok(ub = u_own, '2e updated_by not stamped with the writer (' || coalesce(ub::text, 'NULL') || ')');
  UPDATE ai_insight_settings SET updated_by = u_b WHERE account_id = a;
  SELECT updated_by INTO ub FROM ai_insight_settings WHERE account_id = a;
  n := n + 1; failed := failed || pg_temp.tc_ok(ub = u_b, '2f a write with no auth.uid() lost its updated_by (' || coalesce(ub::text, 'NULL') || ')');

  -- ---------- 3. channel admin roles ----------
  n := n + 1; failed := failed || pg_temp.tc_check('3a agent channel admin demoted another channel admin', u_ag,
    format(smr, tm, u_ag2, 'member'), 'ERROR 42501:%workspace owner or admin%');
  r := pg_temp.tc_try('authenticated', u_ag, format(smr, tm, u_tl, 'admin'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', '3b agent channel admin could not promote a member (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('3c agent channel admin demoted a just-promoted channel admin', u_ag,
    format(smr, tm, u_tl, 'member'), 'ERROR 42501:%workspace owner or admin%');
  r := pg_temp.tc_try('authenticated', u_ag2, format(smr, tm, u_ag2, 'member'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', '3d a channel admin could not step down (' || r || ')');
  r := pg_temp.tc_try('authenticated', u_own, format(smr, tm, u_ag, 'member'));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', '3e the workspace owner could not demote a channel admin (' || r || ')');
  SELECT string_agg(user_id::text || '=' || role, ',' ORDER BY user_id) INTO sp
    FROM chat_channel_members WHERE channel_id = tm AND user_id IN (u_ag, u_ag2, u_tl);
  n := n + 1; failed := failed || pg_temp.tc_ok(
    sp = u_ag || '=member,' || u_ag2 || '=member,' || u_tl || '=admin', '3f roles after the changes (' || sp || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('3g a bank guest was promoted to channel admin', u_own,
    format(smr, pv, u_g, 'admin'), 'ERROR 22023:%bank guest cannot be a channel admin%');

  -- ---------- 4. removing a channel admin ----------
  -- tm now: own admin, tl admin, ag and ag2 members. Make ag a channel admin again.
  r := pg_temp.tc_try('authenticated', u_own, format(smr, tm, u_ag, 'admin'));
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: re-promote ag (%)', r; END IF;
  n := n + 1; failed := failed || pg_temp.tc_check('4a agent channel admin removed another channel admin', u_ag,
    format(rmm, tm, u_tl), 'ERROR 42501:%workspace owner or admin can remove a channel admin%');
  r := pg_temp.tc_try('authenticated', u_ag, format(rmm, tm, u_ag2));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', '4b agent channel admin could not remove a plain member (' || r || ')');
  n := n + 1; failed := failed || pg_temp.tc_check('4c removing yourself was not refused as before', u_ag,
    format(rmm, tm, u_ag), 'ERROR 22023:%chat_leave_channel%');
  r := pg_temp.tc_try('authenticated', u_adm, format(rmm, tm, u_tl));
  n := n + 1; failed := failed || pg_temp.tc_ok(r = 'ok', '4d the workspace admin could not remove a channel admin (' || r || ')');
  SELECT string_agg(user_id::text, ',' ORDER BY user_id) INTO sp
    FROM chat_channel_members WHERE channel_id = tm AND user_id IN (u_ag, u_ag2, u_tl);
  n := n + 1; failed := failed || pg_temp.tc_ok(sp = u_ag::text, '4e members after the removals (' || coalesce(sp, 'none') || ')');

  -- grants as before
  FOREACH f IN ARRAY ARRAY['public.chat_forward_message(uuid,uuid,jsonb)', 'public.chat_set_member_role(uuid,uuid,text)',
                           'public.chat_remove_member(uuid,uuid)'] LOOP
    n := n + 1; failed := failed || pg_temp.tc_ok(has_function_privilege('authenticated', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('anon', f, 'EXECUTE')
                                                 AND NOT has_function_privilege('service_role', f, 'EXECUTE'),
      f || ' grants changed');
  END LOOP;
  f := 'public.ai_insight_settings_guard()';
  n := n + 1; failed := failed || pg_temp.tc_ok(NOT has_function_privilege('authenticated', f, 'EXECUTE')
                                               AND NOT has_function_privilege('anon', f, 'EXECUTE')
                                               AND NOT has_function_privilege('service_role', f, 'EXECUTE'),
    f || ' is executable by a client role');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT165', MESSAGE = 'verify-security-lows rollback';
  EXCEPTION WHEN SQLSTATE 'ZT165' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'security lows verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'security lows verification passed (% checks)', n;
END
$verify$;
