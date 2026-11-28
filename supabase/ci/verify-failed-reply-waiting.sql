-- Behavioural regression suite for migration 326: a reply that later
-- fails restarts the customer's wait from their original unanswered
-- message; a delivered reply stays an answer; a failure of an older
-- reply after a newer good one restarts nothing; a failure corrected by
-- a delivery ends the wait again; closed and personal chats never
-- restart; a failure inside the trigger never fails the status update.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.
-- now() is fixed for the whole block, so the times below are exact.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000326001';
  a_acct  UUID;
  k       UUID[] := '{}';
  ct      UUID;
  cv      UUID[] := '{}';
  c1      UUID;
  r1      UUID;
  r2      UUID;
  w0      TIMESTAMPTZ;
  v       TEXT;
  i       INT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fr_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fr_wait(p_conv uuid)
    RETURNS timestamptz LANGUAGE sql AS $body$
      SELECT x.customer_waiting_since FROM public.conversations x WHERE x.id = p_conv
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES (u_owner, 'fr326-owner@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  FOR i IN 1..7 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '97150326' || lpad(i::text, 4, '0'), 'FR customer ' || i)
    RETURNING id INTO ct;
    k := k || ct;
    IF i = 6 THEN
      INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id)
        VALUES (a_acct, u_owner, ct, u_owner) RETURNING id INTO c1;
    ELSE
      INSERT INTO conversations (account_id, user_id, contact_id)
        VALUES (a_acct, u_owner, ct) RETURNING id INTO c1;
    END IF;
    cv := cv || c1;
  END LOOP;
  w0 := now() - interval '50 minutes';

  -- ---------- 1. a reply then 'failed': waiting again from w0 ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[1], 'customer', 'hello', w0);
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[1], 'customer', 'anyone?', now() - interval '45 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv[1], 'agent', u_owner, 'on it', 'sent', now() - interval '40 minutes')
    RETURNING id INTO r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[1]) IS NULL,
    'fixture: the reply did not end the wait');
  UPDATE messages SET status = 'failed' WHERE id = r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[1]) = w0,
    'a reply that failed did not restart the wait from the first unanswered message');
  n := n + 1; failed := failed || pg_temp.fr_ok(
    (SELECT public.conversation_waiting_since(x) FROM conversations x WHERE x.id = cv[1]) = w0,
    'conversation_waiting_since does not show the restarted wait');
  -- 291's correction: a delivery after the failure ends it again.
  UPDATE messages SET status = 'delivered' WHERE id = r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[1]) IS NULL,
    'a failure corrected by a delivery left the customer waiting');

  -- ---------- 2. a delivered reply is still an answer ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[2], 'customer', 'hello', w0);
  INSERT INTO messages (conversation_id, sender_type, content_text, status, created_at)
    VALUES (cv[2], 'bot', 'automatic answer', 'sending', now() - interval '40 minutes')
    RETURNING id INTO r1;
  UPDATE messages SET status = 'sent' WHERE id = r1;
  UPDATE messages SET status = 'delivered' WHERE id = r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[2]) IS NULL,
    'a delivered reply left the customer waiting');

  -- ---------- 3. an older reply fails after a newer good one ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[3], 'customer', 'hello', w0);
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv[3], 'agent', u_owner, 'first', 'sent', now() - interval '40 minutes')
    RETURNING id INTO r1;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[3], 'customer', 'and?', now() - interval '30 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv[3], 'agent', u_owner, 'second', 'sent', now() - interval '20 minutes')
    RETURNING id INTO r2;
  UPDATE messages SET status = 'failed' WHERE id = r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[3]) IS NULL,
    'an older failed reply restarted a wait a newer reply had answered');
  -- ... and the newer one failing too brings back the wait it ended.
  UPDATE messages SET status = 'failed' WHERE id = r2;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[3]) = w0,
    'with both replies failed the wait did not start at the first unanswered message');

  -- ---------- 4. a customer wrote again after the reply ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[4], 'customer', 'hello', w0);
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv[4], 'agent', u_owner, 'on it', 'sent', now() - interval '40 minutes')
    RETURNING id INTO r1;
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[4], 'customer', 'still there?', now() - interval '30 minutes');
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[4]) = now() - interval '30 minutes',
    'fixture: the second customer message did not start a wait');
  UPDATE messages SET status = 'failed' WHERE id = r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[4]) = w0,
    'a failed reply did not move the wait back to the message it had answered');
  -- Corrected: the wait is the one the second message started.
  UPDATE messages SET status = 'read' WHERE id = r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[4]) = now() - interval '30 minutes',
    'a corrected reply did not hand the wait back to the later customer message');

  -- ---------- 5. a closed chat does not restart ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[5], 'customer', 'hello', w0);
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv[5], 'agent', u_owner, 'bye', 'sent', now() - interval '40 minutes')
    RETURNING id INTO r1;
  UPDATE conversations SET status = 'closed' WHERE id = cv[5];
  UPDATE messages SET status = 'failed' WHERE id = r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[5]) IS NULL,
    'a failed reply restarted the wait on a closed chat');

  -- ---------- 6. a personal chat never waits ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[6], 'customer', 'hello', w0);
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv[6], 'agent', u_owner, 'hi', 'sent', now() - interval '40 minutes')
    RETURNING id INTO r1;
  UPDATE messages SET status = 'failed' WHERE id = r1;
  n := n + 1; failed := failed || pg_temp.fr_ok(pg_temp.fr_wait(cv[6]) IS NULL,
    'a failed reply started a wait on a personal chat');

  -- ---------- 7. a trigger failure never fails the status update ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv[7], 'customer', 'hello', w0);
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status, created_at)
    VALUES (cv[7], 'agent', u_owner, 'hi', 'sent', now() - interval '40 minutes')
    RETURNING id INTO r1;
  EXECUTE $fn$
    CREATE FUNCTION public.fr326_boom() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'fr326 boom';
    END $body$
  $fn$;
  EXECUTE 'CREATE TRIGGER fr326_boom BEFORE UPDATE OF customer_waiting_since ON public.conversations
           FOR EACH ROW EXECUTE FUNCTION public.fr326_boom()';
  BEGIN
    UPDATE messages SET status = 'failed' WHERE id = r1;
    v := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v := 'ERROR ' || SQLERRM;
  END;
  n := n + 1; failed := failed || pg_temp.fr_ok(v = 'ok',
    'a trigger failure failed the status update (' || v || ')');
  n := n + 1; failed := failed || pg_temp.fr_ok(
    (SELECT m.status FROM messages m WHERE m.id = r1) = 'failed',
    'the status update did not land');
  EXECUTE 'DROP TRIGGER fr326_boom ON public.conversations';

  RAISE EXCEPTION USING ERRCODE = 'ZT326', MESSAGE = 'verify-failed-reply-waiting rollback';
  EXCEPTION WHEN SQLSTATE 'ZT326' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'failed reply waiting verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'failed reply waiting verification passed (% checks)', n;
END
$verify$;
