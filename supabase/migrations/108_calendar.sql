-- ============================================================
-- 108_calendar.sql — the staff calendar (docs/calendar.md)
--
--  * Staff only. Every policy goes through current_account_id(), which
--    is NULL for a bank guest, a deactivated row and an inactive
--    workspace (082-083), so a guest sees and writes nothing here.
--  * calendar_events: created_by is an auth user id (as
--    notifications.user_id). Recurring events carry an RFC 5545 RRULE
--    body and are expanded in TS (rrule), never in SQL; exdates are the
--    cancelled occurrences, by original start.
--  * Who sees an event (calendar_event_can_view): in the caller's active
--    workspace, and the creator, an attendee, anyone there when
--    visibility = 'workspace', or an owner/admin unless it is 'private'.
--    As in 106 the table policy passes the row's own columns to the
--    shared predicate (calendar_event_row_visible), so INSERT …
--    RETURNING is not refused.
--  * Who edits or deletes an event: its creator only, never an admin.
--    The attendee list is the creator's too; an attendee updates only
--    their own response and reminders (column grants + policy), and
--    responded_at is stamped by the trigger when the response changes.
--  * calendar_event_attendees_guard binds every writer: an attendee is a
--    live, non-guest member of the event's account, never its creator.
--  * Bells (DEFINER triggers; a failure is a WARNING, never an undo):
--    calendar_invite, calendar_update, calendar_cancelled (status, or a
--    delete, captured BEFORE DELETE), calendar_response.
--  * Reminders: calendar_reminder_sweep(p_now) (service role) rings
--    non-recurring events, scheduled meetings and open tasks;
--    recurring occurrences are computed in TS and rung through
--    calendar_insert_reminder. Both dedupe on calendar_reminders_sent.
--
-- The SECURITY DEFINER helpers read RLS-forced tables, so, as in 106,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE, DROP … IF
-- EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '108 must be applied by a superuser or BYPASSRLS role (the calendar functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.calendar_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text NULL,
  location    text NULL,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  all_day     boolean NOT NULL DEFAULT false,
  time_zone   text NOT NULL DEFAULT 'UTC',
  color       text NOT NULL DEFAULT 'blue',
  rrule       text NULL,
  exdates     timestamptz[] NOT NULL DEFAULT '{}',
  visibility  text NOT NULL DEFAULT 'attendees',
  reminders   integer[] NOT NULL DEFAULT '{10}',
  status      text NOT NULL DEFAULT 'confirmed',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_events_title_check CHECK (
    btrim(title) <> '' AND char_length(btrim(title)) <= 200),
  CONSTRAINT calendar_events_description_check CHECK (
    description IS NULL OR char_length(description) <= 5000),
  CONSTRAINT calendar_events_location_check CHECK (
    location IS NULL OR char_length(location) <= 300),
  -- An all-day single day may be stored with end = start (end exclusive).
  CONSTRAINT calendar_events_time_check CHECK (
    end_at > start_at OR (all_day AND end_at = start_at)),
  CONSTRAINT calendar_events_time_zone_check CHECK (
    char_length(time_zone) BETWEEN 1 AND 64),
  CONSTRAINT calendar_events_color_check CHECK (
    color IN ('blue', 'green', 'red', 'amber', 'violet', 'pink', 'teal', 'slate')),
  -- The RRULE body only (no "RRULE:" prefix, no DTSTART line).
  CONSTRAINT calendar_events_rrule_check CHECK (
    rrule IS NULL OR (char_length(rrule) <= 500 AND rrule ~ '^FREQ=[^[:space:]]+$')),
  CONSTRAINT calendar_events_visibility_check CHECK (
    visibility IN ('private', 'attendees', 'workspace')),
  CONSTRAINT calendar_events_reminders_check CHECK (
    cardinality(reminders) <= 5
    AND coalesce(array_ndims(reminders), 1) = 1
    AND array_position(reminders, NULL) IS NULL
    AND 0 <= ALL (reminders) AND 40320 >= ALL (reminders)),
  CONSTRAINT calendar_events_status_check CHECK (
    status IN ('confirmed', 'cancelled')),
  -- The target of the composite FK below.
  CONSTRAINT calendar_events_id_account_key UNIQUE (id, account_id)
);

