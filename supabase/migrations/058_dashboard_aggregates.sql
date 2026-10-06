-- ============================================================
-- 058_dashboard_aggregates.sql — server-side aggregation for the
-- dashboard charts.
--
-- Why
--
--   The dashboard used to download every message row of the last 30
--   (or 90) days, the last 14 days again for the response-time chart,
--   and every open deal, then bucket them in the browser. Behind a
--   tunnel that is megabytes per page view, and it was silently WRONG
--   past PostgREST's max-rows cap (1000): a busy account's chart just
--   stopped counting. These functions return a handful of aggregated
--   rows instead — at most one per day, per weekday, or per stage.
--
-- Security
--
--   SECURITY INVOKER: every function runs as the caller, so the RLS on
--   `messages` (via `can_view_conversation`, migration 042) and `deals`
--   scopes the aggregate to exactly the rows the old client queries
--   saw. No privilege bypass.
--
-- Time zones
--
--   "Today" and "Monday" are the viewer's LOCAL calendar, as before.
--   The client still computes the window boundaries (so DST and the
--   browser's notion of midnight are unchanged) and passes its IANA
--   zone for the per-day / per-weekday bucketing.
--
-- Re-runnable: CREATE OR REPLACE / CREATE INDEX IF NOT EXISTS.
-- ============================================================

-- Every function below filters messages on `created_at >= p_since`;
-- without this index that is a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON public.messages (created_at);

-- ------------------------------------------------------------
-- Messages per local day, split customer (incoming) vs everything
-- else (agent + bot = outgoing). Days with no messages are absent;
-- the client seeds zero buckets.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_message_series(
  p_since TIMESTAMPTZ,
  p_tz    TEXT
)
RETURNS TABLE (day DATE, incoming BIGINT, outgoing BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (m.created_at AT TIME ZONE p_tz)::date AS day,
    count(*) FILTER (WHERE m.sender_type = 'customer') AS incoming,
    count(*) FILTER (WHERE m.sender_type <> 'customer') AS outgoing
  FROM messages m
  WHERE m.created_at >= p_since
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.dashboard_message_series(TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_message_series(TIMESTAMPTZ, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.dashboard_message_series(TIMESTAMPTZ, TEXT) TO authenticated;

-- ------------------------------------------------------------
-- First-response samples, summed per (weekday, period).
--
-- Pairing rule (unchanged from the client version): within each
-- conversation, the FIRST customer message of an unanswered run is
-- paired with the next agent/bot message; a customer double-texting
-- while waiting counts once. Equivalently: every non-customer message
-- whose predecessor (inside the window) is a customer message closes
-- a pair, and the pair opened at the latest "run start" — a customer
-- message whose predecessor is not a customer message.
--
-- `dow` is Monday-first (0 = Mon … 6 = Sun) of the customer message
-- in p_tz. `period` places the customer message relative to the
-- client's week boundaries: 'this_week', 'last_week', or 'earlier'
-- (still inside the window; counts toward the weekday bars only).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_response_time(
  p_since            TIMESTAMPTZ,
  p_tz               TEXT,
  p_this_week_start  TIMESTAMPTZ,
  p_last_week_start  TIMESTAMPTZ
)
RETURNS TABLE (dow INT, period TEXT, samples BIGINT, total_minutes DOUBLE PRECISION)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH ordered AS (
    SELECT
      m.conversation_id,
      m.id,
      m.created_at,
      m.sender_type = 'customer' AS is_customer,
      lag(m.sender_type = 'customer') OVER w AS prev_customer
    FROM messages m
    WHERE m.created_at >= p_since
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
    WHERE NOT is_customer
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
$$;

REVOKE ALL ON FUNCTION public.dashboard_response_time(TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_response_time(TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.dashboard_response_time(TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ------------------------------------------------------------
-- Open deals per stage (count + value). Feeds both the pipeline
-- donut and the "open deals value" metric card — the sum over all
-- rows is the account-wide open total.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_open_deals_by_stage()
RETURNS TABLE (stage_id UUID, deal_count BIGINT, total_value NUMERIC)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT d.stage_id, count(*) AS deal_count, coalesce(sum(d.value), 0) AS total_value
  FROM deals d
  WHERE d.status = 'open'
  GROUP BY d.stage_id;
$$;

REVOKE ALL ON FUNCTION public.dashboard_open_deals_by_stage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dashboard_open_deals_by_stage() FROM anon;
GRANT EXECUTE ON FUNCTION public.dashboard_open_deals_by_stage() TO authenticated;
