-- ============================================================
-- 106_meetings.sql — video meetings (Cloudflare Realtime SFU)
--
-- Staff schedule a meeting, or start one now, and join it from the
-- browser; the media goes through Cloudflare's SFU, so the database only
-- holds who may join and who is in the room (docs/meetings.md).
--
--  * Staff only. Every policy goes through current_account_id(), which
--    is NULL for a bank guest, a deactivated row and an inactive
--    workspace (082-083), so a guest sees and writes nothing here.
--  * meetings: host_user_id is an auth user id, like
--    notifications.user_id. "Live" is not a stored status: it is derived
--    from meeting_participants (left_at IS NULL and a heartbeat in the
--    last 60 seconds; clients beat every 20). status is scheduled,
--    ended or cancelled, and the last two are terminal.
--  * Who sees a meeting (meeting_can_view): in the caller's active
--    workspace, and owner/admin, the host, an invitee, or anyone there
--    when open_to_workspace. Who manages it (meeting_can_manage): the
--    same workspace, and owner/admin or the host.
--    The meetings policy cannot call meeting_can_view(id): a STABLE
--    function reads the statement's snapshot, which does not hold a row
--    the same INSERT is writing, so INSERT … RETURNING (PostgREST's
--    return=representation) would be refused. Both entry points
--    therefore share one row predicate (meeting_row_visible /
--    meeting_row_manageable) and the table policy passes its own
--    columns.
--  * meeting_invitees: one row per invited person, in the meeting's
--    account (composite FK). The person must hold a live, non-guest
--    profile in that account (meeting_invitees_guard, every writer).
--    Inviting someone else rings their bell: type 'meeting_invite',
--    meta = {meeting_id}; inviting yourself does not.
--  * meeting_participants: one row per join (one Cloudflare session),
--    at most one open (left_at IS NULL) per person per meeting.
--    No client writes at all: the API routes write them on the service
--    role after checking meeting_can_view through the caller's client.
--  * meetings_guard binds every writer, the service role included:
--    account_id and host_user_id never change, a new meeting is
--    'scheduled', ended/cancelled are terminal, and ended_at is stamped
--    by the trigger on entering 'ended'. Entering either terminal
--    status closes (left_at) every participant row still open, so a
--    cancelled meeting does not show people in it either.
--  * meetings and meeting_participants join supabase_realtime: the room
--    discovers tracks from participant rows. RLS is replayed per
--    subscriber, so a subscription shows only what a query would.
--
-- The SECURITY DEFINER helpers read RLS-forced tables, so, as in 087,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, guarded constraints, CREATE OR
-- REPLACE, DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '106 must be applied by a superuser or BYPASSRLS role (the meeting functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.meetings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  title             text NOT NULL,
  description       text NULL,
  scheduled_start   timestamptz NULL,
  scheduled_end     timestamptz NULL,
  host_user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  open_to_workspace boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'scheduled',
  ended_at          timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meetings_title_check CHECK (
    btrim(title) <> '' AND char_length(btrim(title)) <= 200),
  CONSTRAINT meetings_description_check CHECK (
    description IS NULL OR char_length(description) <= 2000),
  CONSTRAINT meetings_schedule_check CHECK (
    scheduled_start IS NULL OR scheduled_end IS NULL OR scheduled_end > scheduled_start),
  CONSTRAINT meetings_status_check CHECK (
    status IN ('scheduled', 'ended', 'cancelled')),
  -- The target of the composite FKs below.
  CONSTRAINT meetings_id_account_key UNIQUE (id, account_id)
);

CREATE INDEX IF NOT EXISTS meetings_account_start_idx
  ON public.meetings (account_id, scheduled_start);
CREATE INDEX IF NOT EXISTS meetings_host_idx
  ON public.meetings (host_user_id);

COMMENT ON TABLE public.meetings IS
  'Video meetings (Cloudflare Realtime SFU). Live is derived from meeting_participants, not stored. Migration 106; docs/meetings.md.';
COMMENT ON COLUMN public.meetings.scheduled_start IS
  'NULL for an instant meeting ("Start now").';
COMMENT ON COLUMN public.meetings.host_user_id IS
  'auth.users id of the host (as notifications.user_id). Never changes (meetings_guard).';
COMMENT ON COLUMN public.meetings.ended_at IS
  'Stamped by meetings_guard on entering status ended.';

CREATE TABLE IF NOT EXISTS public.meeting_invitees (
  meeting_id uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id),
  CONSTRAINT meeting_invitees_meeting_fkey FOREIGN KEY (meeting_id, account_id)
    REFERENCES public.meetings (id, account_id) ON DELETE CASCADE
);

-- "Meetings I am invited to."
CREATE INDEX IF NOT EXISTS meeting_invitees_user_idx
  ON public.meeting_invitees (user_id);

COMMENT ON TABLE public.meeting_invitees IS
  'Who is invited to a meeting: a live, non-guest member of its account (meeting_invitees_guard). Migration 106.';

