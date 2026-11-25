-- 319: a reminder bell is read once what it rang for is over or moved.
--
-- The alarm card (src/components/reminders/reminder-alarm.tsx) closes only
-- when its own bell is read. So a task finished elsewhere kept ringing, a
-- moved one kept a card whose Done closed the NEW reminder, and a moved or
-- cancelled meeting still offered Join. Triggers, so every writer is covered:
--
--  * tasks: it leaves 'open', its due time changes, or it is deleted.
--  * meetings: it is cancelled, its start moves, or it is deleted. An ENDED
--    meeting keeps its bell: it is what a person who missed it has left.
--  * calendar_events: it is cancelled, moved or deleted. Its bells carry
--    their occurrence_start, so one still right stays: a series whose end
--    alone changed, or the other dates when one is taken out (exdates).
--
-- Nothing newer is read: the triggers run inside the change, when the sweep
-- (268) has not seen the new time yet, and calendar_reminders_sent keys
-- carry the time, so the new time still rings, with a bell of its own. A
-- bell the sweep commits in the same instant as the change may stay.
-- The sweep and push_still_allowed are not touched. Existing bells are not
-- marked (an alarm is at most 2 h old).
--
-- Needs 268. Re-runnable. supabase/ci/verify-stale-bells.sql asserts it.

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '319 must be applied by a superuser or BYPASSRLS role (its functions write other people''s bells)';
  END IF;
  IF to_regprocedure('public.calendar_reminder_sweep(timestamptz)') IS NULL
     OR pg_get_functiondef('public.calendar_reminder_sweep(timestamptz)'::regprocedure) NOT LIKE '%interval ''12 hours''%' THEN
    RAISE EXCEPTION '319: apply 268 first';
  END IF;
END $$;

-- Unread reminder bells by the task, meeting or event they are about. Small:
-- a bell leaves it when read.
CREATE INDEX IF NOT EXISTS idx_notifications_unread_reminder_subject
  ON public.notifications ((coalesce(meta ->> 'task_id', meta ->> 'meeting_id', meta ->> 'event_id')))
  WHERE read_at IS NULL AND type IN ('task_due', 'meeting_reminder', 'event_reminder');

-- ---------- 1. Tasks ----------

-- TG_ARGV[0] is the bell's type; for tasks and meetings every unread bell of
-- the row is about a time that no longer holds.
CREATE OR REPLACE FUNCTION public.stale_bells_read()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
-- A lock on the bells is caught below; a wait for one would hold the change.
SET lock_timeout = '1s'
AS $$
BEGIN
  -- Never in the way of the change itself.
  UPDATE notifications n
     SET read_at = now()
   WHERE n.read_at IS NULL
     AND n.type IN ('task_due', 'meeting_reminder', 'event_reminder')
     AND n.type = TG_ARGV[0]
     AND n.account_id = OLD.account_id
     AND coalesce(n.meta ->> 'task_id', n.meta ->> 'meeting_id', n.meta ->> 'event_id') = OLD.id::text;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'stale_bells_read: % %: % (%)', TG_TABLE_NAME, OLD.id, SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

-- Not "UPDATE OF": a BEFORE trigger may be what changes the column. The
-- WHEN keeps every other update free.
DROP TRIGGER IF EXISTS tasks_stale_bells ON public.tasks;
CREATE TRIGGER tasks_stale_bells
  AFTER UPDATE ON public.tasks
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND OLD.due_at IS NOT NULL
        AND (NEW.status <> 'open' OR NEW.due_at IS DISTINCT FROM OLD.due_at))
  EXECUTE FUNCTION public.stale_bells_read('task_due');

DROP TRIGGER IF EXISTS tasks_stale_bells_delete ON public.tasks;
CREATE TRIGGER tasks_stale_bells_delete
  AFTER DELETE ON public.tasks
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND OLD.due_at IS NOT NULL)
  EXECUTE FUNCTION public.stale_bells_read('task_due');

-- ---------- 2. Meetings ----------

