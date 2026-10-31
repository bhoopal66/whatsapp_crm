-- ============================================================
-- 162_bank_coordinator_case_lists.sql — the case lists and bank
-- spaces show a coordinator the cases of the banks they hold.
--
-- 161 made holding a case's bank (coordinator_banks, 133) a live
-- coordinator role in case_role, so a holder can open and act on any
-- case of that bank. But the lists never ask case_role: they filter
-- readable cases inline (agent, named coordinator, or an agent of a
-- team the caller leads), so a holder still saw none of those cases
-- in the inbox, overdue tasks, bank spaces or the bank dashboard.
-- This re-creates the latest definition of each such function
-- verbatim, adding one clause beside the named-coordinator test:
--
--   OR public.case_holds_bank(c.account_id, <actor>, c.bank_code)
--
--  * case_inbox (latest 141), case_task_overdue (123), bank_ws_cases
--    (141), bank_ws_dashboard (131), bank_ws_posts_list and
--    bank_ws_actions_list (126): the readable-case filter.
--  * bank_ws_access (126): a holder (team_lead / agent) is a 'member'
--    of that bank's space whether or not an open case exists;
--    bank_ws_list (126) lists those spaces to match.
--  * bank_ws_pin_set (126): a holder edits pins, as the named
--    coordinator of an open case of the bank does.
--
--  * bank_ws_summary (131): a holder counts among the space's members
--    as a coordinator, and their own role reads 'coordinator' (it fell
--    through to 'team_lead' before).
--
-- Apply 161 first (case_holds_bank). As 161, this must be applied by
-- a superuser or BYPASSRLS role. Same signatures and return types, so
-- the existing grants stay. Re-runnable: CREATE OR REPLACE only.
-- Asserted by supabase/ci/verify-bank-coordinator-cases.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '162 must be applied by a superuser or BYPASSRLS role (the functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Bank space membership (126) ----------