CREATE TABLE IF NOT EXISTS public.meeting_participants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    uuid NOT NULL,
  account_id    uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cf_session_id text NOT NULL,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  left_at       timestamptz NULL,
  tracks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  audio_muted   boolean NOT NULL DEFAULT false,
  video_off     boolean NOT NULL DEFAULT false,
  CONSTRAINT meeting_participants_cf_session_key UNIQUE (cf_session_id),
  CONSTRAINT meeting_participants_tracks_check CHECK (jsonb_typeof(tracks) = 'array'),
  CONSTRAINT meeting_participants_meeting_fkey FOREIGN KEY (meeting_id, account_id)
    REFERENCES public.meetings (id, account_id) ON DELETE CASCADE
);

-- "Who is in the room": open rows of one meeting.
CREATE INDEX IF NOT EXISTS meeting_participants_open_idx
  ON public.meeting_participants (meeting_id, last_seen_at) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS meeting_participants_user_idx
  ON public.meeting_participants (user_id);
-- One open seat per person per meeting: join closes the old seat and
-- inserts the new one in two writes, so two tabs joining at once would
-- otherwise both hold a seat. The loser gets 23505 and retries.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_participants_one_open_seat
  ON public.meeting_participants (meeting_id, user_id) WHERE left_at IS NULL;

COMMENT ON TABLE public.meeting_participants IS
  'One row per join (one Cloudflare session). Present = left_at IS NULL AND last_seen_at > now() - 60 s. Service role writes only. Migration 106.';
COMMENT ON COLUMN public.meeting_participants.tracks IS
  'The participant''s published tracks: [{trackName, kind: audio|video|screen}].';

-- ---------- 2. Who sees and manages a meeting ----------

