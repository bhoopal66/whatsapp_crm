-- Behavioural regression suite for migration 327 (one daily cap of 3
-- automated messages per person: HR, desk digests and CSAT requests).
--
-- A CSAT request counts; with 3 sent that day (any mix) HR holds
-- ('daily_cap'), the desk cancels ('daily_cap') and CSAT holds until the
-- next Dubai day ('daily_cap'), then goes; under 3 each sends. HR now
-- counts desk digests (the old one-way gap).
--
-- ONE statement on purpose (see verify-desk-reminder-digest.sql). Fixtures
-- are rolled back by a sentinel exception; failures are named in the end.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000327001';
  u_lead  UUID := '00000000-0000-4000-8000-000000327002';
  a_acct  UUID;
  w1      UUID;
  kc      UUID;              -- the companies' contact
  k       UUID[] := '{}';    -- k[1..8]: one person per check
  cv      UUID[] := '{}';
  cu      UUID[] := '{}';    -- desk customers, one digest each today
  ks      UUID[] := '{}';    -- cases, for CSAT rows
  g       UUID;
  today   DATE;
  t10     TIMESTAMPTZ;
  o       UUID;
  q7      UUID;
  q8      UUID;
  d5      UUID;
  d6      UUID;
  n_cu    INT := 0;
  i       INT;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  today := (now() AT TIME ZONE 'Asia/Dubai')::date;
  t10 := (today::timestamp + interval '10 hours') AT TIME ZONE 'Asia/Dubai';
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sdc_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- A statement as a signed-in user: the value / 'ok', or 'ERROR ...'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sdc_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; m text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s: %s', st, m);
      END;
    END $body$
  $fn$;
  -- A digest / CSAT request already sent today.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sdc_desk_sent(p_acct uuid, p_cu uuid, p_ct uuid, p_cv uuid, p_day date, p_at timestamptz)
    RETURNS uuid LANGUAGE sql AS $body$
      INSERT INTO desk_digest_outbox (account_id, customer_id, contact_id, conversation_id, local_day, app_number,
                                      summary, pending, status, claimed_at, sent_at)
      VALUES (p_acct, p_cu, p_ct, p_cv, p_day, 'SDC', 'sdc', 1, 'sent', p_at, p_at) RETURNING id
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sdc_csat_sent(p_acct uuid, p_case uuid, p_trigger text, p_ct uuid, p_cv uuid, p_at timestamptz)
    RETURNS uuid LANGUAGE sql AS $body$
      INSERT INTO case_csat_requests (account_id, case_id, trigger, contact_id, conversation_id, bank_code, stage,
                                      status, attempts, claimed_at, sent_at, handed_to_gateway_at)
      VALUES (p_acct, p_case, p_trigger, p_ct, p_cv, 'RAK', 'Approved', 'sent', 1, p_at, p_at, p_at) RETURNING id
    $body$
  $fn$;
  -- An HR message queued, then claimed: '<claim answer>/<status>:<hold reason>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sdc_hr(p_acct uuid, p_ct uuid, p_cv uuid, p_key text, p_at timestamptz)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v uuid; a text;
    BEGIN
      INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key)
      VALUES (p_acct, p_cv, p_ct, 'stage_hr_interview', 'hr_interview_invite', p_key) RETURNING id INTO v;
      -- Claim, then read the row in a statement of its own: a subquery in
      -- the claim's own expression reads that statement's snapshot, from
      -- before the claim's UPDATE, and would show a held row as queued.
      a := hr_automsg_claim(v, p_at);
      RETURN a || '/'
          || (SELECT x.status || ':' || coalesce(x.hold_reason, '-') FROM hr_automsg_outbox x WHERE x.id = v);
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'sdc327-owner@example.invalid'), (u_lead, 'sdc327-lead@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN RAISE EXCEPTION 'fixture: no account was provisioned'; END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_lead;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971503270000', 'SDC company')
    RETURNING id INTO kc;
  FOR i IN 1..8 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, u_owner, '97150327000' || i, 'SDC person ' || i) RETURNING id INTO o;
    k := k || o;
    INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
    VALUES (a_acct, u_owner, o, u_lead) RETURNING id INTO o;
    cv := cv || o;
    INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key)
    VALUES (o, a_acct, 'recruiter', 'hr_interview');
  END LOOP;
  -- HR: on, no consent needed, the default cap of 3.
  r := pg_temp.sdc_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_lead))
    || pg_temp.sdc_as(u_owner, 'SELECT public.hr_automsg_settings_set(false, NULL, NULL, NULL, false, 3)::text')
    || pg_temp.sdc_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''stage_hr_interview'', true)::text');
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: %', r; END IF;
  -- Desk: an approved utility template, digests on; ten companies.
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'RAK', 'RAKBANK') ON CONFLICT DO NOTHING;
  INSERT INTO message_templates (account_id, user_id, name, category, language, body_text, status) VALUES
    (a_acct, u_owner, 'desk_digest', 'Utility', 'en', 'Application {{1}}: still needed: {{2}}.', 'APPROVED');
  PERFORM desk_bank_code_set(u_owner, a_acct, 'RAK', 'RAK');
  PERFORM desk_digest_settings_set(u_owner, a_acct, true, 'desk_digest', 'en', 10, 2);
  -- One contact acts for ten companies; desk_case_open refuses a second
  -- open lead for the same contact at one bank, so each company applies
  -- at a bank of its own (RAA..RAJ).
  FOR i IN 1..10 LOOP
    INSERT INTO case_banks (account_id, code, name)
    VALUES (a_acct, 'RA' || chr(64 + i), 'SDC bank ' || i) ON CONFLICT DO NOTHING;
    PERFORM desk_bank_code_set(u_owner, a_acct, 'RA' || chr(64 + i), 'RA' || chr(64 + i));
    cu := cu || (SELECT x.customer_id FROM desk_case_open(a_acct, 'SDC327-' || i, 'SDC Trading ' || i,
                                                          'RA' || chr(64 + i),
                                                          'Business account', kc, u_owner, NULL, now()) x);
  END LOOP;
  -- CSAT: on, send hours 9-20; four approved cases.
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'SDC-327-A1', 'x', 'connected', true) RETURNING id INTO w1;
  FOR i IN 1..4 LOOP
    g := (SELECT x.group_id FROM sg_open(a_acct, 'SDC-327-' || i, kc, w1, 'sdc ' || i, NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_lead, 'label', 'agent')), NULL) x);
    o := (SELECT x.case_id FROM case_open(g, 'RAK', NULL, 'Business account', NULL, NULL) x);
    UPDATE cases x SET stage = 'Approved', outcome = 'Approved', closed_at = t10 WHERE x.id = o;
    ks := ks || o;
  END LOOP;
  PERFORM case_csat_settings_set(u_owner, a_acct, true, true, true, 'case_csat_submitted', 'case_csat_approved',
                                 'en', 7, 9, 20, NULL);
  -- Only the rows written below.
  DELETE FROM case_csat_requests x WHERE x.account_id = a_acct;
  DELETE FROM desk_digest_outbox x WHERE x.account_id = a_acct;

  -- ---------- 1. a CSAT request counts ----------
  PERFORM pg_temp.sdc_csat_sent(a_acct, ks[1], 'submitted', k[1], cv[1], t10);
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key)
  VALUES (a_acct, cv[1], k[1], 'stage_hr_interview', 'hr_interview_invite', 'sdc327:1') RETURNING id INTO o;
  n := n + 1; failed := failed || pg_temp.sdc_ok(
    automated_sends_today(a_acct, k[1], t10, 'Asia/Dubai') = 1
    AND (hr_automsg_row_state(o)->>'sent_today')::int = 1,
    'a CSAT request sent today was not counted');
  n := n + 1; failed := failed || pg_temp.sdc_ok(
    automated_sends_today(a_acct, k[1], t10 + interval '1 day', 'Asia/Dubai') = 0,
    'yesterday''s CSAT request was counted today');

  -- ---------- 2. HR: holds at 3 of any mix, sends under 3 ----------
  -- k2: a digest, a CSAT request and an HR message; the 4th is held.
  n_cu := n_cu + 1; PERFORM pg_temp.sdc_desk_sent(a_acct, cu[n_cu], k[2], cv[2], today, t10);
  PERFORM pg_temp.sdc_csat_sent(a_acct, ks[2], 'submitted', k[2], cv[2], t10);
  r := pg_temp.sdc_hr(a_acct, k[2], cv[2], 'sdc327:2a', t10);
  n := n + 1; failed := failed || pg_temp.sdc_ok(r = 'claimed/queued:-', 'HR at 2 of 3 did not send (' || r || ')');
  r := pg_temp.sdc_hr(a_acct, k[2], cv[2], 'sdc327:2b', t10);
  n := n + 1; failed := failed || pg_temp.sdc_ok(r = 'capped/held:daily_cap',
    'HR after a digest, a CSAT request and an HR message that day was not held (' || r || ')');
  -- k3: the old one-way gap: 3 digests and no HR message, HR holds.
  FOR i IN 1..3 LOOP
    n_cu := n_cu + 1; PERFORM pg_temp.sdc_desk_sent(a_acct, cu[n_cu], k[3], cv[3], today, t10);
  END LOOP;
  r := pg_temp.sdc_hr(a_acct, k[3], cv[3], 'sdc327:3', t10);
  n := n + 1; failed := failed || pg_temp.sdc_ok(r = 'capped/held:daily_cap',
    'HR ignored 3 desk digests that day (' || r || ')');
  -- k4: 2 digests: HR sends.
  FOR i IN 1..2 LOOP
    n_cu := n_cu + 1; PERFORM pg_temp.sdc_desk_sent(a_acct, cu[n_cu], k[4], cv[4], today, t10);
  END LOOP;
  r := pg_temp.sdc_hr(a_acct, k[4], cv[4], 'sdc327:4', t10);
  n := n + 1; failed := failed || pg_temp.sdc_ok(r = 'claimed/queued:-', 'HR after 2 digests did not send (' || r || ')');

  -- ---------- 3. desk: cancels at 3 of any mix, sends under 3 ----------
  -- k5: 2 HR messages and a CSAT request; k6: one of each.
  r := pg_temp.sdc_hr(a_acct, k[5], cv[5], 'sdc327:5a', t10) || pg_temp.sdc_hr(a_acct, k[5], cv[5], 'sdc327:5b', t10)
    || pg_temp.sdc_hr(a_acct, k[6], cv[6], 'sdc327:6', t10);
  IF r <> 'claimed/queued:-claimed/queued:-claimed/queued:-' THEN RAISE EXCEPTION 'fixture: HR %', r; END IF;
  PERFORM pg_temp.sdc_csat_sent(a_acct, ks[3], 'submitted', k[5], cv[5], t10);
  PERFORM pg_temp.sdc_csat_sent(a_acct, ks[3], 'approved', k[6], cv[6], t10);
  n_cu := n_cu + 1;
  INSERT INTO desk_digest_outbox (account_id, customer_id, contact_id, conversation_id, local_day, app_number, summary, pending)
  VALUES (a_acct, cu[n_cu], k[5], cv[5], today, 'SDC', 'sdc', 1) RETURNING id INTO d5;
  n_cu := n_cu + 1;
  INSERT INTO desk_digest_outbox (account_id, customer_id, contact_id, conversation_id, local_day, app_number, summary, pending)
  VALUES (a_acct, cu[n_cu], k[6], cv[6], today, 'SDC', 'sdc', 1) RETURNING id INTO d6;

  -- ---------- 4. CSAT: holds at 3 of any mix, sends under 3 ----------
  -- k7: an HR message and 2 digests; k8: 2 HR messages.
  r := pg_temp.sdc_hr(a_acct, k[7], cv[7], 'sdc327:7', t10)
    || pg_temp.sdc_hr(a_acct, k[8], cv[8], 'sdc327:8a', t10) || pg_temp.sdc_hr(a_acct, k[8], cv[8], 'sdc327:8b', t10);
  IF r <> 'claimed/queued:-claimed/queued:-claimed/queued:-' THEN RAISE EXCEPTION 'fixture: HR %', r; END IF;
  FOR i IN 1..2 LOOP
    n_cu := n_cu + 1; PERFORM pg_temp.sdc_desk_sent(a_acct, cu[n_cu], k[7], cv[7], today, t10);
  END LOOP;
  INSERT INTO case_csat_requests (account_id, case_id, trigger, contact_id, conversation_id, bank_code, stage)
  VALUES (a_acct, ks[4], 'approved', k[7], cv[7], 'RAK', 'Approved') RETURNING id INTO q7;
  INSERT INTO case_csat_requests (account_id, case_id, trigger, contact_id, conversation_id, bank_code, stage)
  VALUES (a_acct, ks[4], 'submitted', k[8], cv[8], 'RAK', 'Approved') RETURNING id INTO q8;

  PERFORM desk_digest_claim(t10);
  PERFORM case_csat_claim(t10);
  n := n + 1; failed := failed || pg_temp.sdc_ok(
    (SELECT x.status || ':' || coalesce(x.status_reason, '-') FROM desk_digest_outbox x WHERE x.id = d5)
      = 'cancelled:daily_cap',
    'a digest after 2 HR messages and a CSAT request was not cancelled daily_cap');
  n := n + 1; failed := failed || pg_temp.sdc_ok(
    (SELECT x.status FROM desk_digest_outbox x WHERE x.id = d6) = 'sending',
    'a digest after an HR message and a CSAT request did not send');
  n := n + 1; failed := failed || pg_temp.sdc_ok(
    (SELECT x.status || ':' || coalesce(x.status_reason, '-') || ':'
            || (x.next_attempt_at = ((today + 1)::timestamp AT TIME ZONE 'Asia/Dubai'))::text
       FROM case_csat_requests x WHERE x.id = q7) = 'held:daily_cap:true',
    'a CSAT request after an HR message and 2 digests was not held daily_cap until the next Dubai day');
  n := n + 1; failed := failed || pg_temp.sdc_ok(
    (SELECT x.status FROM case_csat_requests x WHERE x.id = q8) = 'sending',
    'a CSAT request after 2 HR messages did not send');
  -- The CSAT request in flight now counts: k8 is at 3, and HR holds.
  r := pg_temp.sdc_hr(a_acct, k[8], cv[8], 'sdc327:8c', t10);
  n := n + 1; failed := failed || pg_temp.sdc_ok(r = 'capped/held:daily_cap',
    'HR after 2 HR messages and a CSAT request was not held (' || r || ')');
  -- The held request waits out the day, then goes on the next one.
  PERFORM case_csat_claim(t10 + interval '1 hour');
  n := n + 1; failed := failed || pg_temp.sdc_ok(
    (SELECT x.status FROM case_csat_requests x WHERE x.id = q7) = 'held',
    'a CSAT request held for the cap was retried the same day');
  PERFORM case_csat_claim(t10 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.sdc_ok(
    (SELECT x.status || ':' || coalesce(x.status_reason, '-') FROM case_csat_requests x WHERE x.id = q7) = 'sending:-',
    'a CSAT request held for the cap did not go the next day');

  RAISE EXCEPTION USING ERRCODE = 'ZT327', MESSAGE = 'verify-shared-daily-cap rollback';
  EXCEPTION WHEN SQLSTATE 'ZT327' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'shared daily cap verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'shared daily cap verification passed (% checks)', n;
END
$verify$;
