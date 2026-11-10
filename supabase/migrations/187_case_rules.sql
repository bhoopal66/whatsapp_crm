-- =============================================================================
-- Migration 187: case automation rules.
--
-- A rule is "when TRIGGER on a case of my workspace, if CONDITIONS, do
-- ACTIONS", defined by an owner/admin and fired by the database. Ported
-- from the outside package's module 020c (rules), with one deliberate
-- difference: there is NO marker table and no redefined role resolver.
-- Each action is a dedicated internal SECURITY DEFINER helper that no role
-- may execute (166 / 181's case_files_ready_move precedent), called only
-- from case_rules_fire, writing directly with the repo's own invariants and
-- history rows (actor NULL, actor_role 'system:rules').
--
--  * Nothing changes until a rule exists: every hook returns after one
--    indexed lookup when the account has no enabled rule for the trigger.
--  * Rules never send anything: no action reaches a WhatsApp, email or
--    gateway path, and this file calls no function that does.
--  * The Compass lock (134) binds every action: on a submitted case
--    (group_id IS NOT NULL, 134's scope) of an account with
--    managed_externally, each action refuses MANAGED_EXTERNALLY. Every
--    action also refuses on a closed case (CASE_CLOSED).
--
-- Triggers: case_opened (AFTER INSERT on cases), stage_changed (stage
--   really changed), submission_attached (group_id NULL -> set),
--   no_activity and sla_overdue (case_rules_sweep, from the automations
--   cron). Conditions (all must match; absent = any): bank_code, stage,
--   product, amount_min, amount_max, pre_submission (group_id IS NULL),
--   days (1..365; required for and only allowed on no_activity: the
--   inbox's last activity (185) not counting the rules' own writes, else
--   opened_at, at least that old). A no_activity rule fires once per
--   idle episode: its run is keyed on that last-activity instant, so it
--   fires again only after real activity and N more idle days.
-- Actions: assign_coordinator {userId}, assign_agent {userId} (target:
--   live non-guest staff of the account, case_reassign's rule),
--   add_note {body} ({{customer}} = contact name,
--   {{bank}} = bank name; through case_note_add_system), set_priority
--   {priority} (cases.priority + a case_detail_log row). There is no
--   add_task: case_tasks.created_by is NOT NULL (123) and a rule has no
--   person to name, so a rule naming it is refused (RULE_INVALID).
-- Firing: case_rules_fire runs the account's enabled rules for the trigger
--   in position order, one case_rule_runs row per rule (matched or not);
--   each action in its own sub-transaction, so a failing action is rolled
--   back alone, recorded with its refusal (the HINT), and stops that rule;
--   the next rule still runs; the hooks swallow any failure (WARNING), so
--   a rule never aborts the write that fired it. While actions run, the
--   transaction-local app.case_rules_firing = 'on' makes the hooks skip,
--   so a rule action never fires rules (forging it only suppresses rules).
-- case_reassign_history.actor_id becomes NULLable (as 134 did for
-- case_outcome_reasons): NULL = a system writer.
--
-- Refusals (HINT): NOT_ALLOWED, RULE_INVALID, RULE_NOT_FOUND,
--   CASE_NOT_FOUND, NOW_REQUIRED; recorded per action: CASE_CLOSED,
--   MANAGED_EXTERNALLY, ASSIGNEE_INVALID, plus 179's.
-- Re-runnable. Apply as a superuser or BYPASSRLS role (FORCE RLS).
-- =============================================================================

SET lock_timeout = '5s';

-- ---------- 1. Tables ----------

ALTER TABLE public.case_reassign_history ALTER COLUMN actor_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.case_rules (
  rule_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  name       text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  trigger    text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions    jsonb NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_rules_name_check CHECK (name !~ '^[[:space:]]*$' AND char_length(name) <= 60),
  CONSTRAINT case_rules_trigger_check
    CHECK (trigger IN ('case_opened', 'stage_changed', 'sla_overdue', 'no_activity', 'submission_attached')),
  CONSTRAINT case_rules_conditions_check CHECK (jsonb_typeof(conditions) = 'object'),
  CONSTRAINT case_rules_actions_check
    CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) BETWEEN 1 AND 5),
  CONSTRAINT case_rules_position_check CHECK (position >= 0)
);
CREATE INDEX IF NOT EXISTS case_rules_account_trigger_idx
  ON public.case_rules (account_id, trigger, position) WHERE enabled;

COMMENT ON TABLE public.case_rules IS
  'Case automation rules (when trigger, if conditions, do actions). Written only through case_rule_save / case_rule_delete (owner/admin). Migration 187.';

CREATE TABLE IF NOT EXISTS public.case_rule_runs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL,
  rule_id    uuid NOT NULL,   -- no FK: the log outlives a deleted rule
  case_id    uuid NOT NULL,
  trigger    text NOT NULL,
  fire_key   text NULL,
  matched    boolean NOT NULL,
  applied    jsonb NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_rule_runs_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_rule_runs_applied_check CHECK (jsonb_typeof(applied) = 'array')
);
CREATE INDEX IF NOT EXISTS case_rule_runs_case_idx ON public.case_rule_runs (case_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS case_rule_runs_key_uq
  ON public.case_rule_runs (rule_id, case_id, fire_key) WHERE fire_key IS NOT NULL;

COMMENT ON TABLE public.case_rule_runs IS
  'One row per rule evaluated by case_rules_fire (matched or not); applied = [{kind, ok, refusal}]. Append-only. Migration 187.';

DROP TRIGGER IF EXISTS case_rule_runs_append_only ON public.case_rule_runs;
CREATE TRIGGER case_rule_runs_append_only BEFORE UPDATE OR DELETE ON public.case_rule_runs
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_rule_runs_no_truncate ON public.case_rule_runs;
CREATE TRIGGER case_rule_runs_no_truncate BEFORE TRUNCATE ON public.case_rule_runs
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 2. Validation ----------

CREATE OR REPLACE FUNCTION public.case_rule_refuse(p_msg text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'rule: %', p_msg USING ERRCODE = 'invalid_parameter_value', HINT = 'RULE_INVALID';
END;
$$;

CREATE OR REPLACE FUNCTION public.case_rule_validate(p_trigger text, p_conditions jsonb, p_actions jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  a         jsonb;
  k         text;
  v_kind    text;
  v_allowed text[];
  v_uuid    text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_trigger IS NULL
     OR p_trigger NOT IN ('case_opened', 'stage_changed', 'sla_overdue', 'no_activity', 'submission_attached') THEN
    PERFORM public.case_rule_refuse(format('unknown trigger %s', p_trigger));
  END IF;
  IF p_conditions IS NULL OR jsonb_typeof(p_conditions) <> 'object' THEN
    PERFORM public.case_rule_refuse('conditions must be an object');
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_conditions) LOOP
    IF k IN ('bank_code', 'stage', 'product') THEN
      IF jsonb_typeof(p_conditions -> k) <> 'string' OR (p_conditions ->> k) ~ '^[[:space:]]*$'
         OR char_length(p_conditions ->> k) > 200 THEN
        PERFORM public.case_rule_refuse(format('condition %s must be 1..200 characters', k));
      END IF;
    ELSIF k IN ('amount_min', 'amount_max') THEN
      IF jsonb_typeof(p_conditions -> k) <> 'number' OR (p_conditions ->> k)::numeric < 0 THEN
        PERFORM public.case_rule_refuse(format('condition %s must be a number >= 0', k));
      END IF;
    ELSIF k = 'pre_submission' THEN
      IF jsonb_typeof(p_conditions -> k) <> 'boolean' THEN
        PERFORM public.case_rule_refuse('condition pre_submission must be true or false');
      END IF;
    ELSIF k = 'days' THEN
      IF p_trigger <> 'no_activity' THEN
        PERFORM public.case_rule_refuse('condition days is for no_activity only');
      END IF;
      IF jsonb_typeof(p_conditions -> k) <> 'number' OR (p_conditions ->> k) !~ '^[0-9]{1,3}$'
         OR (p_conditions ->> k)::int NOT BETWEEN 1 AND 365 THEN
        PERFORM public.case_rule_refuse('condition days must be an integer 1..365');
      END IF;
    ELSE
      PERFORM public.case_rule_refuse(format('unknown condition %s', k));
    END IF;
  END LOOP;
  IF p_trigger = 'no_activity' AND NOT (p_conditions ? 'days') THEN
    PERFORM public.case_rule_refuse('no_activity needs days');
  END IF;

  IF p_actions IS NULL OR jsonb_typeof(p_actions) <> 'array'
     OR jsonb_array_length(p_actions) NOT BETWEEN 1 AND 5 THEN
    PERFORM public.case_rule_refuse('actions must be an array of 1..5');
  END IF;
  FOR a IN SELECT x FROM jsonb_array_elements(p_actions) x LOOP
    IF jsonb_typeof(a) <> 'object' OR jsonb_typeof(a -> 'kind') IS DISTINCT FROM 'string' THEN
      PERFORM public.case_rule_refuse('an action is an object with a string kind');
    END IF;
    v_kind := a ->> 'kind';
    v_allowed := CASE v_kind
      WHEN 'assign_coordinator' THEN ARRAY['kind', 'userId']
      WHEN 'assign_agent'       THEN ARRAY['kind', 'userId']
      WHEN 'add_note'           THEN ARRAY['kind', 'body']
      WHEN 'set_priority'       THEN ARRAY['kind', 'priority']
    END;
    IF v_allowed IS NULL THEN
      PERFORM public.case_rule_refuse(format('unknown action %s', v_kind));
    END IF;
    FOR k IN SELECT jsonb_object_keys(a) LOOP
      IF NOT (k = ANY (v_allowed)) THEN
        PERFORM public.case_rule_refuse(format('unknown key %s for %s', k, v_kind));
      END IF;
    END LOOP;
    IF v_kind IN ('assign_coordinator', 'assign_agent') THEN
      IF jsonb_typeof(a -> 'userId') IS DISTINCT FROM 'string' OR (a ->> 'userId') !~ v_uuid THEN
        PERFORM public.case_rule_refuse(format('%s needs a userId (a uuid)', v_kind));
      END IF;
    ELSIF v_kind = 'add_note' THEN
      IF jsonb_typeof(a -> 'body') IS DISTINCT FROM 'string' OR (a ->> 'body') ~ '^[[:space:]]*$'
         OR char_length(a ->> 'body') > 4000 THEN
        PERFORM public.case_rule_refuse('body must be 1..4000 characters');
      END IF;
    ELSIF v_kind = 'set_priority' THEN
      IF jsonb_typeof(a -> 'priority') IS DISTINCT FROM 'string'
         OR (a ->> 'priority') NOT IN ('low', 'normal', 'high', 'urgent') THEN
        PERFORM public.case_rule_refuse('priority must be low, normal, high or urgent');
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- ---------- 3. Store (staff functions, service_role only) ----------

CREATE OR REPLACE FUNCTION public.case_rule_list(p_actor uuid)
RETURNS SETOF public.case_rules
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a record;
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL THEN
    RAISE EXCEPTION 'case_rule_list: % is not live staff', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY SELECT x.* FROM public.case_rules x WHERE x.account_id = a.account_id
                ORDER BY x.position, x.created_at, x.rule_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_rule_save(p_actor uuid, p_rule_id uuid, p_name text, p_enabled boolean,
  p_trigger text, p_conditions jsonb, p_actions jsonb, p_position integer)
RETURNS public.case_rules
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a      record;
  r      public.case_rules%ROWTYPE;
  v_cond jsonb := coalesce(p_conditions, '{}'::jsonb);
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL OR a.role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'case_rule_save: % may not change rules', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_name IS NULL OR p_name ~ '^[[:space:]]*$' OR char_length(btrim(p_name)) > 60 THEN
    PERFORM public.case_rule_refuse('name must be 1..60 characters');
  END IF;
  PERFORM public.case_rule_validate(p_trigger, v_cond, p_actions);
  IF p_position IS NOT NULL AND p_position < 0 THEN
    PERFORM public.case_rule_refuse('position must be >= 0');
  END IF;
  IF p_rule_id IS NULL THEN
    INSERT INTO public.case_rules (account_id, name, enabled, trigger, conditions, actions, position, created_by)
    VALUES (a.account_id, btrim(p_name), coalesce(p_enabled, true), p_trigger, v_cond, p_actions,
            coalesce(p_position, (SELECT coalesce(max(x.position), 0) + 1 FROM public.case_rules x
                                   WHERE x.account_id = a.account_id)),
            p_actor)
    RETURNING * INTO r;
    RETURN r;
  END IF;
  UPDATE public.case_rules x
     SET name = btrim(p_name), enabled = coalesce(p_enabled, true), trigger = p_trigger, conditions = v_cond,
         actions = p_actions, position = coalesce(p_position, x.position), updated_at = now()
   WHERE x.rule_id = p_rule_id AND x.account_id = a.account_id
  RETURNING * INTO r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rule % not found', p_rule_id USING ERRCODE = 'no_data_found', HINT = 'RULE_NOT_FOUND';
  END IF;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_rule_delete(p_actor uuid, p_rule_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a record;
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL OR a.role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'case_rule_delete: % may not change rules', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  DELETE FROM public.case_rules x WHERE x.rule_id = p_rule_id AND x.account_id = a.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rule % not found', p_rule_id USING ERRCODE = 'no_data_found', HINT = 'RULE_NOT_FOUND';
  END IF;
END;
$$;

-- A case's run log, oldest first, for a reader of the case in the
-- actor's active account (CASE_NOT_FOUND otherwise).
CREATE OR REPLACE FUNCTION public.case_rule_runs_list(p_actor uuid, p_case uuid)
RETURNS SETOF public.case_rule_runs
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  a record;
BEGIN
  SELECT * INTO a FROM public.case_view_account(p_actor);
  IF p_actor IS NULL OR a.account_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.cases c WHERE c.id = p_case AND c.account_id = a.account_id)
     OR NOT coalesce(public.case_can_read(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  RETURN QUERY SELECT x.* FROM public.case_rule_runs x WHERE x.case_id = p_case ORDER BY x.id;
END;
$$;

-- ---------- 4. Internal action helpers (no role may execute) ----------

-- Locks the case and applies the two refusals every action shares.
CREATE OR REPLACE FUNCTION public.case_rule_action_case(p_case uuid)
RETURNS public.cases
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF c.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'case % is closed', p_case USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  IF c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) THEN
    RAISE EXCEPTION 'case % is managed in Compass', p_case
      USING ERRCODE = 'insufficient_privilege', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  RETURN c;
END;
$$;

-- case_reassign's target rule (live non-guest staff of the case's
-- account), without an actor; history actor NULL, role system:rules.
CREATE OR REPLACE FUNCTION public.case_rule_act_assign(p_case uuid, p_field text, p_to_user uuid, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  v_from uuid;
BEGIN
  c := public.case_rule_action_case(p_case);
  IF p_field IS NULL OR p_field NOT IN ('agent', 'coordinator') THEN
    RAISE EXCEPTION 'reassign field % is not agent or coordinator', p_field
      USING ERRCODE = 'check_violation', HINT = 'ASSIGNEE_INVALID';
  END IF;
  IF p_to_user IS NULL OR public.case_account_role(c.account_id, p_to_user) IS NULL THEN
    RAISE EXCEPTION 'user % is not live staff of this workspace', p_to_user
      USING ERRCODE = 'check_violation', HINT = 'ASSIGNEE_INVALID';
  END IF;
  v_from := CASE p_field WHEN 'agent' THEN c.agent_id ELSE c.coordinator_id END;
  IF v_from IS NOT DISTINCT FROM p_to_user THEN
    RETURN false;
  END IF;
  UPDATE public.cases x
     SET agent_id = CASE WHEN p_field = 'agent' THEN p_to_user ELSE x.agent_id END,
         coordinator_id = CASE WHEN p_field = 'coordinator' THEN p_to_user ELSE x.coordinator_id END
   WHERE x.id = p_case;
  INSERT INTO public.case_reassign_history (case_id, account_id, field, from_user, to_user, actor_id, actor_role,
                                            changed_at)
  VALUES (p_case, c.account_id, p_field, v_from, p_to_user, NULL, 'system:rules', p_now);
  RETURN true;
END;
$$;

-- No add_task action (see the header): an earlier draft's helper, if a
-- database has it, goes.
DROP FUNCTION IF EXISTS public.case_rule_act_add_task(uuid, jsonb, timestamptz);

CREATE OR REPLACE FUNCTION public.case_rule_act_add_note(p_case uuid, p_body text, p_now timestamptz)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c        public.cases%ROWTYPE;
  v_name   text;
  v_bank   text;
BEGIN
  c := public.case_rule_action_case(p_case);
  SELECT ct.name INTO v_name FROM public.contacts ct WHERE ct.id = c.contact_id AND ct.account_id = c.account_id;
  SELECT b.name INTO v_bank FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = c.bank_code;
  RETURN public.case_note_add_system(p_case, 'system:rules',
    replace(replace(p_body, '{{customer}}', coalesce(v_name, '')), '{{bank}}', coalesce(v_bank, c.bank_code, '')),
    p_now);
END;
$$;

CREATE OR REPLACE FUNCTION public.case_rule_act_set_priority(p_case uuid, p_priority text, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  c := public.case_rule_action_case(p_case);
  IF p_priority IS NULL OR p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'priority % is not low, normal, high or urgent', p_priority
      USING ERRCODE = 'check_violation', HINT = 'PRIORITY_INVALID';
  END IF;
  IF p_priority = c.priority THEN
    RETURN false;
  END IF;
  UPDATE public.cases SET priority = p_priority WHERE id = p_case;
  INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role, changed_at)
  VALUES (p_case, c.account_id, 'priority', c.priority, p_priority, NULL, 'system:rules', p_now);
  RETURN true;
END;
$$;

-- ---------- 5. Matching and firing ----------

-- The inbox's last activity (185's lateral, same sources and exclusions),
-- minus the rules' own writes (actor NULL, role system:rules): a
-- no_activity rule that reassigns or sets priority must not restart its
-- own idle clock. Rule notes are already out (author_id NULL).
CREATE OR REPLACE FUNCTION public.case_rule_last_activity(p_case uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT max(e.at) FROM (
    SELECT h.changed_at AS at FROM public.case_stage_history h WHERE h.case_id = p_case
    UNION ALL SELECT r.changed_at FROM public.case_reassign_history r
               WHERE r.case_id = p_case AND NOT (r.actor_id IS NULL AND r.actor_role IS NOT DISTINCT FROM 'system:rules')
    UNION ALL SELECT d.changed_at FROM public.case_detail_log d
               WHERE d.case_id = p_case AND NOT (d.actor_id IS NULL AND d.actor_role IS NOT DISTINCT FROM 'system:rules')
    UNION ALL SELECT l.changed_at FROM public.case_task_status_log l WHERE l.case_id = p_case
    UNION ALL SELECT n.created_at FROM public.case_notes n WHERE n.case_id = p_case AND n.author_id IS NOT NULL
    UNION ALL SELECT o.updated_at FROM public.case_documents o WHERE o.case_id = p_case
    UNION ALL SELECT b.created_at FROM public.case_bank_contacts b WHERE b.case_id = p_case
    UNION ALL SELECT s.changed_at FROM public.case_sla_state_log s WHERE s.case_id = p_case AND s.actor_role <> 'system'
  ) e
$$;

CREATE OR REPLACE FUNCTION public.case_rule_matches(p_cond jsonb, c public.cases, p_trigger text, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_cond ? 'bank_code' AND c.bank_code IS DISTINCT FROM p_cond ->> 'bank_code' THEN RETURN false; END IF;
  IF p_cond ? 'stage' AND c.stage IS DISTINCT FROM p_cond ->> 'stage' THEN RETURN false; END IF;
  IF p_cond ? 'product' AND c.product IS DISTINCT FROM p_cond ->> 'product' THEN RETURN false; END IF;
  IF p_cond ? 'amount_min' AND (c.amount IS NULL OR c.amount < (p_cond ->> 'amount_min')::numeric) THEN
    RETURN false;
  END IF;
  IF p_cond ? 'amount_max' AND (c.amount IS NULL OR c.amount > (p_cond ->> 'amount_max')::numeric) THEN
    RETURN false;
  END IF;
  IF p_cond ? 'pre_submission' AND (c.group_id IS NULL) <> (p_cond ->> 'pre_submission')::boolean THEN
    RETURN false;
  END IF;
  IF p_trigger = 'no_activity'
     AND coalesce(public.case_rule_last_activity(c.id), c.opened_at)
         > p_now - make_interval(days => (p_cond ->> 'days')::int) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- Runs the account's enabled rules for p_trigger on p_case. Returns the
-- number of run rows written. Not executable by any role.
CREATE OR REPLACE FUNCTION public.case_rules_fire(p_trigger text, p_case uuid, p_now timestamptz,
  p_key text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c         public.cases%ROWTYPE;
  r         public.case_rules%ROWTYPE;
  a         jsonb;
  v_matched boolean;
  v_applied jsonb;
  v_hint    text;
  v_prev    text := coalesce(current_setting('app.case_rules_firing', true), '');
  v_n       integer := 0;
  v_idle    timestamptz;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'case_rules_fire needs a finite clock' USING ERRCODE = 'null_value_not_allowed', HINT = 'NOW_REQUIRED';
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF p_trigger = 'no_activity' THEN   -- the rules' own writes never move it
    v_idle := coalesce(public.case_rule_last_activity(p_case), c.opened_at);
  END IF;
  FOR r IN
    SELECT * FROM public.case_rules x
     WHERE x.account_id = c.account_id AND x.enabled AND x.trigger = p_trigger
     ORDER BY x.position, x.created_at, x.rule_id
  LOOP
    -- A rule whose days have not passed yet is not due: no run row, so the
    -- episode key below stays free for the sweep on which it is due.
    CONTINUE WHEN p_trigger = 'no_activity'
      AND v_idle > p_now - make_interval(days => (r.conditions ->> 'days')::int);
    IF p_key IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('case_rules:' || r.rule_id::text || '/' || p_case::text || '/' || p_key));
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.case_rule_runs x
                             WHERE x.rule_id = r.rule_id AND x.case_id = p_case AND x.fire_key = p_key);
    END IF;
    SELECT * INTO c FROM public.cases x WHERE x.id = p_case;   -- an earlier rule may have changed it
    v_applied := '[]'::jsonb;
    BEGIN
      v_matched := public.case_rule_matches(r.conditions, c, p_trigger, p_now);
    EXCEPTION WHEN others THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      v_matched := false;
      v_applied := jsonb_build_array(jsonb_build_object('kind', 'conditions', 'ok', false,
                                                        'refusal', coalesce(nullif(v_hint, ''), SQLSTATE)));
    END;
    IF v_matched THEN
      PERFORM set_config('app.case_rules_firing', 'on', true);   -- the hooks skip while actions run
      FOR a IN SELECT x FROM jsonb_array_elements(r.actions) x LOOP
        BEGIN
          CASE a ->> 'kind'
            WHEN 'assign_coordinator' THEN
              PERFORM public.case_rule_act_assign(p_case, 'coordinator', (a ->> 'userId')::uuid, p_now);
            WHEN 'assign_agent' THEN
              PERFORM public.case_rule_act_assign(p_case, 'agent', (a ->> 'userId')::uuid, p_now);
            WHEN 'add_note' THEN
              PERFORM public.case_rule_act_add_note(p_case, a ->> 'body', p_now);
            WHEN 'set_priority' THEN
              PERFORM public.case_rule_act_set_priority(p_case, a ->> 'priority', p_now);
          END CASE;
          v_applied := v_applied || jsonb_build_array(jsonb_build_object('kind', a ->> 'kind', 'ok', true,
                                                                         'refusal', NULL));
        EXCEPTION WHEN others THEN
          GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
          v_applied := v_applied || jsonb_build_array(jsonb_build_object('kind', a ->> 'kind', 'ok', false,
                                                        'refusal', coalesce(nullif(v_hint, ''), SQLSTATE)));
          EXIT;
        END;
      END LOOP;
      PERFORM set_config('app.case_rules_firing', v_prev, true);
    END IF;
    INSERT INTO public.case_rule_runs (account_id, rule_id, case_id, trigger, fire_key, matched, applied, at)
    VALUES (c.account_id, r.rule_id, p_case, p_trigger, p_key, v_matched, v_applied, p_now);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- ---------- 6. Hooks on cases ----------

CREATE OR REPLACE FUNCTION public.case_rules_on_case()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_trigger text;
BEGIN
  IF coalesce(current_setting('app.case_rules_firing', true), '') = 'on' THEN
    RETURN NULL;   -- a rule action's own write fires no rules
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_trigger := 'case_opened';
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage THEN
    v_trigger := 'stage_changed';
  END IF;
  FOR i IN 1..2 LOOP
    IF i = 2 THEN
      v_trigger := CASE WHEN TG_OP = 'UPDATE' AND OLD.group_id IS NULL AND NEW.group_id IS NOT NULL
                        THEN 'submission_attached' END;
    END IF;
    CONTINUE WHEN v_trigger IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.case_rules r
                      WHERE r.account_id = NEW.account_id AND r.trigger = v_trigger AND r.enabled);
    BEGIN
      PERFORM public.case_rules_fire(v_trigger, NEW.id, clock_timestamp());
    EXCEPTION WHEN others THEN
      RAISE WARNING 'case rules (%) on case % failed: %', v_trigger, NEW.id, SQLERRM;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_rules_opened ON public.cases;
CREATE TRIGGER case_rules_opened AFTER INSERT ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.case_rules_on_case();
DROP TRIGGER IF EXISTS case_rules_changed ON public.cases;
CREATE TRIGGER case_rules_changed AFTER UPDATE OF stage, group_id ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.case_rules_on_case();

-- ---------- 7. Sweep (automations cron) ----------

-- no_activity: open cases of accounts with an enabled no_activity rule,
-- idle at least the smallest days of those rules (once per rule, case and
-- idle episode: the key is the last-activity instant the idle test
-- compares, so the rule fires again only after real activity resets it
-- and N more idle days pass). sla_overdue: running overdue timers on open cases
-- (once per rule, case and timer run). Run after case_sla_evaluate.
CREATE OR REPLACE FUNCTION public.case_rules_sweep(p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v       record;
  v_runs  integer;
  v_fired jsonb := '[]'::jsonb;
BEGIN
  IF p_now IS NULL OR NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'case_rules_sweep needs a finite clock' USING ERRCODE = 'null_value_not_allowed', HINT = 'NOW_REQUIRED';
  END IF;
  FOR v IN
    SELECT x.id, coalesce(public.case_rule_last_activity(x.id), x.opened_at) AS idle_since FROM public.cases x
      JOIN (SELECT r.account_id, min((r.conditions ->> 'days')::int) AS days FROM public.case_rules r
             WHERE r.enabled AND r.trigger = 'no_activity' GROUP BY r.account_id) m ON m.account_id = x.account_id
     WHERE x.closed_at IS NULL
       AND coalesce(public.case_rule_last_activity(x.id), x.opened_at) <= p_now - make_interval(days => m.days)
     ORDER BY x.id
  LOOP
    v_runs := public.case_rules_fire('no_activity', v.id, p_now,
      'idle@' || to_char(v.idle_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    IF v_runs > 0 THEN
      v_fired := v_fired || jsonb_build_array(jsonb_build_object('caseId', v.id, 'trigger', 'no_activity', 'runs', v_runs));
    END IF;
  END LOOP;
  FOR v IN
    SELECT t.case_id, t.timer, t.started_at FROM public.case_sla_timers t
      JOIN public.cases x ON x.id = t.case_id
     WHERE t.stopped_at IS NULL AND t.state = 'overdue' AND x.closed_at IS NULL
       AND EXISTS (SELECT 1 FROM public.case_rules r
                    WHERE r.account_id = x.account_id AND r.enabled AND r.trigger = 'sla_overdue')
     ORDER BY t.case_id, t.timer
  LOOP
    v_runs := public.case_rules_fire('sla_overdue', v.case_id, p_now,
      v.timer || '@' || to_char(v.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    IF v_runs > 0 THEN
      v_fired := v_fired || jsonb_build_array(jsonb_build_object('caseId', v.case_id, 'trigger', 'sla_overdue', 'runs', v_runs));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('fired', v_fired);
END;
$$;

-- ---------- 8. RLS ----------

ALTER TABLE public.case_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_rule_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_rules_select ON public.case_rules;
-- case_rule_list's audience (case_view_account: owner, admin, team
-- leader, agent of the active account); viewers and guests read nothing.
CREATE POLICY case_rules_select ON public.case_rules FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS case_rule_runs_select ON public.case_rule_runs;
CREATE POLICY case_rule_runs_select ON public.case_rule_runs FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()) AND public.case_rls_can_read(case_id));

-- ---------- 9. Privileges ----------

REVOKE ALL ON public.case_rules, public.case_rule_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.case_rule_runs_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_rules, public.case_rule_runs TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.case_rule_refuse(text),
  public.case_rule_validate(text, jsonb, jsonb),
  public.case_rule_list(uuid),
  public.case_rule_save(uuid, uuid, text, boolean, text, jsonb, jsonb, integer),
  public.case_rule_delete(uuid, uuid),
  public.case_rule_runs_list(uuid, uuid),
  public.case_rule_action_case(uuid),
  public.case_rule_act_assign(uuid, text, uuid, timestamptz),
  public.case_rule_act_add_note(uuid, text, timestamptz),
  public.case_rule_act_set_priority(uuid, text, timestamptz),
  public.case_rule_last_activity(uuid),
  public.case_rule_matches(jsonb, public.cases, text, timestamptz),
  public.case_rules_fire(text, uuid, timestamptz, text),
  public.case_rules_on_case(),
  public.case_rules_sweep(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_rule_list(uuid),
  public.case_rule_save(uuid, uuid, text, boolean, text, jsonb, jsonb, integer),
  public.case_rule_delete(uuid, uuid),
  public.case_rule_runs_list(uuid, uuid),
  public.case_rules_sweep(timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.case_rules_fire(text, uuid, timestamptz, text) IS
  'Runs the account''s enabled rules for a trigger on a case; one case_rule_runs row per rule. No grants: called by the cases hooks and case_rules_sweep. Migration 187.';
COMMENT ON FUNCTION public.case_rules_sweep(timestamptz) IS
  'no_activity and sla_overdue rules; returns {fired: [{caseId, trigger, runs}]}. service_role; run from the automations cron after case_sla_evaluate. Migration 187.';

RESET lock_timeout;
