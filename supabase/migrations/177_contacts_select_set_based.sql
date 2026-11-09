-- ============================================================
-- 177_contacts_select_set_based.sql — the contacts list stopped
-- timing out for agents and team leaders.
--
-- The problem. 059 left everyone below admin on a per-row call:
--
--   account_id = (SELECT current_account_id())
--   AND ((SELECT current_role_rank()) >= 4
--        OR can_view_contact(account_id, id, user_id))
--
-- can_view_contact is SECURITY DEFINER with SET search_path, so it is
-- never inlined; each call runs two membership lookups and a
-- conversations probe. Measured on production (2026-11-09, 3,852
-- contacts in one workspace): 0.65 ms a row, 2.5 s for an agent and
-- 3.8 s for a team leader per scan of the table. The Contacts screen's
-- one request scans it twice (the exact count and the page), and an
-- agent who sees 3 contacts still pays for all 3,852. Under load that
-- passed the 8 s statement_timeout and the screen said "Failed to load
-- contacts" (about 200 times from 4 to 9 November).
--
-- The fix, without changing who sees what. For a caller below admin,
-- can_view_contact inside their own active account is exactly:
--
--   the contact's owner (user_id) is the caller, or someone in a team
--   the caller leads (team leaders only: leads_teammate)
--   OR a conversation of the contact has as its user_id or assignee the
--   caller, or (team leaders only) someone in a team the caller leads
--
-- (its first two branches are settled by the leading account and rank
-- terms: current_account_id() is non-NULL only for an active, live,
-- non-guest row, which is_account_member(account) also requires). So
-- the policy now computes two sets once per statement, as hashed
-- subplans, instead of calling a function per row:
--
--   contact_visibility_people()  the caller, plus the members of the
--                                teams they lead when team_leader+
--   contact_visibility_chat_contact_ids()
--                                contacts with a conversation whose
--                                user_id or assignee is one of those
--
-- The owner test is on the row itself (user_id IN people), not through
-- a contact-id set, because an INSERT ... RETURNING checks the SELECT
-- policy against a row a STABLE function's snapshot cannot see yet: an
-- agent's own new contact must pass on its columns alone.
--
-- Checked against production before shipping: for every live agent and
-- team leader (31 people) the new rule returned exactly the contact ids
-- can_view_contact did, in at most 7 ms instead of 2.5 to 4 s.
--
-- can_view_contact itself is unchanged and still used by the other
-- policies (contacts_update, notes, deals, ...); the TS mirror in
-- lib/auth/conversation-visibility.ts is unaffected because the rule
-- did not change. If can_view_contact ever changes, change these two
-- helpers with it; verify-contacts-select-set-based.sql compares them.
--
-- Re-runnable: CREATE OR REPLACE / DROP POLICY IF EXISTS.
-- ============================================================

CREATE OR REPLACE FUNCTION public.contact_visibility_people()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
ROWS 10
SET search_path TO ''
AS $$
  WITH me AS (
    SELECT p.user_id, p.account_id, p.account_role
      FROM public.profiles p
     WHERE p.user_id = auth.uid()
       AND p.is_active
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
  )
  SELECT me.user_id FROM me
  UNION
  -- leads_teammate(account, x), for a caller who is team_leader or up
  -- (can_view_contact's is_account_member(account, 'team_leader')).
  SELECT tm.user_id
    FROM me
    JOIN public.teams t
      ON t.account_id = me.account_id
     AND t.leader_user_id = me.user_id
    JOIN public.team_members tm ON tm.team_id = t.id
   WHERE me.account_role IN ('owner', 'admin', 'team_leader');
$$;

COMMENT ON FUNCTION public.contact_visibility_people() IS
  'The people whose contacts and chats the caller sees below admin: themselves, plus the members of the teams they lead (team_leader and up). Set form of can_view_contact for the contacts_select policy; see migration 177.';

CREATE OR REPLACE FUNCTION public.contact_visibility_chat_contact_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
ROWS 100
SET search_path TO ''
AS $$
  -- Like can_view_contact's conversation probes, not scoped to an
  -- account: the policy's account term already confines the contact.
  SELECT v.contact_id
    FROM public.conversations v
   WHERE v.contact_id IS NOT NULL
     AND (
       v.user_id IN (SELECT public.contact_visibility_people())
       OR v.assigned_agent_id IN (SELECT public.contact_visibility_people())
     );
$$;

COMMENT ON FUNCTION public.contact_visibility_chat_contact_ids() IS
  'Contacts with a conversation owned by or assigned to one of contact_visibility_people(). Set form of can_view_contact for the contacts_select policy; see migration 177.';

REVOKE ALL ON FUNCTION public.contact_visibility_people() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.contact_visibility_chat_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contact_visibility_people() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.contact_visibility_chat_contact_ids() TO authenticated, service_role;

DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts
  FOR SELECT
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      (SELECT public.current_role_rank()) >= 4
      OR user_id IN (SELECT public.contact_visibility_people())
      OR id IN (SELECT public.contact_visibility_chat_contact_ids())
    )
  );
