-- Behavioural regression suite for case CSAT (migration 246).
--
-- Off by default; owners and admins switch it on, version-checked. A
-- case leaving the pre-submission stages asks once ('submitted'), an
-- approval asks once ('approved'); never for someone opted out or with
-- no company chat. The claim keeps quiet and send hours, one request per
-- person per 24 hours, and turns a lost claim 'unconfirmed'; 'held' is
-- retried an hour later. A 1-5 reply within the window is stored once.
-- Reads follow case_can_read; exported and erased through the 229
-- registry; the tables are closed to every API role.
--
-- ONE statement on purpose: `supabase db query --file` sends the file as
-- a single prepared statement and rejects several. Fixtures are rolled
-- back by a sentinel exception; failures are named in the final one.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000246001';
  u_agent UUID := '00000000-0000-4000-8000-000000246002';
  u_out   UUID := '00000000-0000-4000-8000-000000246003';
  a_acct  UUID;
  w1      UUID;
  c1      UUID;
  c2      UUID;
  c3      UUID;
  cv1     UUID;
  g1      UUID;
  g2      UUID;
  g3      UUID;
  k1      UUID;
  k2      UUID;
  k3      UUID;
  q_sub   UUID;
  q_app   UUID;
  ver     TIMESTAMPTZ;
  today   DATE := (now() AT TIME ZONE 'Asia/Dubai')::date;
  t07     TIMESTAMPTZ;
  t10     TIMESTAMPTZ;
  r       RECORD;
  j       JSONB;
  b       BOOLEAN;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  t07 := (today::timestamp + interval '7 hours') AT TIME ZONE 'Asia/Dubai';
  t10 := (today::timestamp + interval '10 hours') AT TIME ZONE 'Asia/Dubai';
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cx_try(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      EXECUTE p_sql INTO v;
      RETURN coalesce(v, 'ok');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
      RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cx_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cx_as(p_role text, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', p_role);
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
    (u_owner, 'csat246-owner@example.invalid'), (u_agent, 'csat246-agent@example.invalid'),
    (u_out, 'csat246-out@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CSAT-246-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500246001', 'Asha Rao')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at)
  VALUES (a_acct, u_agent, '971500246002', 'CX opted', now()) RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500246003', 'CX no chat')
    RETURNING id INTO c3;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c1) RETURNING id INTO cv1;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_agent, c2);
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'RAK', 'RAKBANK') ON CONFLICT DO NOTHING;
  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CSAT-246-1', c1, w1, 'csat 1', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  g2 := (SELECT x.group_id FROM sg_open(a_acct, 'CSAT-246-2', c2, w1, 'csat 2', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  g3 := (SELECT x.group_id FROM sg_open(a_acct, 'CSAT-246-3', c3, w1, 'csat 3', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);

  -- ---------- 1. off by default; the switch ----------
  k1 := (SELECT x.case_id FROM case_open(g1, 'RAK', NULL, 'Business account', NULL, NULL) x);
  n := n + 1; failed := failed || pg_temp.cx_ok(k1 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM case_csat_requests q
    WHERE q.case_id = k1), 'a rating request was queued while CSAT was off (or no case opened)');
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT s.enabled = false AND s.template_submitted = 'case_csat_submitted' AND s.reply_window_days = 7
            AND s.send_start_hour = 9 AND s.send_end_hour = 20 AND s.updated_at IS NULL
       FROM case_csat_settings_get(u_agent, a_acct) s),
    'the defaults read back wrong');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_try(format(
    'SELECT case_csat_settings_set(%L, %L, true, true, true, ''a'', ''b'', ''en'', 7, 9, 20, NULL)::text',
    u_agent, a_acct)) LIKE 'ERROR % NOT_ALLOWED:%', 'an agent switched CSAT on');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_try(format(
    'SELECT case_csat_settings_set(%L, %L, true, true, true, ''a'', ''b'', ''en'', 7, 20, 20, NULL)::text',
    u_owner, a_acct)) LIKE 'ERROR % INVALID:%', 'send hours that end before they start were accepted');
  ver := case_csat_settings_set(u_owner, a_acct, true, true, true, 'case_csat_submitted', 'case_csat_approved',
                                'en', 7, 9, 20, NULL);
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_try(format(
    'SELECT case_csat_settings_set(%L, %L, true, true, true, ''a'', ''b'', ''en'', 7, 9, 20, NULL)::text',
    u_owner, a_acct)) LIKE 'ERROR % STALE:%', 'a save over a version it did not read was accepted');

  -- ---------- 2. when to ask ----------
  k2 := (SELECT x.case_id FROM case_open(g2, 'RAK', NULL, 'Business account', NULL, NULL) x);
  k3 := (SELECT x.case_id FROM case_open(g3, 'RAK', NULL, 'Business account', NULL, NULL) x);
  INSERT INTO case_stage_history (case_id, account_id, from_stage, to_stage, actor_id, actor_role)
  VALUES (k1, a_acct, 'Review', 'Submitted', NULL, 'api');
  SELECT q.* INTO r FROM case_csat_requests q WHERE q.case_id = k1 AND q.trigger = 'submitted';
  q_sub := r.id;
  n := n + 1; failed := failed || pg_temp.cx_ok(r.status = 'queued' AND r.contact_id = c1 AND r.conversation_id = cv1
    AND r.agent_id = u_agent AND r.bank_code = 'RAK',
    format('a submission did not queue a request to the case contact''s chat (%s)', r.status));
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT q.status_reason FROM case_csat_requests q WHERE q.case_id = k2) = 'opted_out'
    AND (SELECT q.status FROM case_csat_requests q WHERE q.case_id = k2) = 'skipped'
    AND (SELECT q.status_reason FROM case_csat_requests q WHERE q.case_id = k3) = 'no_chat',
    'an opted-out contact or a contact with no chat was not skipped');
  PERFORM case_set_stage(k1, u_owner, 'Under review');
  INSERT INTO case_stage_history (case_id, account_id, from_stage, to_stage, actor_id, actor_role)
  VALUES (k1, a_acct, 'Review', 'Submitted', NULL, 'api');
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT count(*) FROM case_csat_requests q WHERE q.case_id = k1) = 1,
    'a later move or a second submission asked again');
  SELECT x.moved INTO b FROM case_set_stage(k1, u_owner, 'Approved', 'Approved') x;
  SELECT q.id INTO q_app FROM case_csat_requests q WHERE q.case_id = k1 AND q.trigger = 'approved';
  n := n + 1; failed := failed || pg_temp.cx_ok(b AND q_app IS NOT NULL, 'an approval did not queue a request');
  n := n + 1; failed := failed || pg_temp.cx_ok(case_csat_trigger_for('Interested', 'Review', NULL) IS NULL
    AND case_csat_trigger_for(NULL, 'Bank custom', NULL) = 'submitted'
    AND case_csat_trigger_for('Under review', 'Declined', 'Declined') IS NULL
    AND case_csat_trigger_for('Approved', 'Closed', 'Approved') = 'approved', 'case_csat_trigger_for is wrong');

  -- ---------- 3. claim: quiet hours, one a day, held, mark ----------
  n := n + 1; failed := failed || pg_temp.cx_ok((SELECT count(*) FROM case_csat_claim(t07) x) = 0
    AND (SELECT q.status FROM case_csat_requests q WHERE q.id = q_sub) = 'queued',
    'a request was claimed before the send hours');
  SELECT x.* INTO r FROM case_csat_claim(t10) x WHERE x.id = q_sub;
  n := n + 1; failed := failed || pg_temp.cx_ok(r.template_name = 'case_csat_submitted' AND r.contact_name = 'Asha Rao'
    AND r.bank_name = 'RAKBANK' AND r.product = 'Business account' AND r.conversation_id = cv1,
    'the claim did not carry template, name, bank and product');
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT q.status FROM case_csat_requests q WHERE q.id = q_app) = 'queued',
    'a second request went to the same person within 24 hours');
  -- The approval request is parked here so the held one is the only
  -- candidate (a held request has not reached the person).
  UPDATE case_csat_requests q SET status = 'skipped' WHERE q.id = q_app;
  b := case_csat_mark(q_sub, 'held', NULL, NULL, NULL, 'awaiting_template', t10);
  n := n + 1; failed := failed || pg_temp.cx_ok(b
    AND (SELECT q.status = 'held' AND q.next_attempt_at = t10 + interval '1 hour'
           FROM case_csat_requests q WHERE q.id = q_sub), 'held was not recorded with a retry an hour later');
  n := n + 1; failed := failed || pg_temp.cx_ok(
    NOT EXISTS (SELECT 1 FROM case_csat_claim(t10 + interval '10 minutes') x WHERE x.id = q_sub),
    'a held request was retried within the hour');
  -- 263: at a small limit a fresh request goes before a held one. Undone.
  BEGIN
    UPDATE case_csat_requests q SET created_at = t10 - interval '1 hour' WHERE q.id = q_sub;
    UPDATE case_csat_requests q SET status = 'queued', created_at = t10 WHERE q.id = q_app;
    SELECT x.* INTO r FROM case_csat_claim(t10 + interval '61 minutes', 1) x;
    n := n + 1; failed := failed || pg_temp.cx_ok(r.id = q_app,
      '263: a held request took the place of a fresh one');
    RAISE EXCEPTION USING ERRCODE = 'ZX263', MESSAGE = 'undo';
  EXCEPTION WHEN SQLSTATE 'ZX263' THEN
    NULL;
  END;
  n := n + 1; failed := failed || pg_temp.cx_ok(
    EXISTS (SELECT 1 FROM case_csat_claim(t10 + interval '61 minutes') x WHERE x.id = q_sub),
    'a held request was not retried after the hour');
  b := case_csat_mark(q_sub, 'sent', 'text', 'wamid.246', NULL, NULL, t10 + interval '61 minutes');
  n := n + 1; failed := failed || pg_temp.cx_ok(b
    AND NOT case_csat_mark(q_sub, 'failed', NULL, NULL, NULL, 'late', t10),
    'a claimed request was not marked sent exactly once');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_try(format(
    'SELECT case_csat_mark(%L, ''sent'', NULL, NULL, NULL, NULL)::text', q_app)) LIKE 'ERROR % INVALID:%',
    'sent without a channel kind was accepted');

  -- ---------- 4. the reply ----------
  b := case_csat_capture(a_acct, c1, NULL, 5, '  great  ', t10 + interval '2 hours');
  n := n + 1; failed := failed || pg_temp.cx_ok(b, 'a reply to a sent request was not stored');
  SELECT x.* INTO r FROM case_csat_responses x WHERE x.request_id = q_sub;
  n := n + 1; failed := failed || pg_temp.cx_ok(r.score = 5 AND r.comment = 'great' AND r.trigger = 'submitted'
    AND r.agent_id = u_agent AND r.bank_code = 'RAK'
    AND (SELECT q.answered_at IS NOT NULL FROM case_csat_requests q WHERE q.id = q_sub),
    'the stored rating is wrong');
  n := n + 1; failed := failed || pg_temp.cx_ok(NOT case_csat_capture(a_acct, c1, NULL, 1, NULL, t10 + interval '3 hours'),
    'a request was answered twice');
  n := n + 1; failed := failed || pg_temp.cx_ok(NOT case_csat_capture(a_acct, c1, NULL, 9, NULL, t10 + interval '3 hours'),
    'a score outside 1-5 was stored');
  UPDATE case_csat_requests q SET status = 'sent', claimed_at = t10 - interval '9 days', sent_at = t10 - interval '8 days'
   WHERE q.id = q_app;
  n := n + 1; failed := failed || pg_temp.cx_ok(NOT case_csat_capture(a_acct, c1, NULL, 4, NULL, t10),
    'a reply after the 7-day window was stored');

  -- ---------- 5. lost claims, expiry ----------
  UPDATE case_csat_requests q SET status = 'sending', claimed_at = t10 - interval '1 hour', created_at = t10,
         sent_at = NULL WHERE q.id = q_app;
  PERFORM case_csat_claim(t10);
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT q.status FROM case_csat_requests q WHERE q.id = q_app) = 'unconfirmed',
    'a lost claim did not become unconfirmed');
  UPDATE case_csat_requests q SET status = 'queued', created_at = t10 - interval '4 days' WHERE q.id = q_app;
  PERFORM case_csat_claim(t10);
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT q.status || '/' || q.status_reason FROM case_csat_requests q WHERE q.id = q_app) = 'cancelled/expired',
    'a request not sent in 3 days did not expire');

  -- ---------- 6. reads ----------
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT count(*) FROM case_csat_for_case(u_agent, k1) x WHERE x.score = 5) = 1,
    'the case''s agent did not read its rating');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_try(format(
    'SELECT count(*)::text FROM case_csat_for_case(%L, %L)', u_out, k1)) LIKE 'ERROR % NOT_ALLOWED:%',
    'someone outside the workspace read a case''s ratings');
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT count(*) FROM case_csat_scores(u_owner, a_acct, t10 - interval '1 day') x
      WHERE x.bank_name = 'RAKBANK' AND x.agent_id = u_agent AND x.score = 5) = 1,
    'the owner''s scores are missing the rating');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_try(format(
    'SELECT count(*)::text FROM case_csat_scores(%L, %L, NULL)', u_out, a_acct)) LIKE 'ERROR % NOT_ALLOWED:%',
    'someone outside the workspace read the scores');

  -- ---------- 7. switching off ----------
  UPDATE case_csat_requests q SET status = 'queued', status_reason = NULL, created_at = t10 WHERE q.id = q_app;
  ver := (SELECT s.updated_at FROM case_csat_settings_get(u_owner, a_acct) s);
  PERFORM case_csat_settings_set(u_owner, a_acct, true, true, false, 'case_csat_submitted', 'case_csat_approved',
                                 'ar', 7, 9, 20, ver);
  n := n + 1; failed := failed || pg_temp.cx_ok(
    (SELECT q.status || '/' || q.status_reason FROM case_csat_requests q WHERE q.id = q_app) = 'cancelled/switched_off',
    'switching approvals off left an approval request queued');

  -- ---------- 8. privacy and closed tables ----------
  j := privacy_subject_export(u_owner, a_acct, c1);
  n := n + 1; failed := failed || pg_temp.cx_ok(jsonb_array_length(j->'data'->'case_csat'->'ratings') = 1,
    'the export did not carry the person''s rating');
  j := privacy_case_csat_erase(a_acct, c1);
  n := n + 1; failed := failed || pg_temp.cx_ok((j->'counts'->>'case_csat_responses')::int = 1
    AND NOT EXISTS (SELECT 1 FROM case_csat_requests q WHERE q.contact_id = c1),
    'the erase did not remove the person''s requests and rating');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_as('authenticated',
    'SELECT count(*)::text FROM public.case_csat_responses') LIKE 'ERROR 42501', 'authenticated read case_csat_responses');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_as('service_role',
    'SELECT count(*)::text FROM public.case_csat_requests') LIKE 'ERROR 42501', 'service_role read case_csat_requests');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_as('authenticated',
    'SELECT count(*)::text FROM case_csat_claim()') LIKE 'ERROR 42501', 'authenticated called case_csat_claim');
  n := n + 1; failed := failed || pg_temp.cx_ok(pg_temp.cx_as('service_role',
    'SELECT count(*)::text FROM case_csat_claim(now() - interval ''1 day'')') NOT LIKE 'ERROR%',
    'service_role could not call case_csat_claim');

  RAISE EXCEPTION USING ERRCODE = 'ZT246', MESSAGE = 'verify-case-csat rollback';
  EXCEPTION WHEN SQLSTATE 'ZT246' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case CSAT verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case CSAT verification passed (% checks)', n;
END
$verify$;
