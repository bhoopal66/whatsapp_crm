-- ============================================================
-- 214: case rules, stage-entered and auto-advance (package 029e)
--
-- Two triggers on 187's case rules engine:
--
-- * stage_entered: fires when a case's stage changes (never on open),
--   for enabled rules whose condition `stage` (required) is the stage
--   entered. Its actions, allowed on this trigger only:
--     create_task {templateKey, ownerRole, dueHours?}: a case task from
--       the case bank's case_task_templates row (TEMPLATE_NOT_FOUND),
--       owned by the case's agent or coordinator (OWNER_MISSING when
--       that person is not set; case_task_create's OWNER_INVALID and due
--       rules otherwise), created_by NULL (system writer).
--     start_sla {timer}: case_sla_start_one for the case's (bank,
--       stage, timer); SLA_NOT_CONFIGURED (recorded in the run, nothing
--       started) when there is no config.
--   The fire key is the stage entered, so leaving and re-entering a
--   stage creates no second task and restarts no timer.
-- * last_required_doc_received: fires only from case_doc_set_status
--   when a document becomes `received` (it was not) and every
--   requirement of the case's (bank, product) is then received. Not
--   from 181's case-files path. Its only action, allowed only there:
--     advance_stage: exactly one stage forward in the bank's list, as
--       case_set_stage would move it (130's pre-submission rules
--       included), history actor NULL / role system:rules. FINAL_STAGE
--       on a closed or final-stage case or when the next stage is an
--       outcome (automation never decides one); NO_NEXT_STAGE when the
--       stage is last or not in the list. The move then fires the
--       stage_changed and stage_entered rules for the new stage (the
--       hooks skip while rules fire, so the helper fires them), but a
--       case advances at most once per transaction: a second advance is
--       ADVANCE_CHAINED (transaction-local app.case_rules_advanced).
--   The fire key is the case's stage, so re-firing at that stage
--   advances nothing again.
--
-- Rules never send anything; no rule is seeded. Every action keeps
-- 187's Compass lock (MANAGED_EXTERNALLY) and CASE_CLOSED, except that
-- advance_stage reports a closed case as FINAL_STAGE.
--
-- Restated bodies: case_rule_validate (189), case_rules_fire and
-- case_rules_on_case (187), case_doc_set_status (134). Apply in order,
-- once: re-running 134, 187 or 189 after 214 reverts these bodies.
-- Must be applied as a superuser or BYPASSRLS role.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '214 must be applied by a superuser or BYPASSRLS role (its functions write RLS-forced tables and read cases)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

-- A rule-created task has no person behind it (187's precedent for
-- case_reassign_history.actor_id): created_by and the status log's
-- actor are NULL with actor_role 'system:rules'.
ALTER TABLE public.case_tasks ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.case_task_status_log ALTER COLUMN actor_id DROP NOT NULL;

ALTER TABLE public.case_rules DROP CONSTRAINT IF EXISTS case_rules_trigger_check;
ALTER TABLE public.case_rules ADD CONSTRAINT case_rules_trigger_check
  CHECK (trigger IN ('case_opened', 'stage_changed', 'sla_overdue', 'no_activity', 'submission_attached',
                     'stage_entered', 'last_required_doc_received'));

