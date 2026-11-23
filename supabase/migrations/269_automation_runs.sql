-- ============================================================
-- 269_automation_runs.sql — waiting automation runs (audit 2026-11-23)
--
--  1. automation_pending_executions.wait_step_id: the wait a run is parked
--     at. The engine continues from that step, then from the conditions
--     around it. No foreign key on purpose: a wait deleted while a run is
--     parked at it must stay tellable from "no wait recorded" (a row
--     parked by the previous build).
--
--  2. automation_save: saving an automation deleted and re-inserted its
--     steps, so a parked run lost its place. One transaction now updates
--     the row, keeps each step by id, adds and removes, and refuses when
--     the automation changed since the caller loaded it.
--     automations.updated_at no longer moves when a run is counted: the
--     check would refuse every save of an automation in use.
--
-- Additive for the previous build. Re-runnable. Apply before the build.
-- Asserted by supabase/ci/verify-automation-runs.sql.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE public.automation_pending_executions
  ADD COLUMN IF NOT EXISTS wait_step_id uuid;

-- Runs after 006's set_updated_at (triggers fire by name), so re-running
-- 006 does not undo it.
CREATE OR REPLACE FUNCTION public.automations_keep_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := OLD.updated_at;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.automations_keep_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS set_updated_at_not_for_counts ON public.automations;
CREATE TRIGGER set_updated_at_not_for_counts
  BEFORE UPDATE ON public.automations
  FOR EACH ROW WHEN (OLD.execution_count IS DISTINCT FROM NEW.execution_count)
  EXECUTE FUNCTION public.automations_keep_updated_at();

-- Service role only: the route has checked the caller. p_patch holds only
-- the columns to change; p_steps NULL leaves the steps alone.
CREATE OR REPLACE FUNCTION public.automation_save(
  p_account_id uuid,
  p_automation_id uuid,
  p_expected_updated_at timestamptz,
  p_patch jsonb,
  p_steps jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_updated timestamptz;
BEGIN
  SELECT a.updated_at INTO v_updated FROM public.automations a
   WHERE a.id = p_automation_id AND a.account_id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF p_expected_updated_at IS DISTINCT FROM v_updated AND p_expected_updated_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  UPDATE public.automations a SET
    name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE a.name END,
    description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE a.description END,
    trigger_type = CASE WHEN p_patch ? 'trigger_type' THEN p_patch->>'trigger_type' ELSE a.trigger_type END,
    trigger_config = CASE WHEN p_patch ? 'trigger_config'
                          THEN NULLIF(p_patch->'trigger_config', 'null'::jsonb) ELSE a.trigger_config END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch->>'is_active')::boolean ELSE a.is_active END
  WHERE a.id = p_automation_id
  RETURNING a.updated_at INTO v_updated;

  IF jsonb_typeof(p_steps) = 'array' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_steps) AS n(id uuid)
        JOIN public.automation_steps s ON s.id = n.id
       WHERE s.automation_id <> p_automation_id
    ) THEN
      RAISE EXCEPTION 'automation_save: a step belongs to another automation';
    END IF;
    INSERT INTO public.automation_steps AS s
           (id, automation_id, parent_step_id, branch, step_type, step_config, position)
    SELECT n.id, p_automation_id, n.parent_step_id, n.branch, n.step_type,
           coalesce(n.step_config, '{}'::jsonb), n.position
      FROM jsonb_to_recordset(p_steps)
        AS n(id uuid, parent_step_id uuid, branch text, step_type text, step_config jsonb, position integer)
    ON CONFLICT (id) DO UPDATE SET
      parent_step_id = EXCLUDED.parent_step_id,
      branch = EXCLUDED.branch,
      step_type = EXCLUDED.step_type,
      step_config = EXCLUDED.step_config,
      position = EXCLUDED.position
    WHERE s.automation_id = p_automation_id;
    -- After the upsert: a step moved out of a removed condition must not
    -- go with it.
    DELETE FROM public.automation_steps s
     WHERE s.automation_id = p_automation_id
       AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_steps) AS n(id uuid) WHERE n.id = s.id);
  END IF;

  RETURN jsonb_build_object('status', 'saved', 'updated_at', v_updated);
END $$;

REVOKE ALL ON FUNCTION public.automation_save(uuid, uuid, timestamptz, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_save(uuid, uuid, timestamptz, jsonb, jsonb) TO service_role;

-- (end)
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
