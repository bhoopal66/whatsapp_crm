-- ============================================================
-- 110_meeting_removal.sql — a removal sticks for the rest of the
-- meeting (on top of 106 and 107; docs/meetings.md)
--
--  * meeting_removed_users: one row per person the host (or an owner or
--    admin: meeting_can_manage) removed from a meeting, in the
--    meeting's account (composite FK, cascading with the meeting).
--    While the row exists, POST /api/meetings/[id]/join refuses the
--    person (403 removed_from_meeting) before any Cloudflare session is
--    made, and meeting_post_message() refuses their chat and reactions
--    (P0001 removed). Letting them back in deletes the row
--    (POST /api/meetings/[id]/moderate, action readmit).
--  * Read by a manager of the meeting, or by the removed person about
--    themselves. No client writes at all: the moderate route writes on
--    the service role after checking meeting_can_manage.
--  * meeting_post_message() is 107's, byte for byte, plus the removed
--    check after the meeting_closed one.
--  * A BEFORE INSERT trigger on meeting_participants refuses a seat for
--    a removed person (P0001 removed_from_meeting), whichever writer
--    and however late the join's own check ran.
--
-- The function reads RLS-forced tables, so, as 106 and 107, this must
-- be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '110 must be applied by a superuser or BYPASSRLS role (meeting_post_message reads RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Who was removed ----------

CREATE TABLE IF NOT EXISTS public.meeting_removed_users (
  meeting_id uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  removed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (meeting_id, user_id),
  CONSTRAINT meeting_removed_users_meeting_fkey FOREIGN KEY (meeting_id, account_id)
    REFERENCES public.meetings (id, account_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.meeting_removed_users IS
  'People removed from a meeting by a manager: refused at join and in the room''s chat until let back in (the row deleted). Written only by the API on the service role. Migration 110.';

-- ---------- 2. Chat and reactions refuse a removed person ----------

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
  -- 110: someone the host removed stays out until they are let back in.
  IF EXISTS (SELECT 1 FROM meeting_removed_users
              WHERE meeting_id = p_meeting AND user_id = v_uid) THEN
    RAISE EXCEPTION 'removed' USING ERRCODE = 'P0001';
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
  'Post a chat message or reaction to a meeting as auth.uid(): visible (42501), scheduled (P0001 meeting_closed), not removed from it (P0001 removed), valid kind/body (22023), at most 20 per person per meeting per 10 s (P0001 rate_limited). Migrations 107, 110.';

-- ---------- 2b. A removal holds against a racing join ----------

-- The join route checks meeting_removed_users and then inserts the
-- seat; a removal landing in between would otherwise leave the removed
-- person a fresh seat. Every seat INSERT (any writer) is refused while
-- the person is removed. Both triggers take the same per-(meeting,
-- person) transaction lock, so a seat and a removal in flight at once
-- are serialised: the later one sees the earlier one committed.
CREATE OR REPLACE FUNCTION public.meeting_removal_lock(p_meeting uuid, p_user uuid)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('meeting_removal:' || p_meeting::text || ':' || p_user::text, 0))
$$;

CREATE OR REPLACE FUNCTION public.meeting_participants_refuse_removed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM meeting_removal_lock(NEW.meeting_id, NEW.user_id);
  IF EXISTS (SELECT 1 FROM meeting_removed_users
              WHERE meeting_id = NEW.meeting_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'removed_from_meeting' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meeting_participants_refuse_removed ON public.meeting_participants;
CREATE TRIGGER meeting_participants_refuse_removed BEFORE INSERT ON public.meeting_participants
  FOR EACH ROW EXECUTE FUNCTION public.meeting_participants_refuse_removed();

CREATE OR REPLACE FUNCTION public.meeting_removed_users_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM meeting_removal_lock(NEW.meeting_id, NEW.user_id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meeting_removed_users_lock ON public.meeting_removed_users;
CREATE TRIGGER meeting_removed_users_lock BEFORE INSERT ON public.meeting_removed_users
  FOR EACH ROW EXECUTE FUNCTION public.meeting_removed_users_lock();

-- ---------- 3. Row-level security ----------

ALTER TABLE public.meeting_removed_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_removed_users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meeting_removed_users_select ON public.meeting_removed_users;
CREATE POLICY meeting_removed_users_select ON public.meeting_removed_users FOR SELECT TO authenticated
  USING (meeting_can_manage(meeting_id) OR user_id = (SELECT auth.uid()));

-- ---------- 4. Privileges ----------

-- A new public table grants anon and authenticated everything: start
-- from nothing. Clients read; only the service role writes.
REVOKE ALL ON public.meeting_removed_users FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.meeting_removed_users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_removed_users TO service_role;

REVOKE ALL ON FUNCTION public.meeting_post_message(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.meeting_post_message(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.meeting_removal_lock(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meeting_participants_refuse_removed() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meeting_removed_users_lock() FROM PUBLIC, anon, authenticated, service_role;
