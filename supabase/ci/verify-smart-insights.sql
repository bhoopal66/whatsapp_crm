-- Behavioural regression suite for the Smart insights foundation
-- (migration 147): who reads and writes ai_insight_settings, the
-- interested-reply tag rules, the conversations_insight_guard on the
-- trusted insight columns, dismiss_tag_suggestion, the same-account
-- suggestion FKs, and the 'chat_tag_auto' event kind.
--
-- ONE statement on purpose (the pinned CLI rejects several). Failing
-- assertions are named in the final exception; fixtures are undone by
-- a sentinel exception while the collected results survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000147001';
  u_admin  UUID := '00000000-0000-4000-8000-000000147002';
  u_agent  UUID := '00000000-0000-4000-8000-000000147003';
  u_view   UUID := '00000000-0000-4000-8000-000000147004';
  u_guest  UUID := '00000000-0000-4000-8000-000000147005';
  u_agent2 UUID := '00000000-0000-4000-8000-000000147006';
  u_other  UUID := '00000000-0000-4000-8000-000000147007';
  a_acct   UUID;
  b_acct   UUID;
  m_int    UUID;
  m_new    UUID;
  s_adcb   UUID;
  m_b      UUID;
  ct       UUID;
  cv_a     UUID;
  cv_b     UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- the value of a SELECT, the row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.si_try(p_role text, p_uid uuid, p_sql text)
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
    CREATE FUNCTION pg_temp.si_do(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;

  -- Fixture: account A (owner, admin, agent, second agent, viewer, bank
  -- guest), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'si-owner@example.invalid'),
    (u_admin,  'si-admin@example.invalid'),
    (u_agent,  'si-agent@example.invalid'),
    (u_view,   'si-view@example.invalid'),
    (u_guest,  'si-guest@example.invalid'),
    (u_agent2, 'si-agent2@example.invalid'),
    (u_other,  'si-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin'  WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'  WHERE user_id IN (u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'Interested') RETURNING id INTO m_int;
  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'New') RETURNING id INTO m_new;
  INSERT INTO chat_tags (account_id, parent_id, name) VALUES (a_acct, m_int, 'ADCB') RETURNING id INTO s_adcb;
  INSERT INTO chat_tags (account_id, name) VALUES (b_acct, 'B tag') RETURNING id INTO m_b;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500147001', 'SI contact A') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_agent, ct) RETURNING id INTO cv_a;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_other, '971500147002', 'SI contact B') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (b_acct, u_other, ct) RETURNING id INTO cv_b;

  -- ---------- 1. settings: who reads, who writes ----------
  r := pg_temp.si_try('authenticated', u_agent, format(
         'INSERT INTO ai_insight_settings (account_id, signals_enabled) VALUES (%L, true)', a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR%' THEN
    failed := array_append(failed, ('an agent created the settings row: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_admin, format(
         'INSERT INTO ai_insight_settings (account_id, signals_enabled, tag_suggest_mode, reply_interested_tag_id) VALUES (%L, true, %L, %L)',
         a_acct, 'suggest', m_int));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin could not create the settings row: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_view, format(
         'SELECT tag_suggest_mode FROM ai_insight_settings WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> 'suggest' THEN
    failed := array_append(failed, ('a viewer could not read the settings: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_agent, format(
         'UPDATE ai_insight_settings SET compose_check_mode = %L WHERE account_id = %L', 'warn', a_acct));
  n := n + 1;
  IF r NOT IN ('0') AND r NOT LIKE 'ERROR%' OR
     (SELECT compose_check_mode FROM ai_insight_settings WHERE account_id = a_acct) <> 'off' THEN
    failed := array_append(failed, ('an agent updated the settings: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_admin, format(
         'UPDATE ai_insight_settings SET compose_check_mode = %L WHERE account_id = %L', 'warn', a_acct));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin could not update the settings: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_guest, format(
         'SELECT count(*) FROM ai_insight_settings WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('a bank guest read the settings: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_other, format(
         'SELECT count(*) FROM ai_insight_settings WHERE account_id = %L', a_acct));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('another account read the settings: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_admin, format(
         'DELETE FROM ai_insight_settings WHERE account_id = %L', a_acct));
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM ai_insight_settings WHERE account_id = a_acct) THEN
    failed := array_append(failed, ('an admin deleted the settings row: ' || r)::text);
  END IF;

  -- ---------- 2. the interested-reply tag ----------
  r := pg_temp.si_do(format(
         'UPDATE ai_insight_settings SET reply_interested_tag_id = %L WHERE account_id = %L', s_adcb, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR%main tag%' THEN
    failed := array_append(failed, ('a sub-tag was accepted as the interested tag: ' || r)::text);
  END IF;
  r := pg_temp.si_do(format(
         'UPDATE ai_insight_settings SET reply_interested_tag_id = %L WHERE account_id = %L', m_b, a_acct));
  n := n + 1;
  -- 165's guard refuses it (23514) before 147's composite FK (23503) would.
  IF r NOT LIKE 'ERROR 23503%' AND r NOT LIKE 'ERROR 23514%of this workspace%' THEN
    failed := array_append(failed, ('another account''s tag was accepted as the interested tag: ' || r)::text);
  END IF;

  -- ---------- 3. the guard ----------
  r := pg_temp.si_try('authenticated', u_agent, format(
         'UPDATE conversations SET status = %L WHERE id = %L', 'closed', cv_a));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an agent''s ordinary update was refused: ' || r)::text);
  END IF;
  r := pg_temp.si_try('authenticated', u_agent, format(
         'UPDATE conversations SET chat_tag_id = %L WHERE id = %L', m_new, cv_a));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an agent''s tag update was refused: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_agent, format(
         'UPDATE conversations SET insight_priority = 2 WHERE id = %L', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' OR (SELECT insight_priority FROM conversations WHERE id = cv_a) <> 0 THEN
    failed := array_append(failed, ('an agent set insight_priority: ' || r)::text);
  END IF;
  r := pg_temp.si_try('authenticated', u_agent, format(
         'UPDATE conversations SET suggested_chat_tag_id = %L WHERE id = %L', m_int, cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' OR (SELECT suggested_chat_tag_id FROM conversations WHERE id = cv_a) IS NOT NULL THEN
    failed := array_append(failed, ('an agent set suggested_chat_tag_id: ' || r)::text);
  END IF;
  -- The suggestion compare-and-set trusts this column: a client that
  -- could push it into the future would freeze the chat's suggestion.
  r := pg_temp.si_try('authenticated', u_agent, format(
         'UPDATE conversations SET suggestion_basis_at = now() + interval ''1 year'' WHERE id = %L', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' OR (SELECT suggestion_basis_at FROM conversations WHERE id = cv_a) IS NOT NULL THEN
    failed := array_append(failed, ('an agent set suggestion_basis_at: ' || r)::text);
  END IF;
  r := pg_temp.si_try('authenticated', u_admin, format(
         'INSERT INTO conversations (account_id, user_id, contact_id, insight_priority) SELECT account_id, user_id, contact_id, 2 FROM conversations WHERE id = %L', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR%' THEN
    failed := array_append(failed, ('a client inserted a conversation with insight_priority set: ' || r)::text);
  END IF;

  r := pg_temp.si_try('service_role', NULL, format(
         'UPDATE conversations SET insight_priority = 2, insight_intent = %L, insight_intent_p = 0.8, suggested_chat_tag_id = %L, suggested_chat_sub_tag_id = %L, suggested_tag_p = 0.9, suggested_tag_at = now() WHERE id = %L',
         'apply', m_int, s_adcb, cv_a));
  n := n + 1;
  IF r <> '1' OR (SELECT insight_priority FROM conversations WHERE id = cv_a) <> 2 THEN
    failed := array_append(failed, ('the service role could not write the insight columns: ' || r)::text);
  END IF;

  r := pg_temp.si_try('service_role', NULL, format(
         'UPDATE conversations SET suggested_chat_tag_id = %L WHERE id = %L', m_b, cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23503%' THEN
    failed := array_append(failed, ('another account''s tag was accepted as a suggestion: ' || r)::text);
  END IF;

  -- ---------- 4. dismiss_tag_suggestion ----------
  r := pg_temp.si_try('authenticated', u_agent2, format(
         'SELECT public.dismiss_tag_suggestion(%L)', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' OR (SELECT suggested_chat_tag_id FROM conversations WHERE id = cv_a) IS DISTINCT FROM m_int THEN
    failed := array_append(failed, ('an agent who cannot see the chat dismissed its suggestion: ' || r)::text);
  END IF;
  r := pg_temp.si_try('authenticated', u_view, format(
         'SELECT public.dismiss_tag_suggestion(%L)', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('a viewer dismissed a suggestion: ' || r)::text);
  END IF;
  r := pg_temp.si_try('authenticated', u_other, format(
         'SELECT public.dismiss_tag_suggestion(%L)', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('another account dismissed a suggestion: ' || r)::text);
  END IF;

  r := pg_temp.si_try('authenticated', u_agent, format(
         'SELECT public.dismiss_tag_suggestion(%L)', cv_a));
  n := n + 1;
  IF r LIKE 'ERROR%' THEN
    failed := array_append(failed, ('the chat''s agent could not dismiss its suggestion: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (
    SELECT 1 FROM conversations
     WHERE id = cv_a
       AND tag_suggestion_dismissed_id = m_int
       AND suggested_chat_tag_id IS NULL
       AND suggested_chat_sub_tag_id IS NULL
       AND suggested_tag_p IS NULL
       AND suggested_tag_at IS NULL
       AND insight_priority = 2
  ) THEN
    failed := array_append(failed, 'dismiss did not clear the suggestion and record the dismissed tag'::text);
  END IF;

  -- The flag does not outlive the function's own UPDATE.
  r := pg_temp.si_try('authenticated', u_agent, format(
         'UPDATE conversations SET insight_priority = 0 WHERE id = %L', cv_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('the guard stayed open after dismiss: ' || r)::text);
  END IF;

  -- Deleting a tag clears the columns that name it, as an admin.
  r := pg_temp.si_try('authenticated', u_admin, format(
         'DELETE FROM chat_tags WHERE id = %L', m_int));
  n := n + 1;
  IF r <> '1' OR (SELECT tag_suggestion_dismissed_id FROM conversations WHERE id = cv_a) IS NOT NULL THEN
    failed := array_append(failed, ('an admin could not delete a tag a chat''s suggestion names: ' || r)::text);
  END IF;

  -- ---------- 5. ai_hint and the event kind ----------
  r := pg_temp.si_try('authenticated', u_admin, format(
         'UPDATE chat_tags SET ai_hint = %L WHERE id = %L', 'The customer wants to apply', m_new));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin could not write a tag hint: ' || r)::text);
  END IF;
  r := pg_temp.si_do(format('UPDATE chat_tags SET ai_hint = %L WHERE id = %L', repeat('x', 301), m_new));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('a 301-character hint was accepted: ' || r)::text);
  END IF;

  r := pg_temp.si_do(format(
         'INSERT INTO conversation_events (account_id, conversation_id, kind) VALUES (%L, %L, %L), (%L, %L, %L)',
         a_acct, cv_a, 'chat_tag_auto', a_acct, cv_a, 'channel_switched'));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('conversation_events refused chat_tag_auto / channel_switched: ' || r)::text);
  END IF;

  -- The automatic tagging note as auto-tag.ts writes it: the name in
  -- to_label, ids and probability in details.
  r := pg_temp.si_do(format(
         'INSERT INTO conversation_events (account_id, conversation_id, kind, to_label, details) VALUES (%L, %L, %L, %L, %L::jsonb)',
         a_acct, cv_a, 'chat_tag_auto', 'Interested · ADCB',
         jsonb_build_object('chat_tag_id', m_new, 'chat_sub_tag_id', NULL, 'p', 0.92)));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (
       SELECT 1 FROM conversation_events
        WHERE conversation_id = cv_a AND kind = 'chat_tag_auto'
          AND to_label = 'Interested · ADCB'
          AND (details->>'p')::numeric = 0.92
          AND details->>'chat_tag_id' = m_new::text) THEN
    failed := array_append(failed, ('a chat_tag_auto note with details was not stored: ' || r)::text);
  END IF;

  n := n + 1;
  IF has_function_privilege('anon', 'public.dismiss_tag_suggestion(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.conversations_insight_guard()', 'EXECUTE')
     OR has_table_privilege('anon', 'public.ai_insight_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ai_insight_settings', 'DELETE') THEN
    failed := array_append(failed, 'anon / clients hold privileges 147 withholds'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT147', MESSAGE = 'verify-smart-insights rollback';
  EXCEPTION WHEN SQLSTATE 'ZT147' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'smart insights verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'smart insights verification passed (% checks)', n;
END
$verify$;
