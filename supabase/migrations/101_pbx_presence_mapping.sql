-- Migration 101: phone presence follows the extension mapping, and a
-- long call keeps its red dot (module 015, phone presence on every
-- person's dot).
--
-- Yeastar sends a status (30009) and an extension's call state (30008)
-- only when they change, so a pbx_presence row is the PBX's word until
-- the next change. The browser no longer lets the chosen status expire
-- (lib/pbx/calls.ts presenceView); a call state still lapses after ten
-- minutes, as a call end the PBX never reported.
--
-- 1. pbx_presence copies the mapping (user_id, account_id) from
--    pbx_extensions when the processor writes. A trigger now keeps the
--    two in step for every writer (the extension PATCH, the sync, the
--    service role): with presence monitoring off, or the extension row
--    gone, the row is deleted (the team should not see that status); a
--    remap moves it to the new person and workspace, because the PBX
--    still holds the extension's status and will not send it again.
-- 2. pbx_presence_keepalive() refreshes a ringing or busy row while its
--    extension is still on a live call (call_live), for the PBX cron to
--    run every minute, so a call longer than ten minutes stays red.
--    call_live_select hides other people's calls from an agent, so the
--    browser cannot check this itself.
--
-- Re-runnable: CREATE OR REPLACE, DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION public.pbx_presence_follow_mapping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM pbx_presence
     WHERE connection_id = OLD.connection_id AND extension = OLD.extension;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.connection_id IS DISTINCT FROM OLD.connection_id
          OR NEW.extension IS DISTINCT FROM OLD.extension) THEN
    DELETE FROM pbx_presence
     WHERE connection_id = OLD.connection_id AND extension = OLD.extension;
  END IF;
  IF NOT NEW.presence_monitor THEN
    DELETE FROM pbx_presence
     WHERE connection_id = NEW.connection_id AND extension = NEW.extension;
  ELSE
    UPDATE pbx_presence
       SET user_id = NEW.user_id, account_id = NEW.account_id
     WHERE connection_id = NEW.connection_id AND extension = NEW.extension
       AND (user_id IS DISTINCT FROM NEW.user_id OR account_id IS DISTINCT FROM NEW.account_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pbx_presence_follow_mapping ON public.pbx_extensions;
CREATE TRIGGER pbx_presence_follow_mapping
  AFTER INSERT OR DELETE
     OR UPDATE OF connection_id, extension, account_id, user_id, presence_monitor
  ON public.pbx_extensions
  FOR EACH ROW EXECUTE FUNCTION public.pbx_presence_follow_mapping();

-- A ringing or busy row whose extension is a member of a live call on
-- the same connection, not yet hung up (BYE), and not refreshed for
-- five minutes (half the browser's window, so a cron run every minute
-- has room to miss a few). call_live outlives a call whose end was
-- never delivered by at most a day (pbx_purge), and so does the dot.
CREATE OR REPLACE FUNCTION public.pbx_presence_keepalive()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v integer;
BEGIN
  UPDATE pbx_presence p
     SET updated_at = now()
   WHERE p.call_state IN ('ringing', 'busy')
     AND p.updated_at < now() - interval '5 minutes'
     AND EXISTS (
       SELECT 1 FROM call_live l
        WHERE l.connection_id = p.connection_id
          -- A call whose hang-up was lost (a gateway or webhook outage)
          -- keeps its call_live row until pbx_purge; without this the
          -- person stayed red for up to a day. updated_at is the last
          -- 30011 frame, which this function never bumps.
          AND l.updated_at > now() - interval '4 hours'
          AND jsonb_path_exists(
                l.members,
                '$[*] ? (@.kind == "extension" && @.number == $ext && !(@.status like_regex "^bye$" flag "i"))',
                jsonb_build_object('ext', p.extension)));
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.pbx_presence_follow_mapping(), public.pbx_presence_keepalive()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pbx_presence_keepalive() TO service_role;
