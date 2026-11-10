-- ============================================================
-- 185_case_views_snooze_mentions.sql — saved inbox views, snooze and
-- the mentions inbox for the coordinator Cases inbox (125 / 162).
-- Port of module 020c part 1 (020c_views.sql). The package's IT role
-- does not exist here; its workspace is the account, its users are
-- profiles, its super_admin is the owner.
--
-- Nothing changes until someone acts: the default inbox lists exactly
-- what 162's did (a case leaves it only while someone has snoozed it),
-- and nothing here sends anything to anyone.
--
--  * case_inbox_validate_filters(filters): THE inbox filter validator,
--    run by case_inbox and case_view_save, so a stored view can never
--    hold a filter the inbox refuses. Keys: 125's (bank, stage, agent,
--    priority, sla_state, customer_waiting, documents_missing,
--    bank_query_open, no_activity_days, include_closed) plus snoozed
--    (hide | only | all), snooze_expired and mentioned_me (booleans).
--    `sort` is NOT a filter here: case_inbox still takes it inside its
--    filters object (unchanged) and validates it itself; a saved view
--    keeps it in its own column. Unknown key, wrong type, out-of-range
--    value: FILTER_INVALID.
--
--  * SAVED VIEWS: case_saved_views, one row per named view (name 1..60
--    characters, not blank; filters a validated object; sort NULL = the
--    inbox default, else most_overdue | due_soonest | stalest). The
--    workspace is the actor's ACTIVE live profile (151's rule); the
--    actor must hold a case role there (case_account_role: owner,
--    admin, team leader, agent; viewers and bank guests: NOT_ALLOWED).
--      case_view_list(actor)    own views + shared views of the
--                               workspace; shared first, then name
--      case_view_save(actor, view_id, name, filters, sort, shared)
--                               view_id NULL creates; else replaces the
--                               actor's OWN view; shared = true needs
--                               owner/admin (also on an update)
--      case_view_delete(actor, view_id)   the owner, or an owner/admin
--                               of the workspace for ANY of its views
--    Another person's private view and any other workspace's view are
--    VIEW_NOT_FOUND, never NOT_ALLOWED (no existence oracle). Refusals:
--    NOT_ALLOWED, NAME_INVALID, FILTER_INVALID, VIEW_NOT_FOUND.
--    RLS (forced): authenticated reads its own views and the shared
--    views of its active account; nobody writes the table directly.
--
--  * SNOOZE: cases.snoozed_until (NULL: not snoozed) and the
--    append-only case_snooze_log (snoozed_until NULL = an unsnooze).
--      case_snooze(actor, case, until, reason, now)
--      case_unsnooze(actor, case, now)
--    Who: case_role (161) coordinator (the named one or a holder of
--    the case's bank), team_lead, admin, super_admin; an agent or
--    anyone else NOT_ALLOWED. Unknown case CASE_NOT_FOUND, closed case
--    CASE_CLOSED; until in (now, now + 30 days] and reason <= 200
--    characters, else SNOOZE_INVALID; an unsnooze needs a snooze still
--    running (SNOOZE_INVALID). SLA-NEUTRAL: no timer is paused, stopped,
--    moved or logged, and a snooze is not a touch (last activity).
--    No scheduler: a snooze simply ends when its time passes.
--
--  * MENTIONS: case_mentions(actor, now, limit = 50, after = NULL):
--    the notes of the actor's active workspace that mention the actor,
--    on cases case_can_read lets them read now, created at or before
--    now; newest first (created_at desc, note id desc), keyset-paged by
--    a text cursor bound to the clock. Refusals: NOT_ALLOWED (NULL
--    actor), NOW_REQUIRED, LIMIT_INVALID (limit 1..200, NULL = 50,
--    capped at 200), CURSOR_INVALID.
--
--  * case_inbox (162's body, otherwise byte-for-byte): two new result
--    columns appended after cursor, snoozed_until and snooze_expired
--    (the snooze ended at or before now and less than 24 hours before
--    it); three new filters, snoozed (default 'hide': leave out cases
--    with snoozed_until > now; 'only'; 'all'), snooze_expired and
--    mentioned_me (a note created at or before now mentions the actor).
--    And a fix: a system-authored note (179, author_id NULL) is not a
--    touch, as 162 already leaves out the SLA job's rows.
--    The result type changes, so case_inbox is dropped and created
--    (same arguments, same grant: service_role only).
--
-- Every function is SECURITY DEFINER over RLS-forced tables, so, as
-- 125 and 162, this must be applied by a superuser or BYPASSRLS role.
-- Only service_role executes them. Re-runnable: IF NOT EXISTS guards,
-- CREATE OR REPLACE, and a DROP IF EXISTS before case_inbox.
-- Asserted by supabase/ci/verify-case-views.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '185 must be applied by a superuser or BYPASSRLS role (the functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS snoozed_until timestamptz NULL;

COMMENT ON COLUMN public.cases.snoozed_until IS
  'The case is out of the default inbox until then (NULL: not snoozed). Written only by case_snooze / case_unsnooze. Migration 185.';

CREATE TABLE IF NOT EXISTS public.case_snooze_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id       uuid NOT NULL,
  account_id    uuid NOT NULL,
  actor_id      uuid NOT NULL,
  actor_role    text NOT NULL,
  snoozed_until timestamptz NULL,  -- NULL: an unsnooze
  reason        text NULL,
  at            timestamptz NOT NULL,
  CONSTRAINT case_snooze_log_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_snooze_log_role_check
    CHECK (actor_role IN ('super_admin', 'admin', 'team_lead', 'coordinator')),
  CONSTRAINT case_snooze_log_reason_check CHECK (reason IS NULL OR char_length(reason) <= 200)
);
CREATE INDEX IF NOT EXISTS case_snooze_log_case_idx ON public.case_snooze_log (case_id, at);

CREATE TABLE IF NOT EXISTS public.case_saved_views (
  view_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id),
  owner_user_id uuid NOT NULL,
  name          text NOT NULL,
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort          text NULL,
  shared        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- [[:space:]], not btrim(): btrim strips spaces only.
  CONSTRAINT case_saved_views_name_check CHECK (name !~ '^[[:space:]]*$' AND char_length(name) <= 60),
  CONSTRAINT case_saved_views_filters_check CHECK (jsonb_typeof(filters) = 'object'),
  CONSTRAINT case_saved_views_sort_check
    CHECK (sort IS NULL OR sort IN ('most_overdue', 'due_soonest', 'stalest'))
);
CREATE INDEX IF NOT EXISTS case_saved_views_owner_idx ON public.case_saved_views (account_id, owner_user_id);
CREATE INDEX IF NOT EXISTS case_saved_views_shared_idx ON public.case_saved_views (account_id) WHERE shared;

