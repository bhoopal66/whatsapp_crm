-- ============================================================
-- 132: assist_audit gets the kind 'agent_run' (019e agent middleware)
-- ============================================================
--
-- What: adds 'agent_run' to the CHECK on public.assist_audit.kind
-- (120 declared it inline, so Postgres named it assist_audit_kind_check).
-- Re-runnable: the constraint is dropped and re-added under the same name.
--
-- Why: the 019e middleware pipeline (src/lib/assist/middleware.ts) writes
-- one audit row per assistant run through auditAfterAgent. The row holds
-- counts only (rounds, tools proposed / allowed / refused / pending) plus
-- the channel name; never message text or tool arguments.
--
-- Who: written by supabaseAgentRunAuditSink in
-- src/lib/assist/middleware.builtin.ts on a service-role client. 120
-- already grants service_role INSERT on assist_audit, so this adds no
-- function and no grant. The append-only guards of 120 cover the new kind
-- unchanged (UPDATE, DELETE and TRUNCATE are refused for every kind).
--
-- Idle: no assistant exists yet, so nothing writes this kind until one does.
-- Assertions: supabase/ci/verify-assistant-safety.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '132 must be applied by a superuser or BYPASSRLS role (assist_audit is RLS-forced)';
  END IF;
END $$;

ALTER TABLE public.assist_audit DROP CONSTRAINT IF EXISTS assist_audit_kind_check;
ALTER TABLE public.assist_audit ADD CONSTRAINT assist_audit_kind_check
  CHECK (kind IN ('pending', 'confirm_refused', 'consume_refused', 'decision', 'execution', 'rate_reset',
                  'agent_run'));
