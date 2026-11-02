-- ============================================================
-- 166_compass_finished_statuses.sql — "Customer Withdrawn" and
-- "Agency Withdrawn" finish a submission.
--
-- A final Compass status closes the case and ends its submission group
-- (122, 137, 151), but case_apply_submission_status recognised only the
-- exact words APPROVED / DECLINED / WITHDRAWN / CLOSED. Compass also
-- reports "Customer Withdrawn" and "Agency Withdrawn", which matched no
-- final status and no stage, so those cases stayed open and their
-- groups were never ended.
--
--  * case_final_stage_for_status(text): the final stage a status closes
--    a case at, or NULL for any other status. Read through 151's
--    case_status_key (upper case, `_` read as a space, blank runs
--    collapsed, trimmed), so "customer_withdrawn" counts too. Both new
--    labels close the case as Withdrawn. DEFAULT_FINAL_STATUSES in
--    src/lib/submission-groups/rules.ts is its TS mirror (rules.test.ts
--    reads this file): change one, change both.
--  * case_apply_submission_status: 151's body, except that the final
--    branch asks case_final_stage_for_status. The non-final branch, the
--    history row (actor NULL, role 'api'), signature, SECURITY DEFINER,
--    search_path and grants are 151's. Open statuses are untouched.
--  * A one-time repair closes the open cases whose group already holds
--    one of these labels, through case_apply_submission_status (the path
--    a Compass PATCH takes), so history, SLA triggers and the webhook
--    outbox hold. Their groups are then ended by the automations cron's
--    sweep of closed cases with no group end (130's
--    case_pending_group_end). Re-running closes nothing more.
--
-- Not changed: 151's map refusals (STATUS_FINAL) still name the four
-- original words. A mapping for one of the new labels is never reached,
-- because the final branch runs first.
--
-- SECURITY DEFINER over RLS-forced tables, and the repair reads
-- `cases`, so, as 122-151, this must be applied by a superuser or
-- BYPASSRLS role (supabase_admin).
--
-- Re-runnable: CREATE OR REPLACE, and the repair only touches open cases.
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '166 must be applied by a superuser or BYPASSRLS role (its repair reads RLS-forced cases)';
  END IF;
END $$;

SET lock_timeout = '10s';

-- ---------- 1. Final statuses ----------

CREATE OR REPLACE FUNCTION public.case_final_stage_for_status(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE public.case_status_key(p)
           WHEN 'APPROVED'           THEN 'Approved'
           WHEN 'DECLINED'           THEN 'Declined'
           WHEN 'WITHDRAWN'          THEN 'Withdrawn'
           WHEN 'CUSTOMER WITHDRAWN' THEN 'Withdrawn'
           WHEN 'AGENCY WITHDRAWN'   THEN 'Withdrawn'
           WHEN 'CLOSED'             THEN 'Closed'
         END
$$;

COMMENT ON FUNCTION public.case_final_stage_for_status(text) IS
  'The final stage a Compass submission status closes its case at (APPROVED, DECLINED, WITHDRAWN, CUSTOMER WITHDRAWN, AGENCY WITHDRAWN, CLOSED, read through case_status_key), else NULL. Mirrored by DEFAULT_FINAL_STATUSES in src/lib/submission-groups/rules.ts. Migration 166.';

-- ---------- 2. case_apply_submission_status ----------

-- 151's case_apply_submission_status; the final branch asks
-- case_final_stage_for_status (166).
CREATE OR REPLACE FUNCTION public.case_apply_submission_status(p_group uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c       public.cases%ROWTYPE;
  v_norm  text := upper(btrim(coalesce(p_status, '')));
  v_stage text;
BEGIN
  v_stage := public.case_final_stage_for_status(p_status);
  IF v_stage IS NOT NULL THEN
    SELECT * INTO c FROM public.cases x WHERE x.group_id = p_group FOR UPDATE;
    IF NOT FOUND OR c.closed_at IS NOT NULL THEN
      RETURN false;
    END IF;
    UPDATE public.cases x
       SET stage = v_stage,
           outcome = CASE WHEN v_stage = 'Closed' THEN x.outcome ELSE v_stage END,
           closed_at = now(),
           group_ended_at = coalesce(x.group_ended_at,
             (SELECT g.ended_at FROM public.submission_groups g
               WHERE g.id = c.group_id AND g.status = 'ENDED'))
     WHERE x.id = c.id;
    INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
    VALUES (c.id, c.account_id, c.stage, v_stage,
            CASE WHEN v_stage = 'Closed' THEN c.outcome ELSE v_stage END, NULL, 'api');
    RETURN true;
  END IF;

  -- 137: a non-final status names a stage.
  IF v_norm = '' THEN
    RETURN false;
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.group_id = p_group FOR UPDATE;
  IF NOT FOUND OR c.closed_at IS NOT NULL
     OR c.stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN
    RETURN false;
  END IF;
  -- 151: the account's map first, when its stage is in this case's list,
  -- else 137's name rule.
  v_stage := public.case_status_target_stage(c.account_id, c.bank_code, p_status);
  IF v_stage IS NULL OR v_stage = c.stage THEN
    RETURN false;
  END IF;
  UPDATE public.cases x SET stage = v_stage WHERE x.id = c.id;
  INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
  VALUES (c.id, c.account_id, c.stage, v_stage, c.outcome, NULL, 'api');
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.case_apply_submission_status(uuid, text) IS
  'Applies a Compass submission status to its case as the API (actor NULL, role api): a final status (case_final_stage_for_status, 166) closes it (122); another moves it to the account''s mapped stage when that is in the case''s bank list (151), else to the stage of the same name (137). Migration 166.';

-- ---------- 3. Privileges ----------

-- As 151's case_status_key and 122's case_apply_submission_status: the
-- service role's alone.
REVOKE ALL ON FUNCTION
  public.case_final_stage_for_status(text),
  public.case_apply_submission_status(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_final_stage_for_status(text),
  public.case_apply_submission_status(uuid, text)
  TO service_role;

-- ---------- 4. Repair: open cases already holding a final label ----------

-- Closes every open case whose group's stored status is now final (the
-- new labels; the four original words were already closed on arrival).
-- A closed case is skipped by case_apply_submission_status itself, so a
-- re-run closes nothing more.
DO $$
DECLARE
  g record;
  v_closed int := 0;
BEGIN
  FOR g IN
    SELECT s.id, s.submission_status
      FROM public.cases c
      JOIN public.submission_groups s ON s.id = c.group_id
     WHERE c.closed_at IS NULL
       AND public.case_final_stage_for_status(s.submission_status) IS NOT NULL
     ORDER BY c.id
  LOOP
    IF public.case_apply_submission_status(g.id, g.submission_status) THEN
      v_closed := v_closed + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '166: closed % open case(s) holding a final submission status', v_closed;
END $$;

RESET lock_timeout;
