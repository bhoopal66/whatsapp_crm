-- Behavioural regression suite for migration 078: partner banks per
-- account and the needs-attention flag.
--
-- Asserts the two columns; the partner_banks CHECK (the envelope: an
-- object with a `codes` array and `custom` absent or an array); that an
-- admin writes partner_banks through the same RLS path as the other
-- switches and an agent cannot; that a person's message clears
-- conversations.ai_attention_at even on an account with no ai_configs
-- row, while bot, customer and sender-less agent messages do not; that
-- 077's pause behaviour is unchanged by the replaced function; that the
-- service role and an agent (existing update policy) may write the
-- flag; and the partial index.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner   UUID := '00000000-0000-4000-8000-000000078001';
  u_admin   UUID := '00000000-0000-4000-8000-000000078002';
  u_agent   UUID := '00000000-0000-4000-8000-000000078003';
  u_owner2  UUID := '00000000-0000-4000-8000-000000078004';
  u_agent2  UUID := '00000000-0000-4000-8000-000000078005';
  a_acct    UUID;   -- has a live AI config
  b_acct    UUID;   -- has no ai_configs row
  ct        UUID;
  cv        UUID;
  cv_b      UUID;
  cv_ho     UUID;
  paused1   TIMESTAMPTZ;
  rec       RECORD;
  r         TEXT;
  n         INT := 0;
  failed    TEXT[] := '{}';
  valid_pb  TEXT := '{"codes": ["MASHREQ", "FAB"], "custom": [{"name": "Some Bank", "aliases": ["SB"]}]}';
