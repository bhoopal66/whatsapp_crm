-- Behavioural regression suite for the staged-upload sweep (migration
-- 155): chat_media_staged_orphans() lists a chat-media object directly
-- under account-<uuid>/staged/ once it is older than p_min_age and no
-- messages.media_url, message_templates.header_media_url or
-- broadcasts.header_media_url points at it, compared on the URL's path
-- whatever the origin, query or fragment. Young objects, referenced
-- ones, other folders, deeper nesting and other buckets are never
-- listed; p_min_age under a day (or NULL) is refused; only the service
-- role may call it. The answer is a text[] (empty: {}), as 087's
-- chat_orphan_files.
--
-- ONE statement on purpose (the pinned CLI rejects several). Failing
-- assertions are named in the final exception; fixtures (fresh ids,
-- so the block can run twice) are undone by a sentinel exception
-- while the collected results survive.

DO $verify$
DECLARE
  u_a    UUID := gen_random_uuid();
  a_acct UUID;
  ct     UUID;
  cv     UUID;
  dir    TEXT;
  o_old  TEXT;
  o_young TEXT;
  o_msg  TEXT;
  o_tpl  TEXT;
  o_bc   TEXT;
  o_deep TEXT;
  o_top  TEXT;
  o_inb  TEXT;
  o_bucket TEXT;
  got    TEXT;
  r      TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- the value of a SELECT, the row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cm_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
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
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  -- Is p_name in the service role's listing (default age, full page)?
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cm_listed(p_name text, p_age interval DEFAULT interval '7 days')
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cm_try('service_role', NULL, format(
        'SELECT (%L = ANY (public.chat_media_staged_orphans(%L::interval, 1000)))::text',
        p_name, p_age)) $body$
  $fn$;

  -- Fixture: one account with a conversation.
  INSERT INTO auth.users (id, email) VALUES (u_a, 'cm-a-' || u_a || '@example.invalid');
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_a;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_a, '9715' || lpad((random() * 1e8)::bigint::text, 8, '0'), 'CM contact')
  RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_a, ct) RETURNING id INTO cv;

  -- Names as buildMediaPath(…, 'staged') makes them; fresh per run.
  dir     := format('account-%s/staged/', a_acct);
  o_old   := dir || '1700000000000-old_' || substr(md5(random()::text), 1, 8) || '.jpg';
  o_young := dir || '1700000000001-young_' || substr(md5(random()::text), 1, 8) || '.jpg';
  o_msg   := dir || '1700000000002-sent_' || substr(md5(random()::text), 1, 8) || '.pdf';
  o_tpl   := dir || '1700000000003-tpl_' || substr(md5(random()::text), 1, 8) || '.png';
  o_bc    := dir || '1700000000004-bc_' || substr(md5(random()::text), 1, 8) || '.mp4';
  o_deep  := dir || 'sub/deeper_' || substr(md5(random()::text), 1, 8) || '.jpg';
  o_top   := format('account-%s/1700000000005-top_%s.jpg', a_acct, substr(md5(random()::text), 1, 8));
  o_inb   := format('account-%s/inbound/media_%s.jpg', a_acct, substr(md5(random()::text), 1, 8));
  o_bucket := dir || '1700000000006-otherbucket_' || substr(md5(random()::text), 1, 8) || '.jpg';

  INSERT INTO storage.objects (bucket_id, name, owner, created_at) VALUES
    ('chat-media', o_old,   u_a, now() - interval '400 days'),
    ('chat-media', o_young, u_a, now() - interval '2 days'),
    ('chat-media', o_msg,   u_a, now() - interval '30 days'),
    ('chat-media', o_tpl,   u_a, now() - interval '30 days'),
    ('chat-media', o_bc,    u_a, now() - interval '30 days'),
    ('chat-media', o_deep,  u_a, now() - interval '30 days'),
    ('chat-media', o_top,   u_a, now() - interval '30 days'),
    ('chat-media', o_inb,   u_a, now() - interval '30 days'),
    ('chat-media', 'account-x/foo.jpg', u_a, now() - interval '30 days'),
    ('chat-media', 'account-x/inbound/bar.jpg', u_a, now() - interval '30 days'),
    ('chat-media', 'account-x/staged/sub/deeper.jpg', u_a, now() - interval '30 days'),
    ('chat-media', 'account-x/staged/1700000000007-notuuid.jpg', u_a, now() - interval '30 days'),
    ('chat-files', o_bucket, u_a, now() - interval '30 days');

  -- References: each under a different origin from the one the object
  -- was uploaded through, with a query or a fragment.
  r := pg_temp.cm_try('service_role', NULL, format(
         'INSERT INTO messages (conversation_id, sender_type, content_type, content_text, media_url) VALUES (%L, %L, %L, %L, %L)',
         cv, 'agent', 'document', 'f.pdf',
         'https://old-tunnel.trycloudflare.com/storage/v1/object/public/chat-media/' || o_msg || '?t=1700000000'));
  IF r <> '1' THEN
    RAISE EXCEPTION 'fixture: message insert failed: %', r;
  END IF;
  INSERT INTO message_templates (account_id, user_id, name, body_text, header_media_url)
  VALUES (a_acct, u_a, 'cm_tpl_' || substr(md5(random()::text), 1, 8), 'hi',
          'http://kong:8000/storage/v1/object/public/chat-media/' || o_tpl || '#preview');
  INSERT INTO broadcasts (account_id, user_id, name, template_name, header_media_url)
  VALUES (a_acct, u_a, 'CM bc', 'hello',
          'https://crm.example.com/storage/v1/object/sign/chat-media/' || o_bc || '?token=abc.def');

  -- ---------- listing ----------
  n := n + 1; got := pg_temp.cm_listed(o_old);
  IF got <> 'true' THEN failed := array_append(failed, ('old unreferenced staged object not listed: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_young);
  IF got <> 'false' THEN failed := array_append(failed, ('young staged object listed: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_young, interval '1 day');
  IF got <> 'true' THEN failed := array_append(failed, ('2-day-old object not listed at p_min_age 1 day: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_msg);
  IF got <> 'false' THEN failed := array_append(failed, ('object sent in a message (other origin, ?query) listed: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_tpl);
  IF got <> 'false' THEN failed := array_append(failed, ('template header object listed: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_bc);
  IF got <> 'false' THEN failed := array_append(failed, ('broadcast header object listed: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_deep);
  IF got <> 'false' THEN failed := array_append(failed, ('nested staged/sub object listed: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_top);
  IF got <> 'false' THEN failed := array_append(failed, ('top-level account object listed: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_inb);
  IF got <> 'false' THEN failed := array_append(failed, ('inbound mirror listed: ' || got)::text); END IF;
  n := n + 1; got := pg_temp.cm_listed(o_bucket);
  IF got <> 'false' THEN failed := array_append(failed, ('chat-files object listed: ' || got)::text); END IF;
  n := n + 1;
  got := pg_temp.cm_try('service_role', NULL,
    'SELECT count(*)::text FROM unnest(public.chat_media_staged_orphans(interval ''1 day'', 1000)) x WHERE x LIKE ''account-x/%''');
  IF got <> '0' THEN failed := array_append(failed, ('account-x paths listed: ' || got)::text); END IF;

  -- ---------- order and limit ----------
  n := n + 1;
  got := pg_temp.cm_try('service_role', NULL,
    'SELECT array_to_string(public.chat_media_staged_orphans(interval ''1 day'', 1), '','')');
  IF got IS DISTINCT FROM o_old THEN failed := array_append(failed, ('p_limit 1 is not the oldest: ' || got)::text); END IF;
  n := n + 1;
  got := pg_temp.cm_try('service_role', NULL,
    'SELECT cardinality(public.chat_media_staged_orphans(interval ''1 day'', 0))::text');
  IF got <> '1' THEN failed := array_append(failed, ('p_limit 0 not clamped to 1: ' || got)::text); END IF;
  n := n + 1;
  got := pg_temp.cm_try('service_role', NULL,
    'SELECT public.chat_media_staged_orphans(interval ''100000 days'')::text');
  IF got <> '{}' THEN failed := array_append(failed, ('nothing old enough is not {}: ' || got)::text); END IF;

  -- ---------- guards ----------
  n := n + 1;
  got := pg_temp.cm_try('service_role', NULL, 'SELECT cardinality(public.chat_media_staged_orphans(interval ''23 hours''))::text');
  IF got NOT LIKE 'ERROR 22023%' THEN failed := array_append(failed, ('p_min_age 23 hours accepted: ' || got)::text); END IF;
  n := n + 1;
  got := pg_temp.cm_try('service_role', NULL, 'SELECT cardinality(public.chat_media_staged_orphans(NULL))::text');
  IF got NOT LIKE 'ERROR 22023%' THEN failed := array_append(failed, ('p_min_age NULL accepted: ' || got)::text); END IF;

  -- ---------- grants ----------
  n := n + 1;
  IF has_function_privilege('anon', 'public.chat_media_staged_orphans(interval, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.chat_media_staged_orphans(interval, integer)', 'EXECUTE')
     OR has_function_privilege('public', 'public.chat_media_staged_orphans(interval, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.chat_media_staged_orphans(interval, integer)', 'EXECUTE') THEN
    failed := array_append(failed, 'EXECUTE grants: want service_role only'::text);
  END IF;
  n := n + 1;
  got := pg_temp.cm_try('authenticated', u_a, 'SELECT cardinality(public.chat_media_staged_orphans())::text');
  IF got NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('authenticated may call it: ' || got)::text); END IF;
  n := n + 1;
  got := pg_temp.cm_try('anon', NULL, 'SELECT cardinality(public.chat_media_staged_orphans())::text');
  IF got NOT LIKE 'ERROR 42501%' THEN failed := array_append(failed, ('anon may call it: ' || got)::text); END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT155', MESSAGE = 'verify-chat-media-staged rollback';
  EXCEPTION WHEN SQLSTATE 'ZT155' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat-media staged sweep verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat-media staged sweep verification passed (% checks)', n;
END
$verify$;
