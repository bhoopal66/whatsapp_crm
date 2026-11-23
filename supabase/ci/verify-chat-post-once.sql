-- Behavioural regression suite for migration 276 (a team chat post whose
-- answer was lost is posted once).
--
-- A repeat with the same client id answers the same message: one row, one
-- set of bells, the attachments kept and not refused. The id is the
-- author's own, belongs to one channel, and is optional. The concurrent
-- repeat (the look-up saw nothing, the insert collides) is played by a
-- trigger that writes the first attempt's row in between.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Failing checks
-- are named in the final exception; every fixture is rolled back by
-- the sentinel raised at the end of the inner block.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000276001';
  u_one   UUID := '00000000-0000-4000-8000-000000276002';
  u_two   UUID := '00000000-0000-4000-8000-000000276003';
  c1      UUID := '00000000-0000-4000-8000-0000002760c1';
  c2      UUID := '00000000-0000-4000-8000-0000002760c2';
  c3      UUID := '00000000-0000-4000-8000-0000002760c3';
  sig     TEXT := 'public.chat_post_message(uuid,text,uuid,uuid,jsonb,uuid,uuid)';
  uuid_re TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  a_acct  UUID;
  dm      UUID;  -- one + two
  team    UUID;
  path    TEXT;
  att     JSONB;
  r       TEXT;
  r2      TEXT;
  post    TEXT := 'SELECT public.chat_post_message(%L, %L, p_client_id => %L::uuid)::text';
  postf   TEXT := 'SELECT public.chat_post_message(%L, %L, p_attachments => %L::jsonb, p_client_id => %L::uuid)::text';
  plain   TEXT := 'SELECT public.chat_post_message(%L, %L, NULL, NULL, %L::jsonb)::text';
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.po_try(p_role text, p_uid uuid, p_sql text)
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
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.po_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ci-cpo-owner@example.invalid'),
    (u_one,   'ci-cpo-one@example.invalid'),
    (u_two,   'ci-cpo-two@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE accounts SET internal_chat_enabled = true WHERE id = a_acct;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_one, u_two);
  dm := pg_temp.po_try('authenticated', u_one,
    format('SELECT public.chat_open_dm(%L, %L::uuid[])::text', a_acct, ARRAY[u_two]))::uuid;
  team := pg_temp.po_try('authenticated', u_owner,
    format('SELECT public.chat_create_channel(%L, %L, %L, NULL, %L::uuid[])::text',
           a_acct, 'team', 'CPO team', ARRAY[u_one, u_two]))::uuid;

  -- ---------- a repeat, with a file, a mention and the DM bell ----------
  path := 'account-' || a_acct || '/channel-' || dm || '/' || gen_random_uuid() || '-offer.pdf';
  INSERT INTO storage.objects (bucket_id, name, metadata)
  VALUES ('chat-files', path, '{"size": 100, "mimetype": "application/pdf"}'::jsonb);
  att := jsonb_build_array(jsonb_build_object('storage_path', path, 'name', 'offer.pdf',
                                              'mime', 'application/pdf', 'bytes', 100));
  r  := pg_temp.po_try('authenticated', u_one, format(postf, dm, 'offer <@' || u_two || '>', att, c1));
  n := n + 1; failed := failed || pg_temp.po_ok(r ~ uuid_re, 'a post with a client id failed: ' || r);
  r2 := pg_temp.po_try('authenticated', u_one, format(postf, dm, 'offer <@' || u_two || '>', att, c1));
  n := n + 1; failed := failed || pg_temp.po_ok(r2 = r, 'a repeat with the same file did not answer the first message: ' || r2);
  n := n + 1; failed := failed || pg_temp.po_ok(
    (SELECT count(*) = 1 AND bool_and(client_id = c1) FROM internal_messages WHERE channel_id = dm),
    'a repeat left another message');
  n := n + 1; failed := failed || pg_temp.po_ok(
    (SELECT count(*) FROM chat_notifications cn JOIN internal_messages im ON im.id = cn.message_id
      WHERE im.channel_id = dm) = 1
    AND (SELECT count(*) FROM message_mentions mm WHERE mm.message_id::text = r) = 1,
    'a repeat rang again');
  n := n + 1; failed := failed || pg_temp.po_ok(
    (SELECT count(*) FROM message_attachments WHERE storage_path = path AND message_id::text = r) = 1,
    'the first message did not keep its file');

  -- what the rules say by now does not turn a posted message into a failure
  UPDATE chat_channels SET archived_at = now() WHERE id = dm;
  r2 := pg_temp.po_try('authenticated', u_one, format(postf, dm, 'offer', att, c1));
  n := n + 1; failed := failed || pg_temp.po_ok(r2 = r, 'a repeat was judged again by the rules: ' || r2);
  UPDATE chat_channels SET archived_at = NULL WHERE id = dm;

  -- ---------- whose id, and where ----------
  r2 := pg_temp.po_try('authenticated', u_two, format(post, dm, 'mine', c1));
  n := n + 1; failed := failed || pg_temp.po_ok(r2 ~ uuid_re AND r2 <> r, 'another author could not use the same uuid: ' || r2);
  r2 := pg_temp.po_try('authenticated', u_one, format(post, team, 'elsewhere', c1));
  n := n + 1; failed := failed || pg_temp.po_ok(r2 LIKE 'ERROR 22023%'
    AND NOT EXISTS (SELECT 1 FROM internal_messages WHERE channel_id = team AND body = 'elsewhere'),
    'the same id in another channel was not refused: ' || r2);
  r2 := pg_temp.po_try('anon', NULL, format(post, dm, 'x', c1));
  n := n + 1; failed := failed || pg_temp.po_ok(r2 LIKE 'ERROR 42501%', 'anon reached a post: ' || r2);

  -- ---------- without the id, as before ----------
  r  := pg_temp.po_try('authenticated', u_one, format(plain, team, 'twice', '[]'));
  r2 := pg_temp.po_try('authenticated', u_one, format(plain, team, 'twice', '[]'));
  n := n + 1; failed := failed || pg_temp.po_ok(r ~ uuid_re AND r2 ~ uuid_re AND r <> r2,
    'two posts without an id are not two messages: ' || r || ' / ' || r2);
  r := pg_temp.po_try('authenticated', u_one, format(
    'SELECT public.chat_post_message(p_channel => %L, p_body => %L, p_thread_root => NULL,'
    ' p_share_conversation => NULL, p_attachments => %L::jsonb, p_reply_to => %L::uuid)::text', team, 'quoted', '[]', r));
  n := n + 1; failed := failed || pg_temp.po_ok(r ~ uuid_re, 'the previous build''s named call failed: ' || r);

  -- ---------- a concurrent repeat ----------
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.po_first_attempt() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF NEW.body = 'race' THEN
        INSERT INTO public.internal_messages (channel_id, account_id, author_kind, author_id, body, client_id)
        VALUES (TG_ARGV[0]::uuid, NEW.account_id, 'user', NEW.author_id, 'race (first)', NEW.client_id);
      END IF;
      RETURN NEW;
    END $body$
  $fn$;
  EXECUTE format('CREATE TRIGGER po_first_attempt BEFORE INSERT ON public.internal_messages
                    FOR EACH ROW EXECUTE FUNCTION pg_temp.po_first_attempt(%L)', dm);
  path := 'account-' || a_acct || '/channel-' || dm || '/' || gen_random_uuid() || '-race.pdf';
  INSERT INTO storage.objects (bucket_id, name, metadata)
  VALUES ('chat-files', path, '{"size": 100, "mimetype": "application/pdf"}'::jsonb);
  att := jsonb_build_array(jsonb_build_object('storage_path', path, 'name', 'race.pdf',
                                              'mime', 'application/pdf', 'bytes', 100));
  r := pg_temp.po_try('authenticated', u_one, format(postf, dm, 'race', att, c2));
  n := n + 1; failed := failed || pg_temp.po_ok(
    r = (SELECT id::text FROM internal_messages WHERE author_id = u_one AND client_id = c2 AND body = 'race (first)'),
    'a concurrent repeat did not answer the first attempt''s message: ' || r);
  n := n + 1; failed := failed || pg_temp.po_ok(
    NOT EXISTS (SELECT 1 FROM chat_notifications WHERE message_id::text = r)
    AND NOT EXISTS (SELECT 1 FROM message_attachments WHERE storage_path = path),
    'a concurrent repeat rang, or wrote files, of its own');
  -- the first attempt is in the DM; this one names the team channel
  r := pg_temp.po_try('authenticated', u_one, format(post, team, 'race', c3));
  n := n + 1; failed := failed || pg_temp.po_ok(r LIKE 'ERROR 22023%', 'a concurrent repeat in another channel was not refused: ' || r);

  -- ---------- one function, its grants ----------
  n := n + 1; failed := failed || pg_temp.po_ok(
    (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'chat_post_message') = 1
    AND to_regprocedure(sig) IS NOT NULL,
    'there is not exactly one chat_post_message');
  n := n + 1; failed := failed || pg_temp.po_ok(
    (SELECT prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid = to_regprocedure(sig)),
    'chat_post_message is not SECURITY DEFINER with a pinned search_path');
  n := n + 1; failed := failed || pg_temp.po_ok(
    (SELECT bool_and(x.grantee IN (p.proowner, 'authenticated'::regrole))
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = to_regprocedure(sig) GROUP BY p.oid),
    'chat_post_message is not granted to authenticated alone');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT276', MESSAGE = 'verify-chat-post-once rollback';
  EXCEPTION WHEN SQLSTATE 'ZT276' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat post once verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat post once verification passed (% checks)', n;
END
$verify$;
