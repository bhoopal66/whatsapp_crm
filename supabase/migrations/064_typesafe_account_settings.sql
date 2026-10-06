-- ============================================================
-- 064_typesafe_account_settings
--
-- Per-account switches for the TypeSafe decision layer (063), set from
-- Settings → AI safety checks instead of server environment variables:
-- on/off, monitor-only or live, which checks run, and which languages
-- they may act on. The server keeps only the secrets (the API key and
-- the log hash key) and optional install-wide overrides.
--
-- No row, or enabled = false, means the layer is off for the account:
-- nothing is sent to TypeSafe and nothing is logged.
--
-- Also: ts_decision_log.intervened and ts_activity_summary(), which the
-- panel's activity view reads.
--
-- Live mode acts on the built-in thresholds when the account has no
-- approved custom policy (063's ts_policy); a custom policy still needs
-- two admins. docs/typesafe.md describes the switches.
--
-- Idempotent — safe to re-run.
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.ts_account_settings (
  account_id           uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  mode                 text NOT NULL DEFAULT 'monitor'
                       CHECK (mode IN ('monitor', 'live')),
  triage               boolean NOT NULL DEFAULT true,
  guardrail            boolean NOT NULL DEFAULT true,
  passages             boolean NOT NULL DEFAULT false,
  -- Also run triage on conversations people handle, to catch opt-outs.
  watch_human_threads  boolean NOT NULL DEFAULT true,
  languages            text NOT NULL DEFAULT 'english'
                       CHECK (languages IN ('english', 'all')),
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- Closed at once, before anything else can reach it.
ALTER TABLE public.ts_account_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ts_account_settings FROM PUBLIC, anon, authenticated, service_role;

-- Who changed it and when is the database's to say, not the caller's.
CREATE OR REPLACE FUNCTION public.ts_account_settings_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS ts_account_settings_stamp ON public.ts_account_settings;
CREATE TRIGGER ts_account_settings_stamp
  BEFORE INSERT OR UPDATE ON public.ts_account_settings
  FOR EACH ROW EXECUTE FUNCTION public.ts_account_settings_stamp();

-- Admins read and write their own account's row (059's initPlan form).
DROP POLICY IF EXISTS ts_account_settings_read   ON public.ts_account_settings;
DROP POLICY IF EXISTS ts_account_settings_insert ON public.ts_account_settings;
DROP POLICY IF EXISTS ts_account_settings_update ON public.ts_account_settings;
CREATE POLICY ts_account_settings_read ON public.ts_account_settings
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );
CREATE POLICY ts_account_settings_insert ON public.ts_account_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );
CREATE POLICY ts_account_settings_update ON public.ts_account_settings
  FOR UPDATE TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  )
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );

REVOKE ALL ON FUNCTION public.ts_account_settings_stamp() FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON public.ts_account_settings TO authenticated;
-- The message path reads the switches through the service role.
GRANT SELECT ON public.ts_account_settings TO service_role;

-- The watch on conversations people handle skips a message the bot's
-- own triage already judged; it finds it by the message's keyed hash.
CREATE INDEX IF NOT EXISTS ts_decision_log_message_idx
  ON public.ts_decision_log (account_id, message_id)
  WHERE message_id IS NOT NULL;

-- ------------------------------------------------------------
-- What the Settings panel reports (/api/typesafe/activity)
-- ------------------------------------------------------------

-- A decision that changed what happened, as opposed to one taken in
-- Live that let things through (triage 'bot', guardrail 'send', a
-- passage filter that kept everything). The watch logs acted=true only
-- for an opt-out it tagged, so its rows need no special case.
ALTER TABLE public.ts_decision_log
  ADD COLUMN IF NOT EXISTS intervened boolean
  GENERATED ALWAYS AS (
    acted AND (
         (check_name = 'triage'    AND decision IN ('rm', 'opted_out', 'bot_restricted'))
      OR (check_name = 'guardrail' AND decision IN ('hold', 'block'))
      OR (check_name = 'passages'  AND decision ~ '(^|;)(conflict|drop)=[1-9]')
    )
  ) STORED;

-- The panel's seven-day summary in one statement, over the caller's
-- own rows: SECURITY INVOKER, so the log's RLS applies (admins see the
-- account's whole log), and scoped to the caller's account explicitly.
-- In SQL rather than in the route, where PostgREST's max-rows cap
-- silently truncated the rows it summed.
CREATE OR REPLACE FUNCTION public.ts_activity_summary(p_since timestamptz)
RETURNS TABLE (
  decisions         bigint,
  interventions     bigint,
  triage_handoffs   bigint,
  opt_outs          bigint,
  replies_held      bigint,
  replies_blocked   bigint,
  passages_dropped  bigint,
  fallbacks         bigint,
  est_usd           numeric,
  p95_latency_ms    double precision,
  last_decision_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*),
    count(*) FILTER (WHERE intervened),
    -- The bot's triage hands the thread over on 'rm' and on an opt-out;
    -- the watch only tags (its threads already have a person).
    count(*) FILTER (WHERE intervened AND check_name = 'triage'
                       AND decision IN ('rm', 'opted_out')
                       AND NOT ('WATCH' = ANY (reason_codes))),
    count(*) FILTER (WHERE acted AND check_name = 'triage'
                       AND 'OPT_OUT_RECORD' = ANY (reason_codes)),
    count(*) FILTER (WHERE intervened AND check_name = 'guardrail' AND decision = 'hold'),
    count(*) FILTER (WHERE intervened AND check_name = 'guardrail' AND decision = 'block'),
    coalesce(sum(substring(decision FROM '(?:^|;)drop=([0-9]+)')::bigint)
               FILTER (WHERE acted AND check_name = 'passages'), 0),
    count(*) FILTER (WHERE fallback_used),
    coalesce(sum(input_tokens), 0) * public.ts_usd_per_mtok() / 1000000,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms),
    max(created_at)
  FROM public.ts_decision_log
  WHERE account_id = (SELECT public.current_account_id())
    AND created_at >= p_since
$$;

REVOKE ALL ON FUNCTION public.ts_activity_summary(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ts_activity_summary(timestamptz) TO authenticated;

RESET lock_timeout;