CREATE OR REPLACE FUNCTION public.bank_ws_access(p_bank_ws uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN v.role IN ('super_admin', 'admin') THEN 'admin'
           WHEN v.role IN ('team_lead', 'agent') AND EXISTS (
             SELECT 1 FROM public.cases c
              WHERE c.account_id = w.account_id AND c.bank_code = w.bank_code AND c.closed_at IS NULL
                AND (c.agent_id = p_user OR c.coordinator_id = p_user OR c.agent_id = ANY (v.team_agents)))
             THEN 'member'
           -- 162: holding the bank (161) makes a member, open case or not.
           WHEN v.role IN ('team_lead', 'agent')
                AND public.case_holds_bank(w.account_id, p_user, w.bank_code) THEN 'member'
         END
    FROM public.bank_workspaces w
   CROSS JOIN LATERAL public.bank_ws_viewer(w.account_id, p_user) v
   WHERE w.id = p_bank_ws
$$;

CREATE OR REPLACE FUNCTION public.bank_ws_list(p_actor uuid, p_account uuid)
RETURNS TABLE (bank_ws_id uuid, account_id uuid, bank_code text, bank_name text, access text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH v AS (SELECT * FROM public.bank_ws_viewer(p_account, p_actor)),
  mb AS (
    SELECT DISTINCT c.bank_code
      FROM public.cases c, v
     WHERE v.role IN ('team_lead', 'agent') AND c.account_id = p_account AND c.closed_at IS NULL
       AND c.bank_code IS NOT NULL
       AND (c.agent_id = p_actor OR c.coordinator_id = p_actor OR c.agent_id = ANY (v.team_agents))
  )
  SELECT w.id, w.account_id, w.bank_code, b.name,
         CASE WHEN v.role IN ('super_admin', 'admin') THEN 'admin' ELSE 'member' END, w.created_at
    FROM public.bank_workspaces w
    JOIN public.case_banks b ON b.account_id = w.account_id AND b.code = w.bank_code
   CROSS JOIN v
   WHERE w.account_id = p_account
     AND (v.role IN ('super_admin', 'admin') OR w.bank_code IN (SELECT mb.bank_code FROM mb)
          OR (v.role IN ('team_lead', 'agent') AND public.case_holds_bank(w.account_id, p_actor, w.bank_code)))
   ORDER BY w.bank_code, w.id
$$;

CREATE OR REPLACE FUNCTION public.bank_ws_pin_set(p_bank_ws uuid, p_actor uuid, p_kind text, p_body text,
  p_now timestamptz DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  w        public.bank_workspaces%ROWTYPE;
  v_access text;
  v_ok     boolean;
  v_id     bigint;
BEGIN
  SELECT * INTO w FROM public.bank_workspaces x WHERE x.id = p_bank_ws;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank workspace % not found', p_bank_ws USING ERRCODE = 'no_data_found', HINT = 'BANK_WS_NOT_FOUND';
  END IF;
  v_access := public.bank_ws_access(p_bank_ws, p_actor);
  v_ok := v_access = 'admin'
       OR (v_access = 'member'
           AND (public.case_account_role(w.account_id, p_actor) = 'team_lead'
                OR EXISTS (SELECT 1 FROM public.cases c
                            WHERE c.account_id = w.account_id AND c.bank_code = w.bank_code
                              AND c.closed_at IS NULL AND c.coordinator_id = p_actor)
                OR public.case_holds_bank(w.account_id, p_actor, w.bank_code)));
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'bank workspace %: % may not edit pins', p_bank_ws, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('bank_contacts', 'product_rules', 'required_documents', 'turnaround_times',
                                      'known_pitfalls') THEN
    RAISE EXCEPTION 'pin kind % is not known', p_kind USING ERRCODE = 'check_violation', HINT = 'KIND_INVALID';
  END IF;
  IF p_body IS NULL OR char_length(p_body) > 8000 THEN
    RAISE EXCEPTION 'pin text must be at most 8000 characters' USING ERRCODE = 'check_violation', HINT = 'BODY_INVALID';
  END IF;
  INSERT INTO public.bank_ws_pins (bank_ws_id, account_id, kind, body, author_id, created_at)
  VALUES (p_bank_ws, w.account_id, p_kind, p_body, p_actor, coalesce(p_now, now()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------- 2. Readable cases in the bank space (126, 131, 141) ----------

CREATE OR REPLACE FUNCTION public.bank_ws_cases(p_bank_ws uuid, p_actor uuid)
RETURNS TABLE (case_id uuid, stage text, product text, agent_id uuid, coordinator_id uuid, opened_at timestamptz,
  closed_at timestamptz, contact_id uuid, contact_name text, sla_state text, next_due_at timestamptz,
  is_lead boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.stage, c.product, c.agent_id, c.coordinator_id, c.opened_at, c.closed_at,
         c.contact_id, coalesce(g.customer_name, ct.name), c.sla_state, nd.next_due_at, c.group_id IS NULL
    FROM public.bank_workspaces w
   CROSS JOIN LATERAL public.bank_ws_viewer(w.account_id, p_actor) v
    JOIN public.cases c ON c.account_id = w.account_id AND c.bank_code = w.bank_code
    LEFT JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
    LEFT JOIN public.contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
   CROSS JOIN LATERAL (SELECT min(t.due_at) AS next_due_at FROM public.case_sla_timers t
                        WHERE t.case_id = c.id AND t.stopped_at IS NULL) nd
   WHERE w.id = p_bank_ws AND public.bank_ws_access(w.id, p_actor) IS NOT NULL
     AND v.role IS NOT NULL
     AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor OR c.coordinator_id = p_actor
          OR c.agent_id = ANY (v.team_agents)
          OR public.case_holds_bank(c.account_id, p_actor, c.bank_code))
   ORDER BY c.closed_at IS NOT NULL,
            CASE WHEN c.closed_at IS NULL THEN
              CASE c.sla_state WHEN 'overdue' THEN 0 WHEN 'due_soon' THEN 1 ELSE 2 END END,
            CASE WHEN c.closed_at IS NULL THEN nd.next_due_at END ASC NULLS LAST,
            c.closed_at DESC, c.opened_at, c.id
$$;

CREATE OR REPLACE FUNCTION public.bank_ws_posts_list(p_thread uuid, p_actor uuid)
RETURNS TABLE (post_id uuid, parent_post_id uuid, author_id uuid, body text, retracted boolean, case_id uuid,
  task_id uuid, case_readable boolean, case_stage text, case_product text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id, p.parent_post_id, p.author_id,
         CASE WHEN x.post_id IS NULL THEN p.body END, x.post_id IS NOT NULL,
         p.case_id, p.task_id, coalesce(rd.readable, false),
         CASE WHEN rd.readable THEN c.stage END, CASE WHEN rd.readable THEN c.product END, p.created_at
    FROM public.bank_ws_threads t
   CROSS JOIN LATERAL public.bank_ws_viewer(t.account_id, p_actor) v
    JOIN public.bank_ws_posts p ON p.thread_id = t.id
    LEFT JOIN public.bank_ws_post_retractions x ON x.post_id = p.id
    LEFT JOIN public.cases c ON c.id = p.case_id AND c.account_id = p.account_id
    LEFT JOIN LATERAL (SELECT v.role IS NOT NULL
                              AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor
                                   OR c.coordinator_id = p_actor OR c.agent_id = ANY (v.team_agents)
                                   OR public.case_holds_bank(c.account_id, p_actor, c.bank_code)) AS readable
                      ) rd ON c.id IS NOT NULL
   WHERE t.id = p_thread AND public.bank_ws_access(t.bank_ws_id, p_actor) IS NOT NULL
   ORDER BY p.created_at, p.id
$$;

CREATE OR REPLACE FUNCTION public.bank_ws_actions_list(p_bank_ws uuid, p_actor uuid)
RETURNS TABLE (action_id uuid, thread_id uuid, owner_id uuid, due_at timestamptz, case_id uuid, task_id uuid,
  task_status text, created_by uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, a.thread_id, a.owner_id, a.due_at, a.case_id, a.task_id,
         CASE WHEN v.role IS NOT NULL
                   AND (v.role IN ('super_admin', 'admin') OR c.agent_id = p_actor
                        OR c.coordinator_id = p_actor OR c.agent_id = ANY (v.team_agents)
                        OR public.case_holds_bank(c.account_id, p_actor, c.bank_code))
              THEN k.status END,
         a.created_by, a.created_at
    FROM public.bank_workspaces w
   CROSS JOIN LATERAL public.bank_ws_viewer(w.account_id, p_actor) v
    JOIN public.bank_ws_actions a ON a.bank_ws_id = w.id
    LEFT JOIN public.cases c ON c.id = a.case_id AND c.account_id = a.account_id
    LEFT JOIN public.case_tasks k ON k.id = a.task_id AND k.account_id = a.account_id
   WHERE w.id = p_bank_ws AND public.bank_ws_access(w.id, p_actor) IS NOT NULL
   ORDER BY a.due_at, a.id
$$;

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
            OR c.agent_id = ANY (v.team_agents)
            OR public.case_holds_bank(c.account_id, p_actor, c.bank_code))
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

-- ---------- 3. Case inbox (141) and overdue tasks (123) ----------

CREATE OR REPLACE FUNCTION public.case_inbox(p_actor uuid, p_account uuid, p_filters jsonb, p_now timestamptz,
  p_limit int DEFAULT 50, p_after text DEFAULT NULL)
RETURNS TABLE (case_id uuid, bank_code text, stage text, agent_id uuid, coordinator_id uuid, priority text,
  due_at timestamptz, sla_state text, overdue_rank integer[], customer_waiting boolean, documents_missing integer,
  bank_query_open boolean, last_activity_at timestamptz, last_touched_by uuid, open_task_overdue_count integer,
  submission_ref text, contact_id uuid, contact_name text, bank_name text, product text, amount numeric,
  opened_at timestamptz, closed_at timestamptz, cursor text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_filters     jsonb := coalesce(p_filters, '{}'::jsonb);
  v_role        text;
  v_all         boolean;
  v_team_agents uuid[] := '{}';
  v_key         text;
  v_bank        text;
  v_stage       text;
  v_agent_txt   text;
  v_agent       uuid;
  v_priority    text;
  v_sla         text;
  v_waiting     boolean;
  v_docs        boolean;
  v_query       boolean;
  v_closed      boolean;
  v_sort        text;
  v_days        numeric;
  v_idle_before timestamptz;
  v_limit       integer;
  v_after       jsonb;
  a_k1          timestamptz;
  a_k2          integer[];
  a_k3          timestamptz;
  a_id          uuid;
BEGIN
  IF p_actor IS NULL OR p_account IS NULL THEN
    RAISE EXCEPTION 'case_inbox: no actor or account' USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'case_inbox needs a finite clock' USING ERRCODE = 'invalid_parameter_value', HINT = 'NOW_REQUIRED';
  END IF;
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'case_inbox: limit % is below 1', p_limit
      USING ERRCODE = 'invalid_parameter_value', HINT = 'LIMIT_INVALID';
  END IF;
  v_limit := least(coalesce(p_limit, 50), 200);

  -- filters: a fixed allowlist of keys, each type-checked
  IF jsonb_typeof(v_filters) <> 'object' THEN
    RAISE EXCEPTION 'inbox filters must be an object' USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  SELECT k INTO v_key FROM jsonb_object_keys(v_filters) k
   WHERE k <> ALL (ARRAY['bank', 'stage', 'agent', 'priority', 'sla_state', 'customer_waiting', 'documents_missing',
                         'bank_query_open', 'no_activity_days', 'include_closed', 'sort'])
   LIMIT 1;
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'inbox filter % is not a filter', left(v_key, 64)
      USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  v_bank      := public.case_inbox_text_filter(v_filters, 'bank');
  v_stage     := public.case_inbox_text_filter(v_filters, 'stage');
  v_agent_txt := public.case_inbox_text_filter(v_filters, 'agent');
  IF v_agent_txt IS NOT NULL THEN
    IF v_agent_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'inbox filter agent must be a uuid' USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
    END IF;
    v_agent := v_agent_txt::uuid;
  END IF;
  v_priority := public.case_inbox_text_filter(v_filters, 'priority', ARRAY['low', 'normal', 'high', 'urgent']);
  v_sla      := public.case_inbox_text_filter(v_filters, 'sla_state', ARRAY['on_track', 'due_soon', 'overdue']);
  v_sort     := coalesce(public.case_inbox_text_filter(v_filters, 'sort', ARRAY['most_overdue', 'due_soonest', 'stalest']),
                         'most_overdue');
  v_waiting  := public.case_inbox_bool_filter(v_filters, 'customer_waiting');
  v_docs     := public.case_inbox_bool_filter(v_filters, 'documents_missing');
  v_query    := public.case_inbox_bool_filter(v_filters, 'bank_query_open');
  v_closed   := coalesce(public.case_inbox_bool_filter(v_filters, 'include_closed'), false);
  IF v_filters ? 'no_activity_days' THEN
    IF jsonb_typeof(v_filters -> 'no_activity_days') <> 'number' THEN
      RAISE EXCEPTION 'inbox filter no_activity_days must be a number'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
    END IF;
    v_days := (v_filters -> 'no_activity_days')::numeric;
    IF v_days <> trunc(v_days) OR v_days < 1 OR v_days > 3650 THEN
      RAISE EXCEPTION 'inbox filter no_activity_days must be a whole number of days 1..3650'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
    END IF;
    v_idle_before := p_now - make_interval(days => v_days::integer);
  END IF;

  -- cursor: JSON text with exactly the keys this function emits, the
  -- same sort and the same clock
  IF p_after IS NOT NULL THEN
    BEGIN
      v_after := p_after::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'inbox cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END;
    IF jsonb_typeof(v_after) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_after) k)
          IS DISTINCT FROM ARRAY['case_id', 'due_at', 'last_activity_at', 'now', 'overdue_rank', 'sort']
       OR jsonb_typeof(v_after -> 'sort') <> 'string' OR v_after ->> 'sort' <> v_sort
       OR jsonb_typeof(v_after -> 'now') <> 'string'
       OR jsonb_typeof(v_after -> 'case_id') <> 'string'
       OR jsonb_typeof(v_after -> 'last_activity_at') <> 'string'
       OR jsonb_typeof(v_after -> 'due_at') NOT IN ('string', 'null')
       OR jsonb_typeof(v_after -> 'overdue_rank') <> 'array' OR jsonb_array_length(v_after -> 'overdue_rank') <> 2
       OR jsonb_typeof(v_after -> 'overdue_rank' -> 0) <> 'number'
       OR jsonb_typeof(v_after -> 'overdue_rank' -> 1) <> 'number' THEN
      RAISE EXCEPTION 'inbox cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END IF;
    BEGIN
      IF (v_after ->> 'now')::timestamptz <> p_now THEN
        RAISE EXCEPTION 'clock';
      END IF;
      a_id := (v_after ->> 'case_id')::uuid;
      a_k1 := public.case_inbox_k1(v_sort, (v_after ->> 'due_at')::timestamptz, (v_after ->> 'last_activity_at')::timestamptz);
      a_k2 := ARRAY[-((v_after -> 'overdue_rank' ->> 0)::integer), -((v_after -> 'overdue_rank' ->> 1)::integer)];
      a_k3 := public.case_inbox_k3(v_sort, (v_after ->> 'due_at')::timestamptz);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'inbox cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END;
  END IF;

  -- visibility, once per call; mirrors case_role (122) exactly: a live,
  -- non-guest owner / admin / team_leader / agent profile in p_account
  v_role := public.case_account_role(p_account, p_actor);
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  v_all := v_role IN ('super_admin', 'admin');
  IF v_role = 'team_lead' THEN
    SELECT coalesce(array_agg(DISTINCT m.user_id), '{}') INTO v_team_agents
      FROM public.teams t
      JOIN public.team_members m ON m.team_id = t.id
     WHERE t.account_id = p_account AND m.account_id = p_account AND t.leader_user_id = p_actor;
  END IF;

  RETURN QUERY
    WITH base AS (
      SELECT c.id AS case_id, c.bank_code, c.stage, c.agent_id, c.coordinator_id, c.priority, c.due_at,
             s.sla_state, ARRAY[s.sla_overdue_minutes, t.n] AS overdue_rank, s.customer_waiting,
             d.n AS documents_missing, c.stage = 'Query raised' AS bank_query_open,
             coalesce(lt.last_activity_at, c.opened_at) AS last_activity_at, lt.last_touched_by,
             t.n AS open_task_overdue_count,
             g.submission_ref, c.contact_id, coalesce(g.customer_name, ct.name) AS contact_name, bk.name AS bank_name,
             c.product, c.amount, c.opened_at, c.closed_at
        FROM public.cases c
        CROSS JOIN LATERAL (
          SELECT CASE max(CASE public.case_sla_state_at(x.due_soon_at, x.due_at, p_now)
                            WHEN 'overdue' THEN 3 WHEN 'due_soon' THEN 2 ELSE 1 END)
                   WHEN 3 THEN 'overdue' WHEN 2 THEN 'due_soon' WHEN 1 THEN 'on_track' END AS sla_state,
                 coalesce(max(floor(extract(epoch FROM (p_now - x.due_at)) / 60)) FILTER (WHERE p_now >= x.due_at), 0)::integer
                   AS sla_overdue_minutes,
                 coalesce(bool_or(x.timer = 'customer_reply'), false) AS customer_waiting
            FROM public.case_sla_timers x
           WHERE x.case_id = c.id AND x.stopped_at IS NULL) s
        CROSS JOIN LATERAL (
          SELECT count(*)::integer AS n FROM public.case_tasks k
           WHERE k.case_id = c.id AND k.status <> 'done' AND k.due_at IS NOT NULL AND k.due_at < p_now) t
        CROSS JOIN LATERAL (
          SELECT count(*)::integer AS n FROM public.case_doc_requirements r
           WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
             AND lower(btrim(r.product)) = lower(btrim(c.product))
             AND NOT EXISTS (SELECT 1 FROM public.case_documents y
                              WHERE y.case_id = c.id AND y.doc_key = r.doc_key AND y.status = 'received')) d
        -- last touch: the latest activity row of this case (ties: the
        -- later source in this list, then the larger ref). Each branch is
        -- filtered on the case, so each reads only that case's rows (a
        -- DISTINCT ON view joined to cases scanned every case's rows).
        LEFT JOIN LATERAL (
          SELECT e.at AS last_activity_at, e.actor AS last_touched_by
            FROM (
              SELECT h.changed_at AS at, h.actor_id AS actor, 1 AS src, lpad(h.id::text, 20, '0') AS ref
                FROM public.case_stage_history h WHERE h.case_id = c.id
              UNION ALL
              SELECT r2.changed_at, r2.actor_id, 2, lpad(r2.id::text, 20, '0')
                FROM public.case_reassign_history r2 WHERE r2.case_id = c.id
              UNION ALL
              SELECT d2.changed_at, d2.actor_id, 3, lpad(d2.id::text, 20, '0')
                FROM public.case_detail_log d2 WHERE d2.case_id = c.id
              UNION ALL
              SELECT l.changed_at, l.actor_id, 4, lpad(l.id::text, 20, '0')
                FROM public.case_task_status_log l WHERE l.case_id = c.id
              UNION ALL
              SELECT n.created_at, n.author_id, 5, n.id::text FROM public.case_notes n WHERE n.case_id = c.id
              UNION ALL
              SELECT o.updated_at, o.updated_by, 6, o.doc_key FROM public.case_documents o WHERE o.case_id = c.id
              UNION ALL
              SELECT b2.created_at, b2.author_id, 7, b2.id::text FROM public.case_bank_contacts b2 WHERE b2.case_id = c.id
              UNION ALL
              -- the SLA job's and the inbound pipeline's rows are not a touch
              SELECT s2.changed_at, s2.actor_id, 8, lpad(s2.id::text, 20, '0')
                FROM public.case_sla_state_log s2 WHERE s2.case_id = c.id AND s2.actor_role <> 'system'
            ) e
           ORDER BY e.at DESC, e.src DESC, e.ref DESC
           LIMIT 1) lt ON true
        -- 130: LEFT JOIN, a lead has no group
        LEFT JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
        LEFT JOIN public.contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
        LEFT JOIN public.case_banks bk ON bk.account_id = c.account_id AND bk.code = c.bank_code
       WHERE c.account_id = p_account
         AND (v_closed OR c.closed_at IS NULL)
         AND (v_all
              OR c.agent_id = p_actor
              OR c.coordinator_id = p_actor
              OR public.case_holds_bank(c.account_id, p_actor, c.bank_code)
              OR c.agent_id = ANY (v_team_agents))
    ), keyed AS (
      SELECT b.*,
             public.case_inbox_k1(v_sort, b.due_at, b.last_activity_at) AS k1,
             ARRAY[-b.overdue_rank[1], -b.overdue_rank[2]] AS k2,
             public.case_inbox_k3(v_sort, b.due_at) AS k3
        FROM base b
       WHERE (v_bank IS NULL OR b.bank_code = v_bank)
         AND (v_stage IS NULL OR b.stage = v_stage)
         AND (v_agent IS NULL OR b.agent_id = v_agent)
         AND (v_priority IS NULL OR b.priority = v_priority)
         AND (v_sla IS NULL OR b.sla_state = v_sla)
         AND (v_waiting IS NULL OR b.customer_waiting = v_waiting)
         AND (v_docs IS NULL OR (b.documents_missing > 0) = v_docs)
         AND (v_query IS NULL OR b.bank_query_open = v_query)
         AND (v_idle_before IS NULL OR b.last_activity_at < v_idle_before)
    )
    SELECT k.case_id, k.bank_code, k.stage, k.agent_id, k.coordinator_id, k.priority, k.due_at, k.sla_state,
           k.overdue_rank, k.customer_waiting, k.documents_missing, k.bank_query_open, k.last_activity_at,
           k.last_touched_by, k.open_task_overdue_count, k.submission_ref, k.contact_id, k.contact_name, k.bank_name,
           k.product, k.amount, k.opened_at, k.closed_at,
           jsonb_build_object('sort', v_sort, 'now', p_now, 'case_id', k.case_id, 'overdue_rank', to_jsonb(k.overdue_rank),
                              'due_at', k.due_at, 'last_activity_at', k.last_activity_at)::text
      FROM keyed k
     WHERE p_after IS NULL OR (k.k1, k.k2, k.k3, k.case_id) > (a_k1, a_k2, a_k3, a_id)
     ORDER BY k.k1, k.k2, k.k3, k.case_id
     LIMIT v_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_task_overdue(p_actor uuid, p_account uuid, p_now timestamptz)
RETURNS TABLE (task_id uuid, case_id uuid, title text, owner_id uuid, due_at timestamptz, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role        text;
  v_team_agents uuid[] := '{}';
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'case_task_overdue needs the clock' USING ERRCODE = 'null_value_not_allowed', HINT = 'NOW_REQUIRED';
  END IF;
  v_role := public.case_account_role(p_account, p_actor);
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  IF v_role = 'team_lead' THEN
    SELECT coalesce(array_agg(DISTINCT m.user_id), '{}') INTO v_team_agents
      FROM public.teams t
      JOIN public.team_members m ON m.team_id = t.id
     WHERE t.account_id = p_account AND m.account_id = p_account AND t.leader_user_id = p_actor;
  END IF;
  RETURN QUERY
    SELECT t.id, t.case_id, t.title, t.owner_id, t.due_at, t.status
      FROM public.case_tasks t
      JOIN public.cases c ON c.id = t.case_id AND c.account_id = t.account_id
     WHERE t.account_id = p_account
       AND t.status <> 'done' AND t.due_at IS NOT NULL AND t.due_at < p_now
       AND (v_role IN ('super_admin', 'admin') OR c.agent_id = p_actor OR c.coordinator_id = p_actor
            OR c.agent_id = ANY (v_team_agents)
            OR public.case_holds_bank(c.account_id, p_actor, c.bank_code))
     ORDER BY t.due_at, t.id;
END;
$$;

-- ---------- Summary (131) ----------

-- 131's body; a bank holder joins the member candidates and, after the
-- named coordinator, the named agent and a leader of an open case's
-- agent, reads 'coordinator'.
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
    -- Who may hold 'member' access: an open case's agent, its
    -- coordinator, the leaders of the agent's teams (126), and the
    -- bank's coordinators (162; bank_ws_access checks they are live).
    SELECT oc.coordinator_id AS user_id FROM oc WHERE oc.coordinator_id IS NOT NULL
    UNION SELECT oc.agent_id FROM oc WHERE oc.agent_id IS NOT NULL
    UNION SELECT t.leader_user_id
            FROM oc JOIN ws ON true
            JOIN public.team_members m ON m.user_id = oc.agent_id AND m.account_id = ws.account_id
            JOIN public.teams t ON t.id = m.team_id AND t.account_id = ws.account_id
           WHERE t.leader_user_id IS NOT NULL
    UNION SELECT b.user_id
            FROM ws JOIN public.coordinator_banks b
              ON b.account_id = ws.account_id AND b.bank_code = ws.bank_code
  ), roles AS (
    SELECT p.user_id,
           CASE WHEN EXISTS (SELECT 1 FROM oc WHERE oc.coordinator_id = p.user_id) THEN 'coordinator'
                WHEN EXISTS (SELECT 1 FROM oc WHERE oc.agent_id = p.user_id) THEN 'agent'
                WHEN EXISTS (SELECT 1 FROM oc JOIN ws ON true
                               JOIN public.team_members m ON m.user_id = oc.agent_id AND m.account_id = ws.account_id
                               JOIN public.teams t ON t.id = m.team_id AND t.account_id = ws.account_id
                              WHERE t.leader_user_id = p.user_id) THEN 'team_lead'
                WHEN EXISTS (SELECT 1 FROM ws WHERE public.case_holds_bank(ws.account_id, p.user_id, ws.bank_code))
                  THEN 'coordinator'
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

RESET lock_timeout;
