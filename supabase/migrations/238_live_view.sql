-- ============================================================
-- 238 — Live view and the worklist's waiting customers (Track B,
-- items 8 and 9). Read-only: no table, no trigger, no setting.
--
--   1. worklist_waiting_chats(p_limit): the company chats whose
--      customer is waiting for a reply (237's
--      conversation_waiting_since), oldest first, for "My worklist".
--      SECURITY INVOKER: the conversations policies (set-based since
--      217) decide which chats a caller sees, so an agent never learns
--      of another agent's waiting customer. Scans 237's partial index
--      conversations_customer_waiting_idx in wait order.
--   2. live_team_view(): one jsonb for the Live view (/live), team
--      leader and up in the caller's ACTIVE workspace. Owners and
--      admins see every live staff member, a team leader the members
--      of the teams they lead plus themselves; anyone else is refused
--      (42501, HINT not_allowed). Per person: presence (offline
--      derived after 75 s, OFFLINE_AFTER_MS in src/lib/presence.ts),
--      open assigned company chats, customers waiting on them and the
--      oldest wait (wall time and business minutes), and replies today
--      (agent messages they sent, not failed, in company chats, since
--      local midnight in response_settings' time zone, default
--      Asia/Dubai). Owners and admins also get the unassigned waiting
--      count. Set-based: one pass per figure, no per-person loop.
--
-- Needs 237 (customer_waiting_since, conversation_waiting_since,
-- response_settings, response_business_minutes). Re-runnable: only
-- CREATE OR REPLACE of the two functions this file owns.
-- Asserted by supabase/ci/verify-live-view.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The worklist's waiting customers
-- ------------------------------------------------------------

-- At most 200 rows (NULL or < 1 = 50). business_minutes uses the
-- workspace's saved hours (the defaults without a row), read once.
-- The two index predicates are spelled out next to the definition so
-- the planner uses conversations_customer_waiting_idx.
CREATE OR REPLACE FUNCTION public.worklist_waiting_chats(p_limit integer DEFAULT 50)
RETURNS TABLE (
  conversation_id   uuid,
  contact_id        uuid,
  contact_name      text,
  contact_phone     text,
  assigned_agent_id uuid,
  waiting_since     timestamptz,
  business_minutes  integer,
  unassigned        boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH acct AS (
    SELECT public.current_account_id() AS id
  ), cfg AS (
    SELECT s.hours, s.timezone
      FROM acct
      LEFT JOIN public.response_settings s ON s.account_id = acct.id
  ), waiting AS (
    SELECT c.id, c.contact_id, c.assigned_agent_id,
           public.conversation_waiting_since(c) AS since
      FROM public.conversations c, acct
     WHERE c.account_id = acct.id
       AND c.customer_waiting_since IS NOT NULL
       AND c.personal_owner_id IS NULL
       AND public.conversation_waiting_since(c) IS NOT NULL
     ORDER BY c.customer_waiting_since, c.id
     LIMIT CASE WHEN coalesce(p_limit, 0) < 1 THEN 50 ELSE least(p_limit, 200) END
  )
  SELECT w.id,
         w.contact_id,
         ct.name,
         ct.phone,
         w.assigned_agent_id,
         w.since,
         public.response_business_minutes(cfg.hours, cfg.timezone, w.since, now()),
         w.assigned_agent_id IS NULL
    FROM waiting w
    CROSS JOIN cfg
    LEFT JOIN public.contacts ct ON ct.id = w.contact_id
   ORDER BY w.since, w.id
$$;

REVOKE ALL ON FUNCTION public.worklist_waiting_chats(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worklist_waiting_chats(integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.worklist_waiting_chats(integer) IS
  'Company chats whose customer is waiting for a reply (237''s conversation_waiting_since), oldest first, as the caller''s RLS shows them: contact, assignee, since when, business minutes, unassigned. Migration 238.';

-- ------------------------------------------------------------
-- 2. The Live view
-- ------------------------------------------------------------

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
       AND c.assigned_agent_id IS NULL;
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
  'The Live view (/live) as one jsonb: per live staff member the caller may watch (owner/admin everyone, a team leader their teams plus themselves) presence, open company chats, customers waiting and the oldest wait, replies today; unassigned_waiting for owners and admins. Refuses anyone below team leader (42501). Migration 238.';
