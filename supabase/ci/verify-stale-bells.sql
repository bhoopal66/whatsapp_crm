-- Migration 319: a task's, meeting's or event's reminder bells are read when
-- it is finished, moved, cancelled or deleted; the bell of the new time, other
-- rows' bells and a series' other dates are not. One statement; rolled back by
-- the sentinel at its end.
DO $$
DECLARE
  u uuid := '00000000-0000-4000-8000-000000319001';
  a uuid; t uuid; t2 uuid; m uuid; e uuid; s uuid; r text;
  v_read timestamptz := now() - interval '1 day';
  v_now  timestamptz := date_trunc('minute', now());
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'sb319-owner@example.invalid');
  SELECT account_id INTO a FROM profiles WHERE user_id = u;

  -- ---- Tasks ----
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'manual', 'sb319 one', u, u, v_now) RETURNING id INTO t;
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a, 'manual', 'sb319 other', u, u, v_now) RETURNING id INTO t2;
  PERFORM calendar_reminder_sweep(v_now + interval '1 second');
  ASSERT (SELECT count(*) = 2 FROM notifications WHERE account_id = a AND type = 'task_due' AND read_at IS NULL), 'fixture: the task bells';
  -- One already read, with its own time: it keeps it.
  INSERT INTO notifications (account_id, user_id, type, title, meta, read_at)
  VALUES (a, u, 'task_due', 'sb319 read', jsonb_build_object('task_id', t, 'offset', 15), v_read);

  UPDATE tasks SET title = 'sb319 one, renamed', due_at = due_at WHERE id = t;
  ASSERT (SELECT count(*) = 2 FROM notifications WHERE account_id = a AND type = 'task_due' AND read_at IS NULL), 'a rename read a bell';

  -- Moved: the old bell is read; the new time rings, and stays.
  UPDATE tasks SET due_at = v_now + interval '1 minute' WHERE id = t;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND meta ->> 'task_id' = t::text AND read_at IS NULL), 'a moved task''s bell still rings';
  PERFORM calendar_reminder_sweep(v_now + interval '61 seconds');
  UPDATE tasks SET note = 'x' WHERE id = t;
  ASSERT (SELECT count(*) = 1 FROM notifications WHERE type = 'task_due' AND meta ->> 'task_id' = t::text AND read_at IS NULL), 'the new time''s bell';
  UPDATE tasks SET status = 'done' WHERE id = t;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND meta ->> 'task_id' = t::text AND read_at IS NULL), 'a finished task''s bell still rings';
  ASSERT (SELECT count(*) = 1 FROM notifications WHERE meta ->> 'task_id' = t::text AND read_at = v_read), 'a bell read before was stamped again';
  ASSERT (SELECT count(*) = 1 FROM notifications WHERE type = 'task_due' AND meta ->> 'task_id' = t2::text AND read_at IS NULL), 'another task''s bell was read';
  DELETE FROM tasks WHERE id = t2;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND meta ->> 'task_id' = t2::text AND read_at IS NULL), 'a deleted task''s bell still rings';

  -- ---- Meetings ----
  INSERT INTO meetings (account_id, title, host_user_id, scheduled_start, scheduled_end)
  VALUES (a, 'sb319 meeting', u, v_now, v_now + interval '1 hour') RETURNING id INTO m;
  PERFORM calendar_reminder_sweep(v_now + interval '1 second');
  ASSERT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_reminder' AND meta ->> 'meeting_id' = m::text AND read_at IS NULL), 'fixture: the meeting bell';
  UPDATE meetings SET scheduled_end = v_now + interval '2 hours' WHERE id = m;
  ASSERT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_reminder' AND meta ->> 'meeting_id' = m::text AND read_at IS NULL), 'a longer meeting read its bell';
  UPDATE meetings SET scheduled_start = v_now + interval '1 minute' WHERE id = m;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_reminder' AND meta ->> 'meeting_id' = m::text AND read_at IS NULL), 'a moved meeting''s bell still rings';
  PERFORM calendar_reminder_sweep(v_now + interval '61 seconds');
  ASSERT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_reminder' AND meta ->> 'meeting_id' = m::text AND read_at IS NULL), 'the moved meeting does not ring';
  UPDATE meetings SET status = 'cancelled' WHERE id = m;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_reminder' AND meta ->> 'meeting_id' = m::text AND read_at IS NULL), 'a cancelled meeting''s bell still rings';
  INSERT INTO meetings (account_id, title, host_user_id, scheduled_start, scheduled_end)
  VALUES (a, 'sb319 ended', u, v_now, v_now + interval '1 hour') RETURNING id INTO m;
  PERFORM calendar_reminder_sweep(v_now + interval '1 second');
  UPDATE meetings SET status = 'ended' WHERE id = m;
  ASSERT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_reminder' AND meta ->> 'meeting_id' = m::text AND read_at IS NULL), 'an ended meeting lost its bell';
  DELETE FROM meetings WHERE id = m;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_reminder' AND meta ->> 'meeting_id' = m::text AND read_at IS NULL), 'a deleted meeting''s bell still rings';

  -- ---- Events ----
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, reminders)
  VALUES (a, u, 'sb319 event', v_now, v_now + interval '1 hour', '{0}') RETURNING id INTO e;
  PERFORM calendar_reminder_sweep(v_now + interval '1 second');
  ASSERT EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND meta ->> 'event_id' = e::text AND read_at IS NULL), 'fixture: the event bell';
  UPDATE calendar_events SET title = 'sb319 renamed', all_day = true WHERE id = e;
  UPDATE calendar_events SET all_day = false WHERE id = e;
  ASSERT EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND meta ->> 'event_id' = e::text AND read_at IS NULL), 'an event with the same start lost its bell';
  UPDATE calendar_events SET start_at = v_now + interval '1 minute' WHERE id = e;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND meta ->> 'event_id' = e::text AND read_at IS NULL), 'a moved event''s bell still rings';
  PERFORM calendar_reminder_sweep(v_now + interval '61 seconds');
  ASSERT EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND meta ->> 'event_id' = e::text AND read_at IS NULL), 'the moved event does not ring';
  UPDATE calendar_events SET status = 'cancelled' WHERE id = e;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND meta ->> 'event_id' = e::text AND read_at IS NULL), 'a cancelled event''s bell still rings';

  -- A series: day 1 to day 4, one unread bell each.
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, reminders, rrule, series_end_at)
  VALUES (a, u, 'sb319 series', v_now, v_now + interval '1 hour', '{0}', 'FREQ=DAILY;COUNT=9', v_now + interval '8 days 1 hour') RETURNING id INTO s;
  PERFORM calendar_insert_reminder(
            'ev:' || s || ':' || floor(extract(epoch FROM v_now + make_interval(days => d)))::bigint || ':0:' || u,
            u, s, v_now + make_interval(days => d), 0)
     FROM generate_series(0, 3) d;
  UPDATE calendar_events SET exdates = ARRAY[v_now + interval '1 day'] WHERE id = s;
  SELECT string_agg(((n.meta ->> 'occurrence_start')::timestamptz - v_now)::text, ', ' ORDER BY n.meta ->> 'occurrence_start') INTO r
    FROM notifications n WHERE n.type = 'event_reminder' AND n.meta ->> 'event_id' = s::text AND n.read_at IS NULL;
  ASSERT r = '00:00:00, 2 days, 3 days', 'one date taken out: ' || coalesce(r, '(none)');
  -- Cut short: the dates before the new end keep theirs.
  UPDATE calendar_events SET rrule = 'FREQ=DAILY;COUNT=3', series_end_at = v_now + interval '2 days 1 hour' WHERE id = s;
  SELECT string_agg(((n.meta ->> 'occurrence_start')::timestamptz - v_now)::text, ', ' ORDER BY n.meta ->> 'occurrence_start') INTO r
    FROM notifications n WHERE n.type = 'event_reminder' AND n.meta ->> 'event_id' = s::text AND n.read_at IS NULL;
  ASSERT r = '00:00:00, 2 days', 'the series cut short: ' || coalesce(r, '(none)');
  -- Another pattern: only the first date certainly holds.
  UPDATE calendar_events SET rrule = 'FREQ=WEEKLY;COUNT=3' WHERE id = s;
  SELECT string_agg(((n.meta ->> 'occurrence_start')::timestamptz - v_now)::text, ', ') INTO r
    FROM notifications n WHERE n.type = 'event_reminder' AND n.meta ->> 'event_id' = s::text AND n.read_at IS NULL;
  ASSERT r = '00:00:00', 'the series with another rule: ' || coalesce(r, '(none)');
  DELETE FROM calendar_events WHERE id = s;
  ASSERT NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND meta ->> 'event_id' = s::text AND read_at IS NULL), 'a deleted event''s bell still rings';

  ASSERT NOT has_function_privilege('authenticated', 'public.stale_bells_read()', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.stale_bells_read()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.calendar_events_stale_bells()', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.calendar_events_stale_bells()', 'EXECUTE'), 'grants';
  ASSERT to_regclass('public.idx_notifications_unread_reminder_subject') IS NOT NULL, 'the index';
  RAISE EXCEPTION USING ERRCODE = 'ZT319', MESSAGE = 'verify-stale-bells rollback';
  EXCEPTION WHEN SQLSTATE 'ZT319' THEN
    NULL;
  END;
END $$;
