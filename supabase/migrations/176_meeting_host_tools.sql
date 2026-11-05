-- ============================================================
-- 176_meeting_host_tools.sql — host lock, recording indicator and
-- shared notes for video meetings (on top of 106, 110 and 112;
-- docs/meetings.md)
--
-- In plain words: a host can lock a meeting so nobody new gets in, the
-- room can show everyone that the call is being recorded, and the
-- people in a meeting share one page of minutes.
--
--  * Lock and recording are four columns on meetings (who and when).
--    They decide what the room tells people, so a client must not be
--    able to set or clear them itself: the routes write them on the
--    service role, after their own checks. meetings_host_tools_guard
--    refuses every other writer, on INSERT too (a host could otherwise
--    create a meeting already stamped). A manager's ordinary UPDATE of
--    a title, or ending a meeting, does not touch them and is unchanged.
--  * A meeting that is not 'scheduled' cannot be recording, so the same
--    trigger empties the two recording columns for every writer. Its
--    name sorts it after meetings_guard and meetings_host_only, and it
--    refuses before it clears, so a client that only ends a meeting is
--    not refused for the columns the trigger itself empties. The lock
--    stays: an ended meeting has no room to enter.
--  * meeting_notes is one row per meeting: the shared minutes. Read as
--    the meeting is (meeting_can_view, so a removed person and a bank
--    guest get nothing), written only through meeting_save_notes().
--    While the meeting is scheduled anyone who can see it may write;
--    after it has ended or been cancelled only the host or an admin may
--    (meeting_can_manage), to finish the minutes.
--  * Two people typing at once: every save names the version it was
--    based on, and a save based on an older version writes nothing and
--    raises SQLSTATE MN001 'STALE'. The client reloads and retries.
--    Version 0 means "there is no row yet".
--  * No foreign key to auth.users on locked_by, recording_by or
--    meeting_notes.updated_by, deliberately. meetings.host_user_id is
--    ON DELETE CASCADE, so a SET NULL on the same row would let deleting
--    a host's login reach one row by two paths at once, the failure 117
--    explains. The uuids are labels: one may outlive its login, and a
--    reader treats an unknown id as an unknown person.
--  * The composite foreign key to meetings is plain, not deferrable:
--    117 asks for a reproduction before adding another, and a row of
--    meeting_notes has one path only.
--  * Realtime: the room listens for INSERT and UPDATE on meeting_notes,
--    which carry the whole new row and are replayed through the SELECT
--    policy per subscriber. REPLICA IDENTITY stays DEFAULT, so the
--    DELETE of a cascade, which Realtime delivers without RLS, carries
--    only the meeting id.
--
-- meeting_save_notes() reads RLS-forced tables and ALTER PUBLICATION
-- needs the publication's owner, so, as 106, this must be applied by a
-- superuser or BYPASSRLS role.
--
-- Re-runnable: columns and the table use IF NOT EXISTS, functions
-- CREATE OR REPLACE, triggers and policies DROP … IF EXISTS, and the
-- table joins the publication only when it is not listed yet.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '176 must be applied by a superuser or BYPASSRLS role (meeting_save_notes reads RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Lock and recording ----------

-- Plain uuid columns: see the header on why these have no foreign key.
ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS locked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS locked_by uuid NULL,
  ADD COLUMN IF NOT EXISTS recording_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS recording_by uuid NULL;

COMMENT ON COLUMN public.meetings.locked_at IS
  'Set while the host has locked the meeting. Service role writes only (meetings_host_tools_guard). Migration 176.';
COMMENT ON COLUMN public.meetings.locked_by IS
  'auth.users id of who locked it. No foreign key on purpose: a SET NULL here beside the host_user_id cascade is the two-path delete of 117.';
COMMENT ON COLUMN public.meetings.recording_started_at IS
  'Set while the room shows the recording indicator. Service role writes only; emptied for every writer once the meeting is not scheduled. Migration 176.';
COMMENT ON COLUMN public.meetings.recording_by IS
  'auth.users id of who started the recording. No foreign key on purpose: see locked_by.';

-- ---------- 2. Only the service role writes them ----------

