-- ============================================================
-- 296_home_figures.sql — the home screen's figures count what happened.
--
--  1. dashboard_message_series and dashboard_response_time (RESTATE 268's):
--     a message that failed to send was never received. It is no longer
--     drawn as an outgoing message, and it neither answers a customer nor
--     stands between a customer's message and the reply that arrived.
--     team_activity_report and live_team_view already leave it out.
--  2. dashboard_open_deal_values(): open deals per stage AND currency. A
--     deal's currency is chosen on the deal, so dashboard_open_deals_by_stage
--     (058, kept for the previous build) adds different currencies. A deal
--     without a currency is in its account's default one.
--  3. deals.currency no longer defaults to 'USD': a deal created without a
--     currency takes its account's default one (deals_default_currency).
--     Existing rows are not rewritten.
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

-- ---------- 2. Open deals per stage and currency ----------

CREATE OR REPLACE FUNCTION public.dashboard_open_deal_values()
 RETURNS TABLE(stage_id uuid, currency text, deal_count bigint, total_value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    d.stage_id,
    coalesce(nullif(upper(btrim(d.currency)), ''), a.default_currency, 'USD') AS currency,
    count(*) AS deal_count,
    coalesce(sum(d.value), 0) AS total_value
  FROM deals d
  LEFT JOIN accounts a ON a.id = d.account_id
  WHERE d.status = 'open'
  GROUP BY 1, 2
  ORDER BY 1, 2;
$function$;

REVOKE ALL ON FUNCTION public.dashboard_open_deal_values() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_open_deal_values() TO authenticated, service_role;

-- ---------- 3. A new deal's currency ----------

-- Runs as whoever inserts: a member reads their own account's row.
CREATE OR REPLACE FUNCTION public.deals_default_currency()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  SELECT a.default_currency INTO NEW.currency FROM accounts a WHERE a.id = NEW.account_id;
  NEW.currency := coalesce(NEW.currency, 'USD');
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.deals_default_currency() FROM PUBLIC, anon, authenticated;

-- The trigger first: it does nothing while the default exists, and a lock
-- timeout between the two must not leave neither.
CREATE OR REPLACE TRIGGER deals_default_currency
  BEFORE INSERT ON public.deals
  FOR EACH ROW WHEN (NEW.currency IS NULL)
  EXECUTE FUNCTION public.deals_default_currency();

ALTER TABLE public.deals ALTER COLUMN currency DROP DEFAULT;

NOTIFY pgrst, 'reload schema';
