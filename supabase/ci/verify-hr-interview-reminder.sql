-- Behavioural regression suite for migration 339.
--
-- A recruitment chat's interview time is set and cleared only through
-- hr_set_interview (HR members of the inbox, open recruitment chats, never
-- a past time), each change logged in the chat's history. The cron's
-- enqueue queues one interview_reminder per (chat, interview_at) once the
-- time is within 24 hours, never for a past or later time, once; a new
-- time cancels the old row and may queue a new one; a reminder whose time
-- no longer holds is stale ('interview_changed').
-- ONE statement on purpose, rolled back on success (see
-- verify-hr-automsg-rcs.sql).

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000339001';  -- owner of A
  u_lead  UUID := '00000000-0000-4000-8000-000000339002';  -- recruiter lead
  u_agent UUID := '00000000-0000-4000-8000-000000339003';  -- not in HR
  a_acct  UUID;
  k1 UUID; k2 UUID; k3 UUID;  -- contacts
  v1 UUID; v2 UUID; v3 UUID;  -- conversations (v3 is a dept chat)
  o1 UUID; o2 UUID;           -- outbox rows
  t1 timestamptz := date_trunc('second', now()) + interval '3 hours';
  t2 timestamptz := date_trunc('second', now()) + interval '5 hours';
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
    (u_owner, 'hi339-owner@example.invalid'),
    (u_lead,  'hi339-lead@example.invalid'),
    (u_agent, 'hi339-agent@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_lead, u_agent);
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971503390001', 'Interview One') RETURNING id INTO k1;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971503390002', 'Interview Two') RETURNING id INTO k2;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971503390003', 'Interview Three') RETURNING id INTO k3;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k1, u_lead) RETURNING id INTO v1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k2, u_lead) RETURNING id INTO v2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k3, u_lead) RETURNING id INTO v3;
  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key)
  VALUES (v1, a_acct, 'recruiter', 'hr_interview');
  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key)
  VALUES (v2, a_acct, 'recruiter', 'hr_interview');
  INSERT INTO hr_conversations (conversation_id, account_id, inbox)
  VALUES (v3, a_acct, 'dept');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_lead))
    || pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''dept'', ''lead'')', u_lead))
    || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(false, NULL, NULL, NULL, false, 20)::text');
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: %', r; END IF;

  -- ---------- Setting the time ----------
  r := pg_temp.hr_as(u_agent, format('SELECT (public.hr_set_interview(%L, %L)).interview_at::text', v1, t1));
  c := c || pg_temp.hr_chk('somebody outside HR sets a time', r, 'ERROR %');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_interview(%L, %L)).interview_at::text', v1, now() - interval '1 hour'));
  c := c || pg_temp.hr_chk('a past time is refused', r, 'ERROR %past%');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_interview(%L, %L)).interview_at::text', v3, t1));
  c := c || pg_temp.hr_chk('a dept chat takes no interview', r, 'ERROR %recruitment%');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_interview(%L, %L)).conversation_id::text', v1, t1));
  c := c || pg_temp.hr_chk('a lead sets a time', r, v1::text);
  r := (SELECT x.interview_at = t1 FROM hr_conversations x WHERE x.conversation_id = v1)::text
    || '/' || (SELECT count(*) FROM hr_stage_history x
                WHERE x.conversation_id = v1 AND x.event = 'interview' AND x.actor = u_lead
                  AND x.reason IS NOT NULL)::text;
  c := c || pg_temp.hr_chk('the time is stored and logged', r, 'true/1');

  -- ---------- Queueing ----------
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  c := c || pg_temp.hr_chk('nothing queued while the trigger is off', r, '0');
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''interview_reminder'', true)::text');
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: %', r; END IF;
  -- v2: an interview 30 hours ahead (not yet), and later one that has passed.
  UPDATE hr_conversations SET interview_at = now() + interval '30 hours' WHERE conversation_id = v2;
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  c := c || pg_temp.hr_chk('one reminder within 24 hours', r, '1');
  SELECT x.id INTO o1 FROM hr_automsg_outbox x
   WHERE x.conversation_id = v1 AND x.trigger = 'interview_reminder';
  r := (SELECT concat_ws('|', x.status, x.template_kind, x.dedupe_key, x.params->>'interview_at')
          FROM hr_automsg_outbox x WHERE x.id = o1);
  c := c || pg_temp.hr_chk('the queued row', r,
    'queued|interview_reminder|interview:' || v1 || ':' || floor(extract(epoch FROM t1))::bigint
    || '|' || to_char(t1 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  c := c || pg_temp.hr_chk('queued once', r, '0');
  UPDATE hr_conversations SET interview_at = now() - interval '1 minute' WHERE conversation_id = v2;
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_interview_reminders(now())::text')
    || '/' || (SELECT count(*) FROM hr_automsg_outbox x WHERE x.conversation_id = v2)::text;
  c := c || pg_temp.hr_chk('never for a past time', r, '0/0');
  r := pg_temp.hr_as(NULL, format('SELECT coalesce(public.hr_automsg_row_state(%L)->>''stale'', ''none'')', o1));
  c := c || pg_temp.hr_chk('the reminder is still true', r, 'none');

  -- ---------- A new time ----------
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_interview(%L, %L)).conversation_id::text', v1, t2));
  c := c || pg_temp.hr_chk('a lead moves the time', r, v1::text);
  r := (SELECT x.status || ':' || coalesce(x.last_error, '-') FROM hr_automsg_outbox x WHERE x.id = o1);
  c := c || pg_temp.hr_chk('the old reminder is cancelled', r, 'cancelled:interview_changed');
  r := pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges(now())::text');
  c := c || pg_temp.hr_chk('the new time queues anew', r, '1');
  SELECT x.id INTO o2 FROM hr_automsg_outbox x
   WHERE x.conversation_id = v1 AND x.trigger = 'interview_reminder' AND x.status = 'queued';
  r := (SELECT x.dedupe_key FROM hr_automsg_outbox x WHERE x.id = o2);
  c := c || pg_temp.hr_chk('the new key', r, 'interview:' || v1 || ':' || floor(extract(epoch FROM t2))::bigint);

  -- ---------- A time that has passed while held ----------
  UPDATE hr_conversations SET interview_at = now() - interval '1 minute' WHERE conversation_id = v1;
  r := pg_temp.hr_as(NULL, format('SELECT coalesce(public.hr_automsg_row_state(%L)->>''stale'', ''none'')', o2));
  c := c || pg_temp.hr_chk('a passed interview is stale', r, 'interview_changed');
  UPDATE hr_conversations SET interview_at = t2 WHERE conversation_id = v1;

  -- ---------- Clearing ----------
  r := pg_temp.hr_as(u_lead, format('SELECT coalesce((public.hr_set_interview(%L, NULL)).interview_at::text, ''cleared'')', v1));
  c := c || pg_temp.hr_chk('a lead clears the time', r, 'cleared');
  r := (SELECT x.status FROM hr_automsg_outbox x WHERE x.id = o2)
    || '/' || (SELECT count(*) FROM hr_stage_history x
                WHERE x.conversation_id = v1 AND x.event = 'interview' AND x.reason IS NULL)::text
    || '/' || (SELECT count(*) FROM hr_stage_history x
                WHERE x.conversation_id = v1 AND x.event = 'interview')::text;
  c := c || pg_temp.hr_chk('clearing cancels and logs', r, 'cancelled/1/3');

  r := concat_ws('/',
    has_function_privilege('authenticated', 'public.hr_set_interview(uuid,timestamptz)', 'EXECUTE'),
    has_function_privilege('anon', 'public.hr_set_interview(uuid,timestamptz)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.hr_automsg_enqueue_interview_reminders(timestamptz)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.hr_automsg_enqueue_interview_reminders(timestamptz)', 'EXECUTE'));
  c := c || pg_temp.hr_chk('grants', r, 't/f/f/t');

  RAISE EXCEPTION 'verify-hr-interview-reminder rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-interview-reminder: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-interview-reminder: all % checks passed', n;
END
$verify$;
