-- Behavioural suite for migration 278: the calendar and meeting bells.
-- Fixture emails cmb278-*. ONE statement, rolled back by a sentinel (see
-- verify-calendar.sql).

DO $verify$
DECLARE
  u_own  UUID := '00000000-0000-4000-8000-000000278001';
  u_adm  UUID := '00000000-0000-4000-8000-000000278002';
  u_crt  UUID := '00000000-0000-4000-8000-000000278003';
  u_att  UUID := '00000000-0000-4000-8000-000000278004';
  u_b    UUID := '00000000-0000-4000-8000-000000278005';
  u_rm   UUID := '00000000-0000-4000-8000-000000278006';  -- removed from the meeting
  u_off  UUID := '00000000-0000-4000-8000-000000278007';  -- invited, then deactivated
  u_gone UUID := '00000000-0000-4000-8000-000000278008';  -- a creator who leaves
  a_acct UUID;
  m      UUID;
  m2     UUID;
  e      UUID;
  s      UUID;
  ts     TIMESTAMPTZ;
  occ    TIMESTAMPTZ;
  tmr    TIMESTAMPTZ := date_trunc('hour', now()) + interval '1 day';
  r      TEXT;
  n      INT := 0;
  failed TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cmb_try(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN EXECUTE p_sql INTO v; ELSE EXECUTE p_sql; END IF;
      RESET ROLE;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN coalesce(v, 'ok');
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claims', '', true);
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;
  -- Who was rung p_type about meta p_key = p_id, as a sorted id-suffix list.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cmb_rung(p_type text, p_key text, p_id uuid) RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce(string_agg(right(n.user_id::text, 3), ',' ORDER BY n.user_id), '')
        FROM public.notifications n WHERE n.type = p_type AND n.meta ->> p_key = p_id::text
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_own, 'cmb278-own@example.invalid'), (u_adm, 'cmb278-adm@example.invalid'),
    (u_crt, 'cmb278-crt@example.invalid'), (u_att, 'cmb278-att@example.invalid'),
    (u_b, 'cmb278-b@example.invalid'), (u_rm, 'cmb278-rm@example.invalid'),
    (u_off, 'cmb278-off@example.invalid'), (u_gone, 'cmb278-gone@example.invalid');
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_own;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_adm;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_crt;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_att, u_b, u_rm, u_off, u_gone);
  INSERT INTO team_activity_settings (account_id, timezone) VALUES (a_acct, 'Asia/Dubai')
  ON CONFLICT (account_id) DO UPDATE SET timezone = 'Asia/Dubai';

  -- ---------- 1. meetings ----------
  INSERT INTO meetings (account_id, host_user_id, title, scheduled_start, scheduled_end)
  VALUES (a_acct, u_crt, 'CMB ahead', tmr, tmr + interval '1 hour') RETURNING id INTO m;
  INSERT INTO meeting_invitees (meeting_id, user_id, account_id)
  SELECT m, u, a_acct FROM unnest(ARRAY[u_att, u_b, u_rm, u_off]) u;
  INSERT INTO meeting_removed_users (meeting_id, account_id, user_id, removed_by)
  VALUES (m, a_acct, u_rm, u_crt);
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_off;

  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_invite' AND user_id = u_att
                    AND body = 'Starts ' || to_char(tmr AT TIME ZONE 'Asia/Dubai', 'DD Mon YYYY HH24:MI') || ' Asia/Dubai') THEN
    failed := array_append(failed, '2: the meeting invitation gives the account''s time'::text);
  END IF;
  r := pg_temp.cmb_try(u_crt, format('UPDATE meetings SET title = %L WHERE id = %L', 'CMB renamed', m));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.cmb_rung('meeting_update', 'meeting_id', m) <> '' THEN
    failed := array_append(failed, ('1: a renamed meeting rings nobody: ' || r)::text);
  END IF;
  r := pg_temp.cmb_try(u_crt, format('UPDATE meetings SET scheduled_start = %L, scheduled_end = %L WHERE id = %L',
                                     tmr + interval '2 hours', tmr + interval '3 hours', m));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.cmb_rung('meeting_update', 'meeting_id', m) <> '004,005'
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_update' AND user_id = u_att AND title = 'CMB renamed'
                       AND body = 'Updated · starts ' || to_char((tmr + interval '2 hours') AT TIME ZONE 'Asia/Dubai', 'DD Mon YYYY HH24:MI') || ' Asia/Dubai'
                       AND actor_user_id = u_crt AND meta = jsonb_build_object('meeting_id', m)) THEN
    failed := array_append(failed, ('1: a moved meeting rings its live invitees, not the removed: ' || r
                                    || ' / ' || pg_temp.cmb_rung('meeting_update', 'meeting_id', m))::text);
  END IF;
  r := pg_temp.cmb_try(u_adm, format('UPDATE meetings SET status = %L WHERE id = %L', 'cancelled', m));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.cmb_rung('meeting_cancelled', 'meeting_id', m) <> '004,005'
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_cancelled' AND body LIKE 'Cancelled · was % Asia/Dubai') THEN
    failed := array_append(failed, ('1: a cancelled meeting rings its live invitees, not the removed: ' || r)::text);
  END IF;
  -- Started: a new end is silent, as is ending it; one that is over is cancelled silently.
  INSERT INTO meetings (account_id, host_user_id, title, scheduled_start, scheduled_end)
  VALUES (a_acct, u_crt, 'CMB running', now() - interval '10 minutes', now() + interval '10 minutes') RETURNING id INTO m2;
  INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (m2, u_att, a_acct);
  UPDATE meetings SET scheduled_end = now() + interval '1 hour' WHERE id = m2;
  UPDATE meetings SET scheduled_end = now() - interval '1 minute' WHERE id = m2;
  UPDATE meetings SET status = 'cancelled' WHERE id = m2;
  INSERT INTO meetings (account_id, host_user_id, title, scheduled_start) VALUES (a_acct, u_crt, 'CMB ended', tmr) RETURNING id INTO m;
  INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (m, u_att, a_acct);
  UPDATE meetings SET status = 'ended' WHERE id = m;
  UPDATE meetings SET scheduled_start = tmr + interval '1 day' WHERE id = m;
  n := n + 1;
  IF pg_temp.cmb_rung('meeting_update', 'meeting_id', m2) || pg_temp.cmb_rung('meeting_cancelled', 'meeting_id', m2)
     || pg_temp.cmb_rung('meeting_update', 'meeting_id', m) || pg_temp.cmb_rung('meeting_cancelled', 'meeting_id', m) <> '' THEN
    failed := array_append(failed, '1: a started or ended meeting rang'::text);
  END IF;
  -- An instant meeting keeps 106's exact words.
  INSERT INTO meetings (account_id, host_user_id, title) VALUES (a_acct, u_crt, 'CMB instant') RETURNING id INTO m;
  INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (m, u_att, a_acct);
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'meeting_invite' AND meta ->> 'meeting_id' = m::text AND body = 'Starting now') THEN
    failed := array_append(failed, '2: an instant meeting''s invitation is "Starting now"'::text);
  END IF;
  n := n + 1;
  IF (SELECT push_bell_url(x) FROM notifications x WHERE x.type = 'meeting_update' LIMIT 1) IS DISTINCT FROM
     (SELECT '/meetings/' || (x.meta ->> 'meeting_id') FROM notifications x WHERE x.type = 'meeting_update' LIMIT 1) THEN
    failed := array_append(failed, '1: a meeting_update push opens the meeting'::text);
  END IF;

  -- ---------- 3. taken off an event ----------
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at)
  VALUES (a_acct, u_crt, 'CMB one', tmr, tmr + interval '1 hour') RETURNING id INTO e;
  INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (e, u_att, a_acct), (e, u_b, a_acct);
  SELECT updated_at INTO ts FROM calendar_events WHERE id = e;
  r := pg_temp.cmb_try(u_crt, format('SELECT title FROM calendar_update_event(%L, %L, %L, %L)', e, ts, '{}', ARRAY[u_att]));
  n := n + 1;
  IF r <> 'CMB one' OR pg_temp.cmb_rung('calendar_cancelled', 'event_id', e) <> '005'
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_cancelled' AND meta = jsonb_build_object('event_id', e)
                       AND body LIKE 'You are no longer invited · was % Asia/Dubai') THEN
    failed := array_append(failed, ('3: a person taken off an event is rung: ' || r)::text);
  END IF;
  r := pg_temp.cmb_try(u_att, format('SELECT calendar_remove_attendees(%L, %L)::text', e, '{}'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' OR NOT EXISTS (SELECT 1 FROM calendar_event_attendees WHERE event_id = e AND user_id = u_att) THEN
    failed := array_append(failed, ('3: only the organiser removes attendees: ' || r)::text);
  END IF;
  -- Deleted: the one person left is rung once, the removed one not again.
  r := pg_temp.cmb_try(u_crt, format('DELETE FROM calendar_events WHERE id = %L', e));
  n := n + 1;
  IF r <> 'ok' OR pg_temp.cmb_rung('calendar_cancelled', 'event_id', e) <> '004,005' THEN
    failed := array_append(failed, ('3: deleting rings once: ' || pg_temp.cmb_rung('calendar_cancelled', 'event_id', e))::text);
  END IF;
  -- A split without u_b rings them about that date only.
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, rrule)
  VALUES (a_acct, u_crt, 'CMB daily', tmr - interval '30 days', tmr - interval '30 days' + interval '1 hour', 'FREQ=DAILY')
  RETURNING id INTO s;
  INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (s, u_att, a_acct), (s, u_b, a_acct);
  -- ---------- 4. wording ----------
  n := n + 1;
  IF (SELECT count(*) FROM notifications WHERE type = 'calendar_invite' AND meta ->> 'event_id' = s::text AND body = 'Repeating event') <> 2 THEN
    failed := array_append(failed, '4: the invitation to a running series has no date'::text);
  END IF;
  UPDATE calendar_events SET title = 'CMB daily 2' WHERE id = s;
  n := n + 1;
  IF (SELECT count(*) FROM notifications WHERE type = 'calendar_update' AND meta ->> 'event_id' = s::text AND body = 'Repeating event updated') <> 2 THEN
    failed := array_append(failed, '4: a running series'' update has no date'::text);
  END IF;
  occ := tmr + interval '3 days';
  SELECT updated_at INTO ts FROM calendar_events WHERE id = s;
  r := pg_temp.cmb_try(u_crt, format('SELECT id::text FROM calendar_split_occurrence(%L, %L, %L, %L, %L)', s, ts, occ,
         jsonb_build_object('start_at', occ, 'end_at', occ + interval '1 hour'), ARRAY[u_att]));
  n := n + 1;
  IF r LIKE 'ERROR%' OR pg_temp.cmb_rung('calendar_cancelled', 'event_id', s) <> '005'
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_cancelled' AND user_id = u_b
                       AND meta = jsonb_build_object('event_id', s, 'occurrence_start', occ)
                       AND body = 'You are no longer invited · was ' || to_char(occ AT TIME ZONE 'Asia/Dubai', 'DD Mon YYYY HH24:MI') || ' Asia/Dubai') THEN
    failed := array_append(failed, ('3: a split tells the person left out: ' || r)::text);
  END IF;
  -- A date that is over: split or cancelled, silently.
  occ := tmr - interval '10 days';
  SELECT updated_at INTO ts FROM calendar_events WHERE id = s;
  r := pg_temp.cmb_try(u_crt, format('SELECT id::text FROM calendar_split_occurrence(%L, %L, %L, %L, %L)', s, ts, occ,
         jsonb_build_object('start_at', occ, 'end_at', occ + interval '1 hour'), ARRAY[u_att]));
  n := n + 1;
  IF r LIKE 'ERROR%' OR pg_temp.cmb_rung('calendar_cancelled', 'event_id', s) <> '005'
     OR pg_temp.cmb_rung('calendar_update', 'event_id', CASE WHEN r LIKE 'ERROR%' THEN NULL ELSE r::uuid END) <> '' THEN
    failed := array_append(failed, ('4: splitting a past date rang: ' || r)::text);
  END IF;
  SELECT updated_at INTO ts FROM calendar_events WHERE id = s;
  r := pg_temp.cmb_try(u_crt, format('SELECT calendar_cancel_occurrence(%L, %L, %L)::text', s, ts, tmr - interval '9 days'));
  n := n + 1;
  IF r LIKE 'ERROR%' OR pg_temp.cmb_rung('calendar_cancelled', 'event_id', s) <> '005' THEN
    failed := array_append(failed, ('4: cancelling a past date rang: ' || r)::text);
  END IF;
  SELECT updated_at INTO ts FROM calendar_events WHERE id = s;
  r := pg_temp.cmb_try(u_crt, format('SELECT title FROM calendar_update_event(%L, %L, %L, %L)', s, ts, '{}', ARRAY[u_att]));
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_cancelled' AND user_id = u_b
                    AND meta = jsonb_build_object('event_id', s) AND body = 'Repeating event · you are no longer invited') THEN
    failed := array_append(failed, ('3: a person taken off a running series is rung, no date: ' || r)::text);
  END IF;
  DELETE FROM calendar_events WHERE id = s;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_cancelled' AND user_id = u_att
                    AND meta = jsonb_build_object('event_id', s) AND body = 'Repeating event cancelled') THEN
    failed := array_append(failed, '4: a running series'' cancellation has no date'::text);
  END IF;

  -- Over: a one-off, then a series. Invited, answered, renamed, taken off,
  -- cancelled / deleted: no bell at all.
  FOREACH r IN ARRAY ARRAY['one', 'series'] LOOP
    INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, rrule, series_end_at)
    VALUES (a_acct, u_crt, 'CMB over ' || r, now() - interval '10 days', now() - interval '10 days' + interval '1 hour',
            CASE r WHEN 'series' THEN 'FREQ=DAILY;COUNT=2' END,
            CASE r WHEN 'series' THEN now() - interval '8 days' END) RETURNING id INTO e;
    INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (e, u_att, a_acct), (e, u_b, a_acct);
    UPDATE calendar_event_attendees SET response = 'accepted' WHERE event_id = e AND user_id = u_att;
    UPDATE calendar_events SET title = 'CMB over 2' WHERE id = e;
    SELECT updated_at INTO ts FROM calendar_events WHERE id = e;
    PERFORM pg_temp.cmb_try(u_crt, format('SELECT title FROM calendar_update_event(%L, %L, %L, %L)', e, ts, '{}', ARRAY[u_att]));
    n := n + 1;
    IF EXISTS (SELECT 1 FROM calendar_event_attendees WHERE event_id = e AND user_id = u_b) THEN
      failed := array_append(failed, ('4: fixture: the removal from a past ' || r || ' did not happen')::text);
    END IF;
    IF r = 'one' THEN DELETE FROM calendar_events WHERE id = e;
    ELSE UPDATE calendar_events SET status = 'cancelled' WHERE id = e; END IF;
    n := n + 1;
    IF EXISTS (SELECT 1 FROM notifications WHERE meta ->> 'event_id' = e::text) THEN
      failed := array_append(failed, ('4: a past ' || r || ' rang ' || (SELECT string_agg(DISTINCT type, ',') FROM notifications WHERE meta ->> 'event_id' = e::text))::text);
    END IF;
  END LOOP;
  -- Today's all-day event stored with end = start is not over; an old one
  -- moved ahead rings.
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, all_day)
  VALUES (a_acct, u_crt, 'CMB today', date_trunc('day', now()), date_trunc('day', now()), true) RETURNING id INTO e;
  INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (e, u_att, a_acct);
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at)
  VALUES (a_acct, u_crt, 'CMB moved', now() - interval '2 days', now() - interval '1 day') RETURNING id INTO s;
  INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (s, u_att, a_acct);
  UPDATE calendar_events SET start_at = tmr, end_at = tmr + interval '1 hour' WHERE id = s;
  n := n + 1;
  IF pg_temp.cmb_rung('calendar_invite', 'event_id', e) <> '004' OR pg_temp.cmb_rung('calendar_update', 'event_id', s) <> '004' THEN
    failed := array_append(failed, '4: today''s all-day event and an old one moved ahead ring'::text);
  END IF;

  -- ---------- 5. a leaver's events ----------
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, rrule)
  VALUES (a_acct, u_gone, 'CMB leaver', tmr, tmr + interval '1 hour', 'FREQ=DAILY') RETURNING id INTO e;
  INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (e, u_att, a_acct);
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, visibility)
  VALUES (a_acct, u_gone, 'CMB leaver private', tmr, tmr + interval '1 hour', 'private') RETURNING id INTO s;
  -- Invited to the private one: the admin sees it, and still may not remove it.
  INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (s, u_adm, a_acct);
  SELECT updated_at INTO ts FROM calendar_events WHERE id = e;
  -- While they are still here: the creator's alone.
  r := pg_temp.cmb_try(u_adm, format('WITH d AS (DELETE FROM calendar_events WHERE id = %L RETURNING 1) SELECT count(*)::text FROM d', e))
       || '/' || pg_temp.cmb_try(u_adm, format('SELECT calendar_event_can_remove(%L)::text', e))
       || '/' || left(pg_temp.cmb_try(u_adm, format('SELECT calendar_cancel_occurrence(%L, %L, %L)::text', e, ts, tmr)), 11);
  n := n + 1;
  IF r <> '0/false/ERROR 42501' THEN failed := array_append(failed, ('5: an admin and a live creator''s event: ' || r)::text); END IF;
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  -- Deletes and cancels, never edits; not an agent, not the private one.
  SELECT updated_at INTO ts FROM calendar_events WHERE id = e;
  r := pg_temp.cmb_try(u_adm, format('WITH d AS (UPDATE calendar_events SET title = %L WHERE id = %L RETURNING 1) SELECT count(*)::text FROM d', 'x', e))
       || '/' || left(pg_temp.cmb_try(u_adm, format('SELECT title FROM calendar_update_event(%L, %L, %L)', e, ts, '{"title": "x"}')), 11)
       || '/' || left(pg_temp.cmb_try(u_adm, format('SELECT title FROM calendar_split_occurrence(%L, %L, %L, %L)', e, ts, tmr, '{}')), 11)
       || '/' || pg_temp.cmb_try(u_att, format('WITH d AS (DELETE FROM calendar_events WHERE id = %L RETURNING 1) SELECT count(*)::text FROM d', e))
       || '/' || pg_temp.cmb_try(u_adm, format('WITH d AS (DELETE FROM calendar_events WHERE id = %L RETURNING 1) SELECT count(*)::text FROM d', s))
       || '/' || pg_temp.cmb_try(u_adm, format('SELECT calendar_event_can_remove(%L)::text', s));
  n := n + 1;
  IF r <> '0/ERROR 42501/ERROR 42501/0/0/false' THEN
    failed := array_append(failed, ('5: a leaver''s event: an edit, an agent or a private one: ' || r)::text);
  END IF;
  n := n + 1;
  IF pg_temp.cmb_try(u_own, format('SELECT count(*)::text FROM calendar_events WHERE id = %L', s)) <> '0' THEN
    failed := array_append(failed, '5: an owner reads a leaver''s private event'::text);
  END IF;
  r := pg_temp.cmb_try(u_adm, format('SELECT calendar_event_can_remove(%L)::text', e))
       || '/' || left(pg_temp.cmb_try(u_adm, format('SELECT calendar_cancel_occurrence(%L, %L, %L)::text', e, ts, tmr)), 5);
  n := n + 1;
  IF r LIKE '%ERROR%' OR r NOT LIKE 'true/%' OR pg_temp.cmb_rung('calendar_cancelled', 'event_id', e) <> '004' THEN
    failed := array_append(failed, ('5: an admin cancels one date of a leaver''s series: ' || r)::text);
  END IF;
  r := pg_temp.cmb_try(u_adm, format('WITH d AS (DELETE FROM calendar_events WHERE id = %L RETURNING 1) SELECT count(*)::text FROM d', e));
  n := n + 1;
  IF r <> '1' OR pg_temp.cmb_rung('calendar_cancelled', 'event_id', e) <> '004,004' THEN
    failed := array_append(failed, ('5: an admin deletes a leaver''s event, its attendees rung: ' || r)::text);
  END IF;

  -- ---------- privileges ----------
  n := n + 1;
  IF has_function_privilege('anon', 'public.calendar_event_can_remove(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.calendar_remove_attendees(uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.calendar_ring_removed(public.calendar_events, uuid[], timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.calendar_series_for_cancel(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.meetings_notify()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.push_bell_url(public.notifications)', 'EXECUTE') THEN
    failed := array_append(failed, 'privileges: a 278 function is open to the wrong role'::text);
  END IF;

  RAISE EXCEPTION 'cmb278_sentinel';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'cmb278_sentinel' THEN RAISE; END IF;
  END;

  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-calendar-meeting-bells: % of % checks failed: %', cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-calendar-meeting-bells: % checks passed', n;
END
$verify$;