DROP TRIGGER IF EXISTS meetings_stale_bells ON public.meetings;
CREATE TRIGGER meetings_stale_bells
  AFTER UPDATE ON public.meetings
  FOR EACH ROW
  WHEN (OLD.status = 'scheduled' AND OLD.scheduled_start IS NOT NULL
        AND (NEW.status = 'cancelled' OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start))
  EXECUTE FUNCTION public.stale_bells_read('meeting_reminder');

DROP TRIGGER IF EXISTS meetings_stale_bells_delete ON public.meetings;
CREATE TRIGGER meetings_stale_bells_delete
  AFTER DELETE ON public.meetings
  FOR EACH ROW
  WHEN (OLD.scheduled_start IS NOT NULL)
  EXECUTE FUNCTION public.stale_bells_read('meeting_reminder');

-- ---------- 3. Calendar events ----------

CREATE OR REPLACE FUNCTION public.calendar_events_stale_bells()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
-- A lock on the bells is caught below; a wait for one would hold the change.
SET lock_timeout = '1s'
AS $$
DECLARE
  -- The end of a repeat rule; without it, the rule's pattern.
  c_end constant text := ';?(UNTIL|COUNT)=[^;]*';
  v_moved boolean := NEW.start_at IS DISTINCT FROM OLD.start_at
                  OR NEW.rrule IS DISTINCT FROM OLD.rrule
                  OR (NEW.rrule IS NOT NULL
                      AND (NEW.all_day, NEW.time_zone) IS DISTINCT FROM (OLD.all_day, OLD.time_zone));
  -- Only where the series ends changed: its dates before that stay.
  v_end_only boolean := NEW.rrule IS NOT NULL AND OLD.rrule IS NOT NULL
                  AND NEW.start_at = OLD.start_at
                  AND (NEW.all_day, NEW.time_zone) IS NOT DISTINCT FROM (OLD.all_day, OLD.time_zone)
                  AND regexp_replace(NEW.rrule, c_end, '', 'g') = regexp_replace(OLD.rrule, c_end, '', 'g');
BEGIN
  UPDATE notifications n
     SET read_at = now()
    FROM (SELECT b.id, (b.meta ->> 'occurrence_start')::timestamptz AS at
            FROM notifications b
           WHERE b.read_at IS NULL
             AND b.type IN ('task_due', 'meeting_reminder', 'event_reminder')
             AND b.type = 'event_reminder'
             AND b.account_id = OLD.account_id
             AND coalesce(b.meta ->> 'task_id', b.meta ->> 'meeting_id', b.meta ->> 'event_id') = OLD.id::text) o
   WHERE n.id = o.id
     AND (NEW.status <> 'confirmed'
          OR o.at = ANY (NEW.exdates)
          -- The event's own start always holds, for a series its first date.
          OR (v_moved AND o.at IS DISTINCT FROM NEW.start_at
              AND NOT (v_end_only AND (NEW.series_end_at IS NULL OR o.at < NEW.series_end_at))));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'calendar_events_stale_bells: %: % (%)', OLD.id, SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS calendar_events_stale_bells ON public.calendar_events;
CREATE TRIGGER calendar_events_stale_bells
  AFTER UPDATE ON public.calendar_events
  FOR EACH ROW
  WHEN (OLD.status = 'confirmed'
        AND (NEW.status <> 'confirmed'
             OR NEW.start_at IS DISTINCT FROM OLD.start_at
             OR NEW.rrule IS DISTINCT FROM OLD.rrule
             OR NEW.exdates IS DISTINCT FROM OLD.exdates
             OR NEW.all_day IS DISTINCT FROM OLD.all_day
             OR NEW.time_zone IS DISTINCT FROM OLD.time_zone))
  EXECUTE FUNCTION public.calendar_events_stale_bells();

DROP TRIGGER IF EXISTS calendar_events_stale_bells_delete ON public.calendar_events;
CREATE TRIGGER calendar_events_stale_bells_delete
  AFTER DELETE ON public.calendar_events
  FOR EACH ROW
  EXECUTE FUNCTION public.stale_bells_read('event_reminder');

-- Triggers only; nobody calls these.
REVOKE ALL ON FUNCTION public.stale_bells_read() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calendar_events_stale_bells() FROM PUBLIC, anon, authenticated;

RESET lock_timeout;