CREATE INDEX IF NOT EXISTS calendar_events_account_start_idx
  ON public.calendar_events (account_id, start_at);
CREATE INDEX IF NOT EXISTS calendar_events_created_by_idx
  ON public.calendar_events (created_by);
-- The reminder sweep: confirmed one-off events by start.
CREATE INDEX IF NOT EXISTS calendar_events_sweep_idx
  ON public.calendar_events (start_at) WHERE status = 'confirmed' AND rrule IS NULL;

COMMENT ON TABLE public.calendar_events IS
  'Staff calendar events. Creator-only edit; visibility via calendar_event_can_view. Migration 108; docs/calendar.md.';
COMMENT ON COLUMN public.calendar_events.time_zone IS
  'IANA zone the creator picked; recurrences expand in it.';
COMMENT ON COLUMN public.calendar_events.rrule IS
  'RFC 5545 RRULE body (FREQ=…), expanded in TS. NULL = a one-off event.';
COMMENT ON COLUMN public.calendar_events.exdates IS
  'Cancelled occurrences, by original start.';
COMMENT ON COLUMN public.calendar_events.reminders IS
  'Minutes before start (0..40320, at most 5) for the creator and every attendee without their own.';

CREATE TABLE IF NOT EXISTS public.calendar_event_attendees (
  event_id     uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL,
  response     text NOT NULL DEFAULT 'pending',
  reminders    integer[] NULL,
  responded_at timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT calendar_event_attendees_event_fkey FOREIGN KEY (event_id, account_id)
    REFERENCES public.calendar_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT calendar_event_attendees_response_check CHECK (
    response IN ('pending', 'accepted', 'tentative', 'declined')),
  CONSTRAINT calendar_event_attendees_reminders_check CHECK (
    reminders IS NULL OR (
      cardinality(reminders) <= 5
      AND coalesce(array_ndims(reminders), 1) = 1
      AND array_position(reminders, NULL) IS NULL
      AND 0 <= ALL (reminders) AND 40320 >= ALL (reminders)))
);

-- "Events I am invited to."
CREATE INDEX IF NOT EXISTS calendar_event_attendees_user_idx
  ON public.calendar_event_attendees (user_id);

COMMENT ON TABLE public.calendar_event_attendees IS
  'Invited colleagues: a live, non-guest member of the event''s account, never its creator. Migration 108.';
COMMENT ON COLUMN public.calendar_event_attendees.reminders IS
  'The attendee''s own offsets; NULL = the event''s.';

