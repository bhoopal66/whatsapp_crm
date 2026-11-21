-- ============================================================
-- 228_hr_automsg_outbox_stats.sql — the HR automated-message queue in
-- numbers, for GET /api/metrics (package 033g).
--
-- hr_automsg_outbox_stats() returns one jsonb over every workspace:
--   rows                       [{status, channel, count}] per status and channel
--   held                       [{reason, channel, count}] held rows by reason
--   oldest_queued_age_seconds  age of the oldest queued row, null when none
--   terminal_failed            failed rows no retry will pick up (attempts >= 3,
--                              the cap 203's mark and 212's fail_terminal set)
-- Counts only: no ids, no text, no contact. SECURITY DEFINER because the
-- table forces RLS; executable by the service role only.
--
-- Re-runnable. Apply after 227, as a superuser or BYPASSRLS role (the
-- refusal below runs before any DDL).
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '228 must be applied by a superuser or BYPASSRLS role (the function reads an RLS-forced table)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.hr_automsg_outbox_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('status', s.status, 'channel', s.channel, 'count', s.n)
                       ORDER BY s.status, s.channel)
        FROM (SELECT o.status, o.channel, count(*) AS n
                FROM hr_automsg_outbox o
               GROUP BY o.status, o.channel) s), '[]'::jsonb),
    'held', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('reason', h.hold_reason, 'channel', h.channel, 'count', h.n)
                       ORDER BY h.hold_reason, h.channel)
        FROM (SELECT o.hold_reason, o.channel, count(*) AS n
                FROM hr_automsg_outbox o
               WHERE o.status = 'held' AND o.hold_reason IS NOT NULL
               GROUP BY o.hold_reason, o.channel) h), '[]'::jsonb),
    'oldest_queued_age_seconds', (
      SELECT floor(extract(epoch FROM now() - min(o.created_at)))::bigint
        FROM hr_automsg_outbox o
       WHERE o.status = 'queued'),
    'terminal_failed', (
      SELECT count(*)
        FROM hr_automsg_outbox o
       WHERE o.status = 'failed' AND o.attempts >= 3)
  )
$$;

REVOKE ALL ON FUNCTION public.hr_automsg_outbox_stats() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hr_automsg_outbox_stats() TO service_role;
