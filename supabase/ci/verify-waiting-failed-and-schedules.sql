-- Behavioural regression suite for migration 321.
--
-- A reply that turns 'failed' after it was saved puts the customer back
-- to waiting, from the oldest customer message after the newest reply
-- that did not fail; a closed, personal or already-waiting chat is left
-- alone; a failure inside the trigger never fails the status write. The
-- time-based run ledger takes one claim per (automation, minute) and is
-- service role only.
--
-- ONE statement on purpose (`supabase db query --file`). Fixtures are
-- rolled back by a sentinel exception; failures are named in the final
-- one. now() is fixed for the whole block.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000321001';
  u_agent UUID := '00000000-0000-4000-8000-000000321002';
  a_acct  UUID;
  ct      UUID;
  ct2     UUID;
  cv      UUID;  -- the main chat
  cv_c    UUID;  -- closed chat
  cv_p    UUID;  -- personal chat
  m_r1    UUID;
  m_r2    UUID;
  m_x     UUID;
  au      UUID;
  v       TEXT;
  ok      BOOLEAN;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wf_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wf_wait(p_conv uuid)
    RETURNS timestamptz LANGUAGE sql AS $body$
      SELECT x.customer_waiting_since FROM public.conversations x WHERE x.id = p_conv
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.wf_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RETURN 'ERROR ' || SQLSTATE;
      END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'wf321-owner@example.invalid'), (u_agent, 'wf321-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '971503210001', 'WF customer') RETURNING id INTO ct;
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '971503210002', 'WF customer 2') RETURNING id INTO ct2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, ct, u_agent) RETURNING id INTO cv;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, ct2, u_agent) RETURNING id INTO cv_c;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, personal_owner_id)
    VALUES (a_acct, u_agent, ct, u_agent, u_agent) RETURNING id INTO cv_p;

  -- ---------- 1. a failed reply restarts the wait ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv, 'customer', 'first', now() - interval '60 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv, 'agent', u_agent, 'reply one', 'sent', now() - interval '50 minutes')
    RETURNING id INTO m_r1;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv, 'customer', 'second', now() - interval '40 minutes');
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv, 'customer', 'third', now() - interval '35 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv, 'agent', u_agent, 'reply two', 'sending', now() - interval '30 minutes')
    RETURNING id INTO m_r2;
  n := n + 1; failed := failed || pg_temp.wf_ok(pg_temp.wf_wait(cv) IS NULL,
    'fixture: the second reply did not end the wait');

  UPDATE messages SET status = 'failed' WHERE id = m_r2;
  n := n + 1; failed := failed || pg_temp.wf_ok(
    pg_temp.wf_wait(cv) = now() - interval '40 minutes',
    'a reply that failed later did not restart the wait from the oldest unanswered customer message');

  -- A second status write on the same failed message changes nothing.
  UPDATE messages SET status = 'failed' WHERE id = m_r2;
  n := n + 1; failed := failed || pg_temp.wf_ok(
    pg_temp.wf_wait(cv) = now() - interval '40 minutes',
    'a repeated failed status moved the wait');

  -- Failing the older reply while already waiting does not move the start.
  UPDATE messages SET status = 'failed' WHERE id = m_r1;
  n := n + 1; failed := failed || pg_temp.wf_ok(
    pg_temp.wf_wait(cv) = now() - interval '40 minutes',
    'a failure on a chat already waiting moved the start of the wait');

  -- Every reply failed: the wait runs from the first customer message.
  UPDATE conversations SET customer_waiting_since = NULL WHERE id = cv;  -- as the service role
  INSERT INTO messages (conversation_id, sender_type, content_text, status, created_at)
    VALUES (cv, 'bot', 'bot answer', 'sent', now() - interval '20 minutes')
    RETURNING id INTO m_x;
  UPDATE messages SET status = 'failed' WHERE id = m_x;
  n := n + 1; failed := failed || pg_temp.wf_ok(
    pg_temp.wf_wait(cv) = now() - interval '60 minutes',
    'with every reply failed, the wait did not start at the first customer message');

  -- A customer message turning failed is not a reply: nothing changes.
  UPDATE conversations SET customer_waiting_since = NULL WHERE id = cv;
  UPDATE messages SET status = 'failed'
   WHERE conversation_id = cv AND sender_type = 'customer' AND content_text = 'third';
  n := n + 1; failed := failed || pg_temp.wf_ok(pg_temp.wf_wait(cv) IS NULL,
    'a customer message turning failed restarted a wait');

  -- ---------- 2. chats that never restart ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_c, 'customer', 'hello', now() - interval '30 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status)
    VALUES (cv_c, 'agent', u_agent, 'bye', 'sent') RETURNING id INTO m_x;
  UPDATE conversations SET status = 'closed' WHERE id = cv_c;
  UPDATE messages SET status = 'failed' WHERE id = m_x;
  n := n + 1; failed := failed || pg_temp.wf_ok(pg_temp.wf_wait(cv_c) IS NULL,
    'a failed reply on a closed chat restarted a wait');

  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_p, 'customer', 'personal', now() - interval '30 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status)
    VALUES (cv_p, 'agent', u_agent, 'personal reply', 'sent') RETURNING id INTO m_x;
  UPDATE messages SET status = 'failed' WHERE id = m_x;
  n := n + 1; failed := failed || pg_temp.wf_ok(pg_temp.wf_wait(cv_p) IS NULL,
    'a failed reply on a personal chat started a wait');

  -- ---------- 3. never fails the status write ----------
  UPDATE conversations SET status = 'open' WHERE id = cv_c;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_c, 'customer', 'again', now() - interval '10 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status)
    VALUES (cv_c, 'agent', u_agent, 'reply', 'sent') RETURNING id INTO m_x;
  EXECUTE $fn$
    CREATE FUNCTION public.wf321_boom() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'wf321 boom';
    END $body$
  $fn$;
  EXECUTE 'CREATE TRIGGER wf321_boom BEFORE UPDATE OF customer_waiting_since ON public.conversations
           FOR EACH ROW EXECUTE FUNCTION public.wf321_boom()';
  BEGIN
    UPDATE messages SET status = 'failed' WHERE id = m_x;
    v := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v := 'ERROR ' || SQLERRM;
  END;
  EXECUTE 'DROP TRIGGER wf321_boom ON public.conversations';
  n := n + 1; failed := failed || pg_temp.wf_ok(v = 'ok',
    'a failure inside the trigger failed the status write: ' || v);
  n := n + 1; failed := failed || pg_temp.wf_ok(
    (SELECT status FROM messages WHERE id = m_x) = 'failed',
    'the failed status was not saved');

  -- ---------- 4. the schedule run ledger ----------
  INSERT INTO automations (account_id, user_id, name, trigger_type, trigger_config, is_active)
    VALUES (a_acct, u_owner, 'wf321 schedule', 'time_based', '{"schedule":"0 9 * * *"}', false)
    RETURNING id INTO au;
  INSERT INTO automation_schedule_runs (automation_id, account_id, slot)
    VALUES (au, a_acct, date_trunc('minute', now()));
  ok := false;
  BEGIN
    INSERT INTO automation_schedule_runs (automation_id, account_id, slot)
      VALUES (au, a_acct, date_trunc('minute', now()));
  EXCEPTION WHEN unique_violation THEN
    ok := true;
  END;
  n := n + 1; failed := failed || pg_temp.wf_ok(ok, 'a schedule slot was claimed twice');
  n := n + 1; failed := failed || pg_temp.wf_ok(
    pg_temp.wf_as(u_owner, 'SELECT count(*)::text FROM public.automation_schedule_runs') LIKE 'ERROR 42501',
    'a signed-in user read the schedule run ledger');
  n := n + 1; failed := failed || pg_temp.wf_ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_schedule_runs'::regclass),
    'RLS is off on automation_schedule_runs');
  DELETE FROM automations WHERE id = au;
  n := n + 1; failed := failed || pg_temp.wf_ok(
    NOT EXISTS (SELECT 1 FROM automation_schedule_runs WHERE automation_id = au),
    'deleting the automation left its schedule runs behind');

  RAISE EXCEPTION USING ERRCODE = 'ZT321', MESSAGE = 'verify-waiting-failed-and-schedules rollback';
  EXCEPTION WHEN SQLSTATE 'ZT321' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'waiting/schedules verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'waiting/schedules verification passed (% checks)', n;
END
$verify$;
