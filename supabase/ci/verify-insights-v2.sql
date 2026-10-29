-- Behavioural regression suite for Customer insights 2.0 (migration
-- 153): the guard on the six new conversations columns, the attention
-- pin and its three ways of clearing (closing the chat, a person's
-- reply, acknowledge_insight_attention) with their
-- insight_attention_cleared notes, who reads the per-message history,
-- the new CHECKs and the attention switches' defaults.
--
-- ONE statement on purpose (the pinned CLI rejects several). Failing
-- assertions are named in the final exception; fixtures are undone by
-- a sentinel exception while the collected results survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000153001';
  u_agent  UUID := '00000000-0000-4000-8000-000000153003';
  u_view   UUID := '00000000-0000-4000-8000-000000153004';
  u_agent2 UUID := '00000000-0000-4000-8000-000000153006';
  u_other  UUID := '00000000-0000-4000-8000-000000153007';
  a_acct   UUID;
  b_acct   UUID;
  ct       UUID;
  ct_ins   UUID;
  ct_svc   UUID;
  cv_a     UUID;
  cv_c     UUID;
  cv_svc   UUID;
  s        TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- the value of a SELECT, the row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.iv_try(p_role text, p_uid uuid, p_sql text)
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

  -- As the table owner: 'ok' or the SQLSTATE + error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.iv_do(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;

  -- Fixture: account A (owner, agent, second agent, viewer), account B
  -- (owner). cv_a and cv_c belong to the agent; the second agent cannot
  -- see them.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'iv-owner@example.invalid'),
    (u_agent,  'iv-agent@example.invalid'),
    (u_view,   'iv-view@example.invalid'),
    (u_agent2, 'iv-agent2@example.invalid'),
    (u_other,  'iv-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'  WHERE user_id IN (u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500153001', 'IV contact A') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_agent, ct) RETURNING id INTO cv_a;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500153002', 'IV contact C') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_agent, ct) RETURNING id INTO cv_c;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500153003', 'IV contact insert') RETURNING id INTO ct_ins;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500153004', 'IV contact svc') RETURNING id INTO ct_svc;

  -- ---------- 1. the guard: agents cannot write the new columns ----------
  FOREACH s IN ARRAY ARRAY[
    'insight_sentiment', 'insight_objections', 'insight_needs_reply',
    'insight_callback', 'insight_attention_at, insight_attention_reason'
  ] LOOP
    r := pg_temp.iv_try('authenticated', u_agent, format(
           'INSERT INTO conversations (account_id, user_id, contact_id, %s) VALUES (%L, %L, %L, %s)',
           s, a_acct, u_agent, ct_ins,
           CASE s
             WHEN 'insight_sentiment' THEN '3'
             WHEN 'insight_objections' THEN '''{price}''::text[]'
             WHEN 'insight_attention_at, insight_attention_reason' THEN 'now(), ''urgent'''
             ELSE '0.7'
           END));
    n := n + 1;
    IF r NOT LIKE '%written by the server only%' THEN
      failed := array_append(failed, ('an agent inserted a chat with ' || s || ': ' || r)::text);
    END IF;

    r := pg_temp.iv_try('authenticated', u_agent, format(
           'UPDATE conversations SET (%s) = (SELECT %s) WHERE id = %L',
           s,
           CASE s
             WHEN 'insight_sentiment' THEN '3'
             WHEN 'insight_objections' THEN '''{price}''::text[]'
             WHEN 'insight_attention_at, insight_attention_reason' THEN 'now(), ''urgent'''
             ELSE '0.7'
           END, cv_a));
    n := n + 1;
    IF r NOT LIKE '%written by the server only%' THEN
      failed := array_append(failed, ('an agent updated ' || s || ': ' || r)::text);
    END IF;
  END LOOP;

  -- An agent's ordinary insert still works.
  r := pg_temp.iv_try('authenticated', u_agent, format(
         'INSERT INTO conversations (account_id, user_id, contact_id) VALUES (%L, %L, %L)',
         a_acct, u_agent, ct_ins));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an agent could not insert an ordinary chat: ' || r)::text);
  END IF;

  -- ---------- 2. the service role writes them ----------
  r := pg_temp.iv_try('service_role', NULL, format(
         'INSERT INTO conversations (account_id, user_id, contact_id, insight_sentiment, insight_objections, insight_attention_at, insight_attention_reason) VALUES (%L, %L, %L, 1, %L::text[], now(), %L)',
         a_acct, u_agent, ct_svc, '{trust,timing}', 'upset'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the service role could not insert a chat with insights: ' || r)::text);
  END IF;
  SELECT id INTO cv_svc FROM conversations WHERE contact_id = ct_svc;

  r := pg_temp.iv_try('service_role', NULL, format(
         'UPDATE conversations SET insight_sentiment = 0.5, insight_objections = %L::text[], insight_needs_reply = 0.9, insight_callback = 0.2, insight_attention_at = now(), insight_attention_reason = %L WHERE id IN (%L, %L)',
         '{price,documents}', 'urgent', cv_a, cv_c));
  n := n + 1;
  IF r <> '2' OR (SELECT insight_attention_reason FROM conversations WHERE id = cv_a) IS DISTINCT FROM 'urgent'
     OR (SELECT insight_objections FROM conversations WHERE id = cv_a) <> '{price,documents}'::text[] THEN
    failed := array_append(failed, ('the service role could not write the new columns: ' || r)::text);
  END IF;

  -- ---------- 3. ordinary agent updates, and NULLing without closing ----------
  r := pg_temp.iv_try('authenticated', u_agent, format(
         'UPDATE conversations SET status = %L WHERE id = %L',
         'pending', cv_a));
  n := n + 1;
  IF r <> '1' OR (SELECT insight_attention_at FROM conversations WHERE id = cv_a) IS NULL THEN
    failed := array_append(failed, ('an agent''s ordinary update failed or unpinned the chat: ' || r)::text);
  END IF;

  r := pg_temp.iv_try('authenticated', u_agent, format(
         'UPDATE conversations SET insight_attention_at = NULL, insight_attention_reason = NULL WHERE id = %L', cv_a));
  n := n + 1;
  IF r NOT LIKE '%written by the server only%'
     OR (SELECT insight_attention_at FROM conversations WHERE id = cv_a) IS NULL THEN
    failed := array_append(failed, ('an agent unpinned a chat without closing it: ' || r)::text);
  END IF;

  -- Re-saving closed on a chat already closed is not "closing": cv_c is
  -- closed by the owner first, re-pinned, then an agent's NULL with a
  -- status re-save is refused.
  PERFORM pg_temp.iv_do(format('UPDATE conversations SET status = %L WHERE id = %L', 'closed', cv_c));
  PERFORM pg_temp.iv_do(format(
    'UPDATE conversations SET insight_attention_at = now(), insight_attention_reason = %L WHERE id = %L', 'callback', cv_c));
  r := pg_temp.iv_try('authenticated', u_agent, format(
         'UPDATE conversations SET status = %L, insight_attention_at = NULL, insight_attention_reason = NULL WHERE id = %L',
         'closed', cv_c));
  n := n + 1;
  IF r NOT LIKE '%written by the server only%' THEN
    failed := array_append(failed, ('an agent unpinned an already-closed chat: ' || r)::text);
  END IF;

  -- ---------- 4. closing clears the pin ----------
  r := pg_temp.iv_try('authenticated', u_agent, format(
         'UPDATE conversations SET status = %L WHERE id = %L', 'closed', cv_a));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an agent could not close a pinned chat: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT insight_attention_at IS NOT NULL OR insight_attention_reason IS NOT NULL
        FROM conversations WHERE id = cv_a) THEN
    failed := array_append(failed, 'closing a chat did not clear its pin'::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (
    SELECT 1 FROM conversation_events
     WHERE conversation_id = cv_a AND kind = 'insight_attention_cleared'
       AND details->>'how' = 'closed' AND details->>'reason' = 'urgent'
       AND actor_user_id = u_agent) THEN
    failed := array_append(failed, 'closing did not record insight_attention_cleared (closed, urgent, actor)'::text);
  END IF;

  -- Closing and NULLing in the same UPDATE goes through the guard's
  -- close exception.
  PERFORM pg_temp.iv_do(format('UPDATE conversations SET status = %L WHERE id = %L', 'open', cv_c));
  r := pg_temp.iv_try('authenticated', u_agent, format(
         'UPDATE conversations SET status = %L, insight_attention_at = NULL, insight_attention_reason = NULL WHERE id = %L',
         'closed', cv_c));
  n := n + 1;
  IF r <> '1' OR (SELECT insight_attention_at FROM conversations WHERE id = cv_c) IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM conversation_events
                     WHERE conversation_id = cv_c AND kind = 'insight_attention_cleared'
                       AND details->>'how' = 'closed' AND details->>'reason' = 'callback') THEN
    failed := array_append(failed, ('closing with explicit NULLs was refused or not noted: ' || r)::text);
  END IF;

  -- ---------- 5. a person's reply clears it; bot and customer do not ----------
  PERFORM pg_temp.iv_do(format(
    'UPDATE conversations SET status = %L, insight_attention_at = now(), insight_attention_reason = %L WHERE id = %L',
    'open', 'wants_person', cv_a));

  r := pg_temp.iv_try('service_role', NULL, format(
         'INSERT INTO messages (conversation_id, sender_type, sender_id, content_text) VALUES (%L, %L, %L, %L)',
         cv_a, 'bot', u_agent, 'bot reply'));
  n := n + 1;
  IF r <> '1' OR (SELECT insight_attention_at FROM conversations WHERE id = cv_a) IS NULL THEN
    failed := array_append(failed, ('a bot message cleared the pin: ' || r)::text);
  END IF;

  r := pg_temp.iv_try('service_role', NULL, format(
         'INSERT INTO messages (conversation_id, sender_type, content_text) VALUES (%L, %L, %L)',
         cv_a, 'customer', 'hello?'));
  n := n + 1;
  IF r <> '1' OR (SELECT insight_attention_at FROM conversations WHERE id = cv_a) IS NULL THEN
    failed := array_append(failed, ('a customer message cleared the pin: ' || r)::text);
  END IF;

  r := pg_temp.iv_try('authenticated', u_agent, format(
         'INSERT INTO messages (conversation_id, sender_type, sender_id, content_text) VALUES (%L, %L, %L, %L)',
         cv_a, 'agent', u_agent, 'on it'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an agent could not send a reply: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT insight_attention_at FROM conversations WHERE id = cv_a) IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM conversation_events
        WHERE conversation_id = cv_a AND kind = 'insight_attention_cleared'
          AND details->>'how' = 'reply' AND details->>'reason' = 'wants_person'
          AND actor_user_id = u_agent) THEN
    failed := array_append(failed, 'a person''s reply did not clear the pin with a reply note'::text);
  END IF;
  n := n + 1;
  IF COALESCE(current_setting('app.insight_write', TRUE), '') = 'on' THEN
    failed := array_append(failed, 'the reply trigger left app.insight_write raised'::text);
  END IF;

  -- ---------- 6. acknowledge_insight_attention ----------
  PERFORM pg_temp.iv_do(format(
    'UPDATE conversations SET insight_attention_at = now(), insight_attention_reason = %L WHERE id = %L',
    'upset', cv_a));

  r := pg_temp.iv_try('authenticated', u_agent2, format(
         'SELECT public.acknowledge_insight_attention(%L)', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' OR (SELECT insight_attention_at FROM conversations WHERE id = cv_a) IS NULL THEN
    failed := array_append(failed, ('an agent who cannot see the chat acknowledged its pin: ' || r)::text);
  END IF;
  r := pg_temp.iv_try('authenticated', u_view, format(
         'SELECT public.acknowledge_insight_attention(%L)', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('a viewer acknowledged a pin: ' || r)::text);
  END IF;
  r := pg_temp.iv_try('authenticated', u_other, format(
         'SELECT public.acknowledge_insight_attention(%L)', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('another account acknowledged a pin: ' || r)::text);
  END IF;

  r := pg_temp.iv_try('authenticated', u_agent, format(
         'SELECT public.acknowledge_insight_attention(%L)', cv_a));
  n := n + 1;
  IF r LIKE 'ERROR%' THEN
    failed := array_append(failed, ('the chat''s agent could not acknowledge its pin: ' || r)::text);
  END IF;
  n := n + 1;
  IF (SELECT insight_attention_at FROM conversations WHERE id = cv_a) IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM conversation_events
        WHERE conversation_id = cv_a AND kind = 'insight_attention_cleared'
          AND details->>'how' = 'handled' AND details->>'reason' = 'upset'
          AND actor_user_id = u_agent) THEN
    failed := array_append(failed, 'acknowledging did not clear the pin with a handled note'::text);
  END IF;

  -- Not pinned: a no-op, no second note.
  r := pg_temp.iv_try('authenticated', u_agent, format(
         'SELECT public.acknowledge_insight_attention(%L)', cv_a));
  n := n + 1;
  IF r LIKE 'ERROR%' OR (SELECT count(*) FROM conversation_events
                          WHERE conversation_id = cv_a AND details->>'how' = 'handled') <> 1 THEN
    failed := array_append(failed, ('acknowledging an unpinned chat was not a no-op: ' || r)::text);
  END IF;

  -- The flag is the RPC's own: an agent's direct write is still refused.
  r := pg_temp.iv_try('authenticated', u_agent, format(
         'UPDATE conversations SET insight_sentiment = 4 WHERE id = %L', cv_a));
  n := n + 1;
  IF r NOT LIKE '%written by the server only%' THEN
    failed := array_append(failed, ('the guard stayed open after acknowledging: ' || r)::text);
  END IF;

  r := pg_temp.iv_do(format(
         'INSERT INTO conversation_events (account_id, conversation_id, kind, details) VALUES (%L, %L, %L, %L::jsonb)',
         a_acct, cv_a, 'insight_attention_set', '{"reason":"urgent"}'));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('conversation_events refused insight_attention_set: ' || r)::text);
  END IF;

  -- ---------- 7. per-message history ----------
  r := pg_temp.iv_try('service_role', NULL, format(
         'INSERT INTO conversation_insight_events (account_id, conversation_id, message_at, figures) VALUES (%L, %L, now(), %L::jsonb)',
         a_acct, cv_a, '{"sentiment":2}'));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the service role could not write history: ' || r)::text);
  END IF;
  r := pg_temp.iv_try('service_role', NULL, format(
         'INSERT INTO conversation_insight_events (account_id, conversation_id, message_at, figures) VALUES (%L, %L, now(), %L::jsonb)',
         b_acct, cv_a, '{"sentiment":2}'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23503%' THEN
    failed := array_append(failed, ('history accepted another account''s chat: ' || r)::text);
  END IF;

  r := pg_temp.iv_try('authenticated', u_agent, format(
         'SELECT count(*) FROM conversation_insight_events WHERE conversation_id = %L', cv_a));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the chat''s agent could not read its history: ' || r)::text);
  END IF;
  r := pg_temp.iv_try('authenticated', u_agent2, format(
         'SELECT count(*) FROM conversation_insight_events WHERE conversation_id = %L', cv_a));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('an agent who cannot see the chat read its history: ' || r)::text);
  END IF;
  r := pg_temp.iv_try('authenticated', u_other, format(
         'SELECT count(*) FROM conversation_insight_events WHERE conversation_id = %L', cv_a));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('another account read the history: ' || r)::text);
  END IF;
  r := pg_temp.iv_try('authenticated', u_agent, format(
         'INSERT INTO conversation_insight_events (account_id, conversation_id, message_at, figures) VALUES (%L, %L, now(), %L::jsonb)',
         a_acct, cv_a, '{"sentiment":4}'));
  n := n + 1;
  IF r NOT LIKE 'ERROR%' THEN
    failed := array_append(failed, ('an agent wrote history: ' || r)::text);
  END IF;

  r := pg_temp.iv_do(format('DELETE FROM conversations WHERE id = %L', cv_a));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM conversation_insight_events WHERE conversation_id = cv_a) THEN
    failed := array_append(failed, ('deleting the chat did not delete its history: ' || r)::text);
  END IF;

  -- ---------- 8. CHECKs ----------
  FOREACH s IN ARRAY ARRAY[
    'insight_objections = ''{price,weather}''::text[]',
    'insight_attention_reason = ''bored''',
    'insight_attention_at = NULL, insight_attention_reason = ''urgent''',
    'insight_attention_at = now(), insight_attention_reason = NULL',
    'insight_sentiment = 4.5',
    'insight_needs_reply = 1.5',
    'insight_callback = -0.1'
  ] LOOP
    r := pg_temp.iv_do(format('UPDATE conversations SET %s WHERE id = %L', s, cv_svc));
    n := n + 1;
    IF r NOT LIKE 'ERROR 23514%' THEN
      failed := array_append(failed, ('a CHECK accepted ' || s || ': ' || r)::text);
    END IF;
  END LOOP;

  -- ---------- 9. attention switches default on ----------
  r := pg_temp.iv_do(format('INSERT INTO ai_insight_settings (account_id) VALUES (%L) ON CONFLICT DO NOTHING', a_acct));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (
       SELECT 1 FROM ai_insight_settings
        WHERE account_id = a_acct
          AND attention_pin_urgent AND attention_pin_upset
          AND attention_pin_wants_person AND attention_pin_callback
          AND attention_notify) THEN
    failed := array_append(failed, ('the attention switches do not default to on: ' || r)::text);
  END IF;

  n := n + 1;
  IF has_function_privilege('anon', 'public.acknowledge_insight_attention(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.acknowledge_insight_attention(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.messages_clear_insight_attention()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.conversations_attention_close_note()', 'EXECUTE')
     OR has_table_privilege('anon', 'public.conversation_insight_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.conversation_insight_events', 'INSERT') THEN
    failed := array_append(failed, 'function or table privileges differ from 153'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT153', MESSAGE = 'verify-insights-v2 rollback';
  EXCEPTION WHEN SQLSTATE 'ZT153' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'insights v2 verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'insights v2 verification passed (% checks)', n;
END
$verify$;