-- mentioned_me and case_mentions read a person's mentions in one account.
CREATE INDEX IF NOT EXISTS case_note_mentions_user_case_idx ON public.case_note_mentions (user_id, case_id);

-- ---------- 2. Integrity (every writer; case_append_only is 122's) ----------

DROP TRIGGER IF EXISTS case_snooze_log_append_only ON public.case_snooze_log;
CREATE TRIGGER case_snooze_log_append_only
  BEFORE UPDATE OR DELETE ON public.case_snooze_log
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_snooze_log_no_truncate ON public.case_snooze_log;
CREATE TRIGGER case_snooze_log_no_truncate
  BEFORE TRUNCATE ON public.case_snooze_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 3. The filter validator ----------

-- The one place inbox filters are checked (case_inbox and
-- case_view_save). NULL is no filters. `sort` is not accepted here.
CREATE OR REPLACE FUNCTION public.case_inbox_validate_filters(p_filters jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_key  text;
  v_txt  text;
  v_days numeric;
BEGIN
  IF p_filters IS NULL THEN
    RETURN;
  END IF;
  IF jsonb_typeof(p_filters) <> 'object' THEN
    RAISE EXCEPTION 'inbox filters must be an object' USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  SELECT k INTO v_key FROM jsonb_object_keys(p_filters) k
   WHERE k <> ALL (ARRAY['bank', 'stage', 'agent', 'priority', 'sla_state', 'customer_waiting', 'documents_missing',
                         'bank_query_open', 'no_activity_days', 'include_closed', 'snoozed', 'snooze_expired',
                         'mentioned_me'])
   LIMIT 1;
  IF v_key IS NOT NULL THEN
    RAISE EXCEPTION 'inbox filter % is not a filter', left(v_key, 64)
      USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  PERFORM public.case_inbox_text_filter(p_filters, 'bank');
  PERFORM public.case_inbox_text_filter(p_filters, 'stage');
  v_txt := public.case_inbox_text_filter(p_filters, 'agent');
  IF v_txt IS NOT NULL AND v_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'inbox filter agent must be a uuid' USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  PERFORM public.case_inbox_text_filter(p_filters, 'priority', ARRAY['low', 'normal', 'high', 'urgent']);
  PERFORM public.case_inbox_text_filter(p_filters, 'sla_state', ARRAY['on_track', 'due_soon', 'overdue']);
  PERFORM public.case_inbox_text_filter(p_filters, 'snoozed', ARRAY['hide', 'only', 'all']);
  PERFORM public.case_inbox_bool_filter(p_filters, 'customer_waiting');
  PERFORM public.case_inbox_bool_filter(p_filters, 'documents_missing');
  PERFORM public.case_inbox_bool_filter(p_filters, 'bank_query_open');
  PERFORM public.case_inbox_bool_filter(p_filters, 'include_closed');
  PERFORM public.case_inbox_bool_filter(p_filters, 'snooze_expired');
  PERFORM public.case_inbox_bool_filter(p_filters, 'mentioned_me');
  IF p_filters ? 'no_activity_days' THEN
    IF jsonb_typeof(p_filters -> 'no_activity_days') <> 'number' THEN
      RAISE EXCEPTION 'inbox filter no_activity_days must be a number'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
    END IF;
    v_days := (p_filters -> 'no_activity_days')::numeric;
    IF v_days <> trunc(v_days) OR v_days < 1 OR v_days > 3650 THEN
      RAISE EXCEPTION 'inbox filter no_activity_days must be a whole number of days 1..3650'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.case_inbox_validate_filters(jsonb) IS
  'The one case inbox filter validator (case_inbox, case_view_save): unknown key, wrong type or out-of-range value is FILTER_INVALID; sort is not a filter here. Migration 185.';

-- ---------- 4. Case inbox (162) ----------

DROP FUNCTION IF EXISTS public.case_inbox(uuid, uuid, jsonb, timestamptz, int, text);
CREATE FUNCTION public.case_inbox(p_actor uuid, p_account uuid, p_filters jsonb, p_now timestamptz,
  p_limit int DEFAULT 50, p_after text DEFAULT NULL)
RETURNS TABLE (case_id uuid, bank_code text, stage text, agent_id uuid, coordinator_id uuid, priority text,
  due_at timestamptz, sla_state text, overdue_rank integer[], customer_waiting boolean, documents_missing integer,
  bank_query_open boolean, last_activity_at timestamptz, last_touched_by uuid, open_task_overdue_count integer,
  submission_ref text, contact_id uuid, contact_name text, bank_name text, product text, amount numeric,
  opened_at timestamptz, closed_at timestamptz, cursor text, snoozed_until timestamptz, snooze_expired boolean)
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
  v_snoozed     text;
  v_expired     boolean;
  v_mentioned   boolean;
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

  -- filters: the shared validator (185), plus the sort, which the inbox
  -- still takes inside its filters object
  IF jsonb_typeof(v_filters) <> 'object' THEN
    RAISE EXCEPTION 'inbox filters must be an object' USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  PERFORM public.case_inbox_validate_filters(v_filters - 'sort');
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
  v_snoozed  := coalesce(public.case_inbox_text_filter(v_filters, 'snoozed', ARRAY['hide', 'only', 'all']), 'hide');
  v_expired  := public.case_inbox_bool_filter(v_filters, 'snooze_expired');
  v_mentioned := public.case_inbox_bool_filter(v_filters, 'mentioned_me');
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
             c.product, c.amount, c.opened_at, c.closed_at,
             c.snoozed_until,
             coalesce(c.snoozed_until <= p_now AND c.snoozed_until > p_now - interval '24 hours', false) AS snooze_expired
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
              -- 185: a system-authored note (179) is not a touch
              SELECT n.created_at, n.author_id, 5, n.id::text FROM public.case_notes n
               WHERE n.case_id = c.id AND n.author_id IS NOT NULL
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
         -- 185: snooze and mentions
         AND (v_snoozed = 'all'
              OR (v_snoozed = 'hide' AND NOT coalesce(b.snoozed_until > p_now, false))
              OR (v_snoozed = 'only' AND coalesce(b.snoozed_until > p_now, false)))
         AND (v_expired IS NULL OR b.snooze_expired = v_expired)
         AND (v_mentioned IS NULL
              OR EXISTS (SELECT 1 FROM public.case_note_mentions m
                           JOIN public.case_notes n ON n.id = m.note_id AND n.account_id = m.account_id
                          WHERE m.case_id = b.case_id AND m.user_id = p_actor AND n.created_at <= p_now) = v_mentioned)
    )
    SELECT k.case_id, k.bank_code, k.stage, k.agent_id, k.coordinator_id, k.priority, k.due_at, k.sla_state,
           k.overdue_rank, k.customer_waiting, k.documents_missing, k.bank_query_open, k.last_activity_at,
           k.last_touched_by, k.open_task_overdue_count, k.submission_ref, k.contact_id, k.contact_name, k.bank_name,
           k.product, k.amount, k.opened_at, k.closed_at,
           jsonb_build_object('sort', v_sort, 'now', p_now, 'case_id', k.case_id, 'overdue_rank', to_jsonb(k.overdue_rank),
                              'due_at', k.due_at, 'last_activity_at', k.last_activity_at)::text,
           k.snoozed_until, k.snooze_expired
      FROM keyed k
     WHERE p_after IS NULL OR (k.k1, k.k2, k.k3, k.case_id) > (a_k1, a_k2, a_k3, a_id)
     ORDER BY k.k1, k.k2, k.k3, k.case_id
     LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.case_inbox(uuid, uuid, jsonb, timestamptz, int, text) IS
  'The coordinator inbox: the cases of p_account the actor may read (case_role, set-wise), filtered, sorted and keyset-paged at the injected clock; snoozed cases hidden unless asked for (185). A pure read, no audit. service_role only. Migrations 125, 162, 185.';

-- ---------- 5. Saved views ----------

-- The actor's active account when they hold a case role there
-- (owner, admin, team leader, agent); NULL otherwise. Internal.
CREATE OR REPLACE FUNCTION public.case_view_account(p_actor uuid, OUT account_id uuid, OUT role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.account_id, public.case_account_role(p.account_id, p_actor)
    FROM public.profiles p
   WHERE p.user_id = p_actor AND p.is_active AND p.deactivated_at IS NULL
     AND public.case_account_role(p.account_id, p_actor) IS NOT NULL
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.case_view_list(p_actor uuid)
RETURNS SETOF public.case_saved_views
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a record;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'case_view_list: no actor' USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF a.account_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT x.* FROM public.case_saved_views x
     WHERE x.account_id = a.account_id AND (x.owner_user_id = p_actor OR x.shared)
     ORDER BY x.shared DESC, x.name, x.view_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_view_save(p_actor uuid, p_view_id uuid, p_name text, p_filters jsonb,
  p_sort text, p_shared boolean)
RETURNS public.case_saved_views
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a         record;
  v         public.case_saved_views%ROWTYPE;
  v_name    text;
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_shared  boolean := coalesce(p_shared, false);
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL THEN
    RAISE EXCEPTION 'case_view_save: % may not save views', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  v_name := regexp_replace(coalesce(p_name, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  IF v_name = '' OR char_length(v_name) > 60 THEN
    RAISE EXCEPTION 'view name must be 1..60 characters' USING ERRCODE = 'invalid_parameter_value', HINT = 'NAME_INVALID';
  END IF;
  -- sort is the view's own field: the validator refuses a sort key
  PERFORM public.case_inbox_validate_filters(v_filters);
  IF p_sort IS NOT NULL AND p_sort NOT IN ('most_overdue', 'due_soonest', 'stalest') THEN
    RAISE EXCEPTION 'view sort % is not an inbox sort', left(p_sort, 64)
      USING ERRCODE = 'invalid_parameter_value', HINT = 'FILTER_INVALID';
  END IF;
  IF v_shared AND a.role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'case_view_save: only an owner or admin shares a view'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;

  IF p_view_id IS NULL THEN
    INSERT INTO public.case_saved_views (account_id, owner_user_id, name, filters, sort, shared)
    VALUES (a.account_id, p_actor, v_name, v_filters, p_sort, v_shared)
    RETURNING * INTO v;
    RETURN v;
  END IF;

  SELECT * INTO v FROM public.case_saved_views x
   WHERE x.view_id = p_view_id AND x.account_id = a.account_id AND (x.owner_user_id = p_actor OR x.shared)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'view % not found', p_view_id USING ERRCODE = 'no_data_found', HINT = 'VIEW_NOT_FOUND';
  END IF;
  IF v.owner_user_id <> p_actor THEN
    RAISE EXCEPTION 'case_view_save: only the owner changes a view'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  UPDATE public.case_saved_views x
     SET name = v_name, filters = v_filters, sort = p_sort, shared = v_shared, updated_at = now()
   WHERE x.view_id = p_view_id
  RETURNING * INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_view_delete(p_actor uuid, p_view_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a       record;
  v       public.case_saved_views%ROWTYPE;
  v_admin boolean;
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL THEN
    RAISE EXCEPTION 'case_view_delete: % may not delete views', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  v_admin := a.role IN ('super_admin', 'admin');
  SELECT * INTO v FROM public.case_saved_views x
   WHERE x.view_id = p_view_id AND x.account_id = a.account_id
   FOR UPDATE;
  -- another person's private view is not found (no existence oracle)
  IF NOT FOUND OR (v.owner_user_id <> p_actor AND NOT v.shared AND NOT v_admin) THEN
    RAISE EXCEPTION 'view % not found', p_view_id USING ERRCODE = 'no_data_found', HINT = 'VIEW_NOT_FOUND';
  END IF;
  IF v.owner_user_id <> p_actor AND NOT v_admin THEN
    RAISE EXCEPTION 'case_view_delete: only the owner, an owner or an admin'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  DELETE FROM public.case_saved_views x WHERE x.view_id = p_view_id;
END;
$$;

COMMENT ON FUNCTION public.case_view_list(uuid) IS
  'The actor''s own saved inbox views and the shared views of their active workspace (shared first, then name). service_role only. Migration 185.';
COMMENT ON FUNCTION public.case_view_save(uuid, uuid, text, jsonb, text, boolean) IS
  'Creates (view id NULL) or replaces the actor''s own saved inbox view; sharing needs owner/admin; filters through case_inbox_validate_filters. Another person''s private view: VIEW_NOT_FOUND. service_role only. Migration 185.';
COMMENT ON FUNCTION public.case_view_delete(uuid, uuid) IS
  'Deletes a saved inbox view: the owner, or an owner/admin of the workspace for any view. Another person''s private view: VIEW_NOT_FOUND. service_role only. Migration 185.';

-- ---------- 6. Snooze ----------

-- Locks the case (FOR NO KEY UPDATE, as case_tools_lock_for_write) and
-- returns the actor's role when they may snooze it: case_role (161)
-- coordinator, team_lead, admin or super_admin. Internal.
CREATE OR REPLACE FUNCTION public.case_snooze_lock(p_case uuid, p_actor uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_closed timestamptz;
  v_role   text;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'snooze: no actor' USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT x.closed_at INTO v_closed FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT coalesce(v_role IN ('super_admin', 'admin', 'team_lead', 'coordinator'), false) THEN
    RAISE EXCEPTION 'case %: % may not snooze it', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF v_closed IS NOT NULL THEN
    RAISE EXCEPTION 'case % is closed', p_case USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_snooze(p_actor uuid, p_case uuid, p_until timestamptz, p_reason text,
  p_now timestamptz DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role   text;
  v_now    timestamptz := coalesce(p_now, now());
  v_reason text := CASE WHEN p_reason ~ '^[[:space:]]*$' THEN NULL ELSE p_reason END;
BEGIN
  IF NOT isfinite(v_now) THEN
    RAISE EXCEPTION 'case_snooze needs a finite clock' USING ERRCODE = 'invalid_parameter_value', HINT = 'NOW_REQUIRED';
  END IF;
  v_role := public.case_snooze_lock(p_case, p_actor);
  IF p_until IS NULL OR NOT isfinite(p_until) OR p_until <= v_now OR p_until > v_now + interval '30 days' THEN
    RAISE EXCEPTION 'a snooze must end after now and within 30 days'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'SNOOZE_INVALID';
  END IF;
  IF char_length(v_reason) > 200 THEN
    RAISE EXCEPTION 'snooze reason is over 200 characters' USING ERRCODE = 'invalid_parameter_value', HINT = 'SNOOZE_INVALID';
  END IF;
  -- SLA-neutral: no timer is read or written here
  UPDATE public.cases x SET snoozed_until = p_until WHERE x.id = p_case;
  INSERT INTO public.case_snooze_log (case_id, account_id, actor_id, actor_role, snoozed_until, reason, at)
  SELECT x.id, x.account_id, p_actor, v_role, p_until, v_reason, v_now FROM public.cases x WHERE x.id = p_case;
  RETURN p_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_unsnooze(p_actor uuid, p_case uuid, p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_now  timestamptz := coalesce(p_now, now());
BEGIN
  IF NOT isfinite(v_now) THEN
    RAISE EXCEPTION 'case_unsnooze needs a finite clock' USING ERRCODE = 'invalid_parameter_value', HINT = 'NOW_REQUIRED';
  END IF;
  v_role := public.case_snooze_lock(p_case, p_actor);
  IF NOT EXISTS (SELECT 1 FROM public.cases x WHERE x.id = p_case AND x.snoozed_until > v_now) THEN
    RAISE EXCEPTION 'case % is not snoozed', p_case USING ERRCODE = 'invalid_parameter_value', HINT = 'SNOOZE_INVALID';
  END IF;
  UPDATE public.cases x SET snoozed_until = NULL WHERE x.id = p_case;
  INSERT INTO public.case_snooze_log (case_id, account_id, actor_id, actor_role, snoozed_until, reason, at)
  SELECT x.id, x.account_id, p_actor, v_role, NULL, NULL, v_now FROM public.cases x WHERE x.id = p_case;
END;
$$;

COMMENT ON FUNCTION public.case_snooze(uuid, uuid, timestamptz, text, timestamptz) IS
  'Snoozes an open case out of the default inbox until p_until (after now, within 30 days): its coordinator (incl. a bank holder), team lead, admin or owner. SLA-neutral; logged in case_snooze_log. service_role only. Migration 185.';
COMMENT ON FUNCTION public.case_unsnooze(uuid, uuid, timestamptz) IS
  'Ends a running snooze (SNOOZE_INVALID when none runs); same roles as case_snooze; logged. service_role only. Migration 185.';

-- ---------- 7. Mentions ----------

CREATE OR REPLACE FUNCTION public.case_mentions(p_actor uuid, p_now timestamptz, p_limit int DEFAULT 50,
  p_after text DEFAULT NULL)
RETURNS TABLE (note_id uuid, case_id uuid, stage text, author_id uuid, system_author text, created_at timestamptz,
  body text, cursor text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a       record;
  v_limit integer;
  v_after jsonb;
  a_at    timestamptz;
  a_id    uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'case_mentions: no actor' USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'case_mentions needs a finite clock' USING ERRCODE = 'invalid_parameter_value', HINT = 'NOW_REQUIRED';
  END IF;
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'case_mentions: limit % is below 1', p_limit
      USING ERRCODE = 'invalid_parameter_value', HINT = 'LIMIT_INVALID';
  END IF;
  v_limit := least(coalesce(p_limit, 50), 200);
  IF p_after IS NOT NULL THEN
    BEGIN
      v_after := p_after::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'mentions cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END;
    IF jsonb_typeof(v_after) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_after) k)
          IS DISTINCT FROM ARRAY['created_at', 'note_id', 'now']
       OR jsonb_typeof(v_after -> 'created_at') <> 'string'
       OR jsonb_typeof(v_after -> 'note_id') <> 'string'
       OR jsonb_typeof(v_after -> 'now') <> 'string' THEN
      RAISE EXCEPTION 'mentions cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END IF;
    BEGIN
      IF (v_after ->> 'now')::timestamptz <> p_now THEN
        RAISE EXCEPTION 'clock';
      END IF;
      a_at := (v_after ->> 'created_at')::timestamptz;
      a_id := (v_after ->> 'note_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'mentions cursor is not valid' USING ERRCODE = 'invalid_parameter_value', HINT = 'CURSOR_INVALID';
    END;
  END IF;

  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF a.account_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT n.id, n.case_id, c.stage, n.author_id, n.system_author, n.created_at, n.body,
           jsonb_build_object('now', p_now, 'created_at', n.created_at, 'note_id', n.id)::text
      FROM public.case_note_mentions m
      JOIN public.case_notes n ON n.id = m.note_id AND n.account_id = m.account_id
      JOIN public.cases c ON c.id = n.case_id AND c.account_id = n.account_id
     WHERE m.user_id = p_actor
       AND m.account_id = a.account_id
       AND n.created_at <= p_now
       AND public.case_can_read(c.id, p_actor)
       AND (p_after IS NULL OR (n.created_at, n.id) < (a_at, a_id))
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.case_mentions(uuid, timestamptz, int, text) IS
  'The notes of the actor''s active workspace that mention them, on cases they may read now, created at or before p_now; newest first, keyset-paged. service_role only. Migration 185.';

-- ---------- 8. RLS ----------

ALTER TABLE public.case_saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_saved_views FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_snooze_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_snooze_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_saved_views_select ON public.case_saved_views;
CREATE POLICY case_saved_views_select ON public.case_saved_views FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND (owner_user_id = (SELECT auth.uid()) OR shared));

DROP POLICY IF EXISTS case_snooze_log_select ON public.case_snooze_log;
CREATE POLICY case_snooze_log_select ON public.case_snooze_log FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

-- ---------- 9. Privileges ----------

REVOKE ALL ON public.case_saved_views, public.case_snooze_log FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.case_snooze_log_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_saved_views, public.case_snooze_log TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.case_inbox_validate_filters(jsonb),
  public.case_inbox(uuid, uuid, jsonb, timestamptz, int, text),
  public.case_view_account(uuid),
  public.case_view_list(uuid),
  public.case_view_save(uuid, uuid, text, jsonb, text, boolean),
  public.case_view_delete(uuid, uuid),
  public.case_snooze_lock(uuid, uuid),
  public.case_snooze(uuid, uuid, timestamptz, text, timestamptz),
  public.case_unsnooze(uuid, uuid, timestamptz),
  public.case_mentions(uuid, timestamptz, int, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_inbox_validate_filters(jsonb),
  public.case_inbox(uuid, uuid, jsonb, timestamptz, int, text),
  public.case_view_list(uuid),
  public.case_view_save(uuid, uuid, text, jsonb, text, boolean),
  public.case_view_delete(uuid, uuid),
  public.case_snooze(uuid, uuid, timestamptz, text, timestamptz),
  public.case_unsnooze(uuid, uuid, timestamptz),
  public.case_mentions(uuid, timestamptz, int, text)
  TO service_role;

RESET lock_timeout;
