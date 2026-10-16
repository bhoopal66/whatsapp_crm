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

-- The policies are set-based. 113 first wrote calls_select as a call
-- of pbx_can_view_call(calls) on every row: a SECURITY DEFINER function
-- cannot be inlined, and RLS runs before a PostgREST filter (not
-- leakproof), so every row of the workspace paid for the team EXISTS and
-- can_view_contact — 20k calls took 22–27 s for a leader or an agent, the
-- "My calls" list included. Now the two sets a call is judged against
-- are computed once per query (initplans) and each row costs array and
-- hash lookups:
--
--   * pbx_visible_user_ids(): the caller, plus (team leader) every
--     person in a team they lead in the active workspace.
--   * pbx_visible_contact_ids(): the contacts can_view_contact (072)
--     lets the caller see, as a set — created by, or with a chat owned
--     by or assigned to, one of those people. verify-pbx.sql checks it
--     against can_view_contact row by row.
--
-- pbx_can_view_call keeps its meaning for its one-call callers
-- (pbx_set_disposition, pbx_link_call_contact, chat_share_call,
-- chat_shared_call_cards) and reads the same people set; its customer
-- branch stays a single can_view_contact, cheaper for one call than the
-- whole set. The policy and the function change together.

CREATE OR REPLACE FUNCTION public.pbx_visible_user_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR current_account_id() IS NULL THEN '{}'::uuid[]
    ELSE ARRAY(
      SELECT auth.uid()
      UNION
      SELECT tm.user_id
        FROM teams t
        JOIN team_members tm ON tm.team_id = t.id
       WHERE current_role_rank() = 3
         AND t.account_id = current_account_id()
         AND t.leader_user_id = auth.uid())
  END
$$;
COMMENT ON FUNCTION public.pbx_visible_user_ids() IS
  'The people whose calls the caller sees below admin: themselves, and for a team leader every person in a team they lead in the active workspace. Empty for a guest. Migration 113.';

CREATE OR REPLACE FUNCTION public.pbx_visible_contact_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- can_view_contact as a set, for the caller's active workspace. Owner
  -- and admin: every contact. Below: created by one of the people, or
  -- with a chat owned by or assigned to one of them.
  WITH ctx AS (
    SELECT current_account_id() AS acct, current_role_rank() AS rnk, pbx_visible_user_ids() AS ppl
  )
  SELECT c.id FROM contacts c, ctx
   WHERE c.account_id = ctx.acct AND ctx.rnk >= 4
  UNION
  SELECT c.id FROM contacts c, ctx
   WHERE c.account_id = ctx.acct AND ctx.rnk < 4 AND c.user_id = ANY (ctx.ppl)
  UNION
  SELECT c.id
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id, ctx
   WHERE c.account_id = ctx.acct AND ctx.rnk < 4
     AND (cv.user_id = ANY (ctx.ppl) OR cv.assigned_agent_id = ANY (ctx.ppl))
$$;
COMMENT ON FUNCTION public.pbx_visible_contact_ids() IS
  'can_view_contact (072) as a set: the contacts of the active workspace the caller may see. The calls policy reads it once per query. Migration 113.';

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
    -- On the call, or it rang them; for a team leader, the same for a
    -- person of a team they lead.
    WHEN COALESCE(p_call.user_id = ANY (s.ppl), false)
      OR COALESCE(p_call.peer_user_id = ANY (s.ppl), false)
      OR (jsonb_typeof(p_call.meta -> 'rang_user_ids') = 'array'
          AND p_call.meta -> 'rang_user_ids' ?| s.ppl::text[]) THEN true
    WHEN p_call.contact_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = p_call.contact_id
         AND can_view_contact(c.account_id, c.id, c.user_id))
    ELSE false
  END
  FROM (SELECT pbx_visible_user_ids() AS ppl) s
$$;
COMMENT ON FUNCTION public.pbx_can_view_call(public.calls) IS
  'One call: the caller''s active account, and owner/admin, a party to the call or rung by it (meta.rang_user_ids), a team leader for the same of a person in a team they lead, or able to see its contact (can_view_contact). Guests: nothing. The calls_select policy is the same rule over sets. Migrations 089, 113.';

REVOKE ALL ON FUNCTION public.pbx_visible_user_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pbx_visible_contact_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pbx_visible_user_ids(), public.pbx_visible_contact_ids()
  TO authenticated, service_role;

-- The rang list is matched only when it is an array: on a JSON string
-- or object `?|` would match the string or a key.
DROP POLICY IF EXISTS calls_select ON public.calls;
CREATE POLICY calls_select ON public.calls
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND ((SELECT public.current_role_rank()) >= 4
         OR user_id = ANY ((SELECT public.pbx_visible_user_ids())::uuid[])
         OR peer_user_id = ANY ((SELECT public.pbx_visible_user_ids())::uuid[])
         OR (jsonb_typeof(meta -> 'rang_user_ids') = 'array'
             AND (meta -> 'rang_user_ids') ?| (SELECT public.pbx_visible_user_ids()::text[]))
         OR contact_id IN (SELECT public.pbx_visible_contact_ids()))
  );

DROP POLICY IF EXISTS call_live_select ON public.call_live;
CREATE POLICY call_live_select ON public.call_live
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND ((SELECT public.current_role_rank()) >= 4
         OR answered_by = ANY ((SELECT public.pbx_visible_user_ids())::uuid[])
         OR ringing_user_ids && (SELECT public.pbx_visible_user_ids()))
  );
