-- Behavioural regression suite for migration 268 (late reminders, pushes
-- for finished tasks, personal numbers out of the figures).
-- ONE statement on purpose (the pinned CLI rejects several); fixtures are
-- rolled back through a sentinel.

DO $verify$
DECLARE
  u_own UUID := '00000000-0000-4000-8000-000000268001';  -- owner
  u_hr  UUID := '00000000-0000-4000-8000-000000268002';  -- HR agent, own number
  u_ag  UUID := '00000000-0000-4000-8000-000000268003';  -- agent
  t0    TIMESTAMPTZ := date_trunc('minute', now()) + interval '2 days';
  a     UUID;
  w_co  UUID; w_pn UUID;
  ct    UUID[];
  cv_co UUID; cv_co2 UUID; cv_p UUID; cv_p2 UUID;
  t_ok  UUID; t_done UUID; t_move UUID; t_hd UUID; t_sn UUID; t_old UUID; t_push UUID;
  e_1   UUID; e_end UUID; e_new UUID; m_1 UUID; m_new UUID;
  o     public.push_outbox;
  s0    TEXT; s1 TEXT; r0 TEXT; r1 TEXT;
  j     JSONB; jn JSONB;
  n     INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rn_ok(p_ok boolean, p_what text) RETURNS text
    LANGUAGE sql AS $b$ SELECT CASE WHEN p_ok IS TRUE THEN NULL ELSE p_what END $b$
  $fn$;
  -- Bells of one thing (its id in the meta): how many, and the last body.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rn_bells(p_id uuid) RETURNS text
    LANGUAGE sql AS $b$
      SELECT count(*) || coalesce(':' || string_agg(split_part(body, ' · ', 1), ',' ORDER BY (meta ->> 'offset')::int DESC), '')
        FROM public.notifications
       WHERE type IN ('task_due', 'event_reminder', 'meeting_reminder')
         AND p_id::text IN (meta ->> 'task_id', meta ->> 'event_id', meta ->> 'meeting_id') $b$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'rn-owner@example.test'), (u_hr, 'rn-hr@example.test'), (u_ag, 'rn-agent@example.test');
  INSERT INTO public.accounts (name, owner_user_id) VALUES ('rn-acct', u_own) RETURNING id INTO a;
  UPDATE public.profiles SET account_id = a, account_role = 'owner' WHERE user_id = u_own;
  UPDATE public.profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_hr, u_ag);
  UPDATE public.profiles SET may_connect_personal_whatsapp = true WHERE user_id = u_hr;

  -- ---------- 1. Late reminders ----------
  INSERT INTO public.tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'follow_up', 'rn late', u_ag, u_own, t0) RETURNING id INTO t_ok;
  INSERT INTO public.tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'follow_up', 'rn done', u_ag, u_own, t0) RETURNING id INTO t_done;
  INSERT INTO public.tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'follow_up', 'rn moved', u_ag, u_own, t0) RETURNING id INTO t_move;
  INSERT INTO public.tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'follow_up', 'rn old', u_ag, u_own, t0 - interval '3 hours') RETURNING id INTO t_old;
  UPDATE public.tasks SET status = 'done' WHERE id = t_done;
  UPDATE public.tasks SET assigned_to = u_hr WHERE id = t_move;
  PERFORM public.calendar_reminder_sweep(t0 + interval '9 hours');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(t_ok) = '1:Overdue', 'a task 9 h late: ' || pg_temp.rn_bells(t_ok))); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(t_done) = '0', 'a closed task rang')); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(
    EXISTS (SELECT 1 FROM public.notifications WHERE type = 'task_due' AND user_id = u_hr AND meta ->> 'task_id' = t_move::text)
    AND pg_temp.rn_bells(t_move) = '1:Overdue', 'a reassigned task rings who has it now')); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(t_old) = '0', 'a task 12 h late still rang')); n := n + 1;
  PERFORM public.calendar_reminder_sweep(t0 + interval '10 hours');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(t_ok) = '1:Overdue', 'a late task rang twice')); n := n + 1;
  -- A sent key outlives the window.
  UPDATE public.calendar_reminders_sent SET sent_at = t0 WHERE key LIKE 'tk0:' || t_ok || ':%';
  PERFORM public.calendar_reminder_sweep(t0 + interval '11 hours 59 minutes');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(t_ok) = '1:Overdue', 'the key was purged inside the window')); n := n + 1;

  -- The heads-up: late only while the due time is ahead.
  INSERT INTO public.tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'follow_up', 'rn heads-up', u_ag, u_own, t0 + interval '1 day') RETURNING id INTO t_hd;
  PERFORM public.calendar_reminder_sweep(t0 + interval '1 day' - interval '4 minutes');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(t_hd) = '1:Due in 4 minutes', 'late heads-up: ' || pg_temp.rn_bells(t_hd))); n := n + 1;
  PERFORM public.calendar_reminder_sweep(t0 + interval '1 day 1 minute');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(t_hd) = '2:Due in 4 minutes,Due now', 'due now after it: ' || pg_temp.rn_bells(t_hd))); n := n + 1;
  -- Snoozed for 10 minutes: no heads-up the moment it is snoozed.
  INSERT INTO public.tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'follow_up', 'rn snoozed', u_ag, u_own, now() + interval '10 minutes') RETURNING id INTO t_sn;
  PERFORM public.calendar_reminder_sweep(now() + interval '1 minute');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(t_sn) = '0', 'a task set 10 minutes ahead rang at once')); n := n + 1;

  -- Events and meetings: 30 minutes late, never after the end, and of
  -- two late reminders only the newest.
  INSERT INTO public.calendar_events (account_id, created_by, title, start_at, end_at, reminders)
  VALUES (a, u_ag, 'rn event', t0 + interval '3 days', t0 + interval '3 days 1 hour', '{10,0}') RETURNING id INTO e_1;
  INSERT INTO public.calendar_events (account_id, created_by, title, start_at, end_at, reminders)
  VALUES (a, u_ag, 'rn short', t0 + interval '3 days', t0 + interval '3 days 10 minutes', '{0}') RETURNING id INTO e_end;
  INSERT INTO public.meetings (account_id, title, host_user_id, scheduled_start)
  VALUES (a, 'rn meeting', u_ag, t0 + interval '3 days') RETURNING id INTO m_1;
  PERFORM public.calendar_reminder_sweep(t0 + interval '3 days' - interval '3 minutes');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(e_1) = '1:In 3 min' AND pg_temp.rn_bells(m_1) = '1:In 3 min',
    'late before the start: ' || pg_temp.rn_bells(e_1) || ' / ' || pg_temp.rn_bells(m_1))); n := n + 1;
  PERFORM public.calendar_reminder_sweep(t0 + interval '3 days 12 minutes');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(e_1) = '2:In 3 min,Started' AND pg_temp.rn_bells(m_1) = '2:In 3 min,Started',
    'late after the start: ' || pg_temp.rn_bells(e_1) || ' / ' || pg_temp.rn_bells(m_1))); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(e_end) = '0', 'an event that is over rang')); n := n + 1;
  INSERT INTO public.calendar_events (account_id, created_by, title, start_at, end_at, reminders)
  VALUES (a, u_ag, 'rn both', t0 + interval '4 days', t0 + interval '4 days 1 hour', '{10,0}') RETURNING id INTO e_new;
  PERFORM public.calendar_reminder_sweep(t0 + interval '4 days 8 minutes');
  PERFORM public.calendar_reminder_sweep(t0 + interval '4 days 9 minutes');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(e_new) = '1:Started', 'two late reminders of one event: ' || pg_temp.rn_bells(e_new))); n := n + 1;
  INSERT INTO public.calendar_events (account_id, created_by, title, start_at, end_at, reminders)
  VALUES (a, u_ag, 'rn 30', t0 + interval '5 days', t0 + interval '5 days 2 hours', '{0}') RETURNING id INTO e_new;
  PERFORM public.calendar_reminder_sweep(t0 + interval '5 days 30 minutes');
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(e_new) = '0', 'an event 30 minutes late rang')); n := n + 1;
  -- Made after its reminder's time: that reminder is not late.
  INSERT INTO public.calendar_events (account_id, created_by, title, start_at, end_at, reminders)
  VALUES (a, u_ag, 'rn quick', now() + interval '2 minutes', now() + interval '1 hour', '{10}') RETURNING id INTO e_new;
  INSERT INTO public.meetings (account_id, title, host_user_id, scheduled_start)
  VALUES (a, 'rn quick', u_ag, now() + interval '2 minutes') RETURNING id INTO m_new;
  PERFORM public.calendar_reminder_sweep(now());
  failed := array_append(failed, pg_temp.rn_ok(pg_temp.rn_bells(e_new) = '0' AND pg_temp.rn_bells(m_new) = '0', 'a reminder whose time was past when it was made rang')); n := n + 1;

  -- ---------- 2. A push for a task that is done or handed on ----------
  INSERT INTO public.tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'follow_up', 'rn push', u_ag, u_own, t0) RETURNING id INTO t_push;
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (u_ag, 'https://push.example.invalid/rn', 'k', 'a');
  INSERT INTO public.push_outbox (user_id, account_id, kind, title, body, url, tag)
  VALUES (u_ag, a, 'task_due', 'rn push', 'b', '/', 'task:' || t_push) RETURNING * INTO o;
  failed := array_append(failed, pg_temp.rn_ok(public.push_still_allowed(o), 'an open task''s push goes out')); n := n + 1;
  UPDATE public.tasks SET assigned_to = u_hr WHERE id = t_push;
  failed := array_append(failed, pg_temp.rn_ok(NOT public.push_still_allowed(o), 'a push for a task handed on')); n := n + 1;
  UPDATE public.tasks SET assigned_to = u_ag, status = 'done' WHERE id = t_push;
  failed := array_append(failed, pg_temp.rn_ok(NOT public.push_still_allowed(o), 'a push for a finished task')); n := n + 1;
  DELETE FROM public.tasks WHERE id = t_push;
  failed := array_append(failed, pg_temp.rn_ok(NOT public.push_still_allowed(o), 'a push for a deleted task')); n := n + 1;
  o.tag := 'bell:' || t_push;
  failed := array_append(failed, pg_temp.rn_ok(public.push_still_allowed(o), 'a push whose tag names no task is judged as before')); n := n + 1;
  o.tag := 'task:nonsense';
  failed := array_append(failed, pg_temp.rn_ok(public.push_still_allowed(o), 'a tag that is not an id')); n := n + 1;

  -- ---------- 3. Personal numbers are not team activity ----------
  INSERT INTO public.whatsapp_config (user_id, account_id, provider, phone_number_id, access_token)
  VALUES (u_own, a, 'openwa', 'rn-co', 't') RETURNING id INTO w_co;
  INSERT INTO public.whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, is_personal)
  VALUES (u_hr, a, 'openwa', 'rn-pn', 't', true) RETURNING id INTO w_pn;
  WITH c AS (
    INSERT INTO public.contacts (account_id, user_id, phone, name)
    SELECT a, u_hr, '+97150268000' || g, 'rn ' || g FROM generate_series(1, 4) g RETURNING id)
  SELECT array_agg(id) INTO ct FROM c;
  INSERT INTO public.conversations (account_id, user_id, contact_id, channel_id, last_message_at)
  VALUES (a, u_hr, ct[1], w_co, now()) RETURNING id INTO cv_co;
  INSERT INTO public.conversations (account_id, user_id, contact_id, channel_id, last_message_at)
  VALUES (a, u_hr, ct[4], w_co, now()) RETURNING id INTO cv_co2;
  -- The dashboard's numbers, taken before the personal chats exist.
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, channel_id, status, created_at)
  VALUES (cv_co, 'agent', u_hr, 'text', 'company hello', w_co, 'sent', now() - interval '3 minutes');
  SELECT jsonb_agg(d)::text INTO s0 FROM public.dashboard_message_series(now() - interval '1 day', 'UTC') d;
  SELECT jsonb_agg(d)::text INTO r0 FROM public.dashboard_response_time(now() - interval '1 day', 'UTC', now() - interval '1 day', now() - interval '8 days') d;

  INSERT INTO public.conversations (account_id, user_id, contact_id, channel_id, personal_owner_id, last_message_at)
  VALUES (a, u_hr, ct[2], w_pn, u_hr, now()) RETURNING id INTO cv_p;
  INSERT INTO public.conversations (account_id, user_id, contact_id, channel_id, personal_owner_id, last_message_at)
  VALUES (a, u_hr, ct[3], w_pn, u_hr, now()) RETURNING id INTO cv_p2;
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, channel_id, status, created_at)
  SELECT cv_p, 'agent', u_hr, 'text', 'private ' || g, w_pn, 'sent', now() - make_interval(mins => 5 + 20 * (8 - g))
    FROM generate_series(1, 8) g;
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, channel_id, status, created_at) VALUES
    (cv_p2, 'customer', NULL, 'text', 'q', w_pn, 'delivered', now() - interval '50 minutes'),
    (cv_p2, 'agent', u_hr, 'text', 'a', w_pn, 'sent', now() - interval '40 minutes'),
    (cv_p2, 'customer', NULL, 'text', 'q2', w_pn, 'delivered', now() - interval '30 minutes');
  SELECT jsonb_agg(d)::text INTO s1 FROM public.dashboard_message_series(now() - interval '1 day', 'UTC') d;
  SELECT jsonb_agg(d)::text INTO r1 FROM public.dashboard_response_time(now() - interval '1 day', 'UTC', now() - interval '1 day', now() - interval '8 days') d;
  failed := array_append(failed, pg_temp.rn_ok(s1 IS NOT DISTINCT FROM s0, 'the message chart counts personal chats')); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(r1 IS NOT DISTINCT FROM r0, 'the response time counts personal chats')); n := n + 1;

  -- A message on the personal number inside a company chat (before 191).
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, channel_id, status, created_at)
  VALUES (cv_co2, 'agent', u_hr, 'text', 'old private', w_pn, 'sent', now() - interval '2 minutes');
  failed := array_append(failed, pg_temp.rn_ok(
    (SELECT count(*) = 1 AND bool_and(conversation_id = cv_co) FROM public.team_activity_starts(a, now() - interval '1 day', 'infinity')),
    'only the company start is a start')); n := n + 1;

  PERFORM set_config('request.jwt.claim.sub', u_own::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_own, 'role', 'authenticated')::text, true);
  j := public.team_activity_report(now() - interval '1 day', now() + interval '1 minute', 'UTC');
  SELECT x INTO jn FROM jsonb_array_elements(j -> 'senders') x WHERE x ->> 'user_id' = u_hr::text;
  failed := array_append(failed, pg_temp.rn_ok(
    jn ->> 'messages_sent' = '1' AND jn ->> 'chats_started' = '1' AND jn ->> 'longest_chase' = '1'
    AND jn ->> 'unanswered_over_limit' = '0' AND jn ->> 'replies' = '0' AND jn ->> 'today_starts' IN ('0', '1')
    AND jn ->> 'burst_10min' = '1', 'the report''s person: ' || jn::text)); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(
    (j ->> 'waiting_recent')::int + (j ->> 'waiting_older')::int = 0, 'a personal chat is waiting')); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(
    (SELECT count(*) = 1 AND bool_and(x ->> 'channel_id' = w_co::text) FROM jsonb_array_elements(j -> 'numbers') x),
    'the report lists a personal number')); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(NOT EXISTS (
    SELECT 1 FROM public.team_activity_chats(now() - interval '1 day', now() + interval '1 minute', 'person', u_hr, NULL, 'unanswered')),
    'the list of chases shows a personal chat')); n := n + 1;
  failed := array_append(failed, pg_temp.rn_ok(
    (SELECT count(*) = 1 FROM public.team_activity_chats(now() - interval '1 day', now() + interval '1 minute', 'person', u_hr, NULL, 'all')),
    'the list of starts is the company start')); n := n + 1;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  INSERT INTO public.team_activity_settings (account_id, daily_new_chats_per_user, timezone)
  VALUES (a, 1, 'UTC');
  -- Only meaningful when all the messages above are of today (UTC).
  PERFORM public.team_activity_alert_sweep();
  failed := array_append(failed, pg_temp.rn_ok(
    NOT EXISTS (SELECT 1 FROM public.team_activity_alerts WHERE account_id = a
                 AND (value > 1 OR subject_id = w_pn)), 'an alert counted personal chats')); n := n + 1;

  -- ---------- 4. Only a person's reply is a response ----------
  SELECT coalesce(sum(samples), 0)::text INTO r0 FROM public.dashboard_response_time(now() - interval '1 day', 'UTC', now() - interval '1 day', now() - interval '8 days');
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, channel_id, status, created_at) VALUES
    (cv_co, 'customer', NULL, 'text', 'q', w_co, 'delivered', now() - interval '110 seconds'),
    (cv_co, 'bot', NULL, 'text', 'auto', w_co, 'sent', now() - interval '100 seconds'),
    (cv_co, 'customer', NULL, 'text', 'q', w_co, 'delivered', now() - interval '90 seconds'),
    (cv_co, 'agent', NULL, 'text', 'from the API', w_co, 'sent', now() - interval '80 seconds');
  SELECT coalesce(sum(samples), 0)::text INTO r1 FROM public.dashboard_response_time(now() - interval '1 day', 'UTC', now() - interval '1 day', now() - interval '8 days');
  failed := array_append(failed, pg_temp.rn_ok(r1 = r0, 'a bot''s or the API''s answer counted as a reply')); n := n + 1;
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content_type, content_text, channel_id, status, created_at) VALUES
    (cv_co, 'customer', NULL, 'text', 'q', w_co, 'delivered', now() - interval '70 seconds'),
    (cv_co, 'agent', u_hr, 'text', 'a person', w_co, 'sent', now() - interval '10 seconds');
  SELECT coalesce(sum(samples), 0)::text INTO r1 FROM public.dashboard_response_time(now() - interval '1 day', 'UTC', now() - interval '1 day', now() - interval '8 days');
  failed := array_append(failed, pg_temp.rn_ok(r1::bigint = r0::bigint + 1, 'a person''s reply counts')); n := n + 1;

  failed := array_append(failed, pg_temp.rn_ok(
    NOT has_function_privilege('authenticated', 'public.calendar_reminder_sweep(timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.push_still_allowed(public.push_outbox)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.team_activity_report(timestamptz,timestamptz,text,uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.team_activity_report(timestamptz,timestamptz,text,uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.dashboard_response_time(timestamptz,text,timestamptz,timestamptz)', 'EXECUTE')
    AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.dashboard_response_time(timestamptz,text,timestamptz,timestamptz)'::regprocedure)
    AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.team_activity_starts(uuid,timestamptz,timestamptz)'::regprocedure),
    'privileges and security')); n := n + 1;

  RAISE EXCEPTION 'RN_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'RN_ROLLBACK' THEN RAISE; END IF;
  END;

  failed := array_remove(failed, NULL);
  IF n < 32 THEN RAISE EXCEPTION 'verify-reminders-and-numbers: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-reminders-and-numbers: % of % failed: %', cardinality(failed), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-reminders-and-numbers: % checks passed', n;
END $verify$;
