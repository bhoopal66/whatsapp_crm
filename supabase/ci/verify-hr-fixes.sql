-- Behavioural regression suite for migration 302 (five HR faults).
--
-- Only the newest stage row of a chat is still true; a no-activity rule
-- above 168 hours nudges; due messages are read page by page; one chat's
-- error is its own in hr_sweep; a new HR line's owner is in HR.
-- ONE statement on purpose, rolled back on success (see
-- verify-hr-automsg-rcs.sql).

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000302001';
  u_lead  UUID := '00000000-0000-4000-8000-000000302002';
  a_acct  UUID;
  k1 UUID; k2 UUID; k3 UUID;
  v1 UUID; v2 UUID; v3 UUID;
  w1 UUID; w2 UUID;
  o1 UUID; o2 UUID;
  v_at    TIMESTAMPTZ;
  r       TEXT;
  c       TEXT[] := '{}';
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
    (u_owner, 'hrf-owner@example.invalid'),
    (u_lead,  'hrf-lead@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN RAISE EXCEPTION 'fixture: no account'; END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_lead;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (a_acct, u_owner, '971503020001') RETURNING id INTO k1;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (a_acct, u_owner, '971503020002') RETURNING id INTO k2;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (a_acct, u_owner, '971503020003') RETURNING id INTO k3;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k1, u_lead) RETURNING id INTO v1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k2, u_lead) RETURNING id INTO v2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k3, u_lead) RETURNING id INTO v3;
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_lead))
    || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(false, NULL, NULL, NULL, false, 20)::text')
    || pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''stage_hr_interview'', true)::text')
    || pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''stage_manager_interview'', true)::text')
    || pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''reply_overdue_nudge'', true)::text')
    || pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', v1))
    || pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', v2))
    || pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', v3));
  IF r LIKE '%ERROR%' THEN RAISE EXCEPTION 'fixture: %', r; END IF;

  -- ---------- 1. interview -> manager_interview -> interview ----------
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''hr_interview'', ''one'')).stage_key', v1))
    || '/' || pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''manager_interview'', ''mistake'')).stage_key', v1))
    || '/' || pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''hr_interview'', ''corrected'')).stage_key', v1));
  c := c || pg_temp.hr_chk('fixture: the moves', r, 'hr_interview/manager_interview/hr_interview');
  r := (SELECT string_agg(o.trigger || ':' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o.id)), ','
                 ORDER BY substr(o.dedupe_key, 6)::bigint)
          FROM hr_automsg_outbox o WHERE o.conversation_id = v1 AND o.trigger LIKE 'stage%');
  c := c || pg_temp.hr_chk('not exactly one message goes out, the newest row''s', r,
    'stage_hr_interview:cancelled,stage_manager_interview:cancelled,stage_hr_interview:claimed');

  -- ---------- 2. A rule of 400 hours nudges ----------
  UPDATE hr_workflow_rules SET after_hours = 400, enabled = true
   WHERE account_id = a_acct AND key = 'no_activity_recruiter' AND action = 'task';
  GET DIAGNOSTICS n = ROW_COUNT;
  c := c || pg_temp.hr_chk('fixture: the no-activity rule', n::text, '1');
  UPDATE hr_automsg_triggers SET updated_at = now() - interval '60 days'
   WHERE account_id = a_acct AND trigger = 'reply_overdue_nudge';
  UPDATE hr_conversations SET last_inbound_at = now() - interval '40 days', last_outbound_at = now() - interval '20 days'
   WHERE conversation_id = v2;
  UPDATE hr_conversations SET last_inbound_at = now() - interval '40 days', last_outbound_at = now() - interval '25 days'
   WHERE conversation_id = v3;
  PERFORM pg_temp.hr_as(NULL, 'SELECT public.hr_automsg_enqueue_nudges()');
  r := (SELECT count(*) FROM hr_automsg_outbox o WHERE o.conversation_id = v2 AND o.trigger = 'reply_overdue_nudge')
    || '/' || (SELECT count(*) FROM hr_automsg_outbox o WHERE o.conversation_id = v3 AND o.trigger = 'reply_overdue_nudge');
  c := c || pg_temp.hr_chk('a 400-hour rule did not nudge, or nudged 7 days after it was overdue', r, '1/0');

  -- ---------- 3. Page by page ----------
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind, dedupe_key, status, hold_reason)
  SELECT a_acct, v3, k3, 'cv_received', 'cv_ack', 'hrf:' || g, 'held', 'quiet_hours' FROM generate_series(1, 3) g;
  r := pg_temp.hr_as(NULL, format('SELECT string_agg(x.id::text, '','') FROM public.hr_automsg_due(1, %L) x', a_acct));
  o1 := r::uuid;
  c := c || pg_temp.hr_chk('the first page is not hr_automsg_due''s',
         pg_temp.hr_as(NULL, format('SELECT string_agg(x.id::text, '','') FROM public.hr_automsg_due_page(1, %L, ''{}'') x', a_acct)), r);
  r := pg_temp.hr_as(NULL, format('SELECT x.id::text FROM public.hr_automsg_due_page(1, %L, ARRAY[%L]::uuid[]) x', a_acct, o1));
  c := c || pg_temp.hr_chk('the next page is not one unseen row', (r <> o1::text AND length(r) = 36)::text, 'true');
  r := pg_temp.hr_as(NULL, format(
         'SELECT (SELECT count(*) FROM public.hr_automsg_due(500, %L)) - (SELECT count(*) FROM public.hr_automsg_due_page(500, %L, ARRAY[%L]::uuid[]))',
         a_acct, a_acct, o1));
  c := c || pg_temp.hr_chk('excluding one row does not leave out one', r, '1');
  r := concat_ws('/',
    has_function_privilege('service_role', to_regprocedure('public.hr_automsg_due_page(integer,uuid,uuid[])'), 'EXECUTE'),
    has_function_privilege('authenticated', to_regprocedure('public.hr_automsg_due_page(integer,uuid,uuid[])'), 'EXECUTE'),
    has_function_privilege('anon', to_regprocedure('public.hr_automsg_due_page(integer,uuid,uuid[])'), 'EXECUTE'),
    has_function_privilege('authenticated', 'public.hr_automsg_stale_reason(text,text,uuid)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.hr_sweep(timestamptz)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.hr_automsg_enqueue_nudges(timestamptz)', 'EXECUTE'),
    (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'hr\_automsg\_due%'));
  c := c || pg_temp.hr_chk('grants', r, 't/f/f/f/f/f/2');

  -- ---------- 4. One chat's error is its own ----------
  EXECUTE format($fn$
    CREATE FUNCTION pg_temp.hrf_fail() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF NEW.conversation_id = %L AND current_setting('hrf.fail', true) = 'on' THEN
        RAISE EXCEPTION 'hrf';
      END IF;
      RETURN NEW;
    END $body$
  $fn$, v2);
  CREATE TRIGGER hrf_fail BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION pg_temp.hrf_fail();
  PERFORM set_config('hrf.fail', 'on', true);
  r := pg_temp.hr_as(NULL, 'SELECT jsonb_typeof(public.hr_sweep())');
  r := r || '/' || (SELECT count(*) FROM tasks x WHERE x.conversation_id = v3 AND x.meta->>'hr_rule' = 'no_activity_recruiter')
    || '/' || (SELECT count(*) FROM tasks x WHERE x.conversation_id = v2 AND x.meta->>'hr_rule' = 'no_activity_recruiter')
    || '/' || (SELECT count(*) FROM hr_rule_fired x WHERE x.conversation_id = v2 AND x.rule_key = 'no_activity_recruiter');
  c := c || pg_temp.hr_chk('one chat''s error undid another''s task, or kept its own claim', r, 'object/1/0/0');
  PERFORM set_config('hrf.fail', 'off', true);
  PERFORM pg_temp.hr_as(NULL, 'SELECT public.hr_sweep()::text');
  r := (SELECT count(*) FROM tasks x WHERE x.conversation_id = v2 AND x.meta->>'hr_rule' = 'no_activity_recruiter')
    || '/' || (SELECT count(*) FROM tasks x WHERE x.conversation_id = v3 AND x.meta->>'hr_rule' = 'no_activity_recruiter');
  c := c || pg_temp.hr_chk('the next sweep did not retry the failed chat only', r, '1/1');

  -- ---------- 5. Who may own a new HR line ----------
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token)
    VALUES (u_lead, a_acct, 'openwa', 'hrf-sess-1', 't') RETURNING id INTO w1;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_primary)
    VALUES (u_owner, a_acct, 'openwa', 'hrf-sess-2', 't', false) RETURNING id INTO w2;
  INSERT INTO hr_lines (channel_id, account_id, created_by) VALUES (w2, a_acct, u_owner);
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_lines_set(ARRAY[%L, %L]::uuid[], false, NULL)::text', w1, w2));
  r := r || '/' || (SELECT string_agg(l.channel_id::text, ',') FROM hr_lines l WHERE l.account_id = a_acct)
    || '/' || (SELECT count(*) FROM hr_line_settings s WHERE s.account_id = a_acct);
  c := c || pg_temp.hr_chk('a number of somebody outside HR became a line', r, 'ERROR 22023 LINE_OWNER_NOT_HR:%/' || w2 || '/0');
  SELECT s.updated_at INTO v_at FROM hr_line_settings s WHERE s.account_id = a_acct;
  r := pg_temp.hr_as(u_owner, format('SELECT (x->>''channel_ids'') FROM public.hr_lines_set(ARRAY[%L]::uuid[], false, %L) x', w2, v_at));
  c := c || pg_temp.hr_chk('an existing line of somebody outside HR could not stay', r, '["' || w2 || '"]');
  UPDATE profiles SET department = 'hr' WHERE user_id = u_lead AND account_id = a_acct;
  SELECT s.updated_at INTO v_at FROM hr_line_settings s WHERE s.account_id = a_acct;
  r := pg_temp.hr_as(u_owner, format(
         'SELECT jsonb_array_length(x->''channel_ids'')::text FROM public.hr_lines_set(ARRAY[%L, %L]::uuid[], false, %L) x', w1, w2, v_at));
  c := c || pg_temp.hr_chk('a number of somebody in HR was refused', r, '2');

  RAISE EXCEPTION 'verify-hr-fixes rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-fixes: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-fixes: all % checks passed', n;
END
$verify$;
