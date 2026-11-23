-- Behavioural regression suite for migration 281 (case CSAT fixes).
--
-- 1. The claim cancels ('case_changed') an approved request whose case is
--    no longer approved, and a submitted one whose case is back before
--    submission or closed as anything but approved, queued or held.
-- 2. A reply is captured only in the request's chat, and only when nothing
--    else was said to the customer since or when it quotes the request.
-- 3. A lost claim never handed over goes back to the queue; one handed
--    over is unconfirmed, and a reply to it is captured; the handoff and
--    the mark act only for their own claim.
--
-- ONE statement on purpose (see verify-case-csat.sql). Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000281001';
  u_agent UUID := '00000000-0000-4000-8000-000000281002';
  a_acct  UUID;
  w1      UUID;
  c1      UUID;
  cv1     UUID;
  cv2     UUID;
  g1      UUID;
  k1      UUID;
  q1      UUID;
  m_req   UUID;
  m_oth   UUID;
  t10     TIMESTAMPTZ;
  r       RECORD;
  b       BOOLEAN;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  t10 := (((now() AT TIME ZONE 'Asia/Dubai')::date)::timestamp + interval '10 hours') AT TIME ZONE 'Asia/Dubai';
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- The claim's answer for the one request, put back to the queue first.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_claim(p_q uuid, p_trigger text, p_status text, p_at timestamptz)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      UPDATE case_csat_requests q SET trigger = p_trigger, status = p_status, status_reason = NULL, created_at = p_at,
             claimed_at = NULL, sent_at = NULL, handed_to_gateway_at = NULL,
             next_attempt_at = CASE WHEN p_status = 'held' THEN p_at END WHERE q.id = p_q;
      PERFORM case_csat_claim(p_at);
      RETURN (SELECT q.status || coalesce('/' || q.status_reason, '') FROM case_csat_requests q WHERE q.id = p_q);
    END $body$
  $fn$;
  -- A sent request, nothing else said: the starting point of section 2.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cf_sent(p_q uuid, p_msg uuid, p_at timestamptz)
    RETURNS void LANGUAGE sql AS $body$
      DELETE FROM case_csat_responses x WHERE x.request_id = p_q;
      UPDATE case_csat_requests q SET status = 'sent', claimed_at = p_at, sent_at = p_at, handed_to_gateway_at = p_at,
             provider_message_id = 'wamid.281', message_id = p_msg, answered_at = NULL WHERE q.id = p_q;
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'csat281-owner@example.invalid'), (u_agent, 'csat281-agent@example.invalid') ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CSAT-281-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500281001', 'Asha Rao')
    RETURNING id INTO c1;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c1) RETURNING id INTO cv1;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'RAK', 'RAKBANK') ON CONFLICT DO NOTHING;
  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CSAT-281-1', c1, w1, 'csat 1', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g1, 'RAK', NULL, 'Business account', NULL, NULL) x);
  PERFORM case_csat_settings_set(u_owner, a_acct, true, true, true, 'case_csat_submitted', 'case_csat_approved',
                                 'en', 7, 9, 20, NULL);
  INSERT INTO case_csat_requests (account_id, case_id, trigger, contact_id, conversation_id, agent_id, bank_code, stage)
  VALUES (a_acct, k1, 'approved', c1, cv1, u_agent, 'RAK', 'Approved') RETURNING id INTO q1;

  -- ---------- 1. the case is read again ----------
  FOR r IN SELECT * FROM (VALUES
      ('approved',  'queued', 'Under review', NULL,        'cancelled/case_changed'),
      ('approved',  'held',   'Under review', NULL,        'cancelled/case_changed'),
      ('approved',  'queued', 'Declined',     'Declined',  'cancelled/case_changed'),
      ('approved',  'queued', 'Approved',     'Approved',  'sending'),
      ('approved',  'held',   'Closed',       'Approved',  'sending'),
      ('submitted', 'queued', 'Review',       NULL,        'cancelled/case_changed'),
      ('submitted', 'held',   'Interested',   NULL,        'cancelled/case_changed'),
      ('submitted', 'queued', 'Withdrawn',    'Withdrawn', 'cancelled/case_changed'),
      ('submitted', 'queued', 'Closed',       'Declined',  'cancelled/case_changed'),
      ('submitted', 'queued', 'Closed',       'Approved',  'sending'),
      ('submitted', 'queued', 'Under review', NULL,        'sending')) v(tr, st, stage, outcome, want) LOOP
    UPDATE cases k SET stage = r.stage, outcome = r.outcome,
           group_id = CASE WHEN case_stage_is_presub(r.stage) THEN NULL ELSE g1 END,
           closed_at = CASE WHEN r.stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN t10 END WHERE k.id = k1;
    n := n + 1; failed := failed || pg_temp.cf_ok(pg_temp.cf_claim(q1, r.tr, r.st, t10) = r.want,
      format('a %s %s request on a case at %s (%s) was not %s', r.st, r.tr, r.stage, coalesce(r.outcome, '-'), r.want));
  END LOOP;

  -- ---------- 3. a lost claim, the handoff, the mark ----------
  -- The case is under review and q1 'sending', claimed at t10.
  b := case_csat_handoff(q1, t10 + interval '1 minute');
  n := n + 1; failed := failed || pg_temp.cf_ok(NOT b
    AND (SELECT q.handed_to_gateway_at IS NULL FROM case_csat_requests q WHERE q.id = q1),
    'another claim''s handoff was accepted');
  PERFORM case_csat_claim(t10 + interval '11 minutes', 1);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT q.status = 'sending' AND q.claimed_at = t10 + interval '11 minutes' FROM case_csat_requests q WHERE q.id = q1),
    'a claim that never reached the gateway was not queued and claimed again');
  n := n + 1; failed := failed || pg_temp.cf_ok(NOT case_csat_handoff(q1, t10)
    AND NOT case_csat_mark(q1, 'held', NULL, NULL, NULL, 'x', t10, t10), 'the lost claim still acted on the row');
  b := case_csat_handoff(q1, t10 + interval '11 minutes');
  n := n + 1; failed := failed || pg_temp.cf_ok(b
    AND case_csat_handoff(q1, t10 + interval '11 minutes')
    AND (SELECT q.handed_to_gateway_at IS NOT NULL FROM case_csat_requests q WHERE q.id = q1),
    'the handoff was not stamped, or a repeat was refused');
  PERFORM case_csat_claim(t10 + interval '25 minutes');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    (SELECT q.status FROM case_csat_requests q WHERE q.id = q1) = 'unconfirmed',
    'a lost claim handed to the gateway was not left unconfirmed');
  PERFORM pg_temp.cf_claim(q1, 'submitted', 'queued', t10);
  PERFORM case_csat_handoff(q1, t10);
  b := case_csat_mark(q1, 'held', NULL, NULL, NULL, 'lookup_failed', t10, t10);
  n := n + 1; failed := failed || pg_temp.cf_ok(b
    AND (SELECT q.status = 'held' AND q.handed_to_gateway_at IS NULL FROM case_csat_requests q WHERE q.id = q1),
    'held did not take the stamp back');
  INSERT INTO messages (conversation_id, sender_type, content_text, message_id, status, created_at)
  VALUES (cv1, 'bot', 'rate us 1 to 5', 'wamid.281', 'sent', t10 + interval '1 second') RETURNING id INTO m_req;
  PERFORM pg_temp.cf_claim(q1, 'submitted', 'queued', t10);
  PERFORM case_csat_handoff(q1, t10, t10);
  b := case_csat_mark(q1, 'unconfirmed', 'text', NULL, m_req, 'whapierror', t10, t10 + interval '1 minute');
  n := n + 1; failed := failed || pg_temp.cf_ok(b
    AND (SELECT q.status = 'unconfirmed' AND q.message_id = m_req AND q.sent_at IS NULL FROM case_csat_requests q
          WHERE q.id = q1), 'a timeout was not recorded as unconfirmed with its message');
  -- The number's own echo of it is not "something else said".
  INSERT INTO messages (conversation_id, sender_type, content_text, message_id, status, created_at)
  VALUES (cv1, 'agent', 'rate us 1 to 5', 'echo.281', 'sent', t10 + interval '2 seconds') RETURNING id INTO m_oth;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    case_csat_capture(a_acct, c1, cv1, NULL, NULL, 4, NULL, t10 + interval '1 hour'),
    'a reply to an unconfirmed request was not stored');
  DELETE FROM messages m WHERE m.id = m_oth;

  -- ---------- 2. what is a rating ----------
  INSERT INTO conversations (account_id, user_id, contact_id, personal_owner_id)
  VALUES (a_acct, u_agent, c1, u_agent) RETURNING id INTO cv2;
  PERFORM pg_temp.cf_sent(q1, m_req, t10);
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT case_csat_capture(a_acct, c1, cv2, NULL, NULL, 3, NULL, t10 + interval '1 hour'),
    'a digit in another chat was taken as a rating');
  b := case_csat_capture(a_acct, c1, cv1, NULL, NULL, 3, 'please call me', t10 + interval '1 hour');
  n := n + 1; failed := failed || pg_temp.cf_ok(b
    AND EXISTS (SELECT 1 FROM case_csat_responses x WHERE x.request_id = q1 AND x.score = 3 AND x.comment = 'please call me'),
    'a reply to the request, nothing said since, was not stored');
  PERFORM pg_temp.cf_sent(q1, m_req, t10);
  INSERT INTO messages (conversation_id, sender_type, content_text, message_id, status, created_at)
  VALUES (cv1, 'agent', 'How many shareholders?', 'wamid.281b', 'sent', t10 + interval '10 minutes') RETURNING id INTO m_oth;
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT case_csat_capture(a_acct, c1, cv1, NULL, NULL, 3, NULL, t10 + interval '1 hour'),
    'the answer to a staff question was taken as a rating');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    NOT case_csat_capture(a_acct, c1, cv1, NULL, m_oth, 3, NULL, t10 + interval '1 hour'),
    'a reply quoting another message was taken as a rating');
  n := n + 1; failed := failed || pg_temp.cf_ok(
    case_csat_capture(a_acct, c1, cv1, NULL, m_req, 3, NULL, t10 + interval '1 hour'),
    'a reply quoting the request was not stored');

  n := n + 1; failed := failed || pg_temp.cf_ok(
    has_function_privilege('service_role', 'case_csat_handoff(uuid, timestamptz, timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'case_csat_handoff(uuid, timestamptz, timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'case_csat_capture(uuid, uuid, uuid, uuid, uuid, integer, text, timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated',
      'case_csat_mark(uuid, text, text, text, uuid, text, timestamptz, timestamptz)', 'EXECUTE'),
    'the 281 functions are not service_role only');

  RAISE EXCEPTION USING ERRCODE = 'ZT281', MESSAGE = 'verify-csat-fixes rollback';
  EXCEPTION WHEN SQLSTATE 'ZT281' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'CSAT fixes verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'CSAT fixes verification passed (% checks)', n;
END
$verify$;