CREATE TABLE IF NOT EXISTS public.calendar_reminders_sent (
  key     text PRIMARY KEY,
  user_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_reminders_sent_at_idx
  ON public.calendar_reminders_sent (sent_at);

COMMENT ON TABLE public.calendar_reminders_sent IS
  'Reminder dedupe: ev:<event>:<occurrence epoch s>:<offset>:<user>, mt:<meeting>:<offset>:<user>, tk:<task>:<due epoch s>:<user>. Purged after 14 days. Service role only. Migration 108.';

-- ---------- 2. Who sees and edits an event ----------

-- DEFINER so the attendee lookup does not run the attendees policy
-- (which calls back into this).
CREATE OR REPLACE FUNCTION public.calendar_event_row_visible(
  p_account_id uuid, p_created_by uuid, p_visibility text, p_event uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_account_id IS NOT NULL
     AND p_account_id = current_account_id()
     AND (p_created_by = auth.uid()
          OR p_visibility = 'workspace'
          OR (p_visibility <> 'private' AND current_role_rank() >= 4)
          OR EXISTS (SELECT 1 FROM calendar_event_attendees a
                      WHERE a.event_id = p_event AND a.user_id = auth.uid()));
$$;

CREATE OR REPLACE FUNCTION public.calendar_event_row_editable(
  p_account_id uuid, p_created_by uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_account_id IS NOT NULL
     AND p_account_id = current_account_id()
     AND p_created_by = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.calendar_event_can_view(p_event uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM calendar_events e
     WHERE e.id = p_event
       AND calendar_event_row_visible(e.account_id, e.created_by, e.visibility, e.id));
$$;
COMMENT ON FUNCTION public.calendar_event_can_view(uuid) IS
  'The caller (active, live, non-guest in the event''s workspace) is its creator or an attendee, or it is visibility workspace, or the caller is owner/admin and it is not private. Migration 108.';

CREATE OR REPLACE FUNCTION public.calendar_event_can_edit(p_event uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM calendar_events e
     WHERE e.id = p_event
       AND calendar_event_row_editable(e.account_id, e.created_by));
$$;
COMMENT ON FUNCTION public.calendar_event_can_edit(uuid) IS
  'The caller (active, live, non-guest in the event''s workspace) created it. Admins included: only the creator. Migration 108.';

-- ---------- 3. Labels for the bell (English, as every SQL bell) ----------

-- A time as the bell shows it: in the account's saved time zone (Team
-- activity's, 068) else UTC, always labelled; an all-day date in the
-- event's own zone.
CREATE OR REPLACE FUNCTION public.calendar_time_label(
  p_account uuid, p_at timestamptz, p_all_day boolean DEFAULT false, p_event_tz text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tz text;
BEGIN
  IF p_all_day THEN
    v_tz := coalesce(p_event_tz, 'UTC');
    RETURN to_char(p_at AT TIME ZONE v_tz, 'DD Mon YYYY') || ' (all day)';
  END IF;
  SELECT s.timezone INTO v_tz FROM team_activity_settings s WHERE s.account_id = p_account;
  v_tz := coalesce(v_tz, 'UTC');
  RETURN to_char(p_at AT TIME ZONE v_tz, 'DD Mon YYYY HH24:MI') || ' ' || v_tz;
END;
$$;

CREATE OR REPLACE FUNCTION public.calendar_offset_label(p_offset integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_offset <= 0 THEN 'Starting now'
    WHEN p_offset % 1440 = 0 THEN 'In ' || (p_offset / 1440) || CASE WHEN p_offset = 1440 THEN ' day' ELSE ' days' END
    WHEN p_offset % 60 = 0 THEN 'In ' || (p_offset / 60) || ' h'
    ELSE 'In ' || p_offset || ' min'
  END;
$$;

-- ---------- 4. Integrity (every writer, the service role included) ----------

CREATE OR REPLACE FUNCTION public.calendar_events_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  NEW.description := NULLIF(btrim(NEW.description), '');
  NEW.location := NULLIF(btrim(NEW.location), '');
  NEW.updated_at := now();

  -- A named zone only: Postgres also takes POSIX strings such as '+04'
  -- and reads their sign the opposite way to the browser (068).
  IF (TG_OP = 'INSERT' OR NEW.time_zone IS DISTINCT FROM OLD.time_zone)
     AND NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown time zone: %', NEW.time_zone USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NOT EXISTS (SELECT 1 FROM profiles p
                    WHERE p.user_id = NEW.created_by
                      AND p.account_id = NEW.account_id
                      AND p.deactivated_at IS NULL
                      AND p.account_role <> 'bank_guest') THEN
      RAISE EXCEPTION 'Only a live staff member of the workspace can create an event there'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'An event''s workspace and creator cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calendar_events_guard ON public.calendar_events;
CREATE TRIGGER calendar_events_guard
  BEFORE INSERT OR UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.calendar_events_guard();

-- An attendee is a live, non-guest member of the event's account (not
-- necessarily active there: 083), never the creator. The composite FK
-- already ties account_id to the event's. responded_at is trigger-owned.
CREATE OR REPLACE FUNCTION public.calendar_event_attendees_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
      RAISE EXCEPTION 'An attendee row''s event, person and workspace cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := OLD.created_at;
    IF NEW.response IS DISTINCT FROM OLD.response THEN
      NEW.responded_at := now();
    ELSE
      NEW.responded_at := OLD.responded_at;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles p
                  WHERE p.user_id = NEW.user_id
                    AND p.account_id = NEW.account_id
                    AND p.deactivated_at IS NULL
                    AND p.account_role <> 'bank_guest') THEN
    RAISE EXCEPTION 'Only a live staff member of the event''s workspace can be invited'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM calendar_events e
              WHERE e.id = NEW.event_id AND e.created_by = NEW.user_id) THEN
    RAISE EXCEPTION 'An event''s creator is not one of its attendees'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Nobody answers for someone else: only the service role may seed a
  -- response.
  IF auth.uid() IS NOT NULL AND NEW.response <> 'pending' THEN
    RAISE EXCEPTION 'A new attendee''s response is pending'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.responded_at := CASE WHEN NEW.response = 'pending' THEN NULL ELSE now() END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calendar_event_attendees_guard ON public.calendar_event_attendees;
CREATE TRIGGER calendar_event_attendees_guard
  BEFORE INSERT OR UPDATE ON public.calendar_event_attendees
  FOR EACH ROW EXECUTE FUNCTION public.calendar_event_attendees_guard();

-- ---------- 5. The bell ----------
-- 106's list plus the calendar's; task_due was already reserved (085).
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected',
    'team_activity_alert',
    'ai_handoff',
    'task_assigned',
    'task_due',
    'chat_mention',
    'chat_dm',
    'chat_thread_reply',
    'chat_broadcast',
    'call_missed',
    'callback_requested',
    'deal_room_join_request',
    'deal_room_update',
    'call_outcome_due',
    'pbx_connection_silent',
    'pbx_connection_restored',
    'meeting_invite',
    'calendar_invite',
    'calendar_update',
    'calendar_cancelled',
    'calendar_response',
    'event_reminder',
    'meeting_reminder'
  ));

