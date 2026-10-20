-- ============================================================
-- 131_bank_dashboard_leads.sql — the bank dashboard and bank workspace
-- screens after case leads (130). Port of module 018c_dash2 (SPEC_018c
-- v3, owner decisions 20 Oct) plus the bank-workspace walkthrough gaps.
-- Replaces bank_ws_dashboard (127) and bank_ws_cases (126); adds
-- bank_ws_summary.
--
--  * DASHBOARD: bank_ws_dashboard(p_actor, p_bank_ws, p_now), same
--    signature, access, scope, refusals and keys as 127; "open" means
--    not at a final stage (closed_at IS NULL, 122's cases_closed_check).
--    New keys:
--      pre_submission  open cases at a pre-submission stage
--                      (case_stage_is_presub).
--      with_bank       open cases past pre-submission.
--      pipeline        { accounts, financing_cases, financing_amount }
--                      over open cases, pre-submission included: account
--                      opening is a COUNT (amount NULL or 0), financing an
--                      AMOUNT (amount > 0); financing_amount is their AED
--                      sum as a decimal string ('0.00' when none).
--      conversion      { leads, submitted, rate }: leads = readable cases
--                      whose history ever reached Interested (a Withdrawn
--                      lead stays counted; a case opened directly from a
--                      submission never was a lead); submitted = of those,
--                      the ones whose history reached the (account, bank)
--                      submission stage (case_submitted_stage); rate =
--                      submitted / leads to 4 decimals, NULL with no leads.
--    amount_in_pipeline stays and equals pipeline.financing_amount.
--    cases_by_stage and avg_days_per_stage cover the pre-submission
--    stages through the same code; final stages stay out of avg_days.
--    Every figure is over the actor's readable cases only, so another
--    agent's lead never changes an agent's figures.
--  * bank_ws_cases(p_bank_ws, p_actor): access rule unchanged (nothing
--    without bank_ws_access); new columns contact_id, contact_name
--    (contacts.name), sla_state (cases.sla_state), next_due_at (earliest
--    due_at of the case's running SLA timers), is_lead (no group). Order:
--    open cases first, overdue before due_soon before the rest, then
--    next_due_at (NULLs last); then closed cases, latest closed first.
--  * bank_ws_summary(p_bank_ws, p_actor) -> jsonb, NULL without access
--    (as bank_ws_cases, no oracle for which ids exist):
--      open_cases    open cases of the bank the actor may read.
--      members       { agents, coordinators, team_leads, total }: the
--                    distinct people whose bank_ws_access is 'member'
--                    (126: through open cases of the bank), each once,
--                    by the first of coordinator of an open case, agent
--                    of an open case, else team lead. Counts only.
--      open_actions  the workspace's bank_ws_actions not done: an
--                    unlinked action (no task, nothing closes it) or one
--                    whose case task is not 'done'.
--      my_role       'admin' for owner / admin access, else the actor's
--                    role by the same precedence.
--
-- Who: SECURITY DEFINER, search_path '', executed by service_role only,
-- p_actor = the signed-in user. As 122, this must be applied by a
-- superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE OR REPLACE, DROP FUNCTION IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '131 must be applied by a superuser or BYPASSRLS role (the functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Dashboard ----------

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
  v_sub text;
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
  v_sub := public.case_submitted_stage(w.account_id, w.bank_code);

  WITH bc AS (
    SELECT c.id, c.stage, c.outcome, c.amount,
           c.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed') AS open,
           public.case_stage_is_presub(c.stage) AS pre
      FROM public.cases c
     WHERE c.account_id = w.account_id AND c.bank_code = w.bank_code
       AND v.role IS NOT NULL
       AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor OR c.coordinator_id = p_actor
            OR c.agent_id = ANY (v.team_agents))
  ), spans AS (
    SELECT h.to_stage AS stage,
           coalesce(lead(h.changed_at) OVER (PARTITION BY h.case_id ORDER BY h.changed_at, h.id),
                    CASE WHEN bc.open THEN p_now END)
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
  ), pl AS (
    SELECT count(*) FILTER (WHERE bc.open AND bc.pre) AS pre_submission,
           count(*) FILTER (WHERE bc.open AND NOT bc.pre) AS with_bank,
           count(*) FILTER (WHERE bc.open AND coalesce(bc.amount, 0) = 0) AS accounts,
           count(*) FILTER (WHERE bc.open AND bc.amount > 0) AS financing_cases,
           (coalesce(sum(bc.amount) FILTER (WHERE bc.open AND bc.amount > 0), 0))::numeric(18, 2)::text AS financing_amount
      FROM bc
  ), cv AS (
    SELECT count(*) AS leads,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.case_stage_history h
                                           WHERE h.case_id = l.id AND h.to_stage = v_sub)) AS submitted
      FROM bc l
     WHERE EXISTS (SELECT 1 FROM public.case_stage_history h WHERE h.case_id = l.id AND h.to_stage = 'Interested')
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
    'pre_submission', (SELECT pl.pre_submission FROM pl),
    'with_bank', (SELECT pl.with_bank FROM pl),
    'pipeline', (SELECT jsonb_build_object('accounts', pl.accounts, 'financing_cases', pl.financing_cases,
        'financing_amount', pl.financing_amount) FROM pl),
    'conversion', (SELECT jsonb_build_object('leads', cv.leads, 'submitted', cv.submitted,
        'rate', CASE WHEN cv.leads > 0 THEN round(cv.submitted::numeric / cv.leads, 4) END) FROM cv),
    'amount_in_pipeline', (SELECT pl.financing_amount FROM pl)
  ) INTO v_out;
  RETURN v_out;
