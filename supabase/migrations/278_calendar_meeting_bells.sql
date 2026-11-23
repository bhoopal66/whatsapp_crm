-- 278: calendar and meeting bells that were missing, wrong or late.
--
--  1. meeting_update / meeting_cancelled: a moved or cancelled meeting
--     rings its invitees (not the actor, not a removed person, live staff
--     only). Before this it told nobody.
--  2. The meeting invitation gives its time with calendar_time_label (the
--     account's zone), not in UTC. 'Starting now' stays exact: the invite
--     pop-up is pinned to it (src/lib/meetings/invite-ring.ts).
--  3. A person taken off an event, or off one date of a series, gets
--     calendar_cancelled. In the functions, not in a DELETE trigger, so
--     deleting an event does not ring twice.
--  4. A series whose first date is past is called "Repeating event …", with
--     no date; an event (or series) that is over rings nobody.
--  5. A leaver's event: owners and admins may delete it, or cancel one of
--     its dates. Never edit it, never a private one.
--
-- The type list and the functions changed by a line (push_bell_url,
-- calendar_update_event, calendar_split_occurrence,
-- calendar_cancel_occurrence) are patched from their live body, as 274
-- does. Restated whole: meeting_invitees_notify (from 106),
-- calendar_events_notify and calendar_event_attendees_notify (from 108).
-- Re-applying 106 or 108 brings the old bodies back: apply 278 again (on a
-- live database neither can be re-run whole: their shorter type list no
-- longer fits the rows). Apply with ON_ERROR_STOP, over one direct session.
--
-- Re-runnable. Writes no rows, so nothing rings while it is applied.

SET lock_timeout = '5s';

-- ---------- 0. Refuse before the first change ----------

DO $$
DECLARE
  p     record;
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '278 must be applied by a superuser or BYPASSRLS role (the calendar functions read RLS-forced tables)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check') THEN
    RAISE EXCEPTION '278: notifications_type_check is missing';
  END IF;

  DROP TABLE IF EXISTS pg_temp.patch_278;
  CREATE TEMP TABLE patch_278 (n int, fn text, old text, new text);
  INSERT INTO patch_278 VALUES
    (1, 'public.push_bell_url(public.notifications)',
     'n.type = ''meeting_invite''',
     'n.type IN (''meeting_invite'', ''meeting_update'', ''meeting_cancelled'')'),
    (2, 'public.calendar_update_event(uuid, timestamptz, jsonb, uuid[])',
     '    DELETE FROM calendar_event_attendees
     WHERE event_id = p_event AND user_id <> ALL (v_people);',
     '    PERFORM calendar_remove_attendees(p_event, v_people);'),
    (3, 'public.calendar_split_occurrence(uuid, timestamptz, timestamptz, jsonb, uuid[])',
     '  IF v_copy.status = ''confirmed'' THEN',
     '  -- 278: an occurrence that is over, and stays in the past, rings nobody.
  IF v_copy.status = ''confirmed''
     AND NOT (calendar_span_over(v_copy.start_at, v_copy.end_at, v_copy.all_day)
              AND calendar_span_over(p_occurrence_start, p_occurrence_start + (v_series.end_at - v_series.start_at),
                                     v_series.all_day)) THEN'),
    (4, 'public.calendar_split_occurrence(uuid, timestamptz, timestamptz, jsonb, uuid[])',
     '  UPDATE calendar_events SET exdates = array_append(exdates, p_occurrence_start)',
     '  -- 278: on the series, but not asked to this date.
  PERFORM calendar_ring_removed(v_series,
    ARRAY(SELECT a.user_id FROM calendar_event_attendees a
           WHERE a.event_id = p_event AND a.user_id <> ALL (v_people)),
    p_occurrence_start);

  UPDATE calendar_events SET exdates = array_append(exdates, p_occurrence_start)'),
    (5, 'public.calendar_cancel_occurrence(uuid, timestamptz, timestamptz)',
     'calendar_series_for_write(p_event)',
     'calendar_series_for_cancel(p_event)'),
    (6, 'public.calendar_cancel_occurrence(uuid, timestamptz, timestamptz)',
     '  IF v_series.status = ''confirmed'' THEN',
     '  IF v_series.status = ''confirmed''
     AND NOT calendar_span_over(p_occurrence_start, p_occurrence_start + (v_series.end_at - v_series.start_at),
                                v_series.all_day) THEN');
  FOR p IN SELECT * FROM patch_278 ORDER BY n LOOP
    v_def := pg_get_functiondef(p.fn::regprocedure);
    IF position(p.new IN v_def) = 0 AND position(p.old IN v_def) = 0 THEN
      RAISE EXCEPTION '278: % has no text to patch (%)', p.fn, p.old;
    END IF;
  END LOOP;
END $$;

-- ---------- 1. The two types ----------

DO $$
DECLARE
  v_def  text;
  v_list text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';
  IF position(quote_literal('meeting_update') IN v_def) = 0
     OR position(quote_literal('meeting_cancelled') IN v_def) = 0 THEN
    SELECT string_agg(quote_literal(x), ', ') INTO v_list
      FROM (SELECT DISTINCT q.m[1] AS x FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS q(m)
            UNION SELECT 'meeting_update'
            UNION SELECT 'meeting_cancelled') vals;
    ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
    EXECUTE format('ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (%s)) NOT VALID',
                   v_list);
    ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_type_check;
  END IF;
END $$;

-- ---------- 2. Is it over ----------

-- An all-day single day may be stored with end = start (108): it lasts
-- the day.
CREATE OR REPLACE FUNCTION public.calendar_span_over(
  p_start timestamptz, p_end timestamptz, p_all_day boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_all_day AND p_end <= p_start THEN p_start + interval '1 day' ELSE p_end END <= now();
$$;

-- A one-off that has ended; a series whose last occurrence has
-- (series_end_at NULL: unbounded, never over).
CREATE OR REPLACE FUNCTION public.calendar_event_over(e public.calendar_events)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN e.rrule IS NULL THEN calendar_span_over(e.start_at, e.end_at, e.all_day)
    WHEN e.series_end_at IS NULL THEN false
    ELSE e.series_end_at
         + CASE WHEN e.all_day AND e.end_at = e.start_at THEN interval '1 day' ELSE interval '0' END <= now()
  END;
$$;

-- A bell's "when" phrase: p_dated || the start, or p_series alone for a
-- series whose first date is past.
CREATE OR REPLACE FUNCTION public.calendar_bell_body(e public.calendar_events, p_dated text, p_series text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN e.rrule IS NOT NULL AND e.start_at <= now() THEN p_series
              ELSE p_dated || calendar_time_label(e.account_id, e.start_at, e.all_day, e.time_zone) END;
$$;

-- ---------- 3. The event's bells (108's, restated) ----------

CREATE OR REPLACE FUNCTION public.calendar_event_attendees_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event calendar_events;
  v_name  text;
BEGIN
  SELECT * INTO v_event FROM calendar_events WHERE id = NEW.event_id;
  IF NOT FOUND OR v_event.status = 'cancelled' OR calendar_event_over(v_event) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL AND auth.uid() = NEW.user_id THEN
      RETURN NULL;
    END IF;
    -- Carried over by calendar_split_occurrence: already invited to the
    -- series; the split rings them calendar_update itself.
    IF current_setting('app.calendar_split', true) = NEW.event_id::text THEN
      RETURN NULL;
    END IF;
    INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body, meta)
    VALUES (NEW.account_id, NEW.user_id, 'calendar_invite', auth.uid(), v_event.title,
            calendar_bell_body(v_event, 'Starts ', 'Repeating event'),
            jsonb_build_object('event_id', NEW.event_id));
    RETURN NULL;
  END IF;

  -- UPDATE OF response, to accepted / tentative / declined. Toggling
  -- rings the creator at most once per attendee per 10 minutes.
  IF EXISTS (SELECT 1 FROM notifications n
              WHERE n.user_id = v_event.created_by
                AND n.type = 'calendar_response'
                AND n.meta->>'event_id' = NEW.event_id::text
                AND n.meta->>'user_id' = NEW.user_id::text
                AND n.created_at > now() - interval '10 minutes') THEN
    RETURN NULL;
  END IF;
  SELECT nullif(btrim(p.full_name), '') INTO v_name
    FROM profiles p WHERE p.user_id = NEW.user_id AND p.account_id = NEW.account_id;
  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body, meta)
  VALUES (NEW.account_id, v_event.created_by, 'calendar_response', auth.uid(), v_event.title,
          coalesce(v_name, 'An attendee') || CASE NEW.response
            WHEN 'accepted' THEN ' accepted'
            WHEN 'declined' THEN ' declined'
            ELSE ' replied maybe' END,
          jsonb_build_object('event_id', NEW.event_id, 'user_id', NEW.user_id, 'response', NEW.response));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create the calendar notification for event %: %', NEW.event_id, SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.calendar_events_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev   calendar_events;
  v_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ev := OLD;
    IF OLD.status = 'cancelled' OR calendar_event_over(OLD)
       OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) THEN
      RETURN OLD;
    END IF;
    v_type := 'calendar_cancelled';
  ELSIF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    v_ev := NEW;
    v_type := 'calendar_cancelled';
  ELSIF NEW.status = 'confirmed'
        AND (NEW.title IS DISTINCT FROM OLD.title
             OR NEW.start_at IS DISTINCT FROM OLD.start_at
             OR NEW.end_at IS DISTINCT FROM OLD.end_at
             OR NEW.location IS DISTINCT FROM OLD.location
             OR NEW.rrule IS DISTINCT FROM OLD.rrule) THEN
    v_ev := NEW;
    v_type := 'calendar_update';
  ELSE
    RETURN NULL;
  END IF;

  -- Over before the change and after it: nobody waits for it. (One moved
  -- out of the future, or into it, is still news.)
  IF TG_OP = 'UPDATE' AND calendar_event_over(NEW) AND calendar_event_over(OLD) THEN
    RETURN NULL;
  END IF;

  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body, meta)
  SELECT v_ev.account_id, a.user_id, v_type, auth.uid(), v_ev.title,
         CASE v_type
           WHEN 'calendar_cancelled' THEN calendar_bell_body(v_ev, 'Cancelled · was ', 'Repeating event cancelled')
           ELSE calendar_bell_body(v_ev, 'Updated · starts ', 'Repeating event updated') END,
         jsonb_build_object('event_id', v_ev.id)
    FROM calendar_event_attendees a
   WHERE a.event_id = v_ev.id
     AND a.user_id IS DISTINCT FROM auth.uid();

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create the calendar notification for event %: %', v_ev.id, SQLERRM;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
END;
$$;

