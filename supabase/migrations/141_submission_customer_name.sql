-- ============================================================
-- 141_submission_customer_name.sql — the customer name the
-- submission tracker sends, kept per submission group.
--
-- POST /api/v1/submission-groups resolves the customer's CRM contact
-- by phone. The request's customer.name (Compass sends the company)
-- was only used when that created a new contact; when the phone
-- already matched one, the name was dropped, and every case screen
-- showed the contact's own name (often a person's WhatsApp name, or
-- blank) instead of the company. CRM contacts are deliberately not
-- renamed (a contact is shared by chats, deals and other cases), so:
--
--  * submission_groups.customer_name: the name the tracker sent as
--    customer.name, display only; NULL when none was sent. Written
--    at creation by sg_open; never changed afterwards.
--  * Backfill of existing rows from the group subject, which Compass
--    titles "<company> - <ref>" and our own default titles
--    "<name or phone> · <submission id>": the trailing " - <token>" /
--    " · <token>" (a token has no spaces) is stripped; a remainder
--    that is blank or has no letter (a phone-number default) stays
--    NULL. The guard of 115/136 refuses any UPDATE of an ENDED group,
--    so the backfill runs with that trigger disabled, inside one DO
--    block (one transaction: the trigger cannot stay disabled).
--  * sg_open gains p_customer_name (DEFAULT NULL; the 9-argument
--    signature is dropped so there is no overload, as 136 did). A
--    replayed open returns the existing row unchanged, as before.
--  * case_inbox (130) and bank_ws_cases (131) return
--    coalesce(customer_name, contacts.name) as contact_name: same
--    signatures, same columns.
--
-- The SECURITY DEFINER functions read RLS-forced tables, and the
-- backfill disables a trigger, so this must be applied by a superuser
-- (or a BYPASSRLS role that owns public.submission_groups).
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, a guarded constraint, a
-- backfill of NULLs only, CREATE OR REPLACE, DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = current_user
       AND (r.rolsuper
            OR (r.rolbypassrls
                AND pg_has_role(current_user,
                      (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.submission_groups'::regclass),
                      'MEMBER')))
  ) THEN
    RAISE EXCEPTION '141 must be applied by a superuser or a BYPASSRLS owner of public.submission_groups';
  END IF;
END $$;

-- ---------- 1. submission_groups.customer_name ----------

ALTER TABLE public.submission_groups
  ADD COLUMN IF NOT EXISTS customer_name text NULL;

-- CUSTOMER_NAME_MAX in src/lib/submission-groups/api-input.ts.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'submission_groups_customer_name_check'
       AND conrelid = 'public.submission_groups'::regclass
  ) THEN
    ALTER TABLE public.submission_groups
      ADD CONSTRAINT submission_groups_customer_name_check
      CHECK (customer_name IS NULL OR char_length(customer_name) <= 200);
  END IF;
END $$;

COMMENT ON COLUMN public.submission_groups.customer_name IS
  'The name the submission tracker sent as customer.name (Compass sends the company). Display only: shown as the case''s customer, the CRM contact keeps its own name. NULL = not sent. Migration 141.';

-- ---------- 2. Backfill from the subject ----------

DO $$ BEGIN
  ALTER TABLE public.submission_groups DISABLE TRIGGER submission_groups_guard;
  UPDATE public.submission_groups g
     SET customer_name = x.name
    FROM (
      SELECT s.id,
             CASE WHEN r.rest ~ '^[[:space:]]*$' OR r.rest !~ '[[:alpha:]]' THEN NULL
                  ELSE left(r.rest, 200) END AS name
        FROM public.submission_groups s
        CROSS JOIN LATERAL (SELECT regexp_replace(s.subject, ' (-|·) [^[:space:]]+$', '') AS rest) r
       WHERE s.customer_name IS NULL AND s.subject IS NOT NULL
    ) x
   WHERE g.id = x.id AND x.name IS NOT NULL;
  ALTER TABLE public.submission_groups ENABLE TRIGGER submission_groups_guard;
END $$;

-- ---------- 3. sg_open ----------

-- 136's sg_open plus p_customer_name. Dropped first so the 9-argument
-- signature does not survive as an overload.
DROP FUNCTION IF EXISTS public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid, text);

CREATE OR REPLACE FUNCTION public.sg_open(p_account uuid, p_submission_ref text, p_contact uuid,
  p_channel uuid, p_subject text, p_coordinator_phone text, p_access jsonb, p_key uuid,
  p_wa_mode text DEFAULT 'group', p_customer_name text DEFAULT NULL)
RETURNS TABLE (group_id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.submission_groups
    (account_id, submission_ref, contact_id, channel_id, subject, coordinator_phone, created_by_key, wa_mode,
     customer_name)
  VALUES (p_account, p_submission_ref, p_contact, p_channel, p_subject, p_coordinator_phone, p_key,
          coalesce(p_wa_mode, 'group'), p_customer_name)
  ON CONFLICT ON CONSTRAINT submission_groups_one_per_submission DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.submission_group_access (group_id, account_id, user_id, label)
    SELECT v_id, p_account, x.user_id, x.label
      FROM jsonb_to_recordset(coalesce(p_access, '[]'::jsonb)) AS x(user_id uuid, label text);
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;
  -- An existing row is returned as it stands; its mode and customer name are not changed.
  RETURN QUERY SELECT g.id, false FROM public.submission_groups g
   WHERE g.account_id = p_account AND g.submission_ref = p_submission_ref;
END;
$$;

-- sg_open as 136 grants it (re-created above with a new signature).
REVOKE ALL ON FUNCTION
  public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid, text, text)
  TO service_role;

-- ---------- 4. Case inbox: the submission's customer name ----------

-- 130's case_inbox; the one change is contact_name, now the name the
-- submission tracker sent, else the contact's (a lead has no group).
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

-- ---------- 5. Bank workspace case list ----------

-- 131's bank_ws_cases (same result type, so its grants stay); the one
-- change is contact_name, as case_inbox above.
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
          OR c.agent_id = ANY (v.team_agents))
   ORDER BY c.closed_at IS NOT NULL,
            CASE WHEN c.closed_at IS NULL THEN
              CASE c.sla_state WHEN 'overdue' THEN 0 WHEN 'due_soon' THEN 1 ELSE 2 END END,
            CASE WHEN c.closed_at IS NULL THEN nd.next_due_at END ASC NULLS LAST,
            c.closed_at DESC, c.opened_at, c.id
$$;


RESET lock_timeout;
