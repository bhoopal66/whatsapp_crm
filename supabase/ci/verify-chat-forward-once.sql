-- Behavioural regression suite for migration 307: a forward and a shared
-- call are made once per client id (a repeat, a concurrent repeat, a
-- deleted copy), a forward carries every file of its source, a bell ends
-- with the read access (edit, leave), and the sensitive-data guard reads
-- file names. The concurrent repeat is played by a trigger that writes the
-- first attempt's row between the look-up and the insert.
--
-- ONE statement on purpose (`supabase db query --file`). Failing checks are
-- named in the final exception; every fixture is rolled back by the
-- sentinel raised at the end of the inner block.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000307001';
  u_one UUID := '00000000-0000-4000-8000-000000307002';
  u_two UUID := '00000000-0000-4000-8000-000000307003';
  u_thr UUID := '00000000-0000-4000-8000-000000307004';
  a     UUID;
  src   UUID;  -- team channel the sources are in
  dm    UUID;  -- own + one
  grp   UUID;  -- own + one + two
  pv    UUID;
  m     UUID;
  m2    UUID;
  mg    UUID;
  mt    UUID;
  mp    UUID;
  cl    UUID;
  r     TEXT;
  r2    TEXT;
  c     UUID;
  fwd   TEXT := 'SELECT public.chat_forward_message(p_message => %L, p_channel => %L, p_attachments => %L::jsonb, p_client_id => %L::uuid)::text';
  old   TEXT := 'SELECT public.chat_forward_message(p_message => %L, p_channel => %L, p_attachments => %L::jsonb)::text';
  shr   TEXT := 'SELECT public.chat_share_call(p_channel => %L, p_call => %L, p_body => %L, p_client_id => %L::uuid)::text';
  shold TEXT := 'SELECT public.chat_share_call(p_channel => %L, p_call => %L, p_body => %L)::text';
  posta TEXT := 'SELECT public.chat_post_message(%L, %L, p_attachments => %L::jsonb)::text';
  uuid_re TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
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
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- One uploaded 100-byte file, as one element of p_attachments.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_up(p_acct uuid, p_ch uuid, p_name text, p_kind text DEFAULT 'file')
    RETURNS jsonb LANGUAGE plpgsql AS $body$
    DECLARE v_path text := 'account-' || p_acct || '/channel-' || p_ch || '/' || gen_random_uuid() || '-f';
            v_mime text := CASE p_kind WHEN 'voice' THEN 'audio/ogg' ELSE 'application/pdf' END;
    BEGIN
      INSERT INTO storage.objects (bucket_id, name, metadata)
      VALUES ('chat-files', v_path, jsonb_build_object('size', 100, 'mimetype', v_mime));
      RETURN jsonb_build_object('storage_path', v_path, 'name', p_name, 'mime', v_mime, 'bytes', 100, 'kind', p_kind)
             || CASE p_kind WHEN 'voice' THEN '{"duration_ms": 1000}'::jsonb ELSE '{}'::jsonb END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'cfo-own@example.invalid'), (u_one, 'cfo-one@example.invalid'),
    (u_two, 'cfo-two@example.invalid'), (u_thr, 'cfo-three@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_own;
  IF a IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_one, u_two, u_thr);
  dm  := pg_temp.cf_try(u_own, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a, ARRAY[u_one]))::uuid;
  grp := pg_temp.cf_try(u_own, format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a, ARRAY[u_one, u_two]))::uuid;
  src := pg_temp.cf_try(u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text',
                        a, 'team', 'CFO team', ARRAY[u_one, u_two]))::uuid;
  pv  := pg_temp.cf_try(u_own, format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text',
                        a, 'private', 'CFO private', ARRAY[u_one, u_two]))::uuid;

  -- ---------- 1. a forward once ----------
  m := pg_temp.cf_try(u_own, format(posta, src, 'two files',
         jsonb_build_array(pg_temp.cf_up(a, src, 'a.pdf'), pg_temp.cf_up(a, src, 'b.pdf'))))::uuid;
  c := gen_random_uuid();
  r  := pg_temp.cf_try(u_own, format(fwd, m, dm, jsonb_build_array(pg_temp.cf_up(a, dm, 'a.pdf'), pg_temp.cf_up(a, dm, 'b.pdf')), c));
  n := n + 1; failed := failed || pg_temp.cf_ok(r ~ uuid_re, 'a forward with a client id failed: ' || r);
  r2 := pg_temp.cf_try(u_own, format(fwd, m, dm, jsonb_build_array(pg_temp.cf_up(a, dm, 'a.pdf'), pg_temp.cf_up(a, dm, 'b.pdf')), c));
  n := n + 1; failed := failed || pg_temp.cf_ok(r2 = r, 'a repeat did not answer the first copy: ' || r2);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT count(*) FROM internal_messages WHERE channel_id = dm) = 1
    AND (SELECT count(*) FROM message_attachments WHERE message_id::text = r) = 2
    AND (SELECT count(*) FROM chat_notifications WHERE user_id = u_one AND account_id = a) = 1,
    'a repeated forward doubled the message, its files or its bell');
  m2 := pg_temp.cf_try(u_own, format('SELECT public.chat_post_message(%L, %L)::text', src, 'other'))::uuid;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    pg_temp.cf_try(u_own, format(fwd, m2, dm, '[]', c)) LIKE 'ERROR 22023:%client id%'
    AND pg_temp.cf_try(u_own, format(fwd, m, pv, '[]', c)) LIKE 'ERROR 22023:%client id%',
    'one client id served another source or channel');
  -- somebody else's id is their own; without an id nothing is remembered
  n := n + 1; failed := failed || pg_temp.cf_ok(
    pg_temp.cf_try(u_one, format(fwd, m2, dm, '[]', c)) ~ uuid_re, 'a client id is not the author''s own');
  r  := pg_temp.cf_try(u_own, format(old, m2, dm, '[]'));
  r2 := pg_temp.cf_try(u_own, format(old, m2, dm, '[]'));
  n := n + 1; failed := failed || pg_temp.cf_ok(r ~ uuid_re AND r2 ~ uuid_re AND r <> r2,
    'the old build''s call (three named arguments) does not work as before: ' || r || ' / ' || r2);
  -- deleted since: a new forward
  c := gen_random_uuid();
  r := pg_temp.cf_try(u_own, format(fwd, m2, dm, '[]', c));
  UPDATE internal_messages SET deleted_at = now() WHERE id::text = r;
  r2 := pg_temp.cf_try(u_own, format(fwd, m2, dm, '[]', c));
  n := n + 1; failed := failed || pg_temp.cf_ok(r2 ~ uuid_re AND r2 <> r, 'a repeat was answered with a deleted copy: ' || r2);
  -- the race
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_first_attempt() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF pg_trigger_depth() = 1 AND NEW.client_id IS NOT NULL THEN
        INSERT INTO public.internal_messages (channel_id, account_id, author_kind, author_id, body, meta, client_id)
        VALUES (NEW.channel_id, NEW.account_id, 'user', NEW.author_id, 'race first', NEW.meta, NEW.client_id);
      END IF;
      RETURN NEW;
    END $body$
  $fn$;
  CREATE TRIGGER cf_first_attempt BEFORE INSERT ON internal_messages
    FOR EACH ROW EXECUTE FUNCTION pg_temp.cf_first_attempt();
  c := gen_random_uuid();
  r := pg_temp.cf_try(u_own, format(fwd, m2, dm, '[]', c));
  DROP TRIGGER cf_first_attempt ON internal_messages;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    r = (SELECT id::text FROM internal_messages WHERE client_id = c AND body = 'race first')
    AND (SELECT count(*) FROM internal_messages WHERE client_id = c) = 1
    AND NOT EXISTS (SELECT 1 FROM chat_notifications WHERE message_id::text = r),
    'a concurrent repeat was not answered with the first copy: ' || r);

  -- ---------- 1. a shared call once ----------
  INSERT INTO calls (account_id, pbx_call_id, direction, remote_number, user_id, status, started_at)
  VALUES (a, 'cfo-call', 'inbound', '971500307001', u_own, 'answered', now()) RETURNING id INTO cl;
  c := gen_random_uuid();
  r  := pg_temp.cf_try(u_own, format(shr, src, cl, 'a call', c));
  r2 := pg_temp.cf_try(u_own, format(shr, src, cl, 'a call', c));
  n := n + 1; failed := failed || pg_temp.cf_ok(r ~ uuid_re AND r2 = r
    AND (SELECT count(*) FROM shared_calls WHERE call_id = cl) = 1, 'a shared call was doubled: ' || r || ' / ' || r2);
  r := pg_temp.cf_try(u_own, format(shold, src, cl, 'a call'));
  n := n + 1; failed := failed || pg_temp.cf_ok(r ~ uuid_re, 'the old build''s share does not work: ' || r);

  -- ---------- one candidate per call, grants ----------
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('chat_forward_message', 'chat_share_call')) = 4
    AND (SELECT bool_and(pronargdefaults = 0) FROM pg_proc WHERE oid IN (
           to_regprocedure('public.chat_forward_message(uuid,uuid,jsonb,uuid)'),
           to_regprocedure('public.chat_share_call(uuid,uuid,text,uuid)'))),
    'the function with p_client_id could also answer a call without it');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_temp']
              AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('chat_forward_message', 'chat_share_call'))
    AND NOT has_function_privilege('authenticated', 'public.chat_assert_not_sensitive(uuid,uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.chat_assert_not_sensitive(uuid,uuid,text)', 'EXECUTE'),
    'grants, SECURITY DEFINER or search_path are wrong');

  -- ---------- 2. every file ----------
  n := n + 1; failed := failed || pg_temp.cf_ok(
    pg_temp.cf_try(u_own, format(old, m, dm, jsonb_build_array(pg_temp.cf_up(a, dm, 'a.pdf')))) LIKE 'ERROR 22023:%copies of the source%'
    AND pg_temp.cf_try(u_own, format(old, m, dm, '[]')) LIKE 'ERROR 22023:%copies of the source%',
    'a forward with a file missing was accepted');

  -- ---------- 3. bells ----------
  mg := pg_temp.cf_try(u_own, format('SELECT public.chat_post_message(%L, %L)::text', grp, 'first wording'))::uuid;
  mt := pg_temp.cf_try(u_own, format('SELECT public.chat_post_message(%L, %L)::text', src, '<@' || u_two || '> first wording'))::uuid;
  mp := pg_temp.cf_try(u_own, format('SELECT public.chat_post_message(%L, %L)::text', pv, '<@' || u_two || '> first wording'))::uuid;
  UPDATE notifications SET read_at = now() WHERE user_id = u_two AND meta->>'message_id' = mg::text;
  UPDATE chat_notifications SET read_at = now() WHERE user_id = u_two AND message_id = mg;
  PERFORM pg_temp.cf_try(u_two, format('SELECT public.chat_post_message(%L, %L)::text', grp, 'bye'));
  r := pg_temp.cf_try(u_own, format('SELECT public.chat_post_message(%L, %L)::text', grp, 'unread one'));
  r2 := concat_ws('|', pg_temp.cf_try(u_two, format('SELECT public.chat_leave_channel(%L)::text', grp)),
                       pg_temp.cf_try(u_two, format('SELECT public.chat_leave_channel(%L)::text', src)),
                       pg_temp.cf_try(u_two, format('SELECT public.chat_leave_channel(%L)::text', pv)));
  n := n + 1; failed := failed || pg_temp.cf_ok(r2 = 'ok|ok|ok', 'leaving failed: ' || r2);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = u_two AND read_at IS NULL AND meta->>'channel_id' IN (grp::text, pv::text))
    AND NOT EXISTS (SELECT 1 FROM chat_notifications x JOIN internal_messages y ON y.id = x.message_id
                     WHERE x.user_id = u_two AND x.read_at IS NULL AND y.channel_id IN (grp, pv)),
    'a leaver kept the unread bells of a group DM or a private channel');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT count(*) FROM notifications WHERE user_id = u_two AND meta->>'message_id' = mt::text) = 1
    AND (SELECT count(*) FROM notifications WHERE user_id = u_one AND meta->>'message_id' = r) = 1,
    'leaving took a team channel''s bell, or somebody else''s');
  r2 := concat_ws('|', pg_temp.cf_try(u_own, format('SELECT public.chat_edit_message(%L, %L)::text', mg, 'second wording')),
                       pg_temp.cf_try(u_own, format('SELECT public.chat_edit_message(%L, %L)::text', mt, '<@' || u_two || '> second wording')));
  n := n + 1; failed := failed || pg_temp.cf_ok(r2 = 'ok|ok'
    AND (SELECT body LIKE '%first wording%' FROM notifications WHERE user_id = u_two AND meta->>'message_id' = mg::text)
    AND (SELECT body LIKE '%second wording%' FROM notifications WHERE user_id = u_one AND meta->>'message_id' = mg::text)
    AND (SELECT body LIKE '%second wording%' FROM notifications WHERE user_id = u_two AND meta->>'message_id' = mt::text),
    'an edit reached the bell of someone who left, or missed a reader''s: ' || r2);

  -- ---------- 4. file names ----------
  m := pg_temp.cf_try(u_own, format(posta, src, 'see file', jsonb_build_array(pg_temp.cf_up(a, src, '4111-1111-1111-1111.pdf'))))::uuid;
  INSERT INTO chat_workspace_settings (account_id, sensitive_mode, sensitive_scope) VALUES (a, 'warn', 'all')
    ON CONFLICT (account_id) DO UPDATE SET sensitive_mode = 'warn', sensitive_scope = 'all';
  n := n + 1; failed := failed || pg_temp.cf_ok(
    pg_temp.cf_try(u_own, format(posta, src, 'see file', jsonb_build_array(pg_temp.cf_up(a, src, '4111-1111-1111-1111.pdf')))) ~ uuid_re,
    'warn mode refused a file name');
  UPDATE chat_workspace_settings SET sensitive_mode = 'block' WHERE account_id = a;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    pg_temp.cf_try(u_own, format(posta, src, 'see file', jsonb_build_array(pg_temp.cf_up(a, src, 'ok.pdf'),
      pg_temp.cf_up(a, src, '4111-1111-1111-1111.pdf')))) LIKE 'ERROR 42501:%contains sensitive data (card)%in team chat',
    'block mode let a card number in a file name through');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    pg_temp.cf_try(u_own, format(old, m, dm, jsonb_build_array(pg_temp.cf_up(a, dm, '4111-1111-1111-1111.pdf')))) LIKE 'ERROR 42501:%contains sensitive data%',
    'block mode let a forward''s file name through');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    pg_temp.cf_try(u_own, format(posta, src, 'see file', jsonb_build_array(pg_temp.cf_up(a, src, 'offer.pdf')))) ~ uuid_re,
    'block mode refused an ordinary file name');
  -- the recorder's own name for a voice note is a date and a time: here one
  -- that passes Luhn (20260101-000002), refused under any other name
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT chat_sensitive_kinds('voice-' || d || '.ogg') = '{card}'
        AND pg_temp.cf_try(u_own, format(posta, src, 'Voice message', jsonb_build_array(pg_temp.cf_up(a, src, 'voice-' || d || '.ogg', 'voice')))) ~ uuid_re
        AND pg_temp.cf_try(u_own, format(posta, src, 'see file', jsonb_build_array(pg_temp.cf_up(a, src, 'voice-' || d || '.ogg')))) LIKE 'ERROR 42501:%'
       FROM (SELECT '20260101-' || lpad(i::text, 6, '0') AS d FROM generate_series(0, 59) i
              WHERE chat_sensitive_kinds('20260101-' || lpad(i::text, 6, '0')) = '{card}' LIMIT 1) x),
    'the recorder''s own file name was read as a card, or the exception is too wide');
  UPDATE chat_workspace_settings SET sensitive_scope = 'guests' WHERE account_id = a;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    pg_temp.cf_try(u_own, format(posta, src, 'see file', jsonb_build_array(pg_temp.cf_up(a, src, '4111-1111-1111-1111.pdf')))) ~ uuid_re,
    'scope guests blocked a channel without a guest');

  RAISE EXCEPTION USING ERRCODE = 'ZT307', MESSAGE = 'verify-chat-forward-once rollback';
  EXCEPTION WHEN SQLSTATE 'ZT307' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat forward once verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat forward once verification passed (% checks)', n;
END
$verify$;
