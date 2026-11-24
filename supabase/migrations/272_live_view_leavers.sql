-- ============================================================
-- 272 — Live view: a leaver's waiting customers are counted
--
-- live_team_view() (238) lists live staff only and counts chats only for
-- them, while unassigned_waiting counted assigned_agent_id IS NULL. A
-- waiting customer whose assignee was deactivated or removed was in
-- neither figure, so /live said all clear. unassigned_waiting now counts
-- a waiting chat when no live, non-guest profile in the account holds it.
--
-- Restated from 238's body; nothing else changes (signature, grants,
-- search_path, JSON keys). Re-runnable. Re-applying 238 afterwards puts
-- its body back: apply in order, then 272 again.
-- Asserted by supabase/ci/verify-live-view-leavers.sql.
-- ============================================================

CREATE OR REPLACE FUNCTION public.live_team_view()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_acct   uuid := public.current_account_id();
  v_rank   integer := public.current_role_rank();
  v_tz     text;
  v_hours  jsonb;
  v_now    timestamptz := now();
  v_day    timestamptz;
  v_people jsonb;
  v_unassigned integer;
BEGIN
  IF v_uid IS NULL OR v_acct IS NULL OR v_rank < 3 THEN
    RAISE EXCEPTION 'Only team leaders, admins and owners can open the live view'
      USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;

  SELECT s.timezone, s.hours INTO v_tz, v_hours
    FROM public.response_settings s
   WHERE s.account_id = v_acct;
  v_tz := coalesce(nullif(v_tz, ''), 'Asia/Dubai');
  -- Local midnight today in the workspace's zone.
  v_day := date_trunc('day', v_now AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  WITH people AS (
    SELECT p.user_id, p.full_name, p.email, p.account_role::text AS role
      FROM public.profiles p
     WHERE p.account_id = v_acct
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
       AND (v_rank >= 4
            OR p.user_id = v_uid
            OR p.user_id IN (
              SELECT tm.user_id
                FROM public.teams t
                JOIN public.team_members tm ON tm.team_id = t.id
               WHERE t.account_id = v_acct
                 AND t.leader_user_id = v_uid))
  ), chats AS (
    SELECT c.assigned_agent_id AS uid,
           count(*)::integer AS open_n,
           count(public.conversation_waiting_since(c))::integer AS waiting_n,
           min(public.conversation_waiting_since(c)) AS oldest
      FROM public.conversations c
     WHERE c.account_id = v_acct
       AND c.assigned_agent_id IN (SELECT people.user_id FROM people)
       AND c.status <> 'closed'
       AND c.personal_owner_id IS NULL
     GROUP BY c.assigned_agent_id
  ), replies AS (
    SELECT m.sender_id AS uid, count(*)::integer AS n
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
     WHERE m.created_at >= v_day
       AND m.sender_type = 'agent'
       AND m.status <> 'failed'
       AND m.sender_id IN (SELECT people.user_id FROM people)
       AND c.account_id = v_acct
       AND c.personal_owner_id IS NULL
     GROUP BY m.sender_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'user_id', pe.user_id,
           'name', coalesce(nullif(btrim(pe.full_name), ''), pe.email),
           'email', pe.email,
           'role', pe.role,
           'presence', CASE
                         WHEN mp.last_seen_at IS NULL
                           OR mp.last_seen_at < v_now - interval '75 seconds'
                         THEN 'offline'
                         ELSE mp.status
                       END,
           'last_seen_at', mp.last_seen_at,
           'open_chats', coalesce(ch.open_n, 0),
           'waiting_chats', coalesce(ch.waiting_n, 0),
           'oldest_waiting_since', ch.oldest,
           'oldest_waiting_business_minutes',
             CASE WHEN ch.oldest IS NOT NULL
                  THEN public.response_business_minutes(v_hours, v_tz, ch.oldest, v_now)
             END,
           'replies_today', coalesce(r.n, 0)
         ) ORDER BY ch.oldest NULLS LAST, pe.full_name, pe.user_id), '[]'::jsonb)
    INTO v_people
    FROM people pe
    LEFT JOIN public.member_presence mp
      ON mp.user_id = pe.user_id AND mp.account_id = v_acct
    LEFT JOIN chats ch ON ch.uid = pe.user_id
    LEFT JOIN replies r ON r.uid = pe.user_id;

  IF v_rank >= 4 THEN
    SELECT count(*)::integer INTO v_unassigned
      FROM public.conversations c
     WHERE c.account_id = v_acct
       AND c.customer_waiting_since IS NOT NULL
       AND c.personal_owner_id IS NULL
       AND public.conversation_waiting_since(c) IS NOT NULL
       -- Nobody here holds it: no assignee, or one who was deactivated,
       -- removed or is not staff (263's escalation sweep asks the same).
       AND NOT EXISTS (
         SELECT 1
           FROM public.profiles p
          WHERE p.user_id = c.assigned_agent_id
            AND p.account_id = v_acct
            AND p.deactivated_at IS NULL
            AND p.account_role <> 'bank_guest');
  END IF;

  RETURN jsonb_build_object(
    'people', v_people,
    'unassigned_waiting', v_unassigned,
    'timezone', v_tz,
    'day_start', v_day,
    'generated_at', v_now,
    'scope', CASE WHEN v_rank >= 4 THEN 'all' ELSE 'team' END
  );
END $$;

REVOKE ALL ON FUNCTION public.live_team_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.live_team_view() TO authenticated;

COMMENT ON FUNCTION public.live_team_view() IS
  'The Live view (/live) as one jsonb: per live staff member the caller may watch (owner/admin everyone, a team leader their teams plus themselves) presence, open company chats, customers waiting and the oldest wait, replies today; unassigned_waiting (no live staff member holds the chat) for owners and admins. Refuses anyone below team leader (42501). Migrations 238, 272.';

NOTIFY pgrst, 'reload schema';
