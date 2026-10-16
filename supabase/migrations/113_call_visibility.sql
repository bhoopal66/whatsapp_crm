-- ============================================================
-- 113 — each person sees their own calls (module 015).
--
-- 089 let a team leader and above see every call of the workspace and
-- every screen pop. In a call centre that put the whole centre's call
-- log and recordings in front of every supervisor, and a leader is a
-- supervisor of a team, not of the centre. From here:
--
--   * owner / admin (rank >= 4): every call of the active workspace,
--     as before.
--   * team leader: the calls they are on (user_id / peer_user_id, or
--     their phone rang: calls.meta.rang_user_ids), the calls of the
--     people in the teams they lead (the same three columns — a ring
--     group's missed call has no user_id, only the people it rang),
--     and the calls of customers they can see (can_view_contact).
--   * agent / viewer: the calls they are on, rang included, and the
--     calls of customers they can see (unchanged, plus rang).
--   * bank guest: nothing (current_account_id() is NULL).
--
-- The customer rule is safe for an agent: can_view_contact (072) gives
-- an agent only the contacts they created or whose chat they own or are
-- assigned; there is no "shared contact" branch, so it does not open
-- the centre's call log. It is the customer-history rule: the customer
-- page shows that customer's calls to whoever works the customer.
--
-- call_live (the screen pop) follows: owners and admins every live
-- call, a leader the ones ringing or answered by them or by a person
-- of a team they lead, everyone else only theirs.
--
-- Everything that asked "rank >= 3 sees the call" goes through
-- pbx_can_view_call (call_recordings_select, pbx_set_disposition,
-- pbx_link_call_contact, chat_share_call, chat_shared_call_cards), so
-- it narrows with it. pbx_call_report (098) keeps its own scope: a
-- leader's report rows are their team plus themselves, and its
-- 'none' / 'total' rows are counts, not calls.
--
-- Re-runnable: CREATE OR REPLACE and DROP POLICY IF EXISTS. Needs 089.
-- ============================================================

CREATE OR REPLACE FUNCTION public.pbx_can_view_call(p_call public.calls)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_call.account_id IS NULL OR p_call.account_id IS DISTINCT FROM current_account_id() THEN false
    WHEN current_role_rank() >= 4 THEN true
    -- On the call, or it rang them.
    WHEN COALESCE(p_call.user_id = auth.uid(), false)
      OR COALESCE(p_call.peer_user_id = auth.uid(), false)
      OR (jsonb_typeof(p_call.meta -> 'rang_user_ids') = 'array'
          AND p_call.meta -> 'rang_user_ids' ? auth.uid()::text) THEN true
    -- A team leader: the same, for a person of a team they lead.
    WHEN current_role_rank() = 3 AND EXISTS (
      SELECT 1
        FROM teams t
        JOIN team_members tm ON tm.team_id = t.id
       WHERE t.account_id = p_call.account_id
         AND t.leader_user_id = auth.uid()
         AND (tm.user_id = p_call.user_id
              OR tm.user_id = p_call.peer_user_id
              OR (jsonb_typeof(p_call.meta -> 'rang_user_ids') = 'array'
                  AND p_call.meta -> 'rang_user_ids' ? tm.user_id::text))) THEN true
    WHEN p_call.contact_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = p_call.contact_id
         AND can_view_contact(c.account_id, c.id, c.user_id))
    ELSE false
  END
$$;
COMMENT ON FUNCTION public.pbx_can_view_call(public.calls) IS
  'calls SELECT: the caller''s active account, and owner/admin, a party to the call or rung by it (meta.rang_user_ids), a team leader for the same of a person in a team they lead, or able to see its contact (can_view_contact). Guests: nothing. Migrations 089, 113.';

DROP POLICY IF EXISTS call_live_select ON public.call_live;
CREATE POLICY call_live_select ON public.call_live
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND ((SELECT auth.uid()) = ANY (ringing_user_ids)
         OR answered_by = (SELECT auth.uid())
         OR (SELECT public.current_role_rank()) >= 4
         OR ((SELECT public.current_role_rank()) = 3
             AND EXISTS (
               SELECT 1
                 FROM public.teams t
                 JOIN public.team_members tm ON tm.team_id = t.id
                WHERE t.account_id = call_live.account_id
                  AND t.leader_user_id = (SELECT auth.uid())
                  AND (tm.user_id = ANY (call_live.ringing_user_ids)
                       OR tm.user_id = call_live.answered_by))))
  );