-- ---------- 4. People taken off an event ----------

-- calendar_cancelled to p_users, still live staff, never the writer.
-- p_occurrence: one date of the series only.
CREATE OR REPLACE FUNCTION public.calendar_ring_removed(
  e public.calendar_events, p_users uuid[], p_occurrence timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF e.status <> 'confirmed'
     OR (CASE WHEN p_occurrence IS NULL THEN calendar_event_over(e)
              ELSE calendar_span_over(p_occurrence, p_occurrence + (e.end_at - e.start_at), e.all_day) END) THEN
    RETURN;
  END IF;
  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body, meta)
  SELECT e.account_id, u, 'calendar_cancelled', auth.uid(), e.title,
         CASE WHEN p_occurrence IS NULL
              THEN calendar_bell_body(e, 'You are no longer invited · was ', 'Repeating event · you are no longer invited')
              ELSE 'You are no longer invited · was '
                   || calendar_time_label(e.account_id, p_occurrence, e.all_day, e.time_zone) END,
         jsonb_build_object('event_id', e.id)
           || CASE WHEN p_occurrence IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('occurrence_start', p_occurrence) END
    FROM unnest(p_users) u
   WHERE u IS DISTINCT FROM auth.uid()
     AND calendar_is_live_staff(u, e.account_id);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create the calendar notification for event %: %', e.id, SQLERRM;
