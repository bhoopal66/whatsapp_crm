-- ============================================================
-- 127_bank_dashboard.sql — the bank dashboard (aggregates over a bank
-- workspace's cases) and the decline / withdraw reason of a case.
-- Port of module 018c (018c_dashboard.sql), over 122's cases and stage
-- history, 123's case tasks, 124's SLA timers and 126's bank
-- workspaces.
--
--  * DASHBOARD: bank_ws_dashboard(p_actor, p_bank_ws, p_now) -> jsonb,
--    computed on every call from the live tables (nothing stored).
--    ACCESS: bank_ws_access(p_bank_ws, p_actor) must be 'admin' or
--    'member' (126); anyone else, a NULL actor included, is refused
--    NOT_ALLOWED. An unknown bank workspace is BANK_WS_NOT_FOUND; a NULL
--    or non-finite p_now is NOW_REQUIRED.
--    SCOPE: the cases of the workspace's account and bank that the actor
--    may read, computed set-wise from bank_ws_viewer (126), which equals
--    case_can_read without a per-row call: owner / admin every case,
--    otherwise the cases they are agent or coordinator of and, for a
--    team lead, their teams' agents' cases. There is no IT role in
--    wacrm. Aggregates only: no case, contact, submission, person or
--    product identifier is in the output.
--    Keys (as the reference):
--      scope               'all' (super_admin / admin) or 'own'.
--      total_cases         the readable cases; every key below is over
--                          the same set.
--      cases_by_stage      { stage: count } by current stage.
--      avg_days_per_stage  { stage: { avg_days, intervals } }: each
--                          case_stage_history row opens an interval in
--                          its to_stage that ends at the case's next
--                          history row (ordered changed_at, id); the
--                          current stage of a case that is not final
--                          ends at p_now. Final stages (Approved,
--                          Declined, Withdrawn, Closed) are outcomes and
--                          left out. avg_days rounded to 2 decimals.
--      approval            { approved, declined, withdrawn, rate } by
--                          cases.outcome (kept after Closed); rate =
--                          approved / (approved + declined) to 4
--                          decimals, NULL when that is 0. Withdrawn is
--                          not a decision and not in the denominator.
--      declined_reasons    { reason_code: count } over Declined cases.
--      withdrawn_reasons   { reason_code: count } over Withdrawn cases.
--      overdue_count       cases, each once, with at p_now a RUNNING SLA
--                          timer that is overdue (case_sla_state_at,
--                          computed, not the stored state) OR a task not
--                          done with due_at < p_now. The stage is not
--                          looked at.
--      amount_in_pipeline  sum of cases.amount (AED) over cases whose
--                          stage is not final and not Closed, as a
--                          decimal string ('0.00' when none).
--  * REASONS: case_outcome_reasons, at most one per case (primary key),
--    append-only (UPDATE / DELETE / TRUNCATE refused by trigger, the
--    owner included). reason_code INCOMPLETE_DOCS | CREDIT_POLICY |
--    INCOME_INSUFFICIENT | KYC_AML | CUSTOMER_WITHDREW | OTHER; optional
--    reason_text up to 500 characters, whitespace-only stored as NULL.
--    case_outcome_reason_set(p_actor, p_case, p_code, p_text): whoever
--    may write the case (case_rule_can_write(case_role(case, actor))),
--    only when the case outcome is Declined or Withdrawn (also after
--    Closed), once per case. Refusals (hint): CASE_NOT_FOUND,
--    NOT_ALLOWED, REASON_INVALID, REASON_TEXT_TOO_LONG,
--    OUTCOME_NOT_DECLINED, REASON_ALREADY_SET. created_at is the server
--    clock.
--  * PRIVILEGES: case_outcome_reasons is RLS-forced; authenticated
--    SELECTs a reason of its active account whose case it may read
--    (case_rls_can_read), so the case page can show it. service_role has
--    NO table privilege: it calls the two SECURITY DEFINER functions
--    (search_path ''). Nobody writes the table directly.
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 122,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '127 must be applied by a superuser or BYPASSRLS role (the functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Reasons ----------

CREATE TABLE IF NOT EXISTS public.case_outcome_reasons (
  case_id     uuid PRIMARY KEY,
  account_id  uuid NOT NULL,
  reason_code text NOT NULL,
  reason_text text NULL,
  outcome     text NOT NULL,
  actor_id    uuid NOT NULL,
  actor_role  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_outcome_reasons_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_outcome_reasons_code_check CHECK (reason_code IN ('INCOMPLETE_DOCS', 'CREDIT_POLICY',
    'INCOME_INSUFFICIENT', 'KYC_AML', 'CUSTOMER_WITHDREW', 'OTHER')),
  CONSTRAINT case_outcome_reasons_text_check CHECK (reason_text IS NULL
    OR (reason_text !~ '^[[:space:]]*$' AND char_length(reason_text) <= 500)),
  CONSTRAINT case_outcome_reasons_outcome_check CHECK (outcome IN ('Declined', 'Withdrawn'))
);
COMMENT ON TABLE public.case_outcome_reasons IS
  'The decline / withdraw reason of a case, once. Written only through case_outcome_reason_set. Append-only. Migration 127.';

ALTER TABLE public.case_outcome_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_outcome_reasons FORCE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS case_outcome_reasons_append_only ON public.case_outcome_reasons;
CREATE TRIGGER case_outcome_reasons_append_only
  BEFORE UPDATE OR DELETE ON public.case_outcome_reasons FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_outcome_reasons_no_truncate ON public.case_outcome_reasons;
CREATE TRIGGER case_outcome_reasons_no_truncate
  BEFORE TRUNCATE ON public.case_outcome_reasons FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

CREATE OR REPLACE FUNCTION public.case_outcome_reason_set(p_actor uuid, p_case uuid, p_code text, p_text text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  v_role text;
  v_text text;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  -- An unknown case and a case the actor may not write answer alike, so the
  -- error is no oracle for which case ids exist.
  IF FOUND THEN
    v_role := public.case_role(p_case, p_actor);
  END IF;
  IF NOT FOUND OR NOT coalesce(public.case_rule_can_write(v_role), false) THEN
    RAISE EXCEPTION 'case %: % may not set the outcome reason', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_code IS NULL OR p_code NOT IN ('INCOMPLETE_DOCS', 'CREDIT_POLICY', 'INCOME_INSUFFICIENT', 'KYC_AML',
                                      'CUSTOMER_WITHDREW', 'OTHER') THEN
    RAISE EXCEPTION 'reason % is not a reason code', p_code USING ERRCODE = 'check_violation', HINT = 'REASON_INVALID';
  END IF;
  v_text := CASE WHEN p_text ~ '^[[:space:]]*$' THEN NULL ELSE p_text END;
  IF char_length(v_text) > 500 THEN
    RAISE EXCEPTION 'reason text over 500 characters' USING ERRCODE = 'check_violation', HINT = 'REASON_TEXT_TOO_LONG';
  END IF;
  IF c.outcome IS NULL OR c.outcome NOT IN ('Declined', 'Withdrawn') THEN
    RAISE EXCEPTION 'case %: outcome % takes no reason', p_case, coalesce(c.outcome, '(none)')
      USING ERRCODE = 'check_violation', HINT = 'OUTCOME_NOT_DECLINED';
  END IF;
  INSERT INTO public.case_outcome_reasons (case_id, account_id, reason_code, reason_text, outcome, actor_id, actor_role)
  VALUES (p_case, c.account_id, p_code, v_text, c.outcome, p_actor, v_role)
  ON CONFLICT (case_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case %: reason already set', p_case USING ERRCODE = 'unique_violation', HINT = 'REASON_ALREADY_SET';
  END IF;
END;
$$;

-- ---------- 2. Dashboard ----------

CREATE OR REPLACE FUNCTION public.bank_ws_dashboard(p_actor uuid, p_bank_ws uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  w     public.bank_workspaces%ROWTYPE;
  v     record;
  v_out jsonb;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'bank_ws_dashboard needs a finite clock' USING ERRCODE = 'invalid_parameter_value', HINT = 'NOW_REQUIRED';
  END IF;
  SELECT * INTO w FROM public.bank_workspaces x WHERE x.id = p_bank_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank workspace % not found', p_bank_ws USING ERRCODE = 'no_data_found', HINT = 'BANK_WS_NOT_FOUND';
  END IF;
  IF p_actor IS NULL OR coalesce(public.bank_ws_access(w.id, p_actor) NOT IN ('admin', 'member'), true) THEN
    RAISE EXCEPTION 'bank workspace %: % has no access', w.id, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT * INTO v FROM public.bank_ws_viewer(w.account_id, p_actor);

  WITH bc AS (
    SELECT c.id, c.stage, c.outcome, c.amount
      FROM public.cases c
     WHERE c.account_id = w.account_id AND c.bank_code = w.bank_code
       AND v.role IS NOT NULL
       AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor OR c.coordinator_id = p_actor
            OR c.agent_id = ANY (v.team_agents))
  ), spans AS (
    SELECT h.to_stage AS stage,
           coalesce(lead(h.changed_at) OVER (PARTITION BY h.case_id ORDER BY h.changed_at, h.id),
                    CASE WHEN bc.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN p_now END)
             - h.changed_at AS spent
      FROM public.case_stage_history h JOIN bc ON bc.id = h.case_id
  ), overdue AS (
    SELECT bc.id FROM bc
     WHERE EXISTS (SELECT 1 FROM public.case_sla_timers t
                    WHERE t.case_id = bc.id AND t.stopped_at IS NULL
                      AND public.case_sla_state_at(t.due_soon_at, t.due_at, p_now) = 'overdue')
        OR EXISTS (SELECT 1 FROM public.case_tasks k
                    WHERE k.case_id = bc.id AND k.status <> 'done' AND k.due_at IS NOT NULL AND k.due_at < p_now)
  ), oc AS (
    SELECT count(*) FILTER (WHERE bc.outcome = 'Approved')  AS approved,
           count(*) FILTER (WHERE bc.outcome = 'Declined')  AS declined,
           count(*) FILTER (WHERE bc.outcome = 'Withdrawn') AS withdrawn
      FROM bc
  )
  SELECT jsonb_build_object(
    'scope', CASE WHEN v.role IN ('super_admin', 'admin') THEN 'all' ELSE 'own' END,
    'total_cases', (SELECT count(*) FROM bc),
    'cases_by_stage', coalesce((SELECT jsonb_object_agg(s.stage, s.n)
        FROM (SELECT bc.stage, count(*) AS n FROM bc GROUP BY bc.stage) s), '{}'::jsonb),
    'avg_days_per_stage', coalesce((SELECT jsonb_object_agg(a.stage, jsonb_build_object('avg_days', a.avg_days, 'intervals', a.n))
        FROM (SELECT sp.stage, round((avg(extract(epoch FROM sp.spent)) / 86400)::numeric, 2) AS avg_days, count(*) AS n
                FROM spans sp
               WHERE sp.spent IS NOT NULL AND sp.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed')
               GROUP BY sp.stage) a), '{}'::jsonb),
    'approval', (SELECT jsonb_build_object('approved', oc.approved, 'declined', oc.declined, 'withdrawn', oc.withdrawn,
        'rate', CASE WHEN oc.approved + oc.declined > 0
                     THEN round(oc.approved::numeric / (oc.approved + oc.declined), 4) END) FROM oc),
    'declined_reasons', coalesce((SELECT jsonb_object_agg(r.reason_code, r.n)
        FROM (SELECT x.reason_code, count(*) AS n FROM public.case_outcome_reasons x JOIN bc ON bc.id = x.case_id
               WHERE bc.outcome = 'Declined' GROUP BY x.reason_code) r), '{}'::jsonb),
    'withdrawn_reasons', coalesce((SELECT jsonb_object_agg(r.reason_code, r.n)
        FROM (SELECT x.reason_code, count(*) AS n FROM public.case_outcome_reasons x JOIN bc ON bc.id = x.case_id
               WHERE bc.outcome = 'Withdrawn' GROUP BY x.reason_code) r), '{}'::jsonb),
    'overdue_count', (SELECT count(*) FROM overdue),
    'amount_in_pipeline', (SELECT coalesce(sum(bc.amount), 0)::numeric(18, 2)::text FROM bc
                            WHERE bc.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed'))
  ) INTO v_out;
  RETURN v_out;
END;
$$;

-- ---------- 3. RLS (authenticated, active account) ----------

DROP POLICY IF EXISTS case_outcome_reasons_select ON public.case_outcome_reasons;
CREATE POLICY case_outcome_reasons_select ON public.case_outcome_reasons FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND public.case_rls_can_read(case_id));

-- ---------- 4. Privileges ----------

REVOKE ALL ON public.case_outcome_reasons FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_outcome_reasons TO authenticated;

REVOKE ALL ON FUNCTION
  public.case_outcome_reason_set(uuid, uuid, text, text),
  public.bank_ws_dashboard(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.case_outcome_reason_set(uuid, uuid, text, text),
  public.bank_ws_dashboard(uuid, uuid, timestamptz)
  TO service_role;

RESET lock_timeout;
