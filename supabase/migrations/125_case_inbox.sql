-- ============================================================
-- 125_case_inbox.sql — the coordinator inbox over 122-124's cases.
-- Port of module 018c (018c_inbox.sql).
--
--  * case_inbox(actor, account, filters, now, limit = 50, after = NULL)
--    lists the cases of p_account the actor may read, one row per case,
--    every column computed at the injected clock p_now (nothing is
--    stored). The account is explicit because one login holds a profile
--    in several workspaces: the route passes the caller's active one.
--      sla_state         worst state of the case's RUNNING timers at
--                        p_now (overdue > due_soon > on_track; NULL:
--                        none runs), from the timer deadlines, never
--                        from cases.sla_state (the SLA job's last run)
--      overdue_rank      int[2]: {minutes the worst running timer is
--                        past its due_at (0: none), open overdue tasks}
--      customer_waiting  a customer_reply timer is running
--      documents_missing documents required for the case's bank and
--                        product (trimmed, case-insensitive, as 123)
--                        with no 'received' row
--      bank_query_open   stage = 'Query raised'
--      last_activity_at / last_touched_by   the last touch (the
--                        latest of stage history, reassignments, detail
--                        edits, task status log, notes, documents, bank
--                        contacts and SLA log rows; the SLA job's and
--                        the inbound pipeline's rows (role 'system') are
--                        not a touch, so the job cannot keep a case
--                        "active"); opened_at when there is none
--      open_task_overdue_count   tasks not done with due_at < p_now
--      submission_ref, contact_id, contact_name (NULL once the group's
--      contact is gone), bank_name, product, amount, opened_at,
--      closed_at   for the UI; nothing else about the contact
--      cursor            text: the keyset position after this row
--  * VISIBILITY equals case_role(case, actor) IS NOT NULL, computed
--    set-wise once per call (074: a per-row access function over
--    thousands of rows took over 300 s): case_account_role(p_account,
--    actor) once; super_admin / admin: every case of the account; team
--    lead: cases whose agent is in a team of the account they lead,
--    plus their own; agent: the cases they are agent or coordinator of.
--    No live staff role in the account (viewer, bank guest,
--    deactivated, stranger): zero rows. A NULL actor or account is
--    refused (NOT_ALLOWED), a NULL or non-finite clock (NOW_REQUIRED).
--  * FILTERS (a JSON object; any other key, a wrong type or an
--    out-of-range value is FILTER_INVALID): bank (a bank code), stage
--    (non-blank strings <= 200 chars), agent (a uuid string), priority
--    (low | normal | high | urgent), sla_state (on_track | due_soon |
--    overdue), customer_waiting, documents_missing, bank_query_open
--    (boolean: true = only where it holds, false = only where not),
--    no_activity_days (integer 1..3650: last activity before p_now - N
--    days), include_closed (boolean, default false), sort (most_overdue
--    (default) | due_soonest | stalest). Values are only ever compared
--    as parameters in fixed predicates; no SQL is built from them.
--  * ORDER (keyset, stable, case id breaks every tie):
--      most_overdue  overdue_rank desc, due_at asc (none last), id
--      due_soonest   due_at asc (none last), overdue_rank desc, id
--      stalest       last_activity_at asc, overdue_rank desc, due_at, id
--  * PAGINATION: p_limit NULL = 50, capped at 200, below 1 LIMIT_INVALID.
--    p_after is a cursor this function returned, for the same sort and
--    the same p_now, else CURSOR_INVALID.
--  * A pure read: STABLE (a write would fail), no audit row (the inbox
--    lists case records, not conversations). Only service_role executes
--    case_inbox; the helpers have no grants. The last touch is a
--    per-case LATERAL inside case_inbox, not a view (no API role could
--    read it, and a DISTINCT ON view joined to cases scans every row).
--
-- case_inbox is SECURITY DEFINER over RLS-forced tables, so, as 122,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '125 must be applied by a superuser or BYPASSRLS role (case_inbox reads RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Index ----------

-- The inbox's driving scan: one account's cases, open ones by default.
CREATE INDEX IF NOT EXISTS cases_account_closed_idx ON public.cases (account_id, closed_at);
-- The last-touch read is per case; 123 indexed this log by task only.
CREATE INDEX IF NOT EXISTS case_task_status_log_case_idx ON public.case_task_status_log (case_id, changed_at);

-- ---------- 2. Helpers (internal) ----------

-- A string filter: NULL when absent; refused unless a non-blank string
-- <= 200 chars (and in p_allowed when given).
CREATE OR REPLACE FUNCTION public.case_inbox_text_filter(p_filters jsonb, p_key text, p_allowed text[] DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v text;
BEGIN
  IF NOT (p_filters ? p_key) THEN
    RETURN NULL;
  END IF;
  v := p_filters ->> p_key;
  -- [[:space:]], not btrim(): btrim strips spaces only.
  IF jsonb_typeof(p_filters -> p_key) <> 'string' OR v ~ '^[[:space:]]*$' OR char_length(v) > 200
     OR (p_allowed IS NOT NULL AND NOT (v = ANY (p_allowed))) THEN
    RAISE EXCEPTION 'inbox filter % is not valid', p_key USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_inbox_bool_filter(p_filters jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF NOT (p_filters ? p_key) THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_filters -> p_key) <> 'boolean' THEN
    RAISE EXCEPTION 'inbox filter % must be true or false', p_key
      USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  RETURN (p_filters -> p_key)::boolean;
END;
$$;

-- The leading and third sort keys (all keys ascending; overdue_rank is
-- negated by the caller, the case id is last).
CREATE OR REPLACE FUNCTION public.case_inbox_k1(p_sort text, p_due_at timestamptz, p_last timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_sort WHEN 'due_soonest' THEN coalesce(p_due_at, 'infinity'::timestamptz)
                     WHEN 'stalest' THEN p_last
                     ELSE '-infinity'::timestamptz END
$$;

CREATE OR REPLACE FUNCTION public.case_inbox_k3(p_sort text, p_due_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_sort WHEN 'due_soonest' THEN '-infinity'::timestamptz
                     ELSE coalesce(p_due_at, 'infinity'::timestamptz) END
$$;

-- ---------- 3. The inbox ----------

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
             g.submission_ref, g.contact_id, ct.name AS contact_name, bk.name AS bank_name,
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
        JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
        LEFT JOIN public.contacts ct ON ct.id = g.contact_id AND ct.account_id = c.account_id
        LEFT JOIN public.case_banks bk ON bk.account_id = c.account_id AND bk.code = c.bank_code
       WHERE c.account_id = p_account
         AND (v_closed OR c.closed_at IS NULL)
         AND (v_all
              OR c.agent_id = p_actor
              OR c.coordinator_id = p_actor
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

COMMENT ON FUNCTION public.case_inbox(uuid, uuid, jsonb, timestamptz, int, text) IS
  'The coordinator inbox: the cases of p_account the actor may read (case_role, set-wise), filtered, sorted and keyset-paged at the injected clock. A pure read, no audit. service_role only. Migration 125.';

-- ---------- 4. Privileges ----------

REVOKE ALL ON FUNCTION
  public.case_inbox_text_filter(jsonb, text, text[]),
  public.case_inbox_bool_filter(jsonb, text),
  public.case_inbox_k1(text, timestamptz, timestamptz),
  public.case_inbox_k3(text, timestamptz),
  public.case_inbox(uuid, uuid, jsonb, timestamptz, int, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.case_inbox(uuid, uuid, jsonb, timestamptz, int, text) TO service_role;

RESET lock_timeout;