-- As meeting_invitees_notify (106): DEFINER because notifications has no
-- INSERT policy; a failure is logged and swallowed. actor_user_id is
-- auth.uid() (NULL for the service role), never a stored id: a user
-- being deleted must not be referenced by a row written in the same
-- statement.
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
  IF NOT FOUND OR v_event.status = 'cancelled' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL AND auth.uid() = NEW.user_id THEN
      RETURN NULL;
    END IF;
    INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body, meta)
    VALUES (NEW.account_id, NEW.user_id, 'calendar_invite', auth.uid(), v_event.title,
            'Starts ' || calendar_time_label(v_event.account_id, v_event.start_at, v_event.all_day, v_event.time_zone),
            jsonb_build_object('event_id', NEW.event_id));
    RETURN NULL;
  END IF;

  -- UPDATE OF response, to accepted / tentative / declined.
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

DROP TRIGGER IF EXISTS calendar_event_attendees_notify ON public.calendar_event_attendees;
CREATE TRIGGER calendar_event_attendees_notify
  AFTER INSERT ON public.calendar_event_attendees
  FOR EACH ROW EXECUTE FUNCTION public.calendar_event_attendees_notify();

DROP TRIGGER IF EXISTS calendar_event_attendees_notify_response ON public.calendar_event_attendees;
CREATE TRIGGER calendar_event_attendees_notify_response
  AFTER UPDATE OF response ON public.calendar_event_attendees
  FOR EACH ROW
  WHEN (NEW.response IS DISTINCT FROM OLD.response
        AND NEW.response IN ('accepted', 'tentative', 'declined'))
  EXECUTE FUNCTION public.calendar_event_attendees_notify();

-- calendar_update (title, start, end, location or rrule changed on a
-- confirmed event) and calendar_cancelled (status → cancelled, or a
-- delete, fired BEFORE DELETE while the attendee rows still exist), to
-- every attendee but the writer. A delete that cascades from its
-- workspace rings nobody.
CREATE OR REPLACE FUNCTION public.calendar_events_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev   calendar_events;
  v_type text;
  v_body text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ev := OLD;
    IF OLD.status = 'cancelled'
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

  v_body := CASE v_type
    WHEN 'calendar_cancelled' THEN 'Cancelled · was ' ELSE 'Updated · starts ' END
    || calendar_time_label(v_ev.account_id, v_ev.start_at, v_ev.all_day, v_ev.time_zone);

  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body, meta)
  SELECT v_ev.account_id, a.user_id, v_type, auth.uid(), v_ev.title, v_body,
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