END;
$$;

-- calendar_update_event runs as its caller, who cannot write a bell, so
-- this deletes and rings in one: whoever may call it may delete these
-- rows anyway (the attendee policies), and can ring nobody else.
CREATE OR REPLACE FUNCTION public.calendar_remove_attendees(p_event uuid, p_keep uuid[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev   calendar_events;
  v_gone uuid[];
BEGIN
  IF NOT calendar_event_can_edit(p_event) THEN
    RAISE EXCEPTION 'not_organiser' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ev FROM calendar_events WHERE id = p_event;
  WITH d AS (
    DELETE FROM calendar_event_attendees
     WHERE event_id = p_event AND user_id <> ALL (coalesce(p_keep, '{}'))
    RETURNING user_id)
  SELECT array_agg(user_id) INTO v_gone FROM d;
  IF v_gone IS NOT NULL THEN
    PERFORM calendar_ring_removed(v_ev, v_gone);
  END IF;
END;
$$;
COMMENT ON FUNCTION public.calendar_remove_attendees(uuid, uuid[]) IS
  'The caller''s own event: takes every attendee not in p_keep off it and rings them calendar_cancelled while it is ahead. Called by calendar_update_event. Migration 278.';

-- ---------- 5. A leaver's event ----------

-- The creator, or an owner/admin when the creator is no longer live staff
-- there and the event is not private. Delete, or cancel one date; edits
-- stay calendar_event_row_editable's (the creator alone).
CREATE OR REPLACE FUNCTION public.calendar_event_row_removable(
  p_account_id uuid, p_created_by uuid, p_visibility text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT calendar_event_row_editable(p_account_id, p_created_by)
      OR (p_account_id IS NOT NULL
          AND p_account_id = current_account_id()
          AND current_role_rank() >= 4
          AND p_visibility <> 'private'
          AND NOT calendar_is_live_staff(p_created_by, p_account_id));
$$;

CREATE OR REPLACE FUNCTION public.calendar_event_can_remove(p_event uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM calendar_events e
     WHERE e.id = p_event
       AND calendar_event_row_removable(e.account_id, e.created_by, e.visibility));
$$;
COMMENT ON FUNCTION public.calendar_event_can_remove(uuid) IS
  'The caller may delete the event or cancel one of its dates: its creator, or an owner/admin when the creator is no longer live staff and the event is not private. Migration 278.';

-- calendar_series_for_write (108), for a cancellation: removable, not
-- editable. The split keeps the other one.
CREATE OR REPLACE FUNCTION public.calendar_series_for_cancel(p_event uuid)
RETURNS public.calendar_events
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v calendar_events;
BEGIN
  SELECT * INTO v FROM calendar_events WHERE id = p_event FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT calendar_event_row_visible(v.account_id, v.created_by, v.visibility, v.id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT calendar_event_row_removable(v.account_id, v.created_by, v.visibility)
     OR coalesce(current_role_rank(), 0) < 1 THEN
    RAISE EXCEPTION 'not_organiser' USING ERRCODE = '42501';
  END IF;
  IF v.rrule IS NULL THEN
    RAISE EXCEPTION 'not_recurring' USING ERRCODE = '22023';
  END IF;
  RETURN v;
END;
$$;

-- ---------- 6. Meetings ----------

-- 106's body; the time is the account's (calendar_time_label).
CREATE OR REPLACE FUNCTION public.meeting_invitees_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_meeting meetings;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.user_id THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_meeting FROM meetings WHERE id = NEW.meeting_id;
  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body, meta)
  VALUES (
    NEW.account_id,
    NEW.user_id,
    'meeting_invite',
    auth.uid(),
    v_meeting.title,
    CASE WHEN v_meeting.scheduled_start IS NOT NULL THEN
      'Starts ' || calendar_time_label(v_meeting.account_id, v_meeting.scheduled_start)
    ELSE 'Starting now' END,
    jsonb_build_object('meeting_id', NEW.meeting_id)
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create the invitation notification for meeting %: %', NEW.meeting_id, SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.meetings_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_type text;
  v_body text;
BEGIN
  IF NEW.status = 'cancelled' THEN
    -- One that is over is being tidied up. With no end it lasts an hour,
    -- as the calendar shows it; an instant meeting has no start either.
    IF coalesce(NEW.scheduled_end, NEW.scheduled_start + interval '1 hour') <= now() THEN
      RETURN NULL;
    END IF;
    v_type := 'meeting_cancelled';
    v_body := 'Cancelled'
      || coalesce(' · was ' || calendar_time_label(NEW.account_id, NEW.scheduled_start), '');
  ELSE
    -- Started, and not moved ahead of now (a running meeting's new end).
    IF (OLD.scheduled_start > now() OR NEW.scheduled_start > now()) IS NOT TRUE THEN
      RETURN NULL;
    END IF;
    v_type := 'meeting_update';
    v_body := 'Updated · starts '
      || coalesce(calendar_time_label(NEW.account_id, NEW.scheduled_start), 'now');
  END IF;

  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body, meta)
  SELECT NEW.account_id, i.user_id, v_type, auth.uid(), NEW.title, v_body,
         jsonb_build_object('meeting_id', NEW.id)
    FROM meeting_invitees i
   WHERE i.meeting_id = NEW.id
     AND i.user_id IS DISTINCT FROM auth.uid()
     AND calendar_is_live_staff(i.user_id, NEW.account_id)
     AND NOT EXISTS (SELECT 1 FROM meeting_removed_users r
                      WHERE r.meeting_id = NEW.id AND r.user_id = i.user_id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create the notification for meeting %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS meetings_notify ON public.meetings;
CREATE TRIGGER meetings_notify
  AFTER UPDATE OF scheduled_start, scheduled_end, status ON public.meetings
  FOR EACH ROW
  WHEN (OLD.status = 'scheduled'
        AND (NEW.status = 'cancelled'
             OR (NEW.status = 'scheduled'
                 AND (NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
                      OR NEW.scheduled_end IS DISTINCT FROM OLD.scheduled_end))))
  EXECUTE FUNCTION public.meetings_notify();

-- ---------- 7. Privileges ----------

REVOKE ALL ON FUNCTION public.calendar_span_over(timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_event_over(public.calendar_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_bell_body(public.calendar_events, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_ring_removed(public.calendar_events, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_series_for_cancel(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_event_attendees_notify() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_events_notify() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meetings_notify() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.calendar_remove_attendees(uuid, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.calendar_remove_attendees(uuid, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.calendar_event_row_removable(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_event_can_remove(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendar_event_row_removable(uuid, uuid, text),
  public.calendar_event_can_remove(uuid)
  TO authenticated, service_role;

-- ---------- 8. Turn it on: the patched functions and the policy ----------

DO $$
DECLARE
  p     record;
  v_def text;
BEGIN
  FOR p IN SELECT * FROM patch_278 ORDER BY n LOOP
    v_def := pg_get_functiondef(p.fn::regprocedure);
    IF position(p.new IN v_def) = 0 THEN
      EXECUTE replace(v_def, p.old, p.new);
    END IF;
  END LOOP;
  DROP TABLE patch_278;
END $$;

ALTER POLICY calendar_events_delete ON public.calendar_events
  USING (calendar_event_row_removable(account_id, created_by, visibility));

COMMENT ON FUNCTION public.calendar_update_event(uuid, timestamptz, jsonb, uuid[]) IS
  'Edit an event the caller organises, only if updated_at is still p_expected (P0001 stale), setting only the patch''s keys; p_attendees (when given) replaces the attendee list, new people pending and invited, removed people rung (278). Migrations 108, 278.';
COMMENT ON FUNCTION public.calendar_cancel_occurrence(uuid, timestamptz, timestamptz) IS
  'Cancel one occurrence of a series the caller may remove (its organiser, or an owner/admin for a leaver''s: 278): adds it to exdates and, while it is ahead, rings calendar_cancelled to every attendee with meta {event_id, occurrence_start}. Idempotent. Migrations 108, 278.';

RESET lock_timeout;