-- The one rule, over a meeting row's own columns. current_account_id()
-- is the caller's active, live, non-guest row (NULL otherwise), and
-- current_role_rank() reads that same row. DEFINER so the invitee
-- lookup does not run meeting_invitees' own policy (which calls back
-- into this).
CREATE OR REPLACE FUNCTION public.meeting_row_visible(
  p_account_id uuid, p_host_user_id uuid, p_open boolean, p_meeting uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_account_id IS NOT NULL
     AND p_account_id = current_account_id()
     AND (current_role_rank() >= 4
          OR p_host_user_id = auth.uid()
          OR p_open
          OR EXISTS (SELECT 1 FROM meeting_invitees i
                      WHERE i.meeting_id = p_meeting AND i.user_id = auth.uid()));
$$;

CREATE OR REPLACE FUNCTION public.meeting_row_manageable(
  p_account_id uuid, p_host_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_account_id IS NOT NULL
     AND p_account_id = current_account_id()
     AND (current_role_rank() >= 4 OR p_host_user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.meeting_can_view(p_meeting uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM meetings m
     WHERE m.id = p_meeting
       AND meeting_row_visible(m.account_id, m.host_user_id, m.open_to_workspace, m.id));
$$;
COMMENT ON FUNCTION public.meeting_can_view(uuid) IS
  'The caller (active, live, non-guest in the meeting''s workspace) is owner/admin, the host, an invitee, or the meeting is open_to_workspace. Migration 106.';

CREATE OR REPLACE FUNCTION public.meeting_can_manage(p_meeting uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM meetings m
     WHERE m.id = p_meeting
       AND meeting_row_manageable(m.account_id, m.host_user_id));
$$;
COMMENT ON FUNCTION public.meeting_can_manage(uuid) IS
  'The caller (active, live, non-guest in the meeting''s workspace) is owner/admin or the host. Migration 106.';

-- ---------- 3. Integrity (every writer, the service role included) ----------

CREATE OR REPLACE FUNCTION public.meetings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.title := btrim(NEW.title);
  NEW.description := NULLIF(btrim(NEW.description), '');
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'scheduled' THEN
      RAISE EXCEPTION 'A new meeting is scheduled'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.ended_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.host_user_id IS DISTINCT FROM OLD.host_user_id THEN
    RAISE EXCEPTION 'A meeting''s workspace and host cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('ended', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A meeting that has % cannot be reopened', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- ended_at is trigger-owned.
  IF NEW.status = 'ended' AND OLD.status <> 'ended' THEN
    NEW.ended_at := now();
  ELSE
    NEW.ended_at := OLD.ended_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meetings_guard ON public.meetings;
CREATE TRIGGER meetings_guard
  BEFORE INSERT OR UPDATE ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.meetings_guard();

-- DEFINER: the caller (a host) has no write on meeting_participants.
CREATE OR REPLACE FUNCTION public.meetings_close_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE meeting_participants
     SET left_at = now()
   WHERE meeting_id = NEW.id AND left_at IS NULL;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS meetings_close_participants ON public.meetings;
CREATE TRIGGER meetings_close_participants
  AFTER UPDATE OF status ON public.meetings
  FOR EACH ROW
  WHEN (NEW.status IN ('ended', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.meetings_close_participants();

-- An invitee is a live, non-guest member of the meeting's account; not
-- necessarily active there (one login, several workspaces: 083). The
-- composite FK already ties account_id to the meeting's.
CREATE OR REPLACE FUNCTION public.meeting_invitees_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles p
                  WHERE p.user_id = NEW.user_id
                    AND p.account_id = NEW.account_id
                    AND p.deactivated_at IS NULL
                    AND p.account_role <> 'bank_guest') THEN
    RAISE EXCEPTION 'Only a live staff member of the meeting''s workspace can be invited'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meeting_invitees_guard ON public.meeting_invitees;
CREATE TRIGGER meeting_invitees_guard
  BEFORE INSERT OR UPDATE ON public.meeting_invitees
  FOR EACH ROW EXECUTE FUNCTION public.meeting_invitees_guard();

-- ---------- 4. The bell ----------
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
    'meeting_invite'
  ));

-- As tasks_notify_assigned (085): DEFINER because notifications has no
-- INSERT policy, and a failure is logged and swallowed, so a missed
-- bell never undoes the invitation. The text is English, as every bell
-- written in SQL is. No auth.uid() (the service role) is someone else.
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
      'Starts ' || to_char(v_meeting.scheduled_start AT TIME ZONE 'UTC', 'DD Mon YYYY HH24:MI') || ' UTC'
    ELSE 'Starting now' END,
    jsonb_build_object('meeting_id', NEW.meeting_id)
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create the invitation notification for meeting %: %', NEW.meeting_id, SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS meeting_invitees_notify ON public.meeting_invitees;
CREATE TRIGGER meeting_invitees_notify
  AFTER INSERT ON public.meeting_invitees
  FOR EACH ROW EXECUTE FUNCTION public.meeting_invitees_notify();

-- ---------- 5. Row-level security ----------

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meetings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_invitees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_invitees FORCE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_participants FORCE ROW LEVEL SECURITY;

-- meeting_can_view over the row's own columns (see the header).
DROP POLICY IF EXISTS meetings_select ON public.meetings;
CREATE POLICY meetings_select ON public.meetings FOR SELECT TO authenticated
  USING (meeting_row_visible(account_id, host_user_id, open_to_workspace, id));

-- current_account_id() is NULL for a guest or a deactivated row, so
-- this is "a live staff member, in their active workspace, hosting".
DROP POLICY IF EXISTS meetings_insert ON public.meetings;
CREATE POLICY meetings_insert ON public.meetings FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 1
    AND host_user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS meetings_update ON public.meetings;
CREATE POLICY meetings_update ON public.meetings FOR UPDATE TO authenticated
  USING (meeting_row_manageable(account_id, host_user_id))
  WITH CHECK (meeting_row_manageable(account_id, host_user_id));

DROP POLICY IF EXISTS meetings_delete ON public.meetings;
CREATE POLICY meetings_delete ON public.meetings FOR DELETE TO authenticated
  USING (meeting_row_manageable(account_id, host_user_id));

DROP POLICY IF EXISTS meeting_invitees_select ON public.meeting_invitees;
CREATE POLICY meeting_invitees_select ON public.meeting_invitees FOR SELECT TO authenticated
  USING (meeting_can_view(meeting_id));

DROP POLICY IF EXISTS meeting_invitees_insert ON public.meeting_invitees;
CREATE POLICY meeting_invitees_insert ON public.meeting_invitees FOR INSERT TO authenticated
  WITH CHECK (meeting_can_manage(meeting_id));

DROP POLICY IF EXISTS meeting_invitees_delete ON public.meeting_invitees;
CREATE POLICY meeting_invitees_delete ON public.meeting_invitees FOR DELETE TO authenticated
  USING (meeting_can_manage(meeting_id));

DROP POLICY IF EXISTS meeting_participants_select ON public.meeting_participants;
CREATE POLICY meeting_participants_select ON public.meeting_participants FOR SELECT TO authenticated
  USING (meeting_can_view(meeting_id));

-- ---------- 6. Privileges ----------

-- A new public table starts with every privilege for anon and
-- authenticated, TRUNCATE (which skips RLS) among them: start from
-- nothing and grant what the policies govern.
REVOKE ALL ON public.meetings, public.meeting_invitees, public.meeting_participants
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meetings TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.meeting_invitees TO authenticated;
GRANT SELECT ON public.meeting_participants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.meetings, public.meeting_invitees, public.meeting_participants TO service_role;

REVOKE ALL ON FUNCTION public.meeting_row_visible(uuid, uuid, boolean, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.meeting_row_manageable(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.meeting_can_view(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.meeting_can_manage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.meeting_row_visible(uuid, uuid, boolean, uuid),
  public.meeting_row_manageable(uuid, uuid),
  public.meeting_can_view(uuid),
  public.meeting_can_manage(uuid)
  TO authenticated, service_role;

-- Trigger functions are not for calling.
REVOKE ALL ON FUNCTION public.meetings_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meetings_close_participants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meeting_invitees_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meeting_invitees_notify() FROM PUBLIC, anon, authenticated;

-- ---------- 7. Realtime ----------
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['meetings', 'meeting_participants'] LOOP
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
