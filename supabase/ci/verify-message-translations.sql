-- Behavioural regression suite for the translation cache (migration
-- 154): message_translations is service-role only (RLS on, no policy,
-- no grant to anon or authenticated); account_id and conversation_id
-- are derived from the message whatever the writer passes; a missing
-- message, a second row per (message, lang), a bad lang, a blank text
-- and a malformed source_hash are refused while the route's upsert
-- updates in place; message_id is immutable; deleting the message
-- deletes the translation; ai_usage_log accepts mode 'translate'.
--
-- ONE statement on purpose (the pinned CLI rejects several). Failing
-- assertions are named in the final exception; fixtures (fresh ids,
-- so the block can run twice) are undone by a sentinel exception
-- while the collected results survive.

DO $verify$
DECLARE
  u_a    UUID := gen_random_uuid();
  u_b    UUID := gen_random_uuid();
  a_acct UUID;
  b_acct UUID;
  ct     UUID;
  cv_a   UUID;
  cv_b   UUID;
  m_a    UUID := gen_random_uuid();
  m_a2   UUID := gen_random_uuid();
  m_b    UUID := gen_random_uuid();
  h1     TEXT := encode(sha256('مرحبا'::bytea), 'hex');
  h2     TEXT := encode(sha256('مرحبا بك'::bytea), 'hex');
  priv   TEXT;
  rl     TEXT;
  r      TEXT;
  v_acct UUID;
  v_conv UUID;
  v_text TEXT;
  v_hash TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- the value of a SELECT, the row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.mt_try(p_role text, p_uid uuid, p_sql text)
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

  -- Fixture: accounts A and B (one owner each), one conversation each;
  -- A has two customer messages, B one.
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'mt-a-' || u_a || '@example.invalid'),
    (u_b, 'mt-b-' || u_b || '@example.invalid');
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_a;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_b;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_a, '9715' || lpad((random() * 1e8)::bigint::text, 8, '0'), 'MT contact A')
  RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_a, ct) RETURNING id INTO cv_a;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_b, '9715' || lpad((random() * 1e8)::bigint::text, 8, '0'), 'MT contact B')
  RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (b_acct, u_b, ct) RETURNING id INTO cv_b;

  -- Customer messages are the service role's to write (062).
  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO messages (id, conversation_id, sender_type, content_text) VALUES (%L, %L, %L, %L), (%L, %L, %L, %L), (%L, %L, %L, %L)',
         m_a, cv_a, 'customer', 'مرحبا',
         m_a2, cv_a, 'customer', 'شكرا',
         m_b, cv_b, 'customer', 'أهلا'));
  IF r <> '3' THEN
    RAISE EXCEPTION 'fixture: messages insert failed: %', r;
  END IF;

  -- ---------- 1. RLS on, no policy ----------
  n := n + 1;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.message_translations'::regclass) THEN
    failed := array_append(failed, 'RLS is not enabled on message_translations'::text);
  END IF;
  n := n + 1;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'message_translations') <> 0 THEN
    failed := array_append(failed, 'message_translations has a policy; it must have none'::text);
  END IF;

  -- ---------- 2. Grants: service role only ----------
  FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    FOREACH rl IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      n := n + 1;
      IF has_table_privilege(rl, 'public.message_translations', priv) THEN
        failed := array_append(failed, (rl || ' has ' || priv || ' on message_translations')::text);
      END IF;
    END LOOP;
    n := n + 1;
    IF NOT has_table_privilege('service_role', 'public.message_translations', priv) THEN
      failed := array_append(failed, ('service_role lacks ' || priv || ' on message_translations')::text);
    END IF;
  END LOOP;

  -- ---------- 3. account / conversation are derived, not trusted ----------
  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO message_translations (account_id, conversation_id, message_id, lang, source_hash, translated_text, provider, model) VALUES (%L, %L, %L, %L, %L, %L, %L, %L)',
         b_acct, cv_b, m_a, 'en', h1, 'Hello', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the service role could not insert a translation: ' || r)::text);
  END IF;
  SELECT account_id, conversation_id INTO v_acct, v_conv
    FROM message_translations WHERE message_id = m_a AND lang = 'en';
  n := n + 1;
  IF v_acct IS DISTINCT FROM a_acct OR v_conv IS DISTINCT FROM cv_a THEN
    failed := array_append(failed, ('derived account/conversation: a row for account A''s message kept the writer''s account ' || coalesce(v_acct::text, 'null') || ' / conversation ' || coalesce(v_conv::text, 'null'))::text);
  END IF;

  -- ---------- 4. a missing message is refused ----------
  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO message_translations (account_id, conversation_id, message_id, lang, source_hash, translated_text, provider, model) VALUES (%L, %L, %L, %L, %L, %L, %L, %L)',
         a_acct, cv_a, gen_random_uuid(), 'en', h1, 'Hello', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23503%' THEN
    failed := array_append(failed, ('a translation of a missing message was not refused: ' || r)::text);
  END IF;

  -- ---------- 5. one row per (message, lang); the upsert updates ----------
  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO message_translations (account_id, conversation_id, message_id, lang, source_hash, translated_text, provider, model) VALUES (%L, %L, %L, %L, %L, %L, %L, %L)',
         a_acct, cv_a, m_a, 'en', h2, 'Hello again', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23505%' THEN
    failed := array_append(failed, ('a second row for the same (message, en) was not refused: ' || r)::text);
  END IF;

  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO message_translations (account_id, conversation_id, message_id, lang, source_hash, translated_text, provider, model) VALUES (%L, %L, %L, %L, %L, %L, %L, %L) ON CONFLICT (message_id, lang) DO UPDATE SET translated_text = EXCLUDED.translated_text, source_hash = EXCLUDED.source_hash',
         b_acct, cv_b, m_a, 'en', h2, 'Hello, welcome', 'anthropic', 'claude-haiku'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the upsert did not write: ' || r)::text);
  END IF;
  SELECT account_id, conversation_id, translated_text, source_hash
    INTO v_acct, v_conv, v_text, v_hash
    FROM message_translations WHERE message_id = m_a AND lang = 'en';
  n := n + 1;
  IF v_text IS DISTINCT FROM 'Hello, welcome' OR v_hash IS DISTINCT FROM h2
     OR v_acct IS DISTINCT FROM a_acct OR v_conv IS DISTINCT FROM cv_a
     OR (SELECT count(*) FROM message_translations WHERE message_id = m_a) <> 1 THEN
    failed := array_append(failed, ('the upsert did not update in place keeping account/conversation: ' || coalesce(v_text, 'null') || ' / ' || coalesce(v_acct::text, 'null'))::text);
  END IF;

  -- ---------- 6. CHECKs ----------
  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO message_translations (account_id, conversation_id, message_id, lang, source_hash, translated_text, provider, model) VALUES (%L, %L, %L, %L, %L, %L, %L, %L)',
         a_acct, cv_a, m_a2, 'fr', h1, 'Bonjour', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('lang fr was not refused: ' || r)::text);
  END IF;

  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO message_translations (account_id, conversation_id, message_id, lang, source_hash, translated_text, provider, model) VALUES (%L, %L, %L, %L, %L, %L, %L, %L)',
         a_acct, cv_a, m_a2, 'en', h1, E' \t\n ', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('a blank translated_text was not refused: ' || r)::text);
  END IF;

  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO message_translations (account_id, conversation_id, message_id, lang, source_hash, translated_text, provider, model) VALUES (%L, %L, %L, %L, %L, %L, %L, %L)',
         a_acct, cv_a, m_a2, 'en', upper(h1), 'Thanks', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('a source_hash that is not 64 lowercase hex chars was not refused: ' || r)::text);
  END IF;

  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO message_translations (account_id, conversation_id, message_id, lang, source_hash, translated_text, provider, model) VALUES (%L, %L, %L, %L, %L, %L, %L, %L)',
         a_acct, cv_a, m_a2, 'en', left(h1, 40), 'Thanks', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('a 40-char source_hash was not refused: ' || r)::text);
  END IF;

  -- ---------- 7. message_id is immutable ----------
  r := pg_temp.mt_try('service_role', NULL, format(
         'UPDATE message_translations SET message_id = %L WHERE message_id = %L',
         m_a2, m_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR%' THEN
    failed := array_append(failed, ('message_id was moved to another message: ' || r)::text);
  END IF;

  -- ---------- 8. deleting the message deletes its translation ----------
  r := pg_temp.mt_try('service_role', NULL, format(
         'DELETE FROM messages WHERE id = %L', m_a));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('fixture: deleting the message failed: ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM message_translations WHERE message_id = m_a) THEN
    failed := array_append(failed, 'deleting the message left its translation behind'::text);
  END IF;

  -- ---------- 9. ai_usage_log.mode accepts 'translate' ----------
  n := n + 1;
  IF (SELECT array_agg(conname::text) FROM pg_constraint
       WHERE conrelid = 'public.ai_usage_log'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%mode%') IS DISTINCT FROM ARRAY['ai_usage_log_mode_check'] THEN
    failed := array_append(failed, 'ai_usage_log does not carry exactly one mode CHECK named ai_usage_log_mode_check'::text);
  END IF;

  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO ai_usage_log (account_id, conversation_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens) VALUES (%L, %L, %L, %L, %L, 10, 5, 15)',
         a_acct, cv_a, 'translate', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('ai_usage_log refused mode translate: ' || r)::text);
  END IF;

  r := pg_temp.mt_try('service_role', NULL, format(
         'INSERT INTO ai_usage_log (account_id, mode, provider, model) VALUES (%L, %L, %L, %L)',
         a_acct, 'bogus', 'openai', 'gpt-4o-mini'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('ai_usage_log accepted mode bogus: ' || r)::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT154', MESSAGE = 'verify-message-translations rollback';
  EXCEPTION WHEN SQLSTATE 'ZT154' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'message translations verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'message translations verification passed (% checks)', n;
END
$verify$;
