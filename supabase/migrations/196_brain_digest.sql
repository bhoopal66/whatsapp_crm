-- ============================================================
-- Migration 196: SECOND BRAIN DIGEST, the read behind the daily digest's
-- promise detection.
-- ============================================================
--
-- Ported from the wacrm module package's migration 022d (digest), on
-- top of migration 194, with 194's mapping (workspace_id text ->
-- account_id uuid, actor text -> auth user id, case_actor_role ->
-- brain_actor_role, contact ids are uuids).
--
-- brain_digest_messages(p_account, p_actor, p_since): live
--   source_kind 'message' items written by staff (created_by NOT NULL;
--   system writers leave it NULL and set system_label) on a case,
--   created at or after p_since, in p_account, that the actor may see
--   (brain_item_visible; an actor with no brain role sees nothing) and
--   whose contact carries no opt-out / deletion mark
--   (brain_contact_marked). Ordered by created_at, item_id; at most
--   2000. The text is the already-redacted item text. Nothing is
--   stored. brain_items stays forced-RLS with no grants.
--
-- PRIVILEGES: SECURITY DEFINER, executable by service_role only.
--
-- Re-runnable: every statement is guarded.
-- ============================================================

CREATE OR REPLACE FUNCTION public.brain_digest_messages(p_account uuid, p_actor uuid, p_since timestamptz)
RETURNS TABLE (item_id uuid, case_id uuid, contact_id uuid, text text, created_by uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT i.item_id, i.case_id, i.contact_id, i.text, i.created_by, i.created_at
    FROM public.brain_items i
   WHERE public.brain_actor_role(p_account, p_actor) IS NOT NULL
     AND i.account_id = p_account
     AND i.deleted_at IS NULL
     AND i.source_kind = 'message'
     AND i.case_id IS NOT NULL
     AND i.created_by IS NOT NULL
     AND i.created_at >= p_since
     AND public.brain_item_visible(i.account_id, i.case_id, i.created_by, i.restricted_role, p_actor)
     AND NOT public.brain_contact_marked(i.account_id, i.contact_id)
   ORDER BY i.created_at, i.item_id
   LIMIT 2000
$$;

COMMENT ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz) IS
  'Staff messages on cases since p_since that the actor may see, contact unmarked; at most 2000, oldest first. Migration 196.';

REVOKE ALL ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz) TO service_role;
