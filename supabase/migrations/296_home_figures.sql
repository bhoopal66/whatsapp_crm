-- ============================================================
-- 296_home_figures.sql — the home screen's figures count what happened.
--
--  1. dashboard_message_series and dashboard_response_time (RESTATE 268's):
--     a message that failed to send was never received. It is no longer
--     drawn as an outgoing message, and it neither answers a customer nor
--     stands between a customer's message and the reply that arrived.
--     team_activity_report and live_team_view already leave it out.
--
-- Re-running 058, 217 or 268 puts an older body back: re-run 296.
-- Apply before the build. Additive for the previous build. Re-runnable.
-- verify-home-figures.sql.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. A failed send is not a message ----------

CREATE OR REPLACE FUNCTION public.dashboard_message_series(p_since timestamp with time zone, p_tz text)
 RETURNS TABLE(day date, incoming bigint, outgoing bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    (m.created_at AT TIME ZONE p_tz)::date AS day,
    count(*) FILTER (WHERE m.sender_type = 'customer') AS incoming,
    count(*) FILTER (WHERE m.sender_type <> 'customer') AS outgoing
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id AND c.personal_owner_id IS NULL
  WHERE m.created_at >= p_since
    AND (m.sender_type = 'customer' OR m.status <> 'failed')
  GROUP BY 1
  ORDER BY 1;
$function$;

CREATE OR REPLACE FUNCTION public.dashboard_response_time(p_since timestamp with time zone, p_tz text, p_this_week_start timestamp with time zone, p_last_week_start timestamp with time zone)
 RETURNS TABLE(dow integer, period text, samples bigint, total_minutes double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH ordered AS (
    SELECT
      m.conversation_id,
      m.id,
      m.created_at,
      m.sender_type = 'customer' AS is_customer,
      (m.sender_type = 'agent' AND m.sender_id IS NOT NULL) AS is_person,
      lag(m.sender_type = 'customer') OVER w AS prev_customer
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id AND c.personal_owner_id IS NULL
    WHERE m.created_at >= p_since
      AND (m.sender_type = 'customer' OR m.status <> 'failed')
    WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id)
  ),
  marked AS (
    SELECT
      o.*,
      -- created_at of the most recent customer run start so far;
      -- rows are time-ordered, so the latest start is the max.
      max(CASE WHEN o.is_customer AND o.prev_customer IS NOT TRUE
               THEN o.created_at END)
        OVER (PARTITION BY o.conversation_id
              ORDER BY o.created_at, o.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_start_at
    FROM ordered o
  ),
  pairs AS (
    SELECT
      run_start_at AS customer_at,
      extract(epoch FROM (created_at - run_start_at)) / 60.0 AS minutes
    FROM marked
    WHERE is_person
      AND prev_customer IS TRUE
      AND run_start_at IS NOT NULL
  )
  SELECT
    (extract(isodow FROM (p.customer_at AT TIME ZONE p_tz))::int - 1) AS dow,
    CASE
      WHEN p.customer_at >= p_this_week_start THEN 'this_week'
      WHEN p.customer_at >= p_last_week_start THEN 'last_week'
      ELSE 'earlier'
    END AS period,
    count(*) AS samples,
    sum(p.minutes)::double precision AS total_minutes
  FROM pairs p
  WHERE p.minutes >= 0
  GROUP BY 1, 2
  ORDER BY 1, 2;
$function$;

REVOKE ALL ON FUNCTION public.dashboard_message_series(timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_message_series(timestamptz, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.dashboard_response_time(timestamptz, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_response_time(timestamptz, text, timestamptz, timestamptz) TO authenticated, service_role;
