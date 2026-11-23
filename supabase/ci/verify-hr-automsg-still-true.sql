-- Behavioural regression suite for migration 275.
--
-- A queued HR message goes out only while its reason holds: a stage
-- invite while the chat is in that stage, a nudge while the same silence
-- lasts. Otherwise row_state names the reason and the claim cancels the
-- row with it in last_error, so a chat that moves back releases nothing.
-- ONE statement on purpose, rolled back on success (see
-- verify-hr-automsg-rcs.sql).

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000275001';  -- owner of A
  u_lead  UUID := '00000000-0000-4000-8000-000000275002';  -- recruiter lead
  a_acct  UUID;
  k1 UUID; k2 UUID;  -- contacts
  v1 UUID; v2 UUID;  -- conversations
  o1 UUID; o2 UUID;  -- outbox rows
  r       TEXT;
  c       TEXT[] := '{}';  -- one element per check: NULL = passed
  failed  TEXT[];
  n       INT := 0;
BEGIN
  BEGIN
  -- Run a statement as a signed-in user (p_uid) or, with p_uid NULL, as
  -- the service role with no user: the value / 'ok', or
  -- 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      BEGIN
        IF p_uid IS NULL THEN
          PERFORM set_config('request.jwt.claim.sub', '', true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('role', 'service_role')::text, true);
          SET LOCAL ROLE service_role;
        ELSE
          PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
          SET LOCAL ROLE authenticated;
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');  -- a void RPC casts to ''
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

  -- NULL when `got` matches the LIKE pattern, else the named failure.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_chk(p_label text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_label || ' (got ' || left(coalesce(p_got, '<null>'), 200) || ')' END
    $body$
  $fn$;

  -- ---------- Fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'm275-owner@example.invalid'),
    (u_lead,  'm275-lead@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_lead;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971502750001', 'Still One') RETURNING id INTO k1;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971502750002', 'Still Two') RETURNING id INTO k2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k1, u_lead) RETURNING id INTO v1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k2, u_lead) RETURNING id INTO v2;
  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key)
  VALUES (v1, a_acct, 'recruiter', 'hr_interview');
  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key,
                                last_inbound_at, last_outbound_at)
  VALUES (v2, a_acct, 'recruiter', 'cv_review', now() - interval '5 days', now() - interval '4 days');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_lead))
    || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(false, NULL, NULL, NULL, false, 20)::text')
    || pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''stage_hr_interview'', true)::text')
    || pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''reply_overdue_nudge'', true, NULL, ''sms'')::text');
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: %', r; END IF;

  -- ---------- A stage invite ----------
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key)
  VALUES (a_acct, v1, k1, 'stage_hr_interview', 'hr_interview_invite', 'hist:275a') RETURNING id INTO o1;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key)
  VALUES (a_acct, v1, k1, 'stage_hr_interview', 'hr_interview_invite', 'hist:275b') RETURNING id INTO o2;
  r := pg_temp.hr_as(NULL, format(
         'SELECT coalesce(public.hr_automsg_row_state(%L)->>''stale'', ''none'') || public.hr_automsg_claim(%L)', o1, o1));
  c := c || pg_temp.hr_chk('an invite of the current stage', r, 'noneclaimed');
  UPDATE hr_conversations SET stage_key = 'cv_review' WHERE conversation_id = v1;
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)->>''stale''', o2))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o2));
  r := r || '/' || (SELECT concat_ws(':', x.status, coalesce(x.hold_reason, '-'), x.last_error, coalesce(x.claim_state, '-'), x.attempts)
                 FROM hr_automsg_outbox x WHERE x.id = o2);
  c := c || pg_temp.hr_chk('an invite of a stage the chat left', r,
                           'stage_changed/cancelled/cancelled:-:stage_changed:-:0');
  UPDATE hr_conversations SET stage_key = 'hr_interview' WHERE conversation_id = v1;
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o2));
  c := c || pg_temp.hr_chk('moving back released a cancelled invite', r, 'lost');
  -- A claimed row is never taken back.
  UPDATE hr_conversations SET stage_key = 'cv_review' WHERE conversation_id = v1;
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o1));
  r := r || '/' || (SELECT x.status || ':' || x.claim_state FROM hr_automsg_outbox x WHERE x.id = o1);
  c := c || pg_temp.hr_chk('a row in flight was cancelled', r, 'lost/queued:sending');

  -- ---------- A nudge (the key comes from the real enqueue, sms suffix) ----------
  UPDATE hr_automsg_triggers SET updated_at = now() - interval '6 days'
   WHERE account_id = a_acct AND trigger = 'reply_overdue_nudge';
  PERFORM pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges()');
  SELECT x.id INTO o1 FROM hr_automsg_outbox x
   WHERE x.conversation_id = v2 AND x.dedupe_key LIKE 'nudge:%|sms';
  c := c || pg_temp.hr_chk('the sms nudge was not queued', (o1 IS NOT NULL)::text, 'true');
  c := c || pg_temp.hr_chk('a nudge of a lasting silence',
         pg_temp.hr_as(NULL, format('SELECT coalesce(public.hr_automsg_row_state(%L)->>''stale'', ''none'')', o1)), 'none');
  -- Somebody wrote again: another silence, its own nudge.
  UPDATE hr_conversations SET last_outbound_at = now() - interval '1 hour' WHERE conversation_id = v2;
  c := c || pg_temp.hr_chk('a nudge of an earlier silence',
         pg_temp.hr_as(NULL, format('SELECT coalesce(public.hr_automsg_row_state(%L)->>''stale'', ''none'')', o1)), 'no_longer_waiting');
  -- The candidate replied.
  UPDATE hr_conversations SET last_outbound_at = now() - interval '4 days', last_inbound_at = now()
   WHERE conversation_id = v2;
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o1));
  r := r || '/' || (SELECT concat_ws(':', x.status, x.last_error) FROM hr_automsg_outbox x WHERE x.id = o1);
  c := c || pg_temp.hr_chk('a nudge after the reply', r, 'cancelled/cancelled:no_longer_waiting');

  -- ---------- A cancel keeps its reason; cv_received has no such rule ----------
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key)
  VALUES (a_acct, v2, k2, 'cv_received', 'cv_ack', 'hist:275c') RETURNING id INTO o2;
  r := pg_temp.hr_as(NULL, format('SELECT coalesce(public.hr_automsg_row_state(%L)->>''stale'', ''none'')', o2))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT x.status || '':'' || x.last_error FROM public.hr_automsg_mark(%L, ''cancelled'', p_error => ''stage_changed'') x', o2));
  c := c || pg_temp.hr_chk('mark cancelled lost its reason', r, 'none/cancelled:stage_changed');

  r := concat_ws('/',
    has_function_privilege('authenticated', 'public.hr_automsg_claim(uuid,timestamptz)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.hr_automsg_claim(uuid,timestamptz)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.hr_automsg_row_state(uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.hr_automsg_stale_reason(text,text,uuid)', 'EXECUTE'));
  c := c || pg_temp.hr_chk('grants', r, 'f/t/t/f');

  RAISE EXCEPTION 'verify-hr-automsg-still-true rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-automsg-still-true: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-automsg-still-true: all % checks passed', n;
END
$verify$;
