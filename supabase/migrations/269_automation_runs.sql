-- ============================================================
-- 269_automation_runs.sql — waiting automation runs (audit 2026-11-23)
--
--  1. automation_pending_executions.wait_step_id: the wait a run is parked
--     at. The engine continues from that step, then from the conditions
--     around it. No foreign key on purpose: a wait deleted while a run is
--     parked at it must stay tellable from "no wait recorded" (a row
--     parked by the previous build).
--
-- Additive for the previous build. Re-runnable. Apply before the build.
-- Asserted by supabase/ci/verify-automation-runs.sql.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE public.automation_pending_executions
  ADD COLUMN IF NOT EXISTS wait_step_id uuid;

-- (end)
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