-- ---------- 2. Validation (189's body, 214 edits marked) ----------

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
     OR p_trigger NOT IN ('case_opened', 'stage_changed', 'sla_overdue', 'no_activity', 'submission_attached',
                          'stage_entered', 'last_required_doc_received') THEN   -- 214
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
      -- cases.amount is numeric(18,2) (122); the cast is reached only
      -- for a JSON number (189).
      -- Parenthesised: plpgsql ends an IF condition at the first bare THEN.
      IF (CASE WHEN jsonb_typeof(p_conditions -> k) <> 'number' THEN true
               ELSE (p_conditions ->> k)::numeric NOT BETWEEN 0 AND 9999999999999999.99 END) THEN
        PERFORM public.case_rule_refuse(format('condition %s must be a number 0..9999999999999999.99', k));
      END IF;
    ELSIF k = 'pre_submission' THEN
      IF jsonb_typeof(p_conditions -> k) <> 'boolean' THEN
        PERFORM public.case_rule_refuse('condition pre_submission must be true or false');
      END IF;
    ELSIF k = 'days' THEN
      IF p_trigger <> 'no_activity' THEN
        PERFORM public.case_rule_refuse('condition days is for no_activity only');
      END IF;
      -- The cast is reached only once the type and pattern pass (189).
      IF (CASE WHEN jsonb_typeof(p_conditions -> k) <> 'number' OR (p_conditions ->> k) !~ '^[0-9]{1,3}$' THEN true
               ELSE (p_conditions ->> k)::int NOT BETWEEN 1 AND 365 END) THEN
        PERFORM public.case_rule_refuse('condition days must be an integer 1..365');
      END IF;
    ELSE
      PERFORM public.case_rule_refuse(format('unknown condition %s', k));
    END IF;
  END LOOP;
  IF p_trigger = 'no_activity' AND NOT (p_conditions ? 'days') THEN
    PERFORM public.case_rule_refuse('no_activity needs days');
  END IF;
  -- 214: stage_entered names the stage it fires on.
  IF p_trigger = 'stage_entered' AND NOT (p_conditions ? 'stage') THEN
    PERFORM public.case_rule_refuse('stage_entered needs stage');
  END IF;
  -- Both bounds passed the loop, so both are numbers here (189).
  IF p_conditions ? 'amount_min' AND p_conditions ? 'amount_max'
     AND (p_conditions ->> 'amount_min')::numeric > (p_conditions ->> 'amount_max')::numeric THEN
    PERFORM public.case_rule_refuse('condition amount_min must not exceed amount_max');
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
      WHEN 'create_task'        THEN ARRAY['kind', 'templateKey', 'ownerRole', 'dueHours']   -- 214
      WHEN 'start_sla'          THEN ARRAY['kind', 'timer']                                  -- 214
      WHEN 'advance_stage'      THEN ARRAY['kind']                                           -- 214
    END;
    IF v_allowed IS NULL THEN
      PERFORM public.case_rule_refuse(format('unknown action %s', v_kind));
    END IF;
    -- 214: create_task / start_sla are stage-entry actions only.
    IF v_kind IN ('create_task', 'start_sla') AND p_trigger <> 'stage_entered' THEN
      PERFORM public.case_rule_refuse(format('%s is for stage_entered only', v_kind));
    END IF;
    -- 214: advance_stage is the last-required-document action, and the
    -- only action allowed there.
    IF (v_kind = 'advance_stage') <> (p_trigger = 'last_required_doc_received') THEN
      PERFORM public.case_rule_refuse(CASE WHEN v_kind = 'advance_stage'
                                           THEN 'advance_stage is for last_required_doc_received only'
                                           ELSE format('%s is not allowed on last_required_doc_received', v_kind) END);
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
    ELSIF v_kind = 'create_task' THEN   -- 214
      IF jsonb_typeof(a -> 'templateKey') IS DISTINCT FROM 'string' OR (a ->> 'templateKey') !~ '^[a-z0-9_]{1,64}$' THEN
        PERFORM public.case_rule_refuse('templateKey must match ^[a-z0-9_]{1,64}$');
      END IF;
      IF jsonb_typeof(a -> 'ownerRole') IS DISTINCT FROM 'string' OR (a ->> 'ownerRole') NOT IN ('agent', 'coordinator') THEN
        PERFORM public.case_rule_refuse('ownerRole must be agent or coordinator');
      END IF;
      IF a ? 'dueHours'
         AND (CASE WHEN jsonb_typeof(a -> 'dueHours') <> 'number' OR (a ->> 'dueHours') !~ '^[0-9]{1,4}$' THEN true
                   ELSE (a ->> 'dueHours')::int NOT BETWEEN 1 AND 8760 END) THEN
        PERFORM public.case_rule_refuse('dueHours must be an integer 1..8760');
      END IF;
    ELSIF v_kind = 'start_sla' THEN   -- 214
      IF jsonb_typeof(a -> 'timer') IS DISTINCT FROM 'string'
         OR (a ->> 'timer') NOT IN ('customer_reply', 'bank_response', 'document_chase') THEN
        PERFORM public.case_rule_refuse('timer must be customer_reply, bank_response or document_chase');
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- ---------- 3. Action helpers (no grant; actor NULL, system:rules) ----------

CREATE OR REPLACE FUNCTION public.case_rule_act_create_task(p_case uuid, p_template_key text, p_owner_role text,
  p_due_hours integer, p_now timestamptz)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c       public.cases%ROWTYPE;
  t       public.case_task_templates%ROWTYPE;
  v_owner uuid;
  v_due   timestamptz;
  v_id    uuid;
BEGIN
  c := public.case_rule_action_case(p_case);
  SELECT * INTO t FROM public.case_task_templates x
   WHERE x.account_id = c.account_id AND x.bank_code = c.bank_code AND x.template_key = p_template_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no task template % for bank % in this workspace', p_template_key, coalesce(c.bank_code, '(none)')
      USING ERRCODE = 'no_data_found', HINT = 'TEMPLATE_NOT_FOUND';
  END IF;
  v_owner := CASE p_owner_role WHEN 'coordinator' THEN c.coordinator_id ELSE c.agent_id END;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'case % has no %', p_case, p_owner_role USING ERRCODE = 'check_violation', HINT = 'OWNER_MISSING';
  END IF;
  -- case_task_create's owner and due rules.
  IF NOT public.case_can_write(p_case, v_owner) THEN
    RAISE EXCEPTION 'user % may not own a task of case %', v_owner, p_case
      USING ERRCODE = 'check_violation', HINT = 'OWNER_INVALID';
  END IF;
  v_due := p_now + make_interval(hours => coalesce(p_due_hours, t.due_hours));
  IF v_due IS NOT NULL AND NOT isfinite(v_due) THEN
    RAISE EXCEPTION 'a task needs a finite due date' USING ERRCODE = 'check_violation', HINT = 'DUE_INVALID';
  END IF;
  INSERT INTO public.case_tasks (case_id, account_id, template_key, title, owner_id, due_at, status,
                                 created_by, created_at, updated_at)
  VALUES (p_case, c.account_id, t.template_key, t.title, v_owner, v_due, 'open', NULL, p_now, p_now)
  RETURNING id INTO v_id;
  INSERT INTO public.case_task_status_log (task_id, case_id, account_id, from_status, to_status,
                                           actor_id, actor_role, changed_at)
  VALUES (v_id, p_case, c.account_id, NULL, 'open', NULL, 'system:rules', p_now);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_rule_act_start_sla(p_case uuid, p_timer text, p_now timestamptz)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  c := public.case_rule_action_case(p_case);
  IF NOT public.case_sla_start_one(p_case, p_timer, p_now, NULL, 'system:rules') THEN
    RAISE EXCEPTION 'no SLA % configured for stage % of bank %', p_timer, c.stage, coalesce(c.bank_code, '(none)')
      USING ERRCODE = 'no_data_found', HINT = 'SLA_NOT_CONFIGURED';
  END IF;
END;
$$;

-- One stage forward, through case_set_stage's invariants for a forward,
-- non-final move; then the stage_changed / stage_entered rules of the
-- new stage. The advanced-case list is transaction-local and is rolled
-- back with a failed action's sub-transaction.
CREATE OR REPLACE FUNCTION public.case_rule_act_advance_stage(p_case uuid, p_now timestamptz)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c        public.cases%ROWTYPE;
  v_stages text[];
  v_pos    integer;
  v_next   text;
  v_done   text := coalesce(current_setting('app.case_rules_advanced', true), '');
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF c.closed_at IS NOT NULL OR c.stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN
    RAISE EXCEPTION 'case % is at final stage %', p_case, c.stage USING ERRCODE = 'check_violation', HINT = 'FINAL_STAGE';
  END IF;
  c := public.case_rule_action_case(p_case);   -- MANAGED_EXTERNALLY
  IF p_case::text = ANY (string_to_array(nullif(v_done, ''), ',')) THEN
    RAISE EXCEPTION 'case % was already advanced in this transaction', p_case
      USING ERRCODE = 'check_violation', HINT = 'ADVANCE_CHAINED';
  END IF;
  IF c.bank_code IS NOT NULL THEN
    -- Holds off case_bank_stages_set until this move commits (as case_set_stage).
    PERFORM 1 FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = c.bank_code FOR SHARE;
  END IF;
  v_stages := public.case_stages_for_bank(c.account_id, c.bank_code);
  v_pos := array_position(v_stages, c.stage);
  v_next := CASE WHEN v_pos IS NOT NULL THEN v_stages[v_pos + 1] END;
  IF v_next IS NULL THEN
    RAISE EXCEPTION 'case %: stage % has no next stage', p_case, c.stage
      USING ERRCODE = 'check_violation', HINT = 'NO_NEXT_STAGE';
  END IF;
  IF v_next IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN
    RAISE EXCEPTION 'case %: next stage % is an outcome', p_case, v_next
      USING ERRCODE = 'check_violation', HINT = 'FINAL_STAGE';
  END IF;
  -- 130's rules, with case_set_stage's hints.
  IF public.case_stage_is_presub(v_next) AND NOT public.case_stage_is_presub(c.stage) THEN
    RAISE EXCEPTION 'case %: pre-submission stage % cannot be re-entered after submission', p_case, v_next
      USING ERRCODE = 'check_violation', HINT = 'PRESUB_REENTRY';
  END IF;
  IF c.group_id IS NULL AND NOT public.case_stage_is_presub(v_next) THEN
    RAISE EXCEPTION 'case %: stage % needs a submission', p_case, v_next
      USING ERRCODE = 'check_violation', HINT = 'SUBMISSION_REQUIRED';
  END IF;
  PERFORM set_config('app.case_rules_advanced', concat_ws(',', nullif(v_done, ''), p_case::text), true);
  UPDATE public.cases x SET stage = v_next, closed_at = NULL WHERE x.id = p_case;
  INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
  VALUES (p_case, c.account_id, c.stage, v_next, c.outcome, NULL, 'system:rules');
  -- The hooks skip while rules fire, so the move's own rules fire here;
  -- like the hook, a failure there never undoes the move.
  BEGIN
    PERFORM public.case_rules_fire('stage_changed', p_case, p_now);
    PERFORM public.case_rules_fire('stage_entered', p_case, p_now, v_next);
  EXCEPTION WHEN others THEN
    RAISE WARNING 'case rules after advancing case % failed: %', p_case, SQLERRM;
  END;
  RETURN v_next;
END;
$$;

-- ---------- 4. case_rules_fire (187's body, 214 edits marked) ----------

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
    -- 214: a stage_entered rule runs only for the stage it names.
    CONTINUE WHEN p_trigger = 'stage_entered' AND (r.conditions ->> 'stage') IS DISTINCT FROM p_key;
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
            WHEN 'create_task' THEN   -- 214
              PERFORM public.case_rule_act_create_task(p_case, a ->> 'templateKey', a ->> 'ownerRole',
                                                       (a ->> 'dueHours')::int, p_now);
            WHEN 'start_sla' THEN     -- 214
              PERFORM public.case_rule_act_start_sla(p_case, a ->> 'timer', p_now);
            WHEN 'advance_stage' THEN -- 214
              PERFORM public.case_rule_act_advance_stage(p_case, p_now);
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

-- ---------- 5. Hooks ----------

-- 187's hook plus stage_entered (keyed by the stage entered).
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
  FOR i IN 1..3 LOOP
    IF i = 2 THEN   -- 214
      v_trigger := CASE WHEN TG_OP = 'UPDATE' AND NEW.stage IS DISTINCT FROM OLD.stage THEN 'stage_entered' END;
      CONTINUE WHEN v_trigger IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.case_rules r
                        WHERE r.account_id = NEW.account_id AND r.trigger = 'stage_entered' AND r.enabled
                          AND r.conditions ->> 'stage' = NEW.stage);
      BEGIN
        PERFORM public.case_rules_fire('stage_entered', NEW.id, clock_timestamp(), NEW.stage);
      EXCEPTION WHEN others THEN
        RAISE WARNING 'case rules (stage_entered) on case % failed: %', NEW.id, SQLERRM;
      END;
      CONTINUE;
    END IF;
    IF i = 3 THEN
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

-- 134's body plus the last_required_doc_received hook, which never
-- aborts the document write.
CREATE OR REPLACE FUNCTION public.case_doc_set_status(p_case uuid, p_actor uuid, p_doc_key text, p_status text,
  p_file_ref text DEFAULT NULL, p_now timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c     public.cases%ROWTYPE;
  v_now timestamptz := coalesce(p_now, now());
  v_was text;   -- 214
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  IF p_status IS NULL OR p_status NOT IN ('requested', 'received', 'rejected') THEN
    RAISE EXCEPTION 'document status % is not requested, received or rejected', p_status
      USING ERRCODE = 'check_violation', HINT = 'STATUS_INVALID';
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  -- 134: a submitted case of an account managed in Compass is edited there.
  IF c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) AND p_status IN ('received', 'rejected') THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', p_case
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.case_doc_requirements r
                  WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
                    AND lower(btrim(r.product)) = lower(btrim(c.product)) AND r.doc_key = p_doc_key) THEN
    RAISE EXCEPTION 'document % is not required for bank % / %', p_doc_key, coalesce(c.bank_code, '(none)'),
      coalesce(c.product, '(none)') USING ERRCODE = 'check_violation', HINT = 'DOC_NOT_REQUIRED';
  END IF;
  IF p_file_ref IS NOT NULL AND p_file_ref !~ '^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'file reference is not an id' USING ERRCODE = 'check_violation', HINT = 'FILE_REF_INVALID';
  END IF;
  IF p_status = 'received' AND p_file_ref IS NULL THEN
    RAISE EXCEPTION 'a received document needs its file reference'
      USING ERRCODE = 'check_violation', HINT = 'FILE_REF_REQUIRED';
  END IF;
  SELECT x.status INTO v_was FROM public.case_documents x WHERE x.case_id = p_case AND x.doc_key = p_doc_key;   -- 214
  INSERT INTO public.case_documents AS d (case_id, account_id, doc_key, status, file_ref, updated_by, updated_at)
  VALUES (p_case, c.account_id, p_doc_key, p_status, p_file_ref, p_actor, v_now)
  ON CONFLICT ON CONSTRAINT case_documents_pkey DO UPDATE
    SET status = EXCLUDED.status, file_ref = EXCLUDED.file_ref,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  -- 214: this document just became received and every requirement of
  -- the case's (bank, product) is now received: fire
  -- last_required_doc_received, keyed by the case's stage.
  IF p_status = 'received' AND v_was IS DISTINCT FROM 'received'
     AND coalesce(current_setting('app.case_rules_firing', true), '') <> 'on'
     AND EXISTS (SELECT 1 FROM public.case_rules r
                  WHERE r.account_id = c.account_id AND r.trigger = 'last_required_doc_received' AND r.enabled) THEN
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM public.case_doc_requirements r
                      WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
                        AND lower(btrim(r.product)) = lower(btrim(c.product))
                        AND NOT EXISTS (SELECT 1 FROM public.case_documents x
                                         WHERE x.case_id = p_case AND x.doc_key = r.doc_key AND x.status = 'received')) THEN
        PERFORM public.case_rules_fire('last_required_doc_received', p_case, clock_timestamp(), c.stage);
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'case rules (last_required_doc_received) on case % failed: %', p_case, SQLERRM;
    END;
  END IF;
  RETURN p_status;
