-- ============================================================
-- 333_sg_admin_send.sql — an owner or admin of a submission group's
-- account may send to any ACTIVE group of it without being on its
-- access list.
--
--  * Why: sg_visible_ids() (173) already lets every owner/admin of the
--    active workspace read every ACTIVE group, but sg_can_send required
--    a list row, a led agent or a held bank, so the owner saw "You can
--    read this group but not send to it." The owner asked for send too.
--  * sg_can_send: 173's body plus sg_archive_role(g.account_id, p_user)
--    (115: a live, non-guest owner/admin profile in the group's account)
--    inside the parenthesised OR. Still ACTIVE only and live staff only;
--    an ENDED group stays unsendable for everyone. Everyone who could
--    send before still can. sg_send_begin / sg_send_begin_media reach it
--    through 210's sg_send_begin_row, so text and media follow the rule.
--  * The prefix label: sg_resolve_role (173) already answers 'owner' /
--    'admin' first for such a caller; the app's send path reads it when
--    there is no open access row (rules.ts canSend, store.ts sendLabel).
--  * Apply in order, once: re-running 173 reverts sg_can_send to its
--    body without the owner/admin branch; re-apply 333 after it.
--  * Like 115/173/210 it must be applied as a superuser or BYPASSRLS
--    role (the sg_* functions read RLS-forced tables).
--  * verify: supabase/ci/verify-sg-admin-send.sql.
-- ============================================================

SET lock_timeout = '10s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '333 must be applied by a superuser or BYPASSRLS role (the sg_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ACTIVE, live staff, and on the open list, leading the case's agent,
-- holding the case's bank, or an owner/admin of the group's account.
-- sg_send_begin calls this and reads no label.
CREATE OR REPLACE FUNCTION public.sg_can_send(p_group uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT g.status = 'ACTIVE'
       AND public.sg_is_staff(g.account_id, p_user)
       AND (EXISTS (SELECT 1 FROM public.submission_group_access a
                     WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL)
            OR public.sg_leads_group_agent(g.id, p_user)
            OR public.sg_holds_group_bank(g.id, p_user)
            OR public.sg_archive_role(g.account_id, p_user) IS NOT NULL)
      FROM public.submission_groups g WHERE g.id = p_group), false)
$$;

COMMENT ON FUNCTION public.sg_can_send(uuid, uuid) IS
  'May p_user send to group p_group? ACTIVE, live staff, and on the open access list, leading the case''s agent, holding its bank, or an owner/admin of the group''s account. Migration 333 (apply in order, once).';

RESET lock_timeout;