-- Sorts after meetings_guard and meetings_host_only. One trigger, in
-- this order, on purpose: a separate clearing trigger sorted first
-- would make this check refuse a host who only ended the meeting.
CREATE OR REPLACE FUNCTION public.meetings_host_tools_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- The routes run on the service role; migrations and the SQL editor
  -- have no signed-in user (062's idiom). OLD is all NULL on INSERT, so
  -- this also refuses a client creating a meeting already stamped.
  IF auth.uid() IS NOT NULL
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND (NEW.locked_at IS DISTINCT FROM OLD.locked_at
          OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
          OR NEW.recording_started_at IS DISTINCT FROM OLD.recording_started_at
          OR NEW.recording_by IS DISTINCT FROM OLD.recording_by) THEN
    RAISE EXCEPTION 'A meeting''s lock and recording state are written by the server only'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status <> 'scheduled' THEN
    NEW.recording_started_at := NULL;
    NEW.recording_by := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS meetings_host_tools_guard ON public.meetings;
CREATE TRIGGER meetings_host_tools_guard
  BEFORE INSERT OR UPDATE ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.meetings_host_tools_guard();

-- ---------- 3. Shared notes ----------

CREATE TABLE IF NOT EXISTS public.meeting_notes (
  meeting_id uuid NOT NULL,
  account_id uuid NOT NULL,
  body       text NOT NULL DEFAULT '',
  version    integer NOT NULL DEFAULT 1,
  -- No foreign key: see the header.
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_notes_pkey PRIMARY KEY (meeting_id),
  CONSTRAINT meeting_notes_body_check CHECK (char_length(body) <= 20000),
  CONSTRAINT meeting_notes_meeting_fkey FOREIGN KEY (meeting_id, account_id)
    REFERENCES public.meetings (id, account_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.meeting_notes IS
  'The shared minutes of a meeting, one row per meeting. Read as the meeting is; written only through meeting_save_notes(). Migration 176.';
COMMENT ON COLUMN public.meeting_notes.version IS
  'Bumped by every save; a save names the version it was based on (meeting_save_notes, MN001 STALE on a mismatch).';
COMMENT ON COLUMN public.meeting_notes.updated_by IS
  'auth.users id of the last writer. No foreign key on purpose: it may outlive the login.';

ALTER TABLE public.meeting_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_notes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meeting_notes_select ON public.meeting_notes;
CREATE POLICY meeting_notes_select ON public.meeting_notes FOR SELECT TO authenticated
  USING (meeting_can_view(meeting_id));

-- ---------- 4. Saving notes ----------

CREATE OR REPLACE FUNCTION public.meeting_save_notes(
  p_meeting uuid, p_body text, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_meeting meetings;
  v_row     meeting_notes;
BEGIN
  IF v_uid IS NULL OR p_meeting IS NULL OR NOT meeting_can_view(p_meeting) THEN
    RAISE EXCEPTION 'meeting_not_visible' USING ERRCODE = '42501';
  END IF;

  -- FOR SHARE: a save cannot slip in behind a meeting ending. The
  -- account comes from the meeting, not from the caller.
  SELECT * INTO v_meeting FROM meetings WHERE id = p_meeting FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'meeting_not_visible' USING ERRCODE = '42501';
  END IF;
  IF v_meeting.status <> 'scheduled' AND NOT meeting_can_manage(p_meeting) THEN
    RAISE EXCEPTION 'meeting_closed' USING ERRCODE = 'P0001';
  END IF;

  -- Blank is allowed: that is how the notes are cleared.
  IF p_body IS NULL OR char_length(p_body) > 20000 THEN
    RAISE EXCEPTION 'invalid_body' USING ERRCODE = '22023',
      DETAIL = 'Meeting notes are at most 20000 characters.';
  END IF;

  IF p_expected_version = 0 THEN
    INSERT INTO meeting_notes (meeting_id, account_id, body, updated_by)
    VALUES (p_meeting, v_meeting.account_id, p_body, v_uid)
    ON CONFLICT (meeting_id) DO NOTHING
    RETURNING * INTO v_row;
  ELSE
    UPDATE meeting_notes
       SET body = p_body,
           version = version + 1,
           updated_by = v_uid,
           updated_at = now()
     WHERE meeting_id = p_meeting
       AND version = p_expected_version
    RETURNING * INTO v_row;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STALE' USING ERRCODE = 'MN001';
  END IF;

  RETURN jsonb_build_object(
    'version', v_row.version,
    'updated_at', v_row.updated_at,
    'updated_by', v_row.updated_by);
END;
$$;

COMMENT ON FUNCTION public.meeting_save_notes(uuid, text, integer) IS
  'Saves a meeting''s notes if p_expected_version is still current (0 = no row yet), else MN001 STALE. Anyone who can view while scheduled, then only a manager. Migration 176.';

-- ---------- 5. Privileges ----------

-- A new public table starts with every privilege for anon and
-- authenticated, TRUNCATE (which skips RLS) among them.
REVOKE ALL ON public.meeting_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.meeting_notes TO authenticated;
GRANT ALL ON public.meeting_notes TO service_role;

REVOKE ALL ON FUNCTION public.meeting_save_notes(uuid, text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.meeting_save_notes(uuid, text, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.meetings_host_tools_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 6. Realtime ----------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public' AND tablename = 'meeting_notes'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.meeting_notes;
  END IF;
END
$$;

RESET lock_timeout;
