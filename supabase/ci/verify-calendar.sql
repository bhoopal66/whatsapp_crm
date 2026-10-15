-- Behavioural regression suite for the staff calendar (migration 108).
--
-- Who sees an event is calendar_event_can_view: a live, non-guest
-- member active in its workspace who created it, is an attendee, or
-- anyone there when it is visibility 'workspace', or an owner/admin
-- unless it is 'private'. Only the creator edits or deletes it, admins
-- included; an attendee changes only their own response and reminders.
-- This asserts those rules (a bank guest, a deactivated member and
-- another workspace see nothing), the attendee guard (live staff of the
-- workspace, never the creator, no response chosen for someone else),
-- the column checks, the calendar_invite / calendar_update /
-- calendar_cancelled / calendar_response bells and who gets them, the
-- reminder sweep (once per key, never a declined attendee, the
-- attendee's own offsets, meetings at 10 and 0 minutes, tasks 15
-- minutes before due), calendar_insert_reminder for recurring
-- occurrences, the notification type list, the grants and the realtime
-- publication.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000108001';
  u_admin UUID := '00000000-0000-4000-8000-000000108002';
  u_crt   UUID := '00000000-0000-4000-8000-000000108003';
  u_att   UUID := '00000000-0000-4000-8000-000000108004';
  u_dec   UUID := '00000000-0000-4000-8000-000000108005';
  u_out   UUID := '00000000-0000-4000-8000-000000108006';
  u_guest UUID := '00000000-0000-4000-8000-000000108007';
  u_gone  UUID := '00000000-0000-4000-8000-000000108008';
  u_other UUID := '00000000-0000-4000-8000-000000108009';
  u_own5  UUID := '00000000-0000-4000-8000-000000108010';
  a_acct  UUID;
  b_acct  UUID;
  e_main  UUID;   -- attendees: u_att, u_dec (declines), u_own5 (own {5})
  e_priv  UUID;   -- private, attendee u_att
  e_ws    UUID;   -- visibility workspace
  e_upd   UUID;   -- updated then cancelled, attendees u_att, u_dec
  e_del   UUID;   -- deleted, attendee u_att
  e_rec   UUID;   -- recurring, attendees u_att, u_dec (declined)
  m_one   UUID;
  t_open  UUID;
  r       TEXT;
  k       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- a SELECT's (or WITH's) value, 'ok', or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cal_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- Fixture: account A (owner, admin, five agents, a bank guest, an
  -- agent deactivated below), account B (owner).
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cal-owner@example.invalid'),
    (u_admin, 'cal-admin@example.invalid'),
    (u_crt,   'cal-crt@example.invalid'),
    (u_att,   'cal-att@example.invalid'),
    (u_dec,   'cal-dec@example.invalid'),
    (u_out,   'cal-out@example.invalid'),
    (u_guest, 'cal-guest@example.invalid'),
    (u_gone,  'cal-gone@example.invalid'),
    (u_other, 'cal-other@example.invalid'),
    (u_own5,  'cal-own5@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_crt, u_att, u_dec, u_out, u_gone, u_own5);
  UPDATE profiles SET full_name = 'Dee Clined' WHERE user_id = u_dec;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  -- ---------- creating ----------
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'WITH x AS (INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at) VALUES (%L, %L, %L, %L, %L) RETURNING id) SELECT id::text FROM x',
    a_acct, u_crt, '  Cal main  ', '2030-01-07 09:10+00', '2030-01-07 10:10+00'));
  n := n + 1;
  IF r NOT SIMILAR TO '[0-9a-f-]{36}' THEN
    RAISE EXCEPTION 'fixture: creator could not create an event with RETURNING: %', r;
  END IF;
  e_main := r::uuid;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM calendar_events WHERE id = e_main AND title = 'Cal main'
                    AND visibility = 'attendees' AND reminders = '{10}' AND status = 'confirmed') THEN
    failed := array_append(failed, 'a new event''s title is trimmed, visibility attendees, reminders {10}'::text);
  END IF;
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, visibility)
  VALUES (a_acct, u_crt, 'Cal private', '2030-02-01 09:00+00', '2030-02-01 10:00+00', 'private') RETURNING id INTO e_priv;
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, visibility)
  VALUES (a_acct, u_crt, 'Cal workspace', '2030-02-02 09:00+00', '2030-02-02 10:00+00', 'workspace') RETURNING id INTO e_ws;
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at)
  VALUES (a_acct, u_crt, 'Cal update', '2030-02-03 09:00+00', '2030-02-03 10:00+00') RETURNING id INTO e_upd;
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at)
  VALUES (a_acct, u_crt, 'Cal delete', '2030-02-04 09:00+00', '2030-02-04 10:00+00') RETURNING id INTO e_del;
  INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at, rrule, time_zone)
  VALUES (a_acct, u_crt, 'Cal daily', '2030-01-10 09:00+00', '2030-01-10 09:30+00', 'FREQ=DAILY;COUNT=5', 'Asia/Dubai')
  RETURNING id INTO e_rec;

  r := pg_temp.cal_try('authenticated', u_guest, format(
    'INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at) VALUES (%L, %L, %L, %L, %L)',
    a_acct, u_guest, 'Cal guest', '2030-01-07 09:00+00', '2030-01-07 10:00+00'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' AND r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('bank guest created an event: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_out, format(
    'INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at) VALUES (%L, %L, %L, %L, %L)',
    a_acct, u_crt, 'Cal forged', '2030-01-07 09:00+00', '2030-01-07 10:00+00'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('agent created an event as someone else: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_out, format(
    'INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at) VALUES (%L, %L, %L, %L, %L)',
    b_acct, u_out, 'Cal B', '2030-01-07 09:00+00', '2030-01-07 10:00+00'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' AND r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('agent created an event in another workspace: ' || r)::text); END IF;
  r := pg_temp.cal_try('service_role', NULL, format(
    'INSERT INTO calendar_events (account_id, created_by, title, start_at, end_at) VALUES (%L, %L, %L, %L, %L)',
    a_acct, u_other, 'Cal outsider', '2030-01-07 09:00+00', '2030-01-07 10:00+00'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('service role created an event for a non-member: ' || r)::text); END IF;

  -- Column checks.
  FOREACH k IN ARRAY ARRAY[
    'color = ''black''', 'rrule = ''RRULE:FREQ=DAILY''', 'rrule = ''FREQ=DAILY
DTSTART:20300101''', 'reminders = ''{-1}''', 'reminders = ''{1,2,3,4,5,6}''',
    'reminders = ''{40321}''', 'visibility = ''team''', 'status = ''tentative''',
    'end_at = start_at', 'title = ''   ''', 'reminders = ''{10,NULL}'''] LOOP
    r := pg_temp.cal_try('authenticated', u_crt, format('UPDATE calendar_events SET %s WHERE id = %L', k, e_ws));
    n := n + 1;
    IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('column check let through ' || k || ': ' || r)::text); END IF;
  END LOOP;
  r := pg_temp.cal_try('authenticated', u_crt, format('UPDATE calendar_events SET time_zone = %L WHERE id = %L', '+04', e_ws));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023:%' THEN failed := array_append(failed, ('a POSIX time zone was accepted: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'UPDATE calendar_events SET all_day = true, end_at = start_at, reminders = %L WHERE id = %L', '{}', e_ws));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('an all-day single day (end = start) with no reminders was refused: ' || r)::text); END IF;

  -- ---------- inviting, and the bell ----------
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (%L, %L, %L), (%L, %L, %L)',
    e_main, u_att, a_acct, e_main, u_dec, a_acct));
  n := n + 1;
  IF r <> 'ok' THEN failed := array_append(failed, ('creator invites colleagues: ' || r)::text); END IF;
  n := n + 1;
  IF (SELECT count(*) FROM notifications
       WHERE type = 'calendar_invite' AND account_id = a_acct AND user_id IN (u_att, u_dec)
         AND actor_user_id = u_crt AND title = 'Cal main'
         AND body = 'Starts 07 Jan 2030 09:10 UTC'
         AND meta = jsonb_build_object('event_id', e_main)) <> 2
     OR EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_invite' AND user_id = u_crt) THEN
    failed := array_append(failed, 'an invitation rings each attendee (not the creator), labelled UTC with no saved zone, meta {event_id}'::text);
  END IF;
  -- With a saved account time zone the bell shows it.
  INSERT INTO team_activity_settings (account_id, timezone) VALUES (a_acct, 'Asia/Dubai')
  ON CONFLICT (account_id) DO UPDATE SET timezone = EXCLUDED.timezone;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'INSERT INTO calendar_event_attendees (event_id, user_id, account_id, reminders) VALUES (%L, %L, %L, %L)',
    e_main, u_own5, a_acct, '{5}'));
  n := n + 1;
  IF r <> 'ok' OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_invite' AND user_id = u_own5
                                 AND body = 'Starts 07 Jan 2030 13:10 Asia/Dubai') THEN
    failed := array_append(failed, ('the invitation shows the account''s saved time zone: ' || r)::text);
  END IF;
  INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES
    (e_priv, u_att, a_acct), (e_upd, u_att, a_acct), (e_upd, u_dec, a_acct),
    (e_del, u_att, a_acct), (e_rec, u_att, a_acct), (e_rec, u_dec, a_acct);

  r := pg_temp.cal_try('authenticated', u_crt, format(
    'INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (%L, %L, %L)', e_ws, u_crt, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('the creator was listed as an attendee: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (%L, %L, %L)', e_ws, u_guest, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('a bank guest was invited: ' || r)::text); END IF;
  r := pg_temp.cal_try('service_role', NULL, format(
    'INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (%L, %L, %L)', e_ws, u_other, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('someone from another workspace was invited: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'INSERT INTO calendar_event_attendees (event_id, user_id, account_id, response) VALUES (%L, %L, %L, %L)', e_ws, u_out, a_acct, 'accepted'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('the creator answered for an attendee: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_out, format(
    'INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (%L, %L, %L)', e_ws, u_out, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a non-creator added an attendee: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_admin, format(
    'INSERT INTO calendar_event_attendees (event_id, user_id, account_id) VALUES (%L, %L, %L)', e_ws, u_out, a_acct));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('an admin added an attendee to someone else''s event: ' || r)::text); END IF;

  -- Deactivated after the invitations.
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  -- ---------- who sees ----------
  FOREACH k IN ARRAY ARRAY[
    format('out|%s|0', e_main), format('out|%s|1', e_ws), format('admin|%s|1', e_main),
    format('admin|%s|0', e_priv), format('owner|%s|0', e_priv), format('att|%s|1', e_priv),
    format('att|%s|1', e_main), format('crt|%s|1', e_priv)] LOOP
    r := pg_temp.cal_try('authenticated',
      CASE split_part(k, '|', 1) WHEN 'out' THEN u_out WHEN 'admin' THEN u_admin WHEN 'owner' THEN u_owner
                                 WHEN 'att' THEN u_att ELSE u_crt END,
      format('SELECT count(*)::text FROM calendar_events WHERE id = %L', split_part(k, '|', 2)));
    n := n + 1;
    IF r <> split_part(k, '|', 3) THEN
      failed := array_append(failed, ('event visibility ' || k || ' saw ' || r)::text);
    END IF;
  END LOOP;
  r := pg_temp.cal_try('authenticated', u_out, format(
    'SELECT count(*)::text FROM calendar_event_attendees WHERE event_id = %L', e_main));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('a non-attendee read an event''s attendees: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_admin, format(
    'SELECT count(*)::text FROM calendar_event_attendees WHERE event_id = %L', e_priv));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('an admin read a private event''s attendees: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_att, format(
    'SELECT count(*)::text FROM calendar_event_attendees WHERE event_id = %L', e_main));
  n := n + 1;
  IF r <> '3' THEN failed := array_append(failed, ('an attendee reads the event''s attendee list: ' || r)::text); END IF;
  FOREACH k IN ARRAY ARRAY[u_guest::text, u_gone::text, u_other::text] LOOP
    r := pg_temp.cal_try('authenticated', k::uuid, format(
      'SELECT (SELECT count(*) FROM calendar_events WHERE account_id = %L) + (SELECT count(*) FROM calendar_event_attendees WHERE account_id = %L) || %L',
      a_acct, a_acct, ''));
    n := n + 1;
    IF r <> '0' THEN failed := array_append(failed, ('guest / deactivated / other workspace saw the calendar (' || k || '): ' || r)::text); END IF;
  END LOOP;

  -- ---------- who edits: the creator only ----------
  FOREACH k IN ARRAY ARRAY[u_admin::text, u_owner::text, u_out::text] LOOP
    r := pg_temp.cal_try('authenticated', k::uuid, format(
      'UPDATE calendar_events SET title = %L WHERE id = %L', 'hijacked', e_ws));
    n := n + 1;
    IF r NOT IN ('ok') OR (SELECT title FROM calendar_events WHERE id = e_ws) <> 'Cal workspace' THEN
      failed := array_append(failed, ('someone other than the creator edited an event (' || k || '): ' || r)::text);
    END IF;
    r := pg_temp.cal_try('authenticated', k::uuid, format('DELETE FROM calendar_events WHERE id = %L', e_ws));
    n := n + 1;
    IF NOT EXISTS (SELECT 1 FROM calendar_events WHERE id = e_ws) THEN
      failed := array_append(failed, ('someone other than the creator deleted an event (' || k || ')')::text);
    END IF;
  END LOOP;
  r := pg_temp.cal_try('authenticated', u_att, format(
    'UPDATE calendar_events SET title = %L WHERE id = %L', 'attendee edit', e_main));
  n := n + 1;
  IF (SELECT title FROM calendar_events WHERE id = e_main) <> 'Cal main' THEN
    failed := array_append(failed, 'an attendee edited the event'::text);
  END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'UPDATE calendar_events SET title = %L WHERE id = %L', 'Cal workspace 2', e_ws));
  n := n + 1;
  IF r <> 'ok' OR (SELECT title FROM calendar_events WHERE id = e_ws) <> 'Cal workspace 2' THEN
    failed := array_append(failed, ('the creator edits their event: ' || r)::text);
  END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'UPDATE calendar_events SET created_by = %L WHERE id = %L', u_out, e_ws));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514:%' THEN failed := array_append(failed, ('an event''s creator was changed: ' || r)::text); END IF;

  -- ---------- responses ----------
  r := pg_temp.cal_try('authenticated', u_dec, format(
    'UPDATE calendar_event_attendees SET response = %L WHERE event_id IN (%L, %L, %L) AND user_id = %L',
    'declined', e_main, e_rec, e_upd, u_dec));
  n := n + 1;
  IF r <> 'ok' OR (SELECT count(*) FROM calendar_event_attendees
                    WHERE user_id = u_dec AND response = 'declined' AND responded_at IS NOT NULL) <> 3 THEN
    failed := array_append(failed, ('an attendee declines, responded_at stamped: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM notifications
                  WHERE type = 'calendar_response' AND user_id = u_crt AND actor_user_id = u_dec
                    AND body = 'Dee Clined declined'
                    AND meta->>'event_id' = e_main::text AND meta->>'response' = 'declined') THEN
    failed := array_append(failed, 'a response rings the creator with meta {event_id, response}'::text);
  END IF;
  r := pg_temp.cal_try('authenticated', u_att, format(
    'UPDATE calendar_event_attendees SET response = %L WHERE event_id = %L', 'accepted', e_main));
  n := n + 1;
  IF (SELECT response FROM calendar_event_attendees WHERE event_id = e_main AND user_id = u_dec) <> 'declined'
     OR (SELECT response FROM calendar_event_attendees WHERE event_id = e_main AND user_id = u_att) <> 'accepted' THEN
    failed := array_append(failed, ('an attendee changed only their own response: ' || r)::text);
  END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'UPDATE calendar_event_attendees SET response = %L WHERE event_id = %L AND user_id = %L', 'pending', e_main, u_att));
  n := n + 1;
  IF (SELECT response FROM calendar_event_attendees WHERE event_id = e_main AND user_id = u_att) <> 'accepted' THEN
    failed := array_append(failed, 'the creator changed an attendee''s response'::text);
  END IF;
  r := pg_temp.cal_try('authenticated', u_att, format(
    'UPDATE calendar_event_attendees SET user_id = %L WHERE event_id = %L AND user_id = %L', u_out, e_main, u_att));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('an attendee wrote a column other than response/reminders: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_att, format(
    'DELETE FROM calendar_event_attendees WHERE event_id = %L AND user_id = %L', e_main, u_att));
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM calendar_event_attendees WHERE event_id = e_main AND user_id = u_att) THEN
    failed := array_append(failed, 'an attendee removed an attendee row'::text);
  END IF;

  -- ---------- update / cancel / delete bells ----------
  r := pg_temp.cal_try('authenticated', u_crt, format('UPDATE calendar_events SET color = %L, reminders = %L WHERE id = %L', 'teal', '{30}', e_upd));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_update' AND meta->>'event_id' = e_upd::text) THEN
    failed := array_append(failed, ('a colour / reminders change rang calendar_update: ' || r)::text);
  END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'UPDATE calendar_events SET start_at = %L, end_at = %L WHERE id = %L', '2030-02-03 11:00+00', '2030-02-03 12:00+00', e_upd));
  n := n + 1;
  IF r <> 'ok' OR (SELECT count(*) FROM notifications
                    WHERE type = 'calendar_update' AND meta = jsonb_build_object('event_id', e_upd)
                      AND user_id IN (u_att, u_dec) AND actor_user_id = u_crt) <> 2
     OR EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_update' AND user_id = u_crt) THEN
    failed := array_append(failed, ('a time change rings calendar_update to every attendee, not the creator: ' || r)::text);
  END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format('UPDATE calendar_events SET status = %L WHERE id = %L', 'cancelled', e_upd));
  n := n + 1;
  IF r <> 'ok' OR (SELECT count(*) FROM notifications
                    WHERE type = 'calendar_cancelled' AND meta = jsonb_build_object('event_id', e_upd)
                      AND user_id IN (u_att, u_dec)) <> 2 THEN
    failed := array_append(failed, ('cancelling rings calendar_cancelled to every attendee: ' || r)::text);
  END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format('DELETE FROM calendar_events WHERE id = %L', e_del));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM calendar_events WHERE id = e_del)
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'calendar_cancelled' AND user_id = u_att
                       AND meta = jsonb_build_object('event_id', e_del) AND title = 'Cal delete') THEN
    failed := array_append(failed, ('deleting rings calendar_cancelled to the attendees: ' || r)::text);
  END IF;

  -- ---------- the reminder sweep ----------
  r := pg_temp.cal_try('authenticated', u_owner, 'SELECT calendar_reminder_sweep(now())::text');
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a signed-in user ran the reminder sweep: ' || r)::text); END IF;
  -- e_main starts 09:10: offset 10 is due at 09:00 for the creator and
  -- u_att; u_dec declined; u_own5's own {5} is due at 09:05.
  r := pg_temp.cal_try('service_role', NULL, 'SELECT calendar_reminder_sweep(''2030-01-07 09:00+00'')::text');
  n := n + 1;
  IF r <> '2' OR (SELECT count(*) FROM notifications WHERE type = 'event_reminder'
                    AND user_id IN (u_crt, u_att) AND title = 'Cal main'
                    AND body = 'In 10 min · 07 Jan 2030 13:10 Asia/Dubai'
                    AND meta->>'event_id' = e_main::text) <> 2 THEN
    failed := array_append(failed, ('the sweep reminds the creator and accepted attendee once each: ' || r)::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND user_id = u_dec) THEN
    failed := array_append(failed, 'the sweep reminded a declined attendee'::text);
  END IF;
  r := pg_temp.cal_try('service_role', NULL, 'SELECT calendar_reminder_sweep(''2030-01-07 09:02+00'')::text');
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, ('a second sweep in the window rang again: ' || r)::text); END IF;
  r := pg_temp.cal_try('service_role', NULL, 'SELECT calendar_reminder_sweep(''2030-01-07 09:05+00'')::text');
  n := n + 1;
  IF r <> '1' OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND user_id = u_own5) THEN
    failed := array_append(failed, ('an attendee''s own reminder offsets are used: ' || r)::text);
  END IF;

  -- Meetings: 10 minutes before and at the start, host and invitees.
  INSERT INTO meetings (account_id, title, host_user_id, scheduled_start, scheduled_end)
  VALUES (a_acct, 'Cal meeting', u_crt, '2030-01-08 09:10+00', '2030-01-08 10:00+00') RETURNING id INTO m_one;
  INSERT INTO meeting_invitees (meeting_id, user_id, account_id) VALUES (m_one, u_att, a_acct);
  INSERT INTO meetings (account_id, title, host_user_id, scheduled_start, scheduled_end, status)
  VALUES (a_acct, 'Cal meeting off', u_out, '2030-01-08 09:10+00', '2030-01-08 10:00+00', 'scheduled');
  UPDATE meetings SET status = 'cancelled' WHERE title = 'Cal meeting off' AND account_id = a_acct;
  r := pg_temp.cal_try('service_role', NULL, 'SELECT calendar_reminder_sweep(''2030-01-08 09:01+00'')::text');
  n := n + 1;
  IF r <> '2' OR (SELECT count(*) FROM notifications WHERE type = 'meeting_reminder'
                    AND user_id IN (u_crt, u_att) AND meta = jsonb_build_object('meeting_id', m_one)
                    AND body LIKE 'In 10 min · %') <> 2 THEN
    failed := array_append(failed, ('a meeting reminds host and invitee 10 minutes before (not a cancelled one): ' || r)::text);
  END IF;
  r := pg_temp.cal_try('service_role', NULL, 'SELECT calendar_reminder_sweep(''2030-01-08 09:10+00'')::text');
  n := n + 1;
  IF r <> '2' OR (SELECT count(*) FROM notifications WHERE type = 'meeting_reminder'
                    AND meta = jsonb_build_object('meeting_id', m_one) AND body LIKE 'Starting now · %') <> 2 THEN
    failed := array_append(failed, ('a meeting rings "starting now" at its start: ' || r)::text);
  END IF;

  -- Tasks: 15 minutes before due, open ones only.
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at)
  VALUES (a_acct, 'manual', 'Cal task', u_att, u_crt, '2030-01-09 09:15+00') RETURNING id INTO t_open;
  INSERT INTO tasks (account_id, kind, title, assigned_to, created_by, due_at, status)
  VALUES (a_acct, 'manual', 'Cal task done', u_att, u_crt, '2030-01-09 09:15+00', 'done');
  r := pg_temp.cal_try('service_role', NULL, 'SELECT calendar_reminder_sweep(''2030-01-09 09:00+00'')::text');
  n := n + 1;
  IF r <> '1' OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'task_due' AND user_id = u_att
                                AND title = 'Cal task' AND meta = jsonb_build_object('task_id', t_open)) THEN
    failed := array_append(failed, ('an open task rings task_due 15 minutes before due: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM calendar_reminders_sent
                  WHERE key = 'tk:' || t_open || ':' || floor(extract(epoch FROM timestamptz '2030-01-09 09:15+00'))::bigint || ':' || u_att)
     OR NOT EXISTS (SELECT 1 FROM calendar_reminders_sent WHERE key = 'mt:' || m_one || ':0:' || u_att)
     OR NOT EXISTS (SELECT 1 FROM calendar_reminders_sent WHERE key = 'ev:' || e_main || ':1894007400:10:' || u_att) THEN
    failed := array_append(failed, 'the dedupe keys are not ev:/mt:/tk: as documented'::text);
  END IF;

  -- ---------- recurring occurrences, from TS ----------
  k := 'ev:' || e_rec || ':1894352400:10:' || u_att;
  r := pg_temp.cal_try('service_role', NULL, format(
    'SELECT calendar_insert_reminder(%L, %L, %L, %L, 10)::text', k, u_att, e_rec, '2030-01-11 09:00+00'));
  n := n + 1;
  IF r <> 'true' OR NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'event_reminder' AND user_id = u_att
                                   AND meta->>'event_id' = e_rec::text AND body = 'In 10 min · 11 Jan 2030 13:00 Asia/Dubai') THEN
    failed := array_append(failed, ('calendar_insert_reminder rings an occurrence: ' || r)::text);
  END IF;
  r := pg_temp.cal_try('service_role', NULL, format(
    'SELECT calendar_insert_reminder(%L, %L, %L, %L, 10)::text', k, u_att, e_rec, '2030-01-11 09:00+00'));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('calendar_insert_reminder rang the same key twice: ' || r)::text); END IF;
  r := pg_temp.cal_try('service_role', NULL, format(
    'SELECT calendar_insert_reminder(%L, %L, %L, %L, 10)::text',
    'ev:' || e_rec || ':1894352400:10:' || u_dec, u_dec, e_rec, '2030-01-11 09:00+00'));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('calendar_insert_reminder reminded a declined attendee: ' || r)::text); END IF;
  r := pg_temp.cal_try('service_role', NULL, format(
    'SELECT calendar_insert_reminder(%L, %L, %L, %L, 15)::text',
    'ev:' || e_rec || ':1894352400:15:' || u_att, u_att, e_rec, '2030-01-11 09:00+00'));
  n := n + 1;
  IF r <> 'false' THEN failed := array_append(failed, ('calendar_insert_reminder used an offset the person did not choose: ' || r)::text); END IF;
  r := pg_temp.cal_try('service_role', NULL, format(
    'SELECT calendar_insert_reminder(%L, %L, %L, %L, 10)::text', 'ev:anything', u_att, e_rec, '2030-01-12 09:00+00'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 22023:%' THEN failed := array_append(failed, ('calendar_insert_reminder took a key of another shape: ' || r)::text); END IF;
  r := pg_temp.cal_try('authenticated', u_crt, format(
    'SELECT calendar_insert_reminder(%L, %L, %L, %L, 10)::text',
    'ev:' || e_rec || ':1894438800:10:' || u_crt, u_crt, e_rec, '2030-01-12 09:00+00'));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501:%' THEN failed := array_append(failed, ('a signed-in user called calendar_insert_reminder: ' || r)::text); END IF;

  -- ---------- types, grants, RLS, realtime ----------
  FOREACH k IN ARRAY ARRAY['calendar_invite', 'calendar_update', 'calendar_cancelled', 'calendar_response',
                           'event_reminder', 'meeting_reminder', 'task_due'] LOOP
    r := pg_temp.cal_try('service_role', NULL, format(
      'INSERT INTO notifications (account_id, user_id, type, title) VALUES (%L, %L, %L, %L)', a_acct, u_out, k, 'x'));
    n := n + 1;
    IF r <> 'ok' THEN failed := array_append(failed, ('notifications_type_check refuses ' || k || ': ' || r)::text); END IF;
  END LOOP;
  n := n + 1;
  IF NOT coalesce(pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'notifications_type_check'
                                         AND conrelid = 'public.notifications'::regclass))
                  LIKE ALL (ARRAY['%''meeting_invite''%', '%''pbx_connection_restored''%', '%''conversation_assigned''%',
                                  '%''chat_broadcast''%', '%''task_assigned''%']), false) THEN
    failed := array_append(failed, 'notifications_type_check lost an older type'::text);
  END IF;
  n := n + 1;
  IF has_table_privilege('anon', 'public.calendar_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.calendar_events', 'TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.calendar_event_attendees', 'TRUNCATE')
     OR has_column_privilege('authenticated', 'public.calendar_event_attendees', 'account_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.calendar_event_attendees', 'event_id', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.calendar_event_attendees', 'response', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.calendar_reminders_sent', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_function_privilege('authenticated', 'public.calendar_reminder_sweep(timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.calendar_reminder_sweep(timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.calendar_insert_reminder(text, uuid, uuid, timestamptz, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.calendar_event_can_view(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.calendar_event_can_view(uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'calendar grants are wider (or narrower) than the policies need'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE oid IN ('public.calendar_event_can_view(uuid)'::regprocedure,
                            'public.calendar_event_can_edit(uuid)'::regprocedure,
                            'public.calendar_reminder_sweep(timestamptz)'::regprocedure,
                            'public.calendar_insert_reminder(text, uuid, uuid, timestamptz, integer)'::regprocedure)
                AND NOT (prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp'])) THEN
    failed := array_append(failed, 'a calendar function is not SECURITY DEFINER with a pinned search_path'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_class
              WHERE oid IN ('public.calendar_events'::regclass, 'public.calendar_event_attendees'::regclass,
                            'public.calendar_reminders_sent'::regclass)
                AND NOT (relrowsecurity AND relforcerowsecurity)) THEN
    failed := array_append(failed, 'row-level security is not forced on every calendar table'::text);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND (SELECT count(*) FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
             AND tablename IN ('calendar_events', 'calendar_event_attendees')) <> 2 THEN
    failed := array_append(failed, 'calendar_events and calendar_event_attendees are not in supabase_realtime'::text);
  END IF;

  -- Deleting a creator's login cascades their events; the cancellation
  -- bells must not reference the deleted user and abort the delete.
  -- (The workspace the sign-up trigger made for them changes owner first.)
  UPDATE accounts SET owner_user_id = u_owner WHERE owner_user_id = u_crt;
  r := pg_temp.cal_try('postgres', NULL, format('DELETE FROM auth.users WHERE id = %L', u_crt));
  n := n + 1;
  IF r <> 'ok' OR EXISTS (SELECT 1 FROM calendar_events WHERE created_by = u_crt) THEN
    failed := array_append(failed, ('deleting an event creator''s login failed: ' || r)::text);
  END IF;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT108', MESSAGE = 'verify-calendar rollback';
  EXCEPTION WHEN SQLSTATE 'ZT108' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'calendar verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'calendar verification passed (% checks)', n;
END
$verify$;
