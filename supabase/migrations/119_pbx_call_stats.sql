-- ============================================================
-- 119 — the call report page's figures (module 015).
--
-- pbx_call_stats(p_from, p_to, p_tz, p_user, p_prev_from, p_prev_to)
-- returns, as one JSON object, everything the Call report page draws
-- for [p_from, p_to): the headline figures and the same for the
-- previous period (for deltas), a zero-filled day series and a weekday x hour
-- grid in p_tz, talk-length buckets, outcomes, a row per person, the
-- most called numbers and the longest calls. Needs 089 and 113.
--
-- Whose calls. Everyone with phone access (viewer and up) in their
-- ACTIVE workspace (current_account_id(), so a bank guest never):
--   * owner / admin (rank >= 4): every call of the workspace, the
--     calls with no person (a ring group nobody answered, an extension
--     with no CRM login) included.
--   * team leader: pbx_visible_user_ids() (113) — themselves and the
--     people of the teams they lead.
--   * agent / viewer: their own calls (pbx_visible_user_ids() is just
--     them).
-- p_user narrows to one person, who must be in that scope; anyone else
-- raises 42501 (an admin may name anyone: the calls are filtered by the
-- workspace). With p_user the calls with no person are left out.
--
-- Attribution and the figures are 098's (pbx_call_report), so the two
-- reports agree. A call counts for calls.user_id. Answered: status
-- answered, or an answered_at on a call still in progress (answered_at
-- survives on a call that ended no_answer after a transfer). Missed:
-- an incoming call ending no_answer, busy, abandoned or voicemail. A
-- missed ring-group call has no person and is counted once. Internal
-- calls (between colleagues) are left out. Talk time is the answered
-- calls' talk_seconds; ring time the answered incoming calls'.
-- outbound_answered also counts an outgoing call that carries talk time
-- whatever its final status (the PBX's talk figure says it connected).
--
-- The JSON (keys in snake_case):
--   summary, previous  calls, inbound_total, inbound_answered,
--                      outbound_total, outbound_answered, missed,
--                      answer_rate (inbound_answered / inbound_total,
--                      0..1, null with no incoming call),
--                      talk_seconds_total, talk_calls, avg_talk_seconds,
--                      longest_talk_seconds, ring_seconds_total,
--                      ring_calls, avg_ring_seconds, max_ring_seconds,
--                      unique_numbers (distinct remote_number),
--                      with_outcome (calls with a disposition).
--                      Averages and maxima are null with nothing to
--                      measure. previous: [p_prev_from, p_prev_to),
--                      the window the caller compares with (the app
--                      passes like with like: today so far against
--                      yesterday up to the same hour); with neither
--                      given, the equally long period just before,
--                      [p_from - (p_to - p_from), p_from). Both or
--                      neither, ending by p_from, at most 100 days.
--   by_day      every local day of the period, oldest first: day
--               (YYYY-MM-DD), calls, inbound_answered, outbound,
--               outbound_answered, missed, talk_seconds.
--   by_hour     non-zero cells only: dow (ISO, 1 = Monday), hour (0-23),
--               calls, answered (in answered + out answered), missed,
--               talk_seconds.
--   talk_buckets  answered calls carrying a talk time, by length:
--               key, min_seconds (inclusive), max_seconds (exclusive,
--               null for the last), calls.
--   outcomes    calls per disposition, plus none: answered calls with
--               no outcome (098's object).
--   people      leader and up with no p_user, else null: a row per
--               person in scope — everyone mapped to an extension plus
--               everyone a call of the period counts for, as 098 — and,
--               for an owner or admin, a 'none' row (user_id null) for
--               the calls with no person. kind, user_id, full_name,
--               extension, then the summary's figures.
--   top_numbers the ten customers called most (grouped by contact, else
--               by number): contact_id, contact_name, remote_number (the
--               latest), calls, talk_seconds, last_call_at.
--   longest     the ten longest answered calls: id, started_at,
--               direction, remote_number, contact_id, contact_name,
--               talk_seconds, user_id, user_name.
--   range       from, to, tz, previous_from, previous_to.
--   scope       'workspace', 'team', 'self' or 'person' (p_user given);
--   user_id     p_user.
-- A contact's name only when the caller can see the contact
-- (can_view_contact, 072), as the calls list (GET /api/pbx/calls);
-- numbers are never masked there either.
--
-- SECURITY DEFINER, as 098: every read is filtered by
-- current_account_id() and the scope by hand. The scope is an array
-- computed once, so each call costs an array lookup (113's lesson).
-- The period is at most 100 days; p_tz is any time zone Postgres
-- converts to (a zone name, an abbreviation or a POSIX offset).
--
-- Re-runnable: CREATE OR REPLACE, then the grants.
-- ============================================================

-- A database that ran an earlier draft has the 4-argument form, which
-- would make a 4-argument call ambiguous.
DROP FUNCTION IF EXISTS public.pbx_call_stats(timestamptz, timestamptz, text, uuid);

CREATE OR REPLACE FUNCTION public.pbx_call_stats(
  p_from timestamptz,
  p_to   timestamptz,
  p_tz   text,
  p_user uuid DEFAULT NULL,
  p_prev_from timestamptz DEFAULT NULL,
  p_prev_to   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := current_account_id();
  v_rank    integer := coalesce(current_role_rank(), 0);
  -- The people whose calls count; NULL for the whole workspace.
  v_scope   uuid[];
  v_people  boolean;
  v_prev    timestamptz := coalesce(p_prev_from, p_from - (p_to - p_from));
  v_prev_to timestamptz := coalesce(p_prev_to, p_from);
  v_result  jsonb;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL OR v_rank < 1 THEN
    RAISE EXCEPTION 'Only members of a workspace can view call statistics'
      USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The period must end after it starts and span at most 100 days'
      USING ERRCODE = '22023';
  END IF;
  IF (p_prev_from IS NULL) <> (p_prev_to IS NULL) OR v_prev_to <= v_prev
     OR v_prev_to > p_from OR v_prev_to - v_prev > interval '100 days' THEN
    RAISE EXCEPTION 'The previous period must end by the start of this one, after it starts, and span at most 100 days'
      USING ERRCODE = '22023';
  END IF;
  -- Asking Postgres to convert is the check: a pg_timezone_names lookup
  -- reads every zone file and cost ~55 ms of a ~250 ms call.
  IF p_tz IS NULL THEN
    RAISE EXCEPTION 'Unknown time zone: NULL' USING ERRCODE = '22023';
  END IF;
  BEGIN
    PERFORM now() AT TIME ZONE p_tz;
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE EXCEPTION 'Unknown time zone: %', p_tz USING ERRCODE = '22023';
  END;

  IF v_rank < 4 THEN
    v_scope := pbx_visible_user_ids();
  END IF;
  IF p_user IS NOT NULL THEN
    IF v_scope IS NOT NULL AND NOT (p_user = ANY (v_scope)) THEN
      RAISE EXCEPTION 'You can view only your own calls and those of the teams you lead'
        USING ERRCODE = '42501';
    END IF;
    v_scope := ARRAY[p_user];
  END IF;
  v_people := v_rank >= 3 AND p_user IS NULL;

  WITH base AS MATERIALIZED (
    SELECT k.id,
           k.user_id AS who,
           k.direction AS dir,
           k.disposition AS disp,
           k.remote_number AS num,
           k.contact_id AS contact,
           k.started_at AS at,
           (k.started_at AT TIME ZONE p_tz) AS loc,
           k.started_at >= p_from AS cur,
           -- 098's answered and missed rules.
           (k.status = 'answered'
            OR (k.status = 'in_progress' AND k.answered_at IS NOT NULL)) AS ans,
           (k.status = 'answered'
            OR (k.status = 'in_progress' AND k.answered_at IS NOT NULL)
            OR (k.direction = 'outbound' AND k.talk_seconds > 0)) AS conn,
           (k.direction = 'inbound'
            AND k.status IN ('no_answer', 'busy', 'abandoned', 'voicemail')) AS miss,
           k.talk_seconds AS talk,
           k.ring_seconds AS ring
      FROM calls k
     WHERE k.account_id = v_account
       -- This period and the previous one, which need not touch it.
       AND ((k.started_at >= p_from AND k.started_at < p_to)
            OR (k.started_at >= v_prev AND k.started_at < v_prev_to))
       AND k.direction IN ('inbound', 'outbound')
       AND (v_scope IS NULL OR k.user_id = ANY (v_scope))
  ),
  people AS (
    SELECT DISTINCT x.u
      FROM (SELECT b.who AS u FROM base b WHERE b.cur AND b.who IS NOT NULL
            UNION
            SELECT e.user_id FROM pbx_extensions e
             WHERE e.account_id = v_account AND e.user_id IS NOT NULL) x
     WHERE v_people AND (v_scope IS NULL OR x.u = ANY (v_scope))
  ),
  -- Each call once in every row it counts in; a row with no calls is
  -- one all-NULL row, counted as zero.
  keyed AS (
    SELECT 'summary'::text AS kind, NULL::uuid AS u, b.*
      FROM (SELECT 1) one LEFT JOIN base b ON b.cur
    UNION ALL
    SELECT 'previous', NULL, b.*
      FROM (SELECT 1) one LEFT JOIN base b ON NOT b.cur
    UNION ALL
    SELECT 'person', p.u, b.*
      FROM people p LEFT JOIN base b ON b.cur AND b.who = p.u
    UNION ALL
    SELECT 'none', NULL, b.*
      FROM (SELECT 1) one LEFT JOIN base b ON b.cur AND b.who IS NULL
     WHERE v_people AND v_scope IS NULL
  ),
  figures AS (
    SELECT k.kind, k.u, jsonb_build_object(
             'calls',                count(k.id),
             'inbound_total',        count(*) FILTER (WHERE k.dir = 'inbound'),
             'inbound_answered',     count(*) FILTER (WHERE k.dir = 'inbound' AND k.ans),
             'outbound_total',       count(*) FILTER (WHERE k.dir = 'outbound'),
             'outbound_answered',    count(*) FILTER (WHERE k.dir = 'outbound' AND k.conn),
             'missed',               count(*) FILTER (WHERE k.miss),
             'answer_rate',          round(count(*) FILTER (WHERE k.dir = 'inbound' AND k.ans)::numeric
                                           / nullif(count(*) FILTER (WHERE k.dir = 'inbound'), 0), 4),
             'talk_seconds_total',   coalesce(sum(k.talk) FILTER (WHERE k.ans), 0),
             'talk_calls',           count(k.talk) FILTER (WHERE k.ans),
             'avg_talk_seconds',     round(avg(k.talk) FILTER (WHERE k.ans)),
             'longest_talk_seconds', max(k.talk) FILTER (WHERE k.ans),
             'ring_seconds_total',   coalesce(sum(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans), 0),
             'ring_calls',           count(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans),
             'avg_ring_seconds',     round(avg(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans)),
             'max_ring_seconds',     max(k.ring) FILTER (WHERE k.dir = 'inbound' AND k.ans),
             'unique_numbers',       count(DISTINCT k.num),
             'with_outcome',         count(k.disp)) AS f
      FROM keyed k
     GROUP BY k.kind, k.u
  )
  SELECT jsonb_build_object(
    'summary',  (SELECT f.f FROM figures f WHERE f.kind = 'summary'),
    'previous', (SELECT f.f FROM figures f WHERE f.kind = 'previous'),
    'by_day', (
      SELECT jsonb_agg(jsonb_build_object(
               'day',               to_char(d.day, 'YYYY-MM-DD'),
               'calls',             coalesce(g.calls, 0),
               'inbound_answered',  coalesce(g.inbound_answered, 0),
               'outbound',          coalesce(g.outbound, 0),
               'outbound_answered', coalesce(g.outbound_answered, 0),
               'missed',            coalesce(g.missed, 0),
               'talk_seconds',      coalesce(g.talk_seconds, 0)) ORDER BY d.day)
        FROM generate_series((p_from AT TIME ZONE p_tz)::date,
                             ((p_to - interval '1 microsecond') AT TIME ZONE p_tz)::date,
                             interval '1 day') d(day)
        LEFT JOIN (
          SELECT b.loc::date AS day,
                 count(*) AS calls,
                 count(*) FILTER (WHERE b.dir = 'inbound' AND b.ans) AS inbound_answered,
                 count(*) FILTER (WHERE b.dir = 'outbound') AS outbound,
                 count(*) FILTER (WHERE b.dir = 'outbound' AND b.conn) AS outbound_answered,
                 count(*) FILTER (WHERE b.miss) AS missed,
                 coalesce(sum(b.talk) FILTER (WHERE b.ans), 0) AS talk_seconds
            FROM base b WHERE b.cur
           GROUP BY b.loc::date) g ON g.day = d.day::date),
    'by_hour', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'dow', h.dow, 'hour', h.hour, 'calls', h.calls, 'answered', h.answered,
               'missed', h.missed, 'talk_seconds', h.talk_seconds) ORDER BY h.dow, h.hour)
        FROM (SELECT extract(isodow FROM b.loc)::integer AS dow,
                     extract(hour FROM b.loc)::integer AS hour,
                     count(*) AS calls,
                     count(*) FILTER (WHERE b.conn) AS answered,
                     count(*) FILTER (WHERE b.miss) AS missed,
                     coalesce(sum(b.talk) FILTER (WHERE b.ans), 0) AS talk_seconds
                FROM base b WHERE b.cur
               GROUP BY 1, 2) h), '[]'::jsonb),
    'talk_buckets', (
      SELECT jsonb_agg(jsonb_build_object(
               'key', t.key, 'min_seconds', t.lo, 'max_seconds', t.hi,
               'calls', (SELECT count(*) FROM base b
                          WHERE b.cur AND b.ans AND b.talk >= t.lo
                            AND (t.hi IS NULL OR b.talk < t.hi))) ORDER BY t.lo)
        FROM (VALUES ('under_30s', 0, 30), ('30s_2m', 30, 120), ('2m_5m', 120, 300),
                     ('5m_15m', 300, 900), ('15m_plus', 900, NULL::integer)) t(key, lo, hi)),
    'outcomes', (
      SELECT jsonb_build_object(
               'interested',     count(*) FILTER (WHERE b.disp = 'interested'),
               'docs_requested', count(*) FILTER (WHERE b.disp = 'docs_requested'),
               'call_back',      count(*) FILTER (WHERE b.disp = 'call_back'),
               'not_eligible',   count(*) FILTER (WHERE b.disp = 'not_eligible'),
               'wrong_number',   count(*) FILTER (WHERE b.disp = 'wrong_number'),
               'none',           count(*) FILTER (WHERE b.ans AND b.disp IS NULL))
        FROM base b WHERE b.cur),
    'people', CASE WHEN v_people THEN coalesce((
      SELECT jsonb_agg(
               jsonb_build_object('kind', f.kind, 'user_id', f.u,
                                  'full_name', pr.full_name, 'extension', ex.extension) || f.f
               ORDER BY (f.kind = 'none'), lower(pr.full_name) NULLS LAST, f.u)
        FROM figures f
        LEFT JOIN profiles pr ON pr.user_id = f.u AND pr.account_id = v_account
        LEFT JOIN pbx_extensions ex ON ex.user_id = f.u AND ex.account_id = v_account
       WHERE f.kind IN ('person', 'none')), '[]'::jsonb) END,
    'top_numbers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'contact_id', t.contact,
               'contact_name', CASE WHEN ct.id IS NOT NULL
                                     AND (v_rank >= 4 OR can_view_contact(ct.account_id, ct.id, ct.user_id))
                                    THEN ct.name END,
               'remote_number', t.num, 'calls', t.calls,
               'talk_seconds', t.talk_seconds, 'last_call_at', t.last_at)
               ORDER BY t.calls DESC, t.last_at DESC)
        FROM (SELECT b.contact,
                     (array_agg(b.num ORDER BY b.at DESC) FILTER (WHERE b.num IS NOT NULL))[1] AS num,
                     count(*) AS calls,
                     coalesce(sum(b.talk) FILTER (WHERE b.ans), 0) AS talk_seconds,
                     max(b.at) AS last_at
                FROM base b
               WHERE b.cur AND (b.contact IS NOT NULL OR b.num IS NOT NULL)
               GROUP BY b.contact, CASE WHEN b.contact IS NULL THEN b.num END
               ORDER BY count(*) DESC, max(b.at) DESC
               LIMIT 10) t
        LEFT JOIN contacts ct ON ct.id = t.contact AND ct.account_id = v_account), '[]'::jsonb),
    'longest', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id, 'started_at', l.at, 'direction', l.dir,
               'remote_number', l.num, 'contact_id', l.contact,
               'contact_name', CASE WHEN ct.id IS NOT NULL
                                     AND (v_rank >= 4 OR can_view_contact(ct.account_id, ct.id, ct.user_id))
                                    THEN ct.name END,
               'talk_seconds', l.talk, 'user_id', l.who, 'user_name', pr.full_name)
               ORDER BY l.talk DESC, l.at DESC)
        FROM (SELECT b.* FROM base b
               WHERE b.cur AND b.ans AND b.talk IS NOT NULL
               ORDER BY b.talk DESC, b.at DESC
               LIMIT 10) l
        LEFT JOIN contacts ct ON ct.id = l.contact AND ct.account_id = v_account
        LEFT JOIN profiles pr ON pr.user_id = l.who AND pr.account_id = v_account), '[]'::jsonb),
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'tz', p_tz,
                                'previous_from', v_prev, 'previous_to', v_prev_to),
    'scope', CASE WHEN p_user IS NOT NULL THEN 'person'
                  WHEN v_rank >= 4 THEN 'workspace'
                  WHEN v_rank = 3 THEN 'team'
                  ELSE 'self' END,
    'user_id', p_user)
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.pbx_call_stats(timestamptz, timestamptz, text, uuid, timestamptz, timestamptz) IS
  'The Call report page''s figures for [p_from, p_to), at most 100 days, days and hours in p_tz: summary and the previous period ([p_prev_from, p_prev_to), else the equally long period just before), by day, weekday x hour, talk buckets, outcomes, people (leader and up), top numbers, longest calls. Owners/admins the workspace (calls with no person included), a team leader their teams plus themselves, everyone else their own calls; p_user narrows to one person in that scope (42501 outside it). 098''s attribution. Migration 119.';

REVOKE ALL ON FUNCTION public.pbx_call_stats(timestamptz, timestamptz, text, uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pbx_call_stats(timestamptz, timestamptz, text, uuid, timestamptz, timestamptz)
  TO authenticated;
