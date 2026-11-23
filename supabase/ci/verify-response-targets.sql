-- Behavioural regression suite for response targets (migration 237).
--
-- A customer message starts a waiting episode on a company chat, a reply
-- that did not fail ends it, closing ends it, clients cannot write it,
-- and a failure inside the trigger never fails the message insert.
-- Business minutes skip nights, weekends and Sunday. The sweep rings the
-- assignee at the target, their team leader (else owners and admins) at
-- twice the target, and owners and admins for an unassigned chat, each
-- level once per episode, again after a reply and a new customer
-- message, and nothing while the switch is off. Only owners and admins
-- may change the settings.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.
-- now() is fixed for the whole block, so "waited 20 minutes" is exact.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000237001';
  u_admin UUID := '00000000-0000-4000-8000-000000237002';
  u_lead  UUID := '00000000-0000-4000-8000-000000237003';
  u_g1    UUID := '00000000-0000-4000-8000-000000237004';  -- in the lead's team
  u_g2    UUID := '00000000-0000-4000-8000-000000237005';  -- in no team
  a_acct  UUID;
  t_team  UUID;
  k       UUID[] := '{}';
  ct      UUID;
  cv_a    UUID;  -- G1, 20 min
  cv_b    UUID;  -- G1, 40 min
  cv_c    UUID;  -- G2, 40 min
  cv_d    UUID;  -- unassigned, 20 min
  cv_e    UUID;  -- G1, used while switched off
  cv_p    UUID;  -- G1's personal chat
  cv_t    UUID;  -- trigger checks
  all_day JSONB := '{"mon":[["00:00","24:00"]],"tue":[["00:00","24:00"]],"wed":[["00:00","24:00"]],"thu":[["00:00","24:00"]],"fri":[["00:00","24:00"]],"sat":[["00:00","24:00"]],"sun":[["00:00","24:00"]]}';
  w0      TIMESTAMPTZ;
  v       TEXT;
  i       INT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as a signed-in user: the value / 'ok', or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rt_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                                m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rt_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rt_chk(p_name text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_name || ' (got ' || left(coalesce(p_got, '<null>'), 200) || ')' END
    $body$
  $fn$;
  -- Bells of one type for one chat, to one person (NULL = anyone).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rt_bells(p_conv uuid, p_type text, p_user uuid)
    RETURNS int LANGUAGE sql AS $body$
      SELECT count(*)::int FROM public.notifications x
       WHERE x.conversation_id = p_conv AND x.type = p_type
         AND (p_user IS NULL OR x.user_id = p_user)
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rt_wait(p_conv uuid)
    RETURNS timestamptz LANGUAGE sql AS $body$
      SELECT x.customer_waiting_since FROM public.conversations x WHERE x.id = p_conv
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'rt237-owner@example.invalid'), (u_admin, 'rt237-admin@example.invalid'),
    (u_lead, 'rt237-lead@example.invalid'), (u_g1, 'rt237-g1@example.invalid'),
    (u_g2, 'rt237-g2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_g1, u_g2);
  INSERT INTO teams (account_id, name, leader_user_id)
    VALUES (a_acct, 'rt237 team', u_lead) RETURNING id INTO t_team;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (t_team, u_g1, a_acct);

  FOR i IN 1..7 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '97150237' || lpad(i::text, 4, '0'), 'RT customer ' || i)
    RETURNING id INTO ct;
    k := k || ct;
  END LOOP;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[1], u_g1) RETURNING id INTO cv_a;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[2], u_g1) RETURNING id INTO cv_b;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[3], u_g2) RETURNING id INTO cv_c;
  INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES (a_acct, u_owner, k[4]) RETURNING id INTO cv_d;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[5], u_g1) RETURNING id INTO cv_e;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, personal_owner_id)
    VALUES (a_acct, u_g1, k[5], u_g1, u_g1) RETURNING id INTO cv_p;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, k[6], u_g1) RETURNING id INTO cv_t;

  -- ---------- 1. the trigger ----------
  w0 := now() - interval '50 minutes';
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_t, 'customer', 'hello', w0);
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_wait(cv_t) = w0,
    'a customer message did not start waiting');
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_t, 'customer', 'anyone?', now() - interval '45 minutes');
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_wait(cv_t) = w0,
    'a second customer message moved the start of the wait');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text, status)
    VALUES (cv_t, 'agent', u_g1, 'did not go out', 'failed');
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_wait(cv_t) = w0,
    'a failed reply ended the wait');
  n := n + 1; failed := failed || pg_temp.rt_ok(
    (SELECT public.conversation_waiting_since(x) FROM conversations x WHERE x.id = cv_t) = w0,
    'conversation_waiting_since does not show a waiting company chat');
  -- A client cannot clear it (the guard keeps the stored value).
  v := pg_temp.rt_as(u_g1, format(
    'UPDATE conversations SET customer_waiting_since = NULL WHERE id = %L', cv_t));
  n := n + 1; failed := failed || pg_temp.rt_chk('the assignee''s update errored', v, 'ok');
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_wait(cv_t) = w0,
    'a client cleared customer_waiting_since');
  INSERT INTO messages (conversation_id, sender_type, content_text, status)
    VALUES (cv_t, 'bot', 'automatic answer', 'sent');
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_wait(cv_t) IS NULL,
    'a bot reply did not end the wait');
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_t, 'customer', 'back again', now() - interval '5 minutes');
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
    VALUES (cv_t, 'agent', u_g1, 'on it');
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_wait(cv_t) IS NULL,
    'an agent reply did not end the wait');
  INSERT INTO messages (conversation_id, sender_type, content_text)
    VALUES (cv_t, 'customer', 'thanks, one more thing');
  UPDATE conversations SET status = 'closed' WHERE id = cv_t;
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_wait(cv_t) IS NULL,
    'closing the chat did not end the wait');
  UPDATE conversations SET status = 'open' WHERE id = cv_t;
  -- Personal chats never wait.
  INSERT INTO messages (conversation_id, sender_type, content_text)
    VALUES (cv_p, 'customer', 'personal hello');
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_wait(cv_p) IS NULL,
    'a personal chat started waiting');
  -- A failure inside the trigger never fails the message insert.
  EXECUTE $fn$
    CREATE FUNCTION public.rt237_boom() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'rt237 boom';
    END $body$
  $fn$;
  EXECUTE 'CREATE TRIGGER rt237_boom BEFORE UPDATE OF customer_waiting_since ON public.conversations
           FOR EACH ROW EXECUTE FUNCTION public.rt237_boom()';
  BEGIN
    INSERT INTO messages (conversation_id, sender_type, content_text)
      VALUES (cv_t, 'customer', 'must still land');
    v := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v := 'ERROR ' || SQLERRM;
  END;
  n := n + 1; failed := failed || pg_temp.rt_chk('a trigger failure failed the message insert', v, 'ok');
  n := n + 1; failed := failed || pg_temp.rt_ok(
    EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = cv_t AND x.content_text = 'must still land')
    AND pg_temp.rt_wait(cv_t) IS NULL,
    'the message was lost, or the failed update still applied');
  EXECUTE 'DROP TRIGGER rt237_boom ON public.conversations';
  EXECUTE 'DROP FUNCTION public.rt237_boom()';

  -- ---------- 2. business minutes (default hours, Asia/Dubai = UTC+4) ----------
  -- Fri 2026-11-20 17:30 -> Sat 09:30 local: 30 + 30.
  n := n + 1; failed := failed || pg_temp.rt_ok(public.response_business_minutes(NULL, NULL,
    '2026-11-20 13:30Z', '2026-11-21 05:30Z') = 60, 'Friday evening to Saturday morning is not 60');
  -- Sat 17:00 -> Mon 10:00 local: 60 on Saturday, Sunday off, 60 on Monday.
  n := n + 1; failed := failed || pg_temp.rt_ok(public.response_business_minutes(NULL, NULL,
    '2026-11-21 13:00Z', '2026-11-23 06:00Z') = 120, 'the weekend is not skipped (Sunday off)');
  -- Thu 20:00 -> Fri 08:00 local: all night.
  n := n + 1; failed := failed || pg_temp.rt_ok(public.response_business_minutes(NULL, NULL,
    '2026-11-19 16:00Z', '2026-11-20 04:00Z') = 0, 'night hours counted');
  -- A whole working day.
  n := n + 1; failed := failed || pg_temp.rt_ok(public.response_business_minutes(NULL, NULL,
    '2026-11-19 00:00Z', '2026-11-19 20:00Z') = 540, 'a full day is not 540 minutes');
  n := n + 1; failed := failed || pg_temp.rt_ok(public.response_business_minutes(NULL, NULL,
    '2026-11-20 06:00Z', '2026-11-20 05:00Z') = 0, 'a reversed range is not 0');
  -- Split hours and another zone: Mon 09:00-12:00 and 13:00-17:00 in UTC.
  n := n + 1; failed := failed || pg_temp.rt_ok(public.response_business_minutes(
    '{"mon":[["09:00","12:00"],["13:00","17:00"]]}', 'UTC',
    '2026-11-23 11:00Z', '2026-11-23 14:00Z') = 120, 'split hours or the zone are wrong');
  -- business_minutes_between: no row = defaults; a saved row = its hours.
  n := n + 1; failed := failed || pg_temp.rt_ok(public.business_minutes_between(a_acct,
    '2026-11-21 13:00Z', '2026-11-23 06:00Z') = 120, 'business_minutes_between ignores the defaults');

  -- ---------- 3. the setter ----------
  v := pg_temp.rt_as(u_g1, format(
    'SELECT public.response_settings_set(true, ''Asia/Dubai'', %L::jsonb, 15)::text', all_day));
  n := n + 1; failed := failed || pg_temp.rt_chk('an agent changed response times', v, 'ERROR 42501 not_allowed:%');
  v := pg_temp.rt_as(u_lead, format(
    'SELECT public.response_settings_set(true, ''Asia/Dubai'', %L::jsonb, 15)::text', all_day));
  n := n + 1; failed := failed || pg_temp.rt_chk('a team leader changed response times', v, 'ERROR 42501 not_allowed:%');
  v := pg_temp.rt_as(u_owner,
    'SELECT public.response_settings_set(true, ''Asia/Dubai'', ''{"mon":[["18:00","09:00"]]}''::jsonb, 15)::text');
  n := n + 1; failed := failed || pg_temp.rt_chk('backwards hours were accepted', v, 'ERROR 22023 invalid_hours:%');
  v := pg_temp.rt_as(u_owner,
    'SELECT public.response_settings_set(true, ''Asia/Dubai'', ''{"mon":[["09:00","12:00"],["11:00","14:00"]]}''::jsonb, 15)::text');
  n := n + 1; failed := failed || pg_temp.rt_chk('overlapping hours were accepted', v, 'ERROR 22023 invalid_hours:%');
  v := pg_temp.rt_as(u_owner, format(
    'SELECT public.response_settings_set(true, ''Mars/Base'', %L::jsonb, 15)::text', all_day));
  n := n + 1; failed := failed || pg_temp.rt_chk('an unknown zone was accepted', v, 'ERROR 22023 invalid_timezone:%');
  v := pg_temp.rt_as(u_owner, format(
    'SELECT public.response_settings_set(true, ''Asia/Dubai'', %L::jsonb, 0)::text', all_day));
  n := n + 1; failed := failed || pg_temp.rt_chk('a zero target was accepted', v, 'ERROR 22023 invalid_target:%');
  -- Saved off first: nothing rings while off.
  v := pg_temp.rt_as(u_admin, format(
    'SELECT public.response_settings_set(false, ''Asia/Dubai'', %L::jsonb, 15)::text', all_day));
  n := n + 1; failed := failed || pg_temp.rt_chk('an admin could not save', v, '{%"enabled": false%');
  n := n + 1; failed := failed || pg_temp.rt_chk('a member cannot read the settings',
    pg_temp.rt_as(u_g2, 'SELECT target_minutes::text FROM public.response_settings'), '15');

  -- ---------- 4. the sweep ----------
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at) VALUES
    (cv_a, 'customer', 'a', now() - interval '20 minutes'),
    (cv_b, 'customer', 'b', now() - interval '40 minutes'),
    (cv_c, 'customer', 'c', now() - interval '40 minutes'),
    (cv_d, 'customer', 'd', now() - interval '20 minutes'),
    (cv_e, 'customer', 'e', now() - interval '40 minutes');

  PERFORM public.response_escalation_sweep();
  n := n + 1; failed := failed || pg_temp.rt_ok(
    (SELECT count(*) FROM notifications x WHERE x.conversation_id IN (cv_a, cv_b, cv_c, cv_d, cv_e)
       AND x.type LIKE 'response_%') = 0, 'the switch was off and something rang');

  PERFORM pg_temp.rt_as(u_owner, format(
    'SELECT public.response_settings_set(true, ''Asia/Dubai'', %L::jsonb, 15)::text', all_day));
  -- cv_e waits too, but keep it out of this pass: G1 replies first.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
    VALUES (cv_e, 'agent', u_g1, 'replied');

  n := n + 1;
  IF ((SELECT x.enabled_at IS NOT NULL FROM response_settings x WHERE x.account_id = a_acct)) IS NOT TRUE THEN failed := array_append(failed, '263: switching on did not stamp enabled_at'::text); END IF;
  -- 263: the waits below begin before this transaction, so before enabled_at.
  UPDATE response_settings SET enabled_at = now() - interval '8 days' WHERE account_id = a_acct;
  PERFORM public.response_escalation_sweep();
  -- A: 20 min -> the assignee only.
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_bells(cv_a, 'response_target_missed', u_g1) = 1,
    'the assignee was not rung at the target');
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_bells(cv_a, 'response_escalated', NULL) = 0,
    'escalated before twice the target');
  n := n + 1; failed := failed || pg_temp.rt_ok(
    (SELECT x.contact_id = k[1] FROM notifications x
      WHERE x.conversation_id = cv_a AND x.type = 'response_target_missed' LIMIT 1),
    'the bell does not carry the chat and contact');
  -- B: 40 min, G1 in a team -> G1 and the leader, not the admins.
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_bells(cv_b, 'response_target_missed', u_g1) = 1
    AND pg_temp.rt_bells(cv_b, 'response_escalated', u_lead) = 1
    AND pg_temp.rt_bells(cv_b, 'response_escalated', NULL) = 1,
    'twice the target did not go to the team leader alone');
  -- C: 40 min, G2 in no team -> owner and admin.
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_bells(cv_c, 'response_target_missed', u_g2) = 1
    AND pg_temp.rt_bells(cv_c, 'response_escalated', u_owner) = 1
    AND pg_temp.rt_bells(cv_c, 'response_escalated', u_admin) = 1
    AND pg_temp.rt_bells(cv_c, 'response_escalated', NULL) = 2,
    'no leader: twice the target did not go to the owners and admins');
  -- D: unassigned -> owner and admin.
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_bells(cv_d, 'response_unassigned', u_owner) = 1
    AND pg_temp.rt_bells(cv_d, 'response_unassigned', u_admin) = 1
    AND pg_temp.rt_bells(cv_d, 'response_unassigned', NULL) = 2,
    'an unassigned waiting chat did not ring the owners and admins');
  -- E: replied before the pass.
  n := n + 1; failed := failed || pg_temp.rt_ok(
    (SELECT count(*) FROM notifications x WHERE x.conversation_id = cv_e AND x.type LIKE 'response_%') = 0,
    'a chat that was answered rang');
  -- Personal chat never rings.
  n := n + 1; failed := failed || pg_temp.rt_ok(
    (SELECT count(*) FROM notifications x WHERE x.conversation_id = cv_p AND x.type LIKE 'response_%') = 0,
    'a personal chat rang');

  -- Once per episode.
  PERFORM public.response_escalation_sweep();
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_bells(cv_a, 'response_target_missed', u_g1) = 1
    AND pg_temp.rt_bells(cv_b, 'response_escalated', u_lead) = 1
    AND pg_temp.rt_bells(cv_c, 'response_escalated', NULL) = 2
    AND pg_temp.rt_bells(cv_d, 'response_unassigned', NULL) = 2,
    'a level rang twice in one episode');

  -- Re-armed by a reply and a new customer message.
  INSERT INTO messages (conversation_id, sender_type, sender_id, content_text)
    VALUES (cv_a, 'agent', u_g1, 'sorry for the wait');
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_a, 'customer', 'still need help', now() - interval '17 minutes');
  PERFORM public.response_escalation_sweep();
  n := n + 1; failed := failed || pg_temp.rt_ok(pg_temp.rt_bells(cv_a, 'response_target_missed', u_g1) = 2,
    'a new waiting episode did not ring again');

  -- Switched off: a new wait rings nothing.
  PERFORM pg_temp.rt_as(u_owner, format(
    'SELECT public.response_settings_set(false, ''Asia/Dubai'', %L::jsonb, 15)::text', all_day));
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
    VALUES (cv_e, 'customer', 'hello again', now() - interval '40 minutes');
  PERFORM public.response_escalation_sweep();
  n := n + 1; failed := failed || pg_temp.rt_ok(
    (SELECT count(*) FROM notifications x WHERE x.conversation_id = cv_e AND x.type LIKE 'response_%') = 0,
    'the switch was off and a chat rang');

  -- ---------- 5. types and access ----------
  n := n + 1; failed := failed || pg_temp.rt_ok(
    (SELECT (length(d) - length(replace(d, '''response_target_missed''', ''))) / length('''response_target_missed''') = 1
            AND d LIKE '%''response_escalated''%' AND d LIKE '%''response_unassigned''%'
            AND d LIKE '%''insight_attention''%'
       FROM (SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
              WHERE conname = 'notifications_type_check') x),
    'notifications_type_check lost a type or lists one twice');
  n := n + 1; failed := failed || pg_temp.rt_chk('authenticated read the escalation ledger',
    pg_temp.rt_as(u_owner, 'SELECT count(*)::text FROM public.response_escalations'), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.rt_chk('authenticated ran the sweep',
    pg_temp.rt_as(u_owner, 'SELECT public.response_escalation_sweep()::text'), 'ERROR 42501%');
  n := n + 1; failed := failed || pg_temp.rt_chk('authenticated wrote the settings table directly',
    pg_temp.rt_as(u_owner, format('UPDATE public.response_settings SET target_minutes = 30 WHERE account_id = %L', a_acct)),
    'ERROR 42501%');

  RAISE EXCEPTION USING ERRCODE = 'ZT237', MESSAGE = 'verify-response-targets rollback';
  EXCEPTION WHEN SQLSTATE 'ZT237' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'response targets verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'response targets verification passed (% checks)', n;
END
$verify$;