BEGIN
  BEGIN
  -- Run a statement as a role (and signed-in user); 'ok' or the error.
  -- auth.uid() reads request.jwt.claim.sub, so both claims are set.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.try_as(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        EXECUTE p_sql;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        RETURN SQLERRM;
      END;
    END $body$
  $fn$;

  -- ---------- columns ----------
  FOR rec IN
    SELECT * FROM (VALUES
      ('ts_account_settings', 'partner_banks', 'jsonb'),
      ('conversations', 'ai_attention_at', 'timestamp with time zone')
    ) AS t(tbl, col, typ)
  LOOP
    n := n + 1;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = rec.tbl
         AND c.column_name = rec.col
         AND c.data_type = rec.typ
         AND c.is_nullable = 'YES'
         AND c.column_default IS NULL
    ) THEN
      failed := array_append(failed,
        format('column %s.%s missing, or wrong type/nullability/default', rec.tbl, rec.col));
    END IF;
  END LOOP;

  -- ---------- the index ----------
  n := n + 1;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'conversations'
       AND indexname = 'idx_conversations_ai_attention'
       AND indexdef LIKE '%(account_id, ai_attention_at DESC)%'
       AND indexdef LIKE '%WHERE (ai_attention_at IS NOT NULL)%'
  ) THEN
    failed := array_append(failed, 'idx_conversations_ai_attention missing or wrong shape'::text);
  END IF;

  -- ---------- the function keeps 077's privileges ----------
  n := n + 1;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.ai_pause_on_agent_reply()'::regprocedure
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public']
  ) THEN
    failed := array_append(failed, 'ai_pause_on_agent_reply lost SECURITY DEFINER or its search_path'::text);
  END IF;

  -- Fixture: account A (owner, admin, agent) with a live AI config;
  -- account B (owner, agent) with no ai_configs row at all.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'pb78-owner@example.invalid'),
    (u_admin,  'pb78-admin@example.invalid'),
    (u_agent,  'pb78-agent@example.invalid'),
    (u_owner2, 'pb78-owner2@example.invalid'),
    (u_agent2, 'pb78-agent2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_owner2;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision two accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  UPDATE profiles SET account_id = b_acct, account_role = 'agent' WHERE user_id = u_agent2;
  INSERT INTO ai_configs (account_id, provider, model, api_key, is_active, auto_reply_enabled)
  VALUES (a_acct, 'openai', 'gpt-x', 'enc', true, true);
  DELETE FROM ai_configs WHERE account_id = b_acct;

  -- ---------- partner_banks: the CHECK ----------
  INSERT INTO ts_account_settings (account_id) VALUES (a_acct);
  FOR rec IN
    SELECT * FROM (VALUES
      ('[]', 'an array'),
      ('{"codes": "x"}', 'codes not an array'),
      ('{}', 'codes missing'),
      ('{"codes": [], "custom": {}}', 'custom not an array'),
      ('{"codes": [], "custom": null}', 'custom JSON null'),
      ('"MASHREQ"', 'a string')
    ) AS t(val, label)
  LOOP
    BEGIN
      UPDATE ts_account_settings SET partner_banks = rec.val::jsonb WHERE account_id = a_acct;
      r := 'ok';
    EXCEPTION WHEN check_violation THEN r := 'rejected';
    END;
    n := n + 1;
    IF r <> 'rejected' THEN
      failed := array_append(failed, format('partner_banks accepted %s: %s', rec.label, rec.val));
    END IF;
  END LOOP;
  FOR rec IN
    SELECT * FROM (VALUES
      (NULL, 'NULL'),
      (valid_pb, 'a full object'),
      ('{"codes": []}', 'codes only')
    ) AS t(val, label)
  LOOP
    BEGIN
      UPDATE ts_account_settings SET partner_banks = rec.val::jsonb WHERE account_id = a_acct;
      r := 'ok';
    EXCEPTION WHEN OTHERS THEN r := SQLERRM;
    END;
    n := n + 1;
    IF r <> 'ok' THEN
      failed := array_append(failed, format('partner_banks refused %s: %s', rec.label, r));
    END IF;
  END LOOP;

  -- ---------- partner_banks: who writes it ----------
  UPDATE ts_account_settings SET partner_banks = NULL WHERE account_id = a_acct;
  n := n + 1;
  r := pg_temp.try_as('authenticated', u_admin, format(
    $q$UPDATE ts_account_settings SET partner_banks = %L::jsonb WHERE account_id = %L$q$,
    valid_pb, a_acct));
  IF r <> 'ok' OR (SELECT partner_banks FROM ts_account_settings WHERE account_id = a_acct)
                  IS DISTINCT FROM valid_pb::jsonb THEN
    failed := array_append(failed, ('admin cannot save partner_banks: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.try_as('authenticated', u_agent, format(
    $q$UPDATE ts_account_settings SET partner_banks = NULL WHERE account_id = %L$q$, a_acct));
  IF (SELECT partner_banks FROM ts_account_settings WHERE account_id = a_acct) IS NULL THEN
    failed := array_append(failed, 'an agent cleared partner_banks'::text);
  END IF;

  -- ---------- the flag on an account with no AI config ----------
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_owner2, '971500078001', 'PB78 no-config contact') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id, ai_attention_at)
  VALUES (b_acct, u_agent2, ct, '2026-01-01 00:00:00+00') RETURNING id INTO cv_b;

  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv_b, 'bot', NULL, 'bot reply');
  n := n + 1;
  IF (SELECT ai_attention_at FROM conversations WHERE id = cv_b) IS NULL THEN
    failed := array_append(failed, 'a bot message cleared ai_attention_at'::text);
  END IF;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv_b, 'customer', NULL, 'customer again');
  n := n + 1;
  IF (SELECT ai_attention_at FROM conversations WHERE id = cv_b) IS NULL THEN
    failed := array_append(failed, 'a customer message cleared ai_attention_at'::text);
  END IF;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv_b, 'agent', NULL, 'API-key send');
  n := n + 1;
  IF (SELECT ai_attention_at FROM conversations WHERE id = cv_b) IS NULL THEN
    failed := array_append(failed, 'an agent message without sender_id cleared ai_attention_at'::text);
  END IF;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv_b, 'agent', u_agent2, 'a person replies');
  SELECT * INTO rec FROM conversations WHERE id = cv_b;
  n := n + 1;
  IF rec.ai_attention_at IS NOT NULL THEN
    failed := array_append(failed, 'an agent reply did not clear ai_attention_at (no ai_configs row)'::text);
  END IF;
  n := n + 1;
  IF rec.ai_autoreply_disabled OR rec.ai_paused_reason IS NOT NULL THEN
    failed := array_append(failed, format('no AI config, yet the reply paused: disabled=%s reason=%s',
      rec.ai_autoreply_disabled, rec.ai_paused_reason));
  END IF;

  -- ---------- who may write the flag ----------
  n := n + 1;
  r := pg_temp.try_as('service_role', NULL, format(
    $q$UPDATE conversations SET ai_attention_at = now() WHERE id = %L$q$, cv_b));
  IF r <> 'ok' OR (SELECT ai_attention_at FROM conversations WHERE id = cv_b) IS NULL THEN
    failed := array_append(failed, ('service role cannot set ai_attention_at: ' || r)::text);
  END IF;
  n := n + 1;
  r := pg_temp.try_as('authenticated', u_agent2, format(
    $q$UPDATE conversations SET ai_attention_at = NULL WHERE id = %L$q$, cv_b));
  IF r <> 'ok' OR (SELECT ai_attention_at FROM conversations WHERE id = cv_b) IS NOT NULL THEN
    failed := array_append(failed, ('an agent cannot clear ai_attention_at on their chat: ' || r)::text);
  END IF;

  -- ---------- 077's pause, unchanged (account A) ----------
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500078002', 'PB78 contact') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, ct) RETURNING id INTO cv;

  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv, 'bot', NULL, 'bot reply');
  n := n + 1;
  IF (SELECT ai_autoreply_disabled FROM conversations WHERE id = cv) THEN
    failed := array_append(failed, 'a bot message paused the bot'::text);
  END IF;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv, 'agent', NULL, 'API-key send');
  n := n + 1;
  IF (SELECT ai_autoreply_disabled FROM conversations WHERE id = cv) THEN
    failed := array_append(failed, 'an agent message without sender_id paused the bot'::text);
  END IF;

  UPDATE ai_configs SET pause_on_agent_reply = false WHERE account_id = a_acct;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv, 'agent', u_agent, 'person, switch off');
  n := n + 1;
  IF (SELECT ai_autoreply_disabled FROM conversations WHERE id = cv) THEN
    failed := array_append(failed, 'paused although pause_on_agent_reply is off'::text);
  END IF;
  UPDATE ai_configs SET pause_on_agent_reply = true WHERE account_id = a_acct;

  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv, 'agent', u_agent, 'person');
  SELECT * INTO rec FROM conversations WHERE id = cv;
  n := n + 1;
  IF NOT rec.ai_autoreply_disabled OR rec.ai_paused_reason IS DISTINCT FROM 'agent_reply'
     OR rec.ai_paused_at IS NULL THEN
    failed := array_append(failed, format('agent reply did not pause: disabled=%s reason=%s at=%s',
      rec.ai_autoreply_disabled, rec.ai_paused_reason, rec.ai_paused_at));
  END IF;

  UPDATE conversations SET ai_paused_at = '2026-01-01 00:00:00+00' WHERE id = cv;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv, 'agent', u_agent, 'person again');
  SELECT ai_paused_at INTO paused1 FROM conversations WHERE id = cv;
  n := n + 1;
  IF paused1 IS NULL OR paused1 <= '2026-01-01 00:00:00+00'::timestamptz THEN
    failed := array_append(failed, ('second agent reply did not refresh ai_paused_at: ' || coalesce(paused1::text, 'NULL'))::text);
  END IF;

  -- A handed-off chat waiting for a person: the reply clears the flag
  -- and leaves the hand-off pause alone.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500078003', 'PB78 handed off') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id, ai_autoreply_disabled,
                             ai_paused_reason, ai_paused_at, ai_attention_at)
  VALUES (a_acct, u_owner, ct, true, 'handoff', '2026-01-01 00:00:00+00',
          '2026-01-01 00:00:00+00') RETURNING id INTO cv_ho;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv_ho, 'agent', u_agent, 'person on a handed-off chat');
  SELECT * INTO rec FROM conversations WHERE id = cv_ho;
  n := n + 1;
  IF rec.ai_paused_reason IS DISTINCT FROM 'handoff'
     OR rec.ai_paused_at IS DISTINCT FROM '2026-01-01 00:00:00+00'::timestamptz
     OR NOT rec.ai_autoreply_disabled THEN
    failed := array_append(failed, format('hand-off pause was touched: reason=%s at=%s',
      rec.ai_paused_reason, rec.ai_paused_at));
  END IF;
  n := n + 1;
  IF rec.ai_attention_at IS NOT NULL THEN
    failed := array_append(failed, 'an agent reply did not clear ai_attention_at on a hand-off'::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT078', MESSAGE = 'verify-partner-banks-attention rollback';
  EXCEPTION WHEN SQLSTATE 'ZT078' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'Partner banks / attention verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'Partner banks / attention verification passed (% checks)', n;
END
$verify$;
