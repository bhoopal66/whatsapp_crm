-- ============================================================
-- Migration 199: deactivating a member takes them off their team and
-- unlinks their Yeastar extension
-- ============================================================
--
-- Until now deactivation (069, set_member_active) only stopped the
-- person signing in. They stayed on their team (as a member or as its
-- leader) and kept their PBX extension, so Settings showed them on a
-- team they no longer work in, and the extension's calls, presence and
-- missed-call tasks kept going to someone who cannot act on them.
--
-- 1. A trigger on profiles: when deactivated_at goes from NULL to a
--    time, in that profile's workspace only,
--      - their team_members row is deleted,
--      - any team they lead is left without a leader (044's rule: a
--        leaderless team is a visible, fixable state),
--      - every pbx_extensions row mapped to them is unmapped
--        (user_id NULL, softphone off). 101's trigger then moves the
--        extension's presence off them. Their past calls keep their
--        name; the extension's next calls have no person until an
--        admin maps it to someone else.
--    Then the number allocation is re-derived (071's sync), so a
--    number their team holds stops listing them.
--    Their DIRECT number allocations are left alone: deleting the last
--    one would turn a restricted number into a shared one.
--    Reactivating restores nothing: an admin puts them back on a team
--    and maps an extension again.
--    Other workspaces the person belongs to are untouched; deactivation
--    is per workspace (083).
-- 2. The same cleanup, once, for everyone deactivated before this
--    migration.
--
-- Lock order is 071's profiles_leave_account_teams: the profile row
-- (held by the UPDATE), then the account's channel-access lock, then
-- team and extension rows.
--
-- Re-runnable: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, and the
-- backfill finds nothing left to do on a second run.
-- supabase/ci/verify-member-deactivation.sql asserts it.
-- ============================================================

CREATE OR REPLACE FUNCTION public.deactivated_member_cleanup(
  p_user_id    uuid,
  p_account_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_account_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(p_account_id));
  DELETE FROM team_members
   WHERE user_id = p_user_id AND account_id = p_account_id;
  UPDATE teams SET leader_user_id = NULL, updated_at = now()
   WHERE leader_user_id = p_user_id AND account_id = p_account_id;
  UPDATE pbx_extensions SET user_id = NULL, softphone_enabled = false
   WHERE user_id = p_user_id AND account_id = p_account_id;
  PERFORM sync_channel_team_members(p_account_id);
END;
$$;

REVOKE ALL ON FUNCTION public.deactivated_member_cleanup(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.deactivated_member_cleanup(uuid, uuid) IS
  'Takes a deactivated person off their team (member or leader) and unmaps their PBX extensions, in one workspace. Called by the profiles_deactivated_cleanup trigger only. See migration 199.';

CREATE OR REPLACE FUNCTION public.profiles_deactivated_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM deactivated_member_cleanup(NEW.user_id, NEW.account_id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_deactivated_cleanup()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS profiles_deactivated_cleanup ON public.profiles;
CREATE TRIGGER profiles_deactivated_cleanup
  AFTER UPDATE OF deactivated_at ON public.profiles
  FOR EACH ROW
  WHEN (OLD.deactivated_at IS NULL AND NEW.deactivated_at IS NOT NULL)
  EXECUTE FUNCTION public.profiles_deactivated_cleanup();

-- ---------- 2. People deactivated before 199 ----------
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT p.user_id, p.account_id
      FROM profiles p
     WHERE p.deactivated_at IS NOT NULL
       AND p.account_id IS NOT NULL
       AND (EXISTS (SELECT 1 FROM team_members tm
                     WHERE tm.user_id = p.user_id AND tm.account_id = p.account_id)
            OR EXISTS (SELECT 1 FROM teams t
                        WHERE t.leader_user_id = p.user_id AND t.account_id = p.account_id)
            OR EXISTS (SELECT 1 FROM pbx_extensions e
                        WHERE e.user_id = p.user_id AND e.account_id = p.account_id))
     ORDER BY p.account_id, p.user_id
  LOOP
    PERFORM deactivated_member_cleanup(r.user_id, r.account_id);
    RAISE NOTICE '199: cleaned up deactivated member % in workspace %', r.user_id, r.account_id;
  END LOOP;
END
$backfill$;
