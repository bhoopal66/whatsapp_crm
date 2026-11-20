-- ============================================================
-- 218_group_managers_number_access.sql — a group's managers can work
-- it whatever the number's allocation.
--
-- The problem. 114's whatsapp_group_manageable_ids() let an agent or
-- team leader manage a group they created or manage only
--
--   AND can_use_channel(g.account_id, g.channel_id)
--
-- so once the group's WhatsApp number was allocated to specific people
-- (060/071) a manager who was not on that list could open the group
-- and do nothing in it. Production, 2026-11-20: an admin made an agent
-- the manager of a group on a number allocated to other people (three
-- of the workspace's four company numbers are allocated; she is on
-- none). The group page showed every action blocked ("You don't have
-- permission to do that.") and sending answered 403 not_allowed "You
-- can't manage this group", although the Managers tab promises that
-- managers can see and work the group. Reproduced on a real Supabase
-- stack; the same function without that one line answered canManage
-- true, no blocks, and the send 200.
--
-- The rule now. Appointing someone manager of a group is the grant for
-- that group: only owners/admins and the group's creator appoint
-- (PUT /api/whatsapp/groups/[id]/managers). An agent or team leader
-- manages a group they created or manage while it still has a number,
-- whoever that number is allocated to. Number allocation keeps
-- deciding who chats one-to-one from the number and who creates a
-- group on it (whatsapp_group_can_create, 114/208, unchanged). Groups
-- are never on a personal number (whatsapp_groups_guard), so nothing
-- personal changes. Viewers, bank guests and other workspaces still
-- manage nothing. TS mirror: canManageGroup in src/lib/groups/access.ts.
--
-- Apply in order, once: re-running 114 after 218 restores the old
-- rule. As 114, apply as a superuser or BYPASSRLS role (the function
-- reads RLS-forced tables). Grants are 114's and survive CREATE OR
-- REPLACE; they are restated so this file stands alone.
-- ============================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.whatsapp_group_manageable_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ctx AS (
    SELECT current_account_id() AS acct, current_role_rank() AS rnk
  )
  SELECT g.id FROM whatsapp_groups g, ctx
   WHERE g.account_id = ctx.acct AND ctx.rnk >= 4
  UNION
  SELECT g.id FROM whatsapp_groups g, ctx
   WHERE g.account_id = ctx.acct AND ctx.rnk IN (2, 3)
     AND g.channel_id IS NOT NULL
     AND (g.created_by = auth.uid()
          OR EXISTS (SELECT 1 FROM whatsapp_group_managers m
                      WHERE m.group_id = g.id AND m.user_id = auth.uid()))
$$;
COMMENT ON FUNCTION public.whatsapp_group_manageable_ids() IS
  'The groups of the active workspace the caller manages (edit, members, invite link, send): owner/admin all; an agent or team leader the ones they created or manage, while the group has a number, whoever the number is allocated to. Migrations 114, 218.';

REVOKE ALL ON FUNCTION public.whatsapp_group_manageable_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_group_manageable_ids()
  TO authenticated, service_role;

RESET lock_timeout;