END;
$$;

-- ---------- 2. Cases list ----------

-- The result type changes, so the 126 function is dropped first.
DROP FUNCTION IF EXISTS public.bank_ws_cases(uuid, uuid);
CREATE FUNCTION public.bank_ws_cases(p_bank_ws uuid, p_actor uuid)
RETURNS TABLE (case_id uuid, stage text, product text, agent_id uuid, coordinator_id uuid, opened_at timestamptz,
  closed_at timestamptz, contact_id uuid, contact_name text, sla_state text, next_due_at timestamptz,
  is_lead boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.stage, c.product, c.agent_id, c.coordinator_id, c.opened_at, c.closed_at,
         c.contact_id, ct.name, c.sla_state, nd.next_due_at, c.group_id IS NULL
    FROM public.bank_workspaces w
   CROSS JOIN LATERAL public.bank_ws_viewer(w.account_id, p_actor) v
    JOIN public.cases c ON c.account_id = w.account_id AND c.bank_code = w.bank_code
    LEFT JOIN public.contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
   CROSS JOIN LATERAL (SELECT min(t.due_at) AS next_due_at FROM public.case_sla_timers t
                        WHERE t.case_id = c.id AND t.stopped_at IS NULL) nd
   WHERE w.id = p_bank_ws AND public.bank_ws_access(w.id, p_actor) IS NOT NULL
     AND v.role IS NOT NULL
     AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor OR c.coordinator_id = p_actor
          OR c.agent_id = ANY (v.team_agents))
   ORDER BY c.closed_at IS NOT NULL,
            CASE WHEN c.closed_at IS NULL THEN
              CASE c.sla_state WHEN 'overdue' THEN 0 WHEN 'due_soon' THEN 1 ELSE 2 END END,
            CASE WHEN c.closed_at IS NULL THEN nd.next_due_at END ASC NULLS LAST,
            c.closed_at DESC, c.opened_at, c.id
$$;

-- ---------- 3. Summary ----------

CREATE OR REPLACE FUNCTION public.bank_ws_summary(p_bank_ws uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ws AS (
    SELECT w.id, w.account_id, w.bank_code, public.bank_ws_access(w.id, p_actor) AS access
      FROM public.bank_workspaces w
     WHERE w.id = p_bank_ws AND p_actor IS NOT NULL
  ), oc AS (
    SELECT c.id, c.agent_id, c.coordinator_id
      FROM ws JOIN public.cases c ON c.account_id = ws.account_id AND c.bank_code = ws.bank_code
     WHERE c.closed_at IS NULL
  ), cand AS (
    -- Who may hold 'member' access through an open case: its agent, its
    -- coordinator, and the leaders of the agent's teams (126).
    SELECT oc.coordinator_id AS user_id FROM oc WHERE oc.coordinator_id IS NOT NULL
    UNION SELECT oc.agent_id FROM oc WHERE oc.agent_id IS NOT NULL
    UNION SELECT t.leader_user_id
            FROM oc JOIN ws ON true
            JOIN public.team_members m ON m.user_id = oc.agent_id AND m.account_id = ws.account_id
            JOIN public.teams t ON t.id = m.team_id AND t.account_id = ws.account_id
           WHERE t.leader_user_id IS NOT NULL
  ), roles AS (
    SELECT p.user_id,
           CASE WHEN EXISTS (SELECT 1 FROM oc WHERE oc.coordinator_id = p.user_id) THEN 'coordinator'
                WHEN EXISTS (SELECT 1 FROM oc WHERE oc.agent_id = p.user_id) THEN 'agent'
                ELSE 'team_lead' END AS role
      FROM (SELECT cand.user_id FROM cand UNION SELECT p_actor) p
  ), mem AS (
    SELECT r.role FROM roles r JOIN ws ON true
     WHERE r.user_id IN (SELECT cand.user_id FROM cand)
       AND public.bank_ws_access(ws.id, r.user_id) = 'member'
  )
  SELECT jsonb_build_object(
    'open_cases', (SELECT count(*) FROM public.bank_ws_cases(ws.id, p_actor) x WHERE x.closed_at IS NULL),
    'members', (SELECT jsonb_build_object(
        'agents', count(*) FILTER (WHERE mem.role = 'agent'),
        'coordinators', count(*) FILTER (WHERE mem.role = 'coordinator'),
        'team_leads', count(*) FILTER (WHERE mem.role = 'team_lead'),
        'total', count(*)) FROM mem),
    'open_actions', (SELECT count(*) FROM public.bank_ws_actions a
                      LEFT JOIN public.case_tasks k ON k.id = a.task_id AND k.account_id = a.account_id
                     WHERE a.bank_ws_id = ws.id AND (a.task_id IS NULL OR k.status IS DISTINCT FROM 'done')),
    'my_role', CASE WHEN ws.access = 'admin' THEN 'admin'
                    ELSE (SELECT r.role FROM roles r WHERE r.user_id = p_actor) END)
    FROM ws
   WHERE ws.access IS NOT NULL
$$;

-- ---------- 4. Privileges ----------

REVOKE ALL ON FUNCTION
  public.bank_ws_dashboard(uuid, uuid, timestamptz),
  public.bank_ws_cases(uuid, uuid),
  public.bank_ws_summary(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.bank_ws_dashboard(uuid, uuid, timestamptz),
  public.bank_ws_cases(uuid, uuid),
  public.bank_ws_summary(uuid, uuid)
  TO service_role;

RESET lock_timeout;