DROP TRIGGER IF EXISTS calendar_events_notify ON public.calendar_events;
CREATE TRIGGER calendar_events_notify
  AFTER UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.calendar_events_notify();

DROP TRIGGER IF EXISTS calendar_events_notify_delete ON public.calendar_events;
CREATE TRIGGER calendar_events_notify_delete
  BEFORE DELETE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.calendar_events_notify();

-- ---------- 6. Reminders (service role) ----------

-- One live, non-guest profile of the person in the account.
CREATE OR REPLACE FUNCTION public.calendar_is_live_staff(p_user uuid, p_account uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p
                  WHERE p.user_id = p_user AND p.account_id = p_account
                    AND p.deactivated_at IS NULL AND p.account_role <> 'bank_guest');
$$;

-- A due reminder: start - offset <= now < start - offset + 5 min, i.e.
-- start in (now + offset - 5 min, now + offset]. Offset 0 therefore
-- rings in the first five minutes after the start ("Starting now").
-- Recipients must still be live staff there; a declined attendee is
-- never reminded. Non-recurring events only: recurring occurrences come
-- from TS through calendar_insert_reminder.
CREATE OR REPLACE FUNCTION public.calendar_reminder_sweep(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM calendar_reminders_sent WHERE sent_at < p_now - interval '14 days';

  WITH recipients AS (
    SELECT e.id AS event_id, e.created_by AS user_id, e.reminders AS offsets
      FROM calendar_events e
     WHERE e.status = 'confirmed' AND e.rrule IS NULL
       AND e.start_at > p_now - interval '5 minutes'
       AND e.start_at <= p_now + interval '40320 minutes'
    UNION ALL
    SELECT e.id, a.user_id, coalesce(a.reminders, e.reminders)
      FROM calendar_events e
      JOIN calendar_event_attendees a ON a.event_id = e.id
     WHERE e.status = 'confirmed' AND e.rrule IS NULL
       AND e.start_at > p_now - interval '5 minutes'
       AND e.start_at <= p_now + interval '40320 minutes'
       AND a.response <> 'declined'
  ),
  due AS (
    SELECT DISTINCT ON (k.key) k.*
      FROM (
        SELECT 'ev:' || e.id || ':' || floor(extract(epoch FROM e.start_at))::bigint
                 || ':' || o.off || ':' || r.user_id AS key,
               r.user_id, e.account_id, 'event_reminder'::text AS type,
               e.title,
               calendar_offset_label(o.off) || ' · '
                 || calendar_time_label(e.account_id, e.start_at, e.all_day, e.time_zone) AS body,
               NULL::uuid AS contact_id, NULL::uuid AS conversation_id,
               jsonb_build_object('event_id', e.id, 'occurrence_start', e.start_at, 'offset', o.off) AS meta
          FROM recipients r
          JOIN calendar_events e ON e.id = r.event_id
          CROSS JOIN LATERAL unnest(r.offsets) AS o(off)
         WHERE e.start_at - make_interval(mins => o.off) <= p_now
           AND p_now < e.start_at - make_interval(mins => o.off) + interval '5 minutes'
           AND calendar_is_live_staff(r.user_id, e.account_id)
        UNION ALL
        SELECT 'mt:' || m.id || ':' || o.off || ':' || r.user_id,
               r.user_id, m.account_id, 'meeting_reminder',
               m.title,
               calendar_offset_label(o.off) || ' · '
                 || calendar_time_label(m.account_id, m.scheduled_start),
               NULL, NULL,
               jsonb_build_object('meeting_id', m.id)
          FROM meetings m
          CROSS JOIN LATERAL (
            SELECT m.host_user_id AS user_id
            UNION SELECT i.user_id FROM meeting_invitees i WHERE i.meeting_id = m.id
          ) r
          CROSS JOIN LATERAL (VALUES (10), (0)) AS o(off)
         WHERE m.status = 'scheduled' AND m.scheduled_start IS NOT NULL
           AND m.scheduled_start > p_now - interval '5 minutes'
           AND m.scheduled_start <= p_now + interval '10 minutes'
           AND m.scheduled_start - make_interval(mins => o.off) <= p_now
           AND p_now < m.scheduled_start - make_interval(mins => o.off) + interval '5 minutes'
           AND calendar_is_live_staff(r.user_id, m.account_id)
        UNION ALL
        SELECT 'tk:' || t.id || ':' || floor(extract(epoch FROM t.due_at))::bigint || ':' || t.assigned_to,
               t.assigned_to, t.account_id, 'task_due',
               t.title,
               'Due ' || calendar_time_label(t.account_id, t.due_at),
               t.contact_id, t.conversation_id,
               jsonb_build_object('task_id', t.id)
          FROM tasks t
         WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
           AND t.due_at > p_now + interval '10 minutes'
           AND t.due_at <= p_now + interval '15 minutes'
           AND calendar_is_live_staff(t.assigned_to, t.account_id)
      ) k
     ORDER BY k.key
  ),
  claimed AS (
    INSERT INTO calendar_reminders_sent (key, user_id, sent_at)
    SELECT key, user_id, p_now FROM due
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  ),
  rung AS (
    INSERT INTO notifications (account_id, user_id, type, title, body, contact_id, conversation_id, meta)
    SELECT d.account_id, d.user_id, d.type, d.title, d.body, d.contact_id, d.conversation_id, d.meta
      FROM due d JOIN claimed c ON c.key = d.key
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM rung;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION public.calendar_reminder_sweep(timestamptz) IS
  'Service role. Rings due event_reminder (one-off events), meeting_reminder (10 and 0 min) and task_due (15 min) bells once each; returns how many. Migration 108.';

-- One recurring occurrence's reminder, computed in TS. p_key must be
-- exactly 'ev:<event>:<floor(epoch seconds of p_occurrence_start)>:
-- <p_offset>:<p_user>'. Returns true when this call rang the bell,
-- false when it was already rung or is no longer due to this person
-- (event cancelled or deleted, occurrence in exdates, person declined,
-- not the creator or an attendee, no longer live staff, or p_offset not
-- among their offsets).
CREATE OR REPLACE FUNCTION public.calendar_insert_reminder(
  p_key text, p_user uuid, p_event uuid, p_occurrence_start timestamptz, p_offset integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev      calendar_events;
  v_offsets integer[];
BEGIN
  IF p_key IS DISTINCT FROM 'ev:' || p_event || ':' || floor(extract(epoch FROM p_occurrence_start))::bigint
                            || ':' || p_offset || ':' || p_user THEN
    RAISE EXCEPTION 'calendar_insert_reminder: key % does not match its event, occurrence, offset and person', p_key
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ev FROM calendar_events WHERE id = p_event;
  IF NOT FOUND OR v_ev.status <> 'confirmed' OR p_occurrence_start = ANY (v_ev.exdates) THEN
    RETURN false;
  END IF;
  IF p_user = v_ev.created_by THEN
    v_offsets := v_ev.reminders;
  ELSE
    SELECT coalesce(a.reminders, v_ev.reminders) INTO v_offsets
      FROM calendar_event_attendees a
     WHERE a.event_id = p_event AND a.user_id = p_user AND a.response <> 'declined';
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;
  IF NOT (p_offset = ANY (v_offsets)) OR NOT calendar_is_live_staff(p_user, v_ev.account_id) THEN
    RETURN false;
  END IF;

  INSERT INTO calendar_reminders_sent (key, user_id) VALUES (p_key, p_user)
  ON CONFLICT (key) DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO notifications (account_id, user_id, type, title, body, meta)
  VALUES (v_ev.account_id, p_user, 'event_reminder', v_ev.title,
          calendar_offset_label(p_offset) || ' · '
            || calendar_time_label(v_ev.account_id, p_occurrence_start, v_ev.all_day, v_ev.time_zone),
          jsonb_build_object('event_id', p_event, 'occurrence_start', p_occurrence_start, 'offset', p_offset));
  RETURN true;
END;
$$;
COMMENT ON FUNCTION public.calendar_insert_reminder(text, uuid, uuid, timestamptz, integer) IS
  'Service role. Rings one recurring occurrence''s event_reminder once per key (ev:<event>:<epoch s>:<offset>:<user>); true if it rang. Migration 108.';

-- ---------- 7. Row-level security ----------

ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_event_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_event_attendees FORCE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_reminders_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_reminders_sent FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_events_select ON public.calendar_events;
CREATE POLICY calendar_events_select ON public.calendar_events FOR SELECT TO authenticated
  USING (calendar_event_row_visible(account_id, created_by, visibility, id));

-- current_account_id() is NULL for a guest or a deactivated row, so
-- this is "a live staff member, in their active workspace, creating".
DROP POLICY IF EXISTS calendar_events_insert ON public.calendar_events;
CREATE POLICY calendar_events_insert ON public.calendar_events FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 1
    AND created_by = (SELECT auth.uid())
  );

-- Creator only, admins included.
DROP POLICY IF EXISTS calendar_events_update ON public.calendar_events;
CREATE POLICY calendar_events_update ON public.calendar_events FOR UPDATE TO authenticated
  USING (calendar_event_row_editable(account_id, created_by))
  WITH CHECK (calendar_event_row_editable(account_id, created_by));

DROP POLICY IF EXISTS calendar_events_delete ON public.calendar_events;
CREATE POLICY calendar_events_delete ON public.calendar_events FOR DELETE TO authenticated
  USING (calendar_event_row_editable(account_id, created_by));

DROP POLICY IF EXISTS calendar_event_attendees_select ON public.calendar_event_attendees;
CREATE POLICY calendar_event_attendees_select ON public.calendar_event_attendees FOR SELECT TO authenticated
  USING (calendar_event_can_view(event_id));

DROP POLICY IF EXISTS calendar_event_attendees_insert ON public.calendar_event_attendees;
CREATE POLICY calendar_event_attendees_insert ON public.calendar_event_attendees FOR INSERT TO authenticated
  WITH CHECK (calendar_event_can_edit(event_id));

DROP POLICY IF EXISTS calendar_event_attendees_delete ON public.calendar_event_attendees;
CREATE POLICY calendar_event_attendees_delete ON public.calendar_event_attendees FOR DELETE TO authenticated
  USING (calendar_event_can_edit(event_id));

-- The attendee's own row, in their active workspace; the column grants
-- below confine it to response, reminders and responded_at.
DROP POLICY IF EXISTS calendar_event_attendees_update ON public.calendar_event_attendees;
CREATE POLICY calendar_event_attendees_update ON public.calendar_event_attendees FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND account_id = (SELECT current_account_id()))
  WITH CHECK (user_id = (SELECT auth.uid()) AND account_id = (SELECT current_account_id()));

-- ---------- 8. Privileges ----------

REVOKE ALL ON public.calendar_events, public.calendar_event_attendees, public.calendar_reminders_sent
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendar_events TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.calendar_event_attendees TO authenticated;
GRANT UPDATE (response, reminders, responded_at) ON public.calendar_event_attendees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.calendar_events, public.calendar_event_attendees TO service_role;
GRANT SELECT, INSERT, DELETE ON public.calendar_reminders_sent TO service_role;

REVOKE ALL ON FUNCTION public.calendar_event_row_visible(uuid, uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_event_row_editable(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_event_can_view(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_event_can_edit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendar_event_row_visible(uuid, uuid, text, uuid),
  public.calendar_event_row_editable(uuid, uuid),
  public.calendar_event_can_view(uuid),
  public.calendar_event_can_edit(uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.calendar_reminder_sweep(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_insert_reminder(text, uuid, uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_reminder_sweep(timestamptz),
  public.calendar_insert_reminder(text, uuid, uuid, timestamptz, integer)
  TO service_role;

-- Internal helpers (they read team_activity_settings and profiles).
REVOKE ALL ON FUNCTION public.calendar_time_label(uuid, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_offset_label(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_is_live_staff(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Trigger functions are not for calling.
REVOKE ALL ON FUNCTION public.calendar_events_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_event_attendees_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_event_attendees_notify() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_events_notify() FROM PUBLIC, anon, authenticated;

-- ---------- 9. Realtime ----------
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['calendar_events', 'calendar_event_attendees'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END
$$;

RESET lock_timeout;
