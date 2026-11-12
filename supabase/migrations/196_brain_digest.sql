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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  -- Set-based on purpose (as 194's brain_search_candidates): the actor's
  -- role once, one case_role per distinct case (owner / admin need none:
  -- case_role gives them admin / super_admin on every case of the
  -- account, 161, and the composite FK keeps an item's case in its
  -- account), and the account's marked contacts as one set, instead of
  -- brain_item_visible + brain_contact_marked per item.
  v_role text := public.brain_actor_role(p_account, p_actor);
  v_all boolean := v_role IN ('admin', 'super_admin');
BEGIN
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH cand AS MATERIALIZED (
    SELECT i.item_id, i.case_id, i.contact_id, i.text, i.created_by, i.created_at, i.restricted_role
      FROM public.brain_items i
     WHERE i.account_id = p_account
       AND i.deleted_at IS NULL
       AND i.source_kind = 'message'
       AND i.case_id IS NOT NULL
       AND i.created_by IS NOT NULL
       AND i.created_at >= p_since
  ),
  -- case_can_read is case_rule_can_read(case_role(...)) (122).
  case_access AS MATERIALIZED (
    SELECT r.case_id, coalesce(public.case_rule_can_read(r.case_role), false) AS can_read, r.case_role
      FROM (SELECT d.case_id, public.case_role(d.case_id, p_actor) AS case_role
              FROM (SELECT DISTINCT c.case_id FROM cand c) d
             WHERE NOT v_all
            OFFSET 0) r
  ),
  marked AS MATERIALIZED (
    SELECT m.contact_id FROM public.brain_contact_marks m WHERE m.account_id = p_account
    UNION
    SELECT ct.id FROM public.contacts ct
     WHERE ct.account_id = p_account AND (ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL)
  )
  SELECT c.item_id, c.case_id, c.contact_id, c.text, c.created_by, c.created_at
    FROM cand c
    LEFT JOIN case_access ca ON ca.case_id = c.case_id
   WHERE (v_all
          OR coalesce(ca.can_read
                      AND (c.restricted_role IS NULL OR ca.case_role = c.restricted_role
                           OR ca.case_role IN ('admin', 'super_admin')), false))
     AND NOT EXISTS (SELECT 1 FROM marked mk WHERE mk.contact_id = c.contact_id)
   ORDER BY c.created_at, c.item_id
   LIMIT 2000;
END;
$$;

COMMENT ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz) IS
  'Staff messages on cases since p_since that the actor may see, contact unmarked; at most 2000, oldest first. Migration 196.';

REVOKE ALL ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.brain_digest_messages(uuid, uuid, timestamptz) TO service_role;
