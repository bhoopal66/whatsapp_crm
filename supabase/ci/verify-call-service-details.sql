-- Behavioural regression suite for migration 336 (call service details).
--
-- One outcome per call: a later leg overwrites a non-send outcome, a
-- 'sending' / 'sent' row is final. The 'sending' claim shares the daily
-- cap of 3 with HR / desk / CSAT (an HR message sent today counts, and
-- this ledger counts for them); an opted-out person is never claimable;
-- only an owner or admin sets the settings or the map.
--
-- ONE statement on purpose (see verify-shared-daily-cap.sql). Fixtures
-- are rolled back by a sentinel exception; failures are named in the end.
-- Every row is read back in a statement of its own, after the call that
-- writes it.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000336001';
  u_agent UUID := '00000000-0000-4000-8000-000000336002';
  a_acct  UUID;
  kp      UUID;   -- capped person: one HR message today
  kq      UUID;   -- a person under the cap
  kr      UUID;   -- opted out
  cvp     UUID;
  c       UUID[] := '{}';
  t10     TIMESTAMPTZ;
  o       UUID;
  i       INT;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  t10 := ((now() AT TIME ZONE 'Asia/Dubai')::date::timestamp + interval '10 hours') AT TIME ZONE 'Asia/Dubai';
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.csd_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- A statement as a signed-in user: the value / 'ok', or 'ERROR ...'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.csd_as(p_uid uuid, p_sql text)
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

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cs336-owner@example.invalid'), (u_agent, 'cs336-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN RAISE EXCEPTION 'fixture: no account was provisioned'; END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971503360001', 'CSD P')
    RETURNING id INTO kp;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971503360002', 'CSD Q')
    RETURNING id INTO kq;
  INSERT INTO contacts (account_id, user_id, phone, name, opted_out_at)
  VALUES (a_acct, u_owner, '971503360003', 'CSD R', now()) RETURNING id INTO kr;
  FOR i IN 1..6 LOOP
    INSERT INTO calls (account_id, pbx_call_id, direction, remote_number, extension, status, talk_seconds)
    VALUES (a_acct, 'CS336-' || i, 'inbound', '97150336000' || i, '201', 'answered', 60) RETURNING id INTO o;
    c := c || o;
  END LOOP;
  -- An HR message already sent to P today (the existing automated sender).
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a_acct, u_owner, kp) RETURNING id INTO cvp;
  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key)
  VALUES (cvp, a_acct, 'recruiter', 'hr_interview');
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key,
                                 status, attempts, claimed_at, sent_at)
  VALUES (a_acct, cvp, kp, 'stage_hr_interview', 'hr_interview_invite', 'cs336:hr', 'sent', 1, t10, t10);

  -- ---------- 1. owner/admin only ----------
  r := pg_temp.csd_as(u_agent, format(
    'SELECT public.pbx_service_details_settings_set(%L, true, ''service_details'', ''en'', 20, true, false)::text', a_acct));
  n := n + 1; failed := failed || pg_temp.csd_ok(r LIKE 'ERROR 42501%', 'an agent set the settings (' || r || ')');
  r := pg_temp.csd_as(u_agent, format(
    'SELECT public.pbx_service_map_upsert(%L, ''did'', ''80012'', ''Mortgages'')::text', a_acct));
  n := n + 1; failed := failed || pg_temp.csd_ok(r LIKE 'ERROR 42501%', 'an agent wrote the service map (' || r || ')');
  r := pg_temp.csd_as(u_owner, format(
    'SELECT public.pbx_service_details_settings_set(%L, true, ''service_details'', ''en'', 20, true, false)::text', a_acct))
    || pg_temp.csd_as(u_owner, format(
    'SELECT public.pbx_service_map_upsert(%L, ''did'', ''80012'', ''Mortgages'')::text', a_acct));
  n := n + 1; failed := failed || pg_temp.csd_ok(r NOT LIKE '%ERROR%', 'the owner could not set (' || r || ')');
  r := pg_temp.csd_as(u_agent, 'SELECT count(*)::text FROM public.pbx_service_details_settings');
  n := n + 1; failed := failed || pg_temp.csd_ok(r = '0', 'an agent read the settings (' || r || ')');
  r := pg_temp.csd_as(u_owner, 'SELECT count(*)::text FROM public.pbx_service_details_settings');
  n := n + 1; failed := failed || pg_temp.csd_ok(r = '1', 'the owner could not read the settings (' || r || ')');

  -- ---------- 2. idempotent per call ----------
  r := pbx_service_details_claim(a_acct, c[1], 'too_short', NULL, t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'claimed', 'a first outcome was not claimed (' || r || ')');
  -- A later leg overwrites a non-send outcome.
  r := pbx_service_details_claim(a_acct, c[1], 'sending', kq, t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'claimed', 'a later leg could not overwrite too_short (' || r || ')');
  r := pbx_service_details_claim(a_acct, c[1], 'sending', kq, t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'duplicate', 'a call was claimed for sending twice (' || r || ')');
  r := pbx_service_details_claim(a_acct, c[1], 'too_short', NULL, t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'duplicate', 'a non-send outcome overwrote sending (' || r || ')');
  n := n + 1; failed := failed || pg_temp.csd_ok(
    (SELECT l.outcome FROM pbx_service_details_log l WHERE l.call_id = c[1]) = 'sending',
    'the sending row did not stay final');
  PERFORM pbx_service_details_settle(a_acct, c[1], 'sent', t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(
    (SELECT l.outcome || ':' || (l.sent_at IS NOT NULL)::text FROM pbx_service_details_log l WHERE l.call_id = c[1])
      = 'sent:true',
    'settle did not mark the call sent');
  r := pbx_service_details_claim(a_acct, c[1], 'sending', kq, t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'duplicate', 'a sent call was claimed again (' || r || ')');
  n := n + 1; failed := failed || pg_temp.csd_ok(
    (SELECT count(*) FROM pbx_service_details_log l WHERE l.call_id = c[1]) = 1,
    'a call has more than one ledger row');

  -- ---------- 3. the shared cap of 3 ----------
  -- P: one HR message today; two calls go, the third is capped.
  r := pbx_service_details_claim(a_acct, c[2], 'sending', kp, t10)
    || '/' || pbx_service_details_claim(a_acct, c[3], 'sending', kp, t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'claimed/claimed',
    'P under the cap (an HR message, then 0 and 1 calls) was not claimed (' || r || ')');
  r := pbx_service_details_claim(a_acct, c[4], 'sending', kp, t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'daily_cap',
    'a 4th automated message to P that day was not capped (' || r || ')');
  n := n + 1; failed := failed || pg_temp.csd_ok(
    (SELECT l.outcome FROM pbx_service_details_log l WHERE l.call_id = c[4]) = 'daily_cap',
    'the capped call did not record daily_cap');
  n := n + 1; failed := failed || pg_temp.csd_ok(
    automated_sends_today(a_acct, kp, t10, 'Asia/Dubai') = 3,
    'the shared count does not include this ledger''s sending rows');
  n := n + 1; failed := failed || pg_temp.csd_ok(
    automated_sends_today(a_acct, kp, t10 + interval '1 day', 'Asia/Dubai') = 0,
    'yesterday''s service details were counted today');
  -- The next day the capped call's later leg may send.
  r := pbx_service_details_claim(a_acct, c[4], 'sending', kp, t10 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'claimed', 'a daily_cap outcome stayed final (' || r || ')');

  -- ---------- 4. opted out is never claimable ----------
  r := pbx_service_details_claim(a_acct, c[5], 'sending', kr, t10);
  n := n + 1; failed := failed || pg_temp.csd_ok(r = 'opted_out', 'an opted-out person was claimed (' || r || ')');
  n := n + 1; failed := failed || pg_temp.csd_ok(
    (SELECT l.outcome FROM pbx_service_details_log l WHERE l.call_id = c[5]) = 'opted_out',
    'the opted-out call did not record opted_out');
  n := n + 1; failed := failed || pg_temp.csd_ok(
    automated_sends_today(a_acct, kr, t10, 'Asia/Dubai') = 0,
    'an opted-out refusal was counted');

  RAISE EXCEPTION USING ERRCODE = 'ZT336', MESSAGE = 'verify-call-service-details rollback';
  EXCEPTION WHEN SQLSTATE 'ZT336' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'call service details verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'call service details verification passed (% checks)', n;
END
$verify$;
