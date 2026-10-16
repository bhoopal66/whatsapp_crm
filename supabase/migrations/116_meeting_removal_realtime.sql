-- ============================================================
-- 116_meeting_removal_realtime.sql — a removed person's room learns
-- of the removal by realtime (on top of 106, 110 and 112;
-- docs/meetings.md)
--
--  * Since 112 a meeting_removed_users row hides the meeting from the
--    person it names (meeting_row_visible), and the seat policy (106)
--    goes through that predicate. So the realtime UPDATE that stamps
--    removed_at on the person's own seat is no longer delivered to
--    them: the moment they are removed they stop seeing their seat.
--    Their room found out only at its next heartbeat (up to 20 s),
--    while still in the call.
--  * The removal row itself is readable by the person it names (110's
--    meeting_removed_users_select: a manager, or user_id = auth.uid()),
--    and realtime replays that SELECT policy per subscriber. Adding the
--    table to supabase_realtime lets the room subscribe to INSERTs on
--    it and leave within a second; the heartbeat stays as the fallback.
--    Managers receive every removal of the meeting, the person only
--    their own, nobody else anything.
--  * REPLICA IDENTITY stays DEFAULT: the room listens for INSERT only,
--    and an INSERT carries the whole new row under any identity.
--
-- ALTER PUBLICATION needs the publication's owner, so, as 106, apply
-- as a superuser.
--
-- Re-runnable: the table is added only when the publication exists and
-- does not list it yet.
-- ============================================================

SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public' AND tablename = 'meeting_removed_users'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.meeting_removed_users;
  END IF;
END
$$;

RESET lock_timeout;
