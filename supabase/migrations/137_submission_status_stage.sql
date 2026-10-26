-- ============================================================
-- 137_submission_status_stage.sql — a submission's status moves its
-- case to the stage of the same name.
--
-- Compass (the submission app of 115 / 134) reports each submission's
-- progress as `status` on PATCH /api/v1/submission-groups/{id}
-- (SUBMITTED, DOCUMENTS_REQUESTED, UNDER_REVIEW, …) and never sends a
-- case `stage`. 122's case_apply_submission_status acted only on the
-- four final statuses, so every open case stayed at Submitted while its
-- submission moved on.
--
--  * case_apply_submission_status(group, status): the final statuses
--    are unchanged (APPROVED / DECLINED / WITHDRAWN / CLOSED close the
--    case). Any other status moves the case to the stage of the bank's
--    list (case_stages_for_bank) whose name equals the status with `_`
--    read as a space, ignoring case and surrounding blanks:
--    UNDER_REVIEW -> Under review. Same rules as 134's API stage move:
--    never a pre-submission stage, never a final stage this way, nothing
--    from a closed or final case; same stage, an unknown status or a
--    group with no case is a no-op (false). History actor NULL / 'api',
--    so case.stage_changed carries source 'compass'.
--  * The route skips a non-final status when the same PATCH carries an
--    explicit `stage`: Compass's own stage wins.
--  * Catch-up: every open case still at Submitted whose submission
--    already reported a non-final status is moved once, through the
--    same function. Only cases at Submitted, so a re-run never undoes a
--    later move.
--
-- SECURITY DEFINER over RLS-forced tables, so, as 122 and 134, this
-- must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE OR REPLACE; the catch-up moves only cases still
-- at Submitted.
-- ============================================================

-- 122's case_apply_submission_status, plus the non-final branch (137).
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
  v_stage := CASE v_norm
               WHEN 'APPROVED'  THEN 'Approved'
               WHEN 'DECLINED'  THEN 'Declined'
               WHEN 'WITHDRAWN' THEN 'Withdrawn'
               WHEN 'CLOSED'    THEN 'Closed'
             END;
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
  SELECT s.stage INTO v_stage
    FROM unnest(public.case_stages_for_bank(c.account_id, c.bank_code)) AS s(stage)
   WHERE upper(s.stage) = regexp_replace(replace(v_norm, '_', ' '), '[[:space:]]+', ' ', 'g')
     AND NOT public.case_stage_is_presub(s.stage)
     AND s.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed')
   LIMIT 1;
  IF v_stage IS NULL OR v_stage = c.stage THEN
    RETURN false;
  END IF;
  UPDATE public.cases x SET stage = v_stage WHERE x.id = c.id;
  INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
  VALUES (c.id, c.account_id, c.stage, v_stage, c.outcome, NULL, 'api');
  RETURN true;
END;
$$;

-- Catch-up: open cases still at Submitted whose submission already
-- reported a non-final status.
DO $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT g.id, g.submission_status
      FROM public.submission_groups g
      JOIN public.cases c ON c.group_id = g.id AND c.account_id = g.account_id
     WHERE c.stage = 'Submitted' AND c.closed_at IS NULL
       AND g.submission_status IS NOT NULL
       AND upper(btrim(g.submission_status)) NOT IN ('APPROVED', 'DECLINED', 'WITHDRAWN', 'CLOSED')
     ORDER BY g.id
  LOOP
    IF public.case_apply_submission_status(r.id, r.submission_status) THEN
      n := n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '137: moved % case(s) to their submission''s stage', n;
END;
$$;
