-- ============================================================
-- 098 — the supervisor call report (module 015, stage 015d).
--
-- pbx_call_report(p_from, p_to) returns the Calls screen's "By person"
-- tab for [p_from, p_to): one row per person, a row for the calls no
-- person is on, and the workspace total. Needs only 089.
--
-- Rows (row_kind):
--   * 'person' — everyone mapped to an extension in the caller's
--     workspace, plus everyone a call in the period is attributed to
--     (a former member keeps their row, without a name).
--   * 'none'   — calls with no person (calls.user_id NULL).
--   * 'total'  — every call in the workspace in the period. Always
--     the whole workspace, a team leader's report included: a leader
--     sees every call of the workspace anyway (pbx_can_view_call).
--
-- Attribution. A call counts for calls.user_id, the person on the
-- extension the PBX reports it to (who answered, or who dialled out).
-- A missed incoming call (no answer, busy, abandoned, voicemail — the
-- processor's missed-call rule) counts for the person whose extension
-- it rang directly. One that rang a ring group or a queue, so several
-- people at once, has no person on it: the PBX names the group, and
-- who it rang is kept only on the screen pop, which is deleted when the
-- call ends. Such a call, like one to an extension with no CRM login,
-- is counted once, in 'none' and the total, never once per person it
-- rang. Internal calls (between colleagues) are left out.
--
-- Figures per row:
--   inbound_answered  incoming calls answered (status answered, or an
--                     answered_at: a call still in progress)
--   outbound          outgoing calls, answered or not
--   missed            missed incoming calls, as above
--   talk_seconds / talk_calls
--                     talk time of the answered calls, in and out, and
--                     how many of them carry a talk time (a call still in
--                     progress has none yet): the average's divisor
--   ring_seconds / ring_calls
--                     ring time of the answered incoming calls: how long
--                     they rang before someone picked up
--   outcomes          calls per disposition, set on any call, plus
--                     'none': answered calls with no outcome
--
-- Who may run it. A team leader and above in their ACTIVE workspace
-- (current_account_id(), so a bank guest never); an owner or admin
-- gets everyone, a team leader (rank 3) the people of the teams they
-- lead plus themselves, as team_activity_report scopes leaders (074).
-- SECURITY DEFINER, as team_activity_report: every read below is
-- filtered by current_account_id() and the leader's scope by hand.
-- The period is at most 100 days.
--
-- Re-runnable: CREATE OR REPLACE, then the grants.
-- ============================================================

CREATE OR REPLACE FUNCTION public.pbx_call_report(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  row_kind          text,
  user_id           uuid,
  full_name         text,
  extension         text,
  inbound_answered  integer,
  outbound          integer,
  missed            integer,
  talk_seconds      bigint,
  talk_calls        integer,
  ring_seconds      bigint,
  ring_calls        integer,
  outcomes          jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := current_account_id();
  v_rank    integer := coalesce(current_role_rank(), 0);
  -- A team leader's people; NULL for an owner or admin (everyone).
  v_team    uuid[];
BEGIN
  IF v_uid IS NULL OR v_account IS NULL OR v_rank < 3 THEN
    RAISE EXCEPTION 'Only team leaders, admins and owners can view the call report'
      USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The period must end after it starts and span at most 100 days'
      USING ERRCODE = '22023';
  END IF;

  IF v_rank = 3 THEN
    SELECT array_agg(DISTINCT x.u) INTO v_team
      FROM (SELECT tm.user_id AS u
              FROM teams t
              JOIN team_members tm ON tm.team_id = t.id
             WHERE t.account_id = v_account
               AND t.leader_user_id = v_uid
            UNION
            SELECT v_uid) x
     WHERE x.u IS NOT NULL;
  END IF;

  RETURN QUERY
  WITH c AS (
    SELECT k.user_id AS who,
           k.direction AS dir,
           k.disposition AS disp,
           -- answered_at is kept from the live frames even when the final
           -- status is no_answer / voicemail / busy (answered, then
           -- transferred to a leg nobody took), so it only counts for a
           -- call still in progress; else that call was answered AND missed.
           (k.status = 'answered'
            OR (k.status = 'in_progress' AND k.answered_at IS NOT NULL)) AS ans,
           (k.direction = 'inbound'
            AND k.status IN ('no_answer', 'busy', 'abandoned', 'voicemail')) AS miss,
           k.talk_seconds AS talk,
           k.ring_seconds AS ring
      FROM calls k
     WHERE k.account_id = v_account
       AND k.started_at >= p_from
       AND k.started_at < p_to
       AND k.direction IN ('inbound', 'outbound')
  ),
  people AS (
    SELECT DISTINCT x.u
      FROM (SELECT c.who AS u FROM c WHERE c.who IS NOT NULL
            UNION
            SELECT e.user_id FROM pbx_extensions e
             WHERE e.account_id = v_account AND e.user_id IS NOT NULL) x
     WHERE v_team IS NULL OR x.u = ANY (v_team)
  ),
  -- Each call once in every row it counts in. The 'none' and 'total'
  -- rows exist with no calls too (one all-NULL row, counted as zero).
  keyed AS (
    SELECT 'person'::text AS kind, p.u, c.dir, c.disp, c.ans, c.miss, c.talk, c.ring
      FROM people p LEFT JOIN c ON c.who = p.u
    UNION ALL
    SELECT 'none'::text, NULL::uuid, c.dir, c.disp, c.ans, c.miss, c.talk, c.ring
      FROM (SELECT 1) one LEFT JOIN c ON c.who IS NULL
    UNION ALL
    SELECT 'total'::text, NULL::uuid, c.dir, c.disp, c.ans, c.miss, c.talk, c.ring
      FROM (SELECT 1) one LEFT JOIN c ON true
  )
  SELECT k.kind,
         k.u,
         pr.full_name,
         ex.extension,
         (count(*) FILTER (WHERE k.dir = 'inbound' AND k.ans))::integer,
         (count(*) FILTER (WHERE k.dir = 'outbound'))::integer,
         (count(*) FILTER (WHERE k.miss))::integer,
         (coalesce(sum(k.talk) FILTER (WHERE k.ans), 0))::bigint,
         (count(k.talk) FILTER (WHERE k.ans))::integer,
         (coalesce(sum(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans), 0))::bigint,
         (count(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans))::integer,
         jsonb_build_object(
           'interested',     count(*) FILTER (WHERE k.disp = 'interested'),
           'docs_requested', count(*) FILTER (WHERE k.disp = 'docs_requested'),
           'call_back',      count(*) FILTER (WHERE k.disp = 'call_back'),
           'not_eligible',   count(*) FILTER (WHERE k.disp = 'not_eligible'),
           'wrong_number',   count(*) FILTER (WHERE k.disp = 'wrong_number'),
           'none',           count(*) FILTER (WHERE k.ans AND k.disp IS NULL))
    FROM keyed k
    LEFT JOIN profiles pr ON pr.user_id = k.u AND pr.account_id = v_account
    LEFT JOIN pbx_extensions ex ON ex.user_id = k.u AND ex.account_id = v_account
   GROUP BY k.kind, k.u, pr.full_name, ex.extension
   ORDER BY (k.kind = 'total'), (k.kind = 'none'), lower(pr.full_name) NULLS LAST, k.u;
END;
$$;

COMMENT ON FUNCTION public.pbx_call_report(timestamptz, timestamptz) IS
  'The Calls screen''s By person report for [p_from, p_to), at most 100 days: a row per person (owners/admins everyone, a team leader their teams plus themselves), one for calls with no person, and the workspace total. A missed ring-group call has no person and is counted once. Internal calls are left out. Migration 098.';

REVOKE ALL ON FUNCTION public.pbx_call_report(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pbx_call_report(timestamptz, timestamptz)
  TO authenticated;
