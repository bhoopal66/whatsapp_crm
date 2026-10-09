-- Behavioural regression suite for AI agent v2 (migration 077).
--
-- Asserts the new ai_configs and conversations columns with their
-- defaults and CHECKs, and the trigger that pauses the bot when a
-- person replies: it pauses on an agent message with a sender_id,
-- ignores bot messages and sender-less (API-key) agent messages,
-- refreshes ai_paused_at on a later agent message, never touches a
-- hand-off pause, and does nothing when pause_on_agent_reply is off.
-- Also: ai_reply_events is RLS-protected with an admin read policy,
-- and notifications accept 'ai_handoff'.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000077001';
  u_agent  UUID := '00000000-0000-4000-8000-000000077002';
  a_acct   UUID;
  ct       UUID;
  cv       UUID;
  cv_ho    UUID;
  paused1  TIMESTAMPTZ;
  rec      RECORD;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- ---------- columns and defaults ----------
  FOR rec IN
    SELECT * FROM (VALUES
      ('ai_configs', 'model_small', 'YES', NULL),
      ('ai_configs', 'model_large', 'YES', NULL),
      ('ai_configs', 'model_routing', 'NO', 'true'),
      ('ai_configs', 'pause_on_agent_reply', 'NO', 'true'),
      ('ai_configs', 'auto_resume_minutes', 'YES', NULL),
      ('ai_configs', 'guardrail_retry', 'NO', 'true'),
      ('conversations', 'ai_paused_reason', 'YES', NULL),
      ('conversations', 'ai_paused_at', 'YES', NULL),
      ('conversations', 'ai_pending_draft', 'YES', NULL),
      ('conversations', 'ai_pending_draft_at', 'YES', NULL),
      ('conversations', 'ai_last_outcome', 'YES', NULL),
      ('conversations', 'ai_last_outcome_detail', 'YES', NULL),
      ('conversations', 'ai_last_outcome_at', 'YES', NULL)
    ) AS t(tbl, col, nullable, dflt)
  LOOP
    n := n + 1;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = rec.tbl
         AND c.column_name = rec.col
         AND c.is_nullable = rec.nullable
         AND c.column_default IS NOT DISTINCT FROM rec.dflt
    ) THEN
      failed := array_append(failed,
        format('column %s.%s missing or wrong nullability/default', rec.tbl, rec.col));
    END IF;
  END LOOP;

  -- Fixture: account A (owner, agent), an AI config that is live.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ai2-owner@example.invalid'),
    (u_agent, 'ai2-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO ai_configs (account_id, provider, model, api_key, is_active, auto_reply_enabled)
  VALUES (a_acct, 'openai', 'gpt-x', 'enc', true, true);

  -- ---------- CHECKs ----------
  BEGIN
    UPDATE ai_configs SET auto_resume_minutes = 4 WHERE account_id = a_acct;
    r := 'ok';
  EXCEPTION WHEN check_violation THEN r := 'rejected';
  END;
  n := n + 1;
  IF r <> 'rejected' THEN failed := array_append(failed, 'auto_resume_minutes = 4 accepted'::text); END IF;
  BEGIN
    UPDATE ai_configs SET auto_resume_minutes = 10081 WHERE account_id = a_acct;
    r := 'ok';
  EXCEPTION WHEN check_violation THEN r := 'rejected';
  END;
  n := n + 1;
  IF r <> 'rejected' THEN failed := array_append(failed, 'auto_resume_minutes = 10081 accepted'::text); END IF;
  BEGIN
    UPDATE ai_configs SET auto_resume_minutes = 5 WHERE account_id = a_acct;
    UPDATE ai_configs SET auto_resume_minutes = 10080 WHERE account_id = a_acct;
    UPDATE ai_configs SET auto_resume_minutes = NULL WHERE account_id = a_acct;
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN r := SQLERRM;
  END;
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('auto_resume_minutes 5/10080/NULL refused: ' || r)::text); END IF;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500077001', 'AI2 contact') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_owner, ct) RETURNING id INTO cv;

  BEGIN
    UPDATE conversations SET ai_paused_reason = 'bogus' WHERE id = cv;
    r := 'ok';
  EXCEPTION WHEN check_violation THEN r := 'rejected';
  END;
  n := n + 1;
  IF r <> 'rejected' THEN failed := array_append(failed, 'ai_paused_reason = bogus accepted'::text); END IF;
  BEGIN
    INSERT INTO ai_reply_events (account_id, outcome, tier) VALUES (a_acct, 'replied', 'huge');
    r := 'ok';
  EXCEPTION WHEN check_violation THEN r := 'rejected';
  END;
  n := n + 1;
  IF r <> 'rejected' THEN failed := array_append(failed, 'ai_reply_events.tier = huge accepted'::text); END IF;
  BEGIN
    INSERT INTO ai_reply_events (account_id, outcome, route_source) VALUES (a_acct, 'replied', 'guess');
    r := 'ok';
  EXCEPTION WHEN check_violation THEN r := 'rejected';
  END;
  n := n + 1;
  IF r <> 'rejected' THEN failed := array_append(failed, 'ai_reply_events.route_source = guess accepted'::text); END IF;
  BEGIN
    INSERT INTO ai_reply_events (account_id, conversation_id, outcome, tier, model, route_source)
    VALUES (a_acct, cv, 'replied', 'small', 'gpt-5.4-nano', 'jev');
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN r := SQLERRM;
  END;
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('a valid ai_reply_events row refused: ' || r)::text); END IF;

  -- ---------- the trigger: what does not pause ----------
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

  -- pause_on_agent_reply off: a person's reply leaves the bot running.
  UPDATE ai_configs SET pause_on_agent_reply = false WHERE account_id = a_acct;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv, 'agent', u_agent, 'person, switch off');
  n := n + 1;
  IF (SELECT ai_autoreply_disabled FROM conversations WHERE id = cv) THEN
    failed := array_append(failed, 'paused although pause_on_agent_reply is off'::text);
  END IF;
  UPDATE ai_configs SET pause_on_agent_reply = true WHERE account_id = a_acct;

  -- ---------- the trigger: a person's reply pauses ----------
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv, 'agent', u_agent, 'person');
  SELECT * INTO rec FROM conversations WHERE id = cv;
  n := n + 1;
  IF NOT rec.ai_autoreply_disabled OR rec.ai_paused_reason IS DISTINCT FROM 'agent_reply'
     OR rec.ai_paused_at IS NULL THEN
    failed := array_append(failed, format('agent reply did not pause: disabled=%s reason=%s at=%s',
      rec.ai_autoreply_disabled, rec.ai_paused_reason, rec.ai_paused_at));
  END IF;

  -- A later reply refreshes the pause time.
  UPDATE conversations SET ai_paused_at = '2026-01-01 00:00:00+00' WHERE id = cv;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv, 'agent', u_agent, 'person again');
  SELECT ai_paused_at INTO paused1 FROM conversations WHERE id = cv;
  n := n + 1;
  IF paused1 IS NULL OR paused1 <= '2026-01-01 00:00:00+00'::timestamptz THEN
    failed := array_append(failed, ('second agent reply did not refresh ai_paused_at: ' || coalesce(paused1::text, 'NULL'))::text);
  END IF;

  -- A hand-off pause is left alone.
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971500077002', 'AI2 handed off') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id, ai_autoreply_disabled,
                             ai_paused_reason, ai_paused_at)
  VALUES (a_acct, u_owner, ct, true, 'handoff', '2026-01-01 00:00:00+00') RETURNING id INTO cv_ho;
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
  VALUES (cv_ho, 'agent', u_agent, 'person on a handed-off chat');
  SELECT * INTO rec FROM conversations WHERE id = cv_ho;
  n := n + 1;
  IF rec.ai_paused_reason IS DISTINCT FROM 'handoff'
     OR rec.ai_paused_at IS DISTINCT FROM '2026-01-01 00:00:00+00'::timestamptz THEN
    failed := array_append(failed, format('hand-off pause was touched: reason=%s at=%s',
      rec.ai_paused_reason, rec.ai_paused_at));
  END IF;

  -- ---------- ai_reply_events RLS ----------
  n := n + 1;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_reply_events'::regclass)
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'ai_reply_events'
          AND policyname = 'ai_reply_events_select' AND cmd = 'SELECT')
     OR EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'ai_reply_events'
          AND cmd <> 'SELECT') THEN
    failed := array_append(failed, 'ai_reply_events: RLS off, read policy missing, or a write policy exists'::text);
  END IF;

  -- ---------- notifications ----------
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title, body)
    VALUES (a_acct, u_owner, 'ai_handoff', 'AI handed off', 'test');
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN r := SQLERRM;
  END;
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('notification type ai_handoff refused: ' || r)::text); END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT077', MESSAGE = 'verify-ai-agent-v2 rollback';
  EXCEPTION WHEN SQLSTATE 'ZT077' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'AI agent v2 verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'AI agent v2 verification passed (% checks)', n;
END
$verify$;