END;
$$;

-- ---------- 5b. The rules' writes are not activity (187's invariant) ----------

-- 187's body plus three exclusions (marked 214). A rule's task, its
-- auto-advance and its SLA start write case_task_status_log,
-- case_stage_history and case_sla_state_log rows with actor NULL / role
-- system:rules; counting them would let a rule reset the idle clock a
-- no_activity rule reads, which 187 promises never happens. The SLA rows
-- the stage-history trigger writes for an auto-advance carry the same
-- actor, so they are left out too.
CREATE OR REPLACE FUNCTION public.case_rule_last_activity(p_case uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT max(e.at) FROM (
    SELECT h.changed_at AS at FROM public.case_stage_history h
     WHERE h.case_id = p_case
       AND NOT (h.actor_id IS NULL AND h.actor_role IS NOT DISTINCT FROM 'system:rules')   -- 214
    UNION ALL SELECT r.changed_at FROM public.case_reassign_history r
               WHERE r.case_id = p_case AND NOT (r.actor_id IS NULL AND r.actor_role IS NOT DISTINCT FROM 'system:rules')
    UNION ALL SELECT d.changed_at FROM public.case_detail_log d
               WHERE d.case_id = p_case AND NOT (d.actor_id IS NULL AND d.actor_role IS NOT DISTINCT FROM 'system:rules')
    UNION ALL SELECT l.changed_at FROM public.case_task_status_log l
               WHERE l.case_id = p_case
                 AND NOT (l.actor_id IS NULL AND l.actor_role IS NOT DISTINCT FROM 'system:rules')   -- 214
    UNION ALL SELECT n.created_at FROM public.case_notes n WHERE n.case_id = p_case AND n.author_id IS NOT NULL
    UNION ALL SELECT o.updated_at FROM public.case_documents o WHERE o.case_id = p_case
    UNION ALL SELECT b.created_at FROM public.case_bank_contacts b WHERE b.case_id = p_case
    UNION ALL SELECT s.changed_at FROM public.case_sla_state_log s
               WHERE s.case_id = p_case AND s.actor_role <> 'system'
                 AND NOT (s.actor_id IS NULL AND s.actor_role = 'system:rules')   -- 214
  ) e
$$;

-- ---------- 6. Grants ----------

REVOKE ALL ON FUNCTION
  public.case_rule_last_activity(uuid),
  public.case_rule_validate(text, jsonb, jsonb),
  public.case_rule_act_create_task(uuid, text, text, integer, timestamptz),
  public.case_rule_act_start_sla(uuid, text, timestamptz),
  public.case_rule_act_advance_stage(uuid, timestamptz),
  public.case_rules_fire(text, uuid, timestamptz, text),
  public.case_rules_on_case()
  FROM PUBLIC, anon, authenticated, service_role;
