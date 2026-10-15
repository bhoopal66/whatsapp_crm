-- ============================================================
-- 107_meetings_v2.sql — in-room chat, reactions, raised hands and
-- moderation for video meetings (on top of 106; docs/meetings.md)
--
--  * meeting_participants gains hand_raised_at, mute_requested_at,
--    removed_at and removed_by. Like the rest of the table they are
--    written only by the API routes on the service role (106 grants
--    clients SELECT alone): POST /api/meetings/[id]/state sets the
--    caller's own hand, POST /api/meetings/[id]/moderate (a manager,
--    meeting_can_manage) asks for a mute, lowers a hand or removes a
--    seat. A removed seat is a closed one: removed_at needs left_at, and
--    removed_by needs removed_at (CHECKs, every writer).
--  * meeting_messages: the room's chat and its reactions, one row per
--    post, in the meeting's account (composite FK, cascading with the
--    meeting). Who reads them is who sees the meeting (meeting_can_view,
--    106's shared rule), so a bank guest, another workspace and a
--    colleague not invited to an invite-only meeting read nothing, and
--    the history stays readable after the meeting ends. Append-only: no
--    client INSERT, UPDATE or DELETE at all. The one way in is
--    meeting_post_message(), SECURITY DEFINER, which checks visibility,
--    that the meeting is still 'scheduled', the kind and body, and a
--    rate limit of 20 posts per person per meeting per 10 seconds.
--    The reaction set is MEETING_REACTIONS in
--    src/lib/meetings/room/contract.ts and is spelled twice below (the
--    CHECK and the function): change all three together.
--  * meeting_messages joins supabase_realtime; RLS is replayed per
--    subscriber, so the room's subscription shows only what a query
--    would.
--
-- The function reads RLS-forced tables, so, as 106, this must be
-- applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, guarded constraints,
-- CREATE … IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '107 must be applied by a superuser or BYPASSRLS role (meeting_post_message reads RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Raised hands and moderation on a seat ----------

ALTER TABLE public.meeting_participants
  ADD COLUMN IF NOT EXISTS hand_raised_at    timestamptz NULL,
  ADD COLUMN IF NOT EXISTS mute_requested_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS removed_at        timestamptz NULL,
  ADD COLUMN IF NOT EXISTS removed_by        uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'meeting_participants_removed_check'
                    AND conrelid = 'public.meeting_participants'::regclass) THEN
    ALTER TABLE public.meeting_participants
      ADD CONSTRAINT meeting_participants_removed_check CHECK (
        (removed_at IS NULL OR left_at IS NOT NULL)
        AND (removed_by IS NULL OR removed_at IS NOT NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.meeting_participants.hand_raised_at IS
  'Set while the person''s hand is up; NULL when lowered (by them, or by a manager). Service role writes only. Migration 107.';
COMMENT ON COLUMN public.meeting_participants.mute_requested_at IS
  'The last time a manager asked this seat to mute; the client mutes itself on seeing it change. Migration 107.';
COMMENT ON COLUMN public.meeting_participants.removed_at IS
  'Stamped with left_at when a manager removes the seat (the room then shows "removed"). Migration 107.';
COMMENT ON COLUMN public.meeting_participants.removed_by IS
  'auth.users id of the manager who removed the seat. Migration 107.';

-- ---------- 2. Chat and reactions ----------

CREATE TABLE IF NOT EXISTS public.meeting_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL,
  account_id uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_messages_kind_check CHECK (kind IN ('chat', 'reaction')),
  -- A chat body is trimmed, 1–2000 characters; a reaction is one of
  -- MEETING_REACTIONS (👍 👏 😂 ❤️ 🎉 😮, the heart with U+FE0F).
  -- Spelled again in meeting_post_message: change both.
  CONSTRAINT meeting_messages_body_check CHECK (
    (kind = 'chat'
       AND char_length(body) BETWEEN 1 AND 2000
       AND body !~ '^[[:space:]]|[[:space:]]$')
    OR (kind = 'reaction'
       AND body IN (E'\U0001F44D', E'\U0001F44F', E'\U0001F602',
                    E'❤️', E'\U0001F389', E'\U0001F62E'))),
  CONSTRAINT meeting_messages_meeting_fkey FOREIGN KEY (meeting_id, account_id)
    REFERENCES public.meetings (id, account_id) ON DELETE CASCADE
);

-- History in order, and the rate-limit count.
CREATE INDEX IF NOT EXISTS meeting_messages_meeting_created_idx
  ON public.meeting_messages (meeting_id, created_at);
CREATE INDEX IF NOT EXISTS meeting_messages_user_idx
  ON public.meeting_messages (user_id);

COMMENT ON TABLE public.meeting_messages IS
  'A meeting''s in-room chat and reactions. Read as the meeting is (meeting_can_view); written only through meeting_post_message(); append-only. Migration 107.';
COMMENT ON COLUMN public.meeting_messages.user_id IS
  'auth.users id of the author: always auth.uid() of the poster.';

-- ---------- 3. Posting ----------

-- Errors (the API maps them): not signed in, no such meeting or not
-- visible → 42501; ended or cancelled → P0001 'meeting_closed'; a bad
-- kind or body → 22023; over 20 posts by this person in this meeting in
-- the last 10 seconds → P0001 'rate_limited'.
--
-- FOR SHARE on the meeting: an end or cancel that commits first is seen
-- (READ COMMITTED re-reads the locked row), and one that comes later
-- waits for this post. The advisory lock makes the rate limit exact
-- under concurrent posts by the same person; the count after it runs on
-- a fresh snapshot, so it sees a post the lock waited for.
CREATE OR REPLACE FUNCTION public.meeting_post_message(p_meeting uuid, p_kind text, p_body text)
RETURNS public.meeting_messages
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_meeting meetings;
  v_body    text;
  v_row     meeting_messages;
BEGIN
  IF v_uid IS NULL OR p_meeting IS NULL OR NOT meeting_can_view(p_meeting) THEN
    RAISE EXCEPTION 'meeting_not_visible' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_meeting FROM meetings WHERE id = p_meeting FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'meeting_not_visible' USING ERRCODE = '42501';
  END IF;
  IF v_meeting.status <> 'scheduled' THEN
    RAISE EXCEPTION 'meeting_closed' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'chat' THEN
    v_body := regexp_replace(coalesce(p_body, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
    IF char_length(v_body) NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'invalid_body' USING ERRCODE = '22023',
        DETAIL = 'A chat message is 1 to 2000 characters.';
    END IF;
  ELSIF p_kind = 'reaction' THEN
    -- The same set as meeting_messages_body_check: change both.
    IF p_body IS NULL OR p_body NOT IN (E'\U0001F44D', E'\U0001F44F', E'\U0001F602',
                                        E'❤️', E'\U0001F389', E'\U0001F62E') THEN
      RAISE EXCEPTION 'invalid_body' USING ERRCODE = '22023',
        DETAIL = 'Not one of the meeting reactions.';
    END IF;
    v_body := p_body;
  ELSE
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023',
      DETAIL = 'kind is chat or reaction.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('meeting_post_message:' || p_meeting::text || ':' || v_uid::text, 0));
  IF (SELECT count(*) FROM meeting_messages
       WHERE meeting_id = p_meeting
         AND user_id = v_uid
         AND created_at > now() - interval '10 seconds') >= 20 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO meeting_messages (meeting_id, account_id, user_id, kind, body)
  VALUES (p_meeting, v_meeting.account_id, v_uid, p_kind, v_body)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION public.meeting_post_message(uuid, text, text) IS
  'Post a chat message or reaction to a meeting as auth.uid(): visible (42501), scheduled (P0001 meeting_closed), valid kind/body (22023), at most 20 per person per meeting per 10 s (P0001 rate_limited). Migration 107.';

-- ---------- 4. Row-level security ----------

ALTER TABLE public.meeting_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_messages FORCE ROW LEVEL SECURITY;

-- Rows of an existing meeting, so meeting_can_view(meeting_id) is safe
-- here (106's INSERT … RETURNING caveat does not apply: clients never
-- insert, and the function returns the row without a policy check).
DROP POLICY IF EXISTS meeting_messages_select ON public.meeting_messages;
CREATE POLICY meeting_messages_select ON public.meeting_messages FOR SELECT TO authenticated
  USING (meeting_can_view(meeting_id));

-- ---------- 5. Privileges ----------

-- Start from nothing (a new public table grants anon and authenticated
-- everything, TRUNCATE included) and grant reads only. The service role
-- reads (counts for the API); nothing but meeting_post_message writes.
REVOKE ALL ON public.meeting_messages FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.meeting_messages TO authenticated, service_role;

-- Supabase's default privileges grant EXECUTE on a new function to
-- anon and service_role too: the function is for a signed-in caller.
REVOKE ALL ON FUNCTION public.meeting_post_message(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.meeting_post_message(uuid, text, text) TO authenticated;

-- ---------- 6. Realtime ----------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public' AND tablename = 'meeting_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.meeting_messages;
  END IF;
END
$$;

RESET lock_timeout;
