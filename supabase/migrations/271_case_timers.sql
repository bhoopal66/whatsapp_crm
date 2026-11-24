-- ============================================================
-- 271_case_timers.sql — case timers, snooze and rules found wrong by the
-- 2026-11-23 audit
--
--  1. A snoozed case stayed hidden from everybody until its date, even
--     when the customer wrote or its stage moved. case_sla_apply_event
--     now ends a running snooze on customer_message and stage_change:
--     cases.snoozed_until becomes the event's clock, so the inbox shows
--     "snooze expired", and case_snooze_log gets the row an unsnooze
--     writes (snoozed_until NULL) with the event's actor and role and the
--     event as its reason. The actor may be nobody (the inbound pipeline,
--     the API, a rule) or an agent, so the log's actor_id is nullable and
--     its role list binds only a row that starts a snooze.
--  2. document_received restarted document_chase after the last required
--     document, so the case went overdue with nothing left to chase. With
--     no required document missing (case_inbox's documents_missing) it
--     stops; while one is missing it restarts as before.
--  3. A keyed rule (SLA overdue, no activity, stage entered) that did not
--     match still used its fire_key up, so "SLA overdue and bank = X" never
--     fired once the bank was filled in. Only a matched run counts as
--     fired; an unmatched run is recorded once per key. The unique index
--     gains `matched`: at most one matched and one unmatched run per key.
--
-- Restates case_sla_apply_event (124) and case_rules_fire (214): do not
-- re-apply 124, 187 or 214 after this file without applying this file
-- again. Additive for the previous build. Re-runnable. Asserted by
-- supabase/ci/verify-case-timers.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '271 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regclass('public.case_snooze_log') IS NULL THEN
    RAISE EXCEPTION '271: apply 185_case_views_snooze_mentions.sql first (case_snooze_log)';
  END IF;
  IF to_regprocedure('public.case_rule_act_advance_stage(uuid,timestamptz)') IS NULL THEN
    RAISE EXCEPTION '271: apply 214_case_rules_stage_automation.sql first (case_rule_act_advance_stage)';
  END IF;
END $$;

-- ---------- 1. The snooze log takes an event's row ----------

ALTER TABLE public.case_snooze_log ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.case_snooze_log
  DROP CONSTRAINT IF EXISTS case_snooze_log_role_check,
  ADD CONSTRAINT case_snooze_log_role_check
    CHECK (snoozed_until IS NULL
           OR (actor_id IS NOT NULL AND actor_role IN ('super_admin', 'admin', 'team_lead', 'coordinator')));

COMMENT ON COLUMN public.case_snooze_log.actor_id IS
  'Who snoozed or unsnoozed; NULL when a system event ended the snooze. Migration 271.';
COMMENT ON COLUMN public.case_snooze_log.reason IS
  'The person''s reason for a snooze; stage_change or customer_message when that event ended it. Migration 271.';
COMMENT ON COLUMN public.cases.snoozed_until IS
  'The case is out of the default inbox until then (NULL: not snoozed). Written only by case_snooze / case_unsnooze and, to end a running snooze, case_sla_apply_event. Migrations 185, 271.';

-- ---------- 1b. Rules: at most one matched and one unmatched run per key ----------

-- 187's index under its own name (a re-run of 187 leaves it alone). One
-- block: the index is never missing.
DO $$ BEGIN
  IF position('matched' IN coalesce(pg_get_indexdef(to_regclass('public.case_rule_runs_key_uq')), '')) = 0 THEN
    DROP INDEX IF EXISTS public.case_rule_runs_key_uq;
    CREATE UNIQUE INDEX case_rule_runs_key_uq
      ON public.case_rule_runs (rule_id, case_id, fire_key, matched) WHERE fire_key IS NOT NULL;
  END IF;
END $$;

-- A lock not had in time refused a change above: the functions below would
-- then write what the tables refuse (every swept rule, every stage change
-- of a snoozed case). psql goes on after an error, so the session turns
-- read-only first, as in 130.
DO $$ BEGIN
  IF position('matched' IN coalesce(pg_get_indexdef(to_regclass('public.case_rule_runs_key_uq')), '')) = 0
     OR EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'public.case_snooze_log'::regclass
                   AND attname = 'actor_id' AND attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = 'public.case_snooze_log'::regclass
                       AND conname = 'case_snooze_log_role_check'
                       AND position('snoozed_until IS NULL' IN pg_get_constraintdef(oid)) > 0) THEN
    PERFORM set_config('wacrm.m271_refused', 'yes', false);
    PERFORM set_config('default_transaction_read_only', 'on', false);
  ELSE
    PERFORM set_config('wacrm.m271_refused', '', false);
  END IF;
END $$;

DO $$ BEGIN
  IF current_setting('wacrm.m271_refused', true) <> '' THEN
    RAISE EXCEPTION '271 did not get its table changes and stopped before its functions (this session is now read-only): reconnect and apply it again'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

-- ---------- 2. SLA events (124's body, 271 edits marked) ----------

CREATE OR REPLACE FUNCTION public.case_sla_apply_event(p_case uuid, p_event text, p_now timestamptz,
  p_actor uuid, p_actor_role text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_timer   text;
  v_account uuid;
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('stage_change', 'customer_message', 'bank_response', 'document_received') THEN
    RAISE EXCEPTION 'SLA event % is not stage_change, customer_message, bank_response or document_received', p_event
      USING ERRCODE = 'check_violation', HINT = 'EVENT_INVALID';
  END IF;
  PERFORM 1 FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  -- 271: something happened on the case, so a running snooze ends now. Set
  -- to now rather than NULL: the inbox then shows "snooze expired".
  IF p_event IN ('stage_change', 'customer_message') THEN
    UPDATE public.cases x SET snoozed_until = p_now
     WHERE x.id = p_case AND x.snoozed_until > p_now
    RETURNING x.account_id INTO v_account;
    IF FOUND THEN
      INSERT INTO public.case_snooze_log (case_id, account_id, actor_id, actor_role, snoozed_until, reason, at)
      VALUES (p_case, v_account, p_actor, p_actor_role, NULL, p_event, p_now);
    END IF;
  END IF;
  IF p_event = 'stage_change' THEN
    FOREACH v_timer IN ARRAY ARRAY['customer_reply', 'bank_response', 'document_chase'] LOOP
      IF NOT public.case_sla_start_one(p_case, v_timer, p_now, p_actor, p_actor_role) THEN
        PERFORM public.case_sla_stop_one(p_case, v_timer, p_now, p_actor, p_actor_role);
      END IF;
    END LOOP;
  ELSIF p_event = 'customer_message' THEN
    PERFORM public.case_sla_stop_one(p_case, 'customer_reply', p_now, p_actor, p_actor_role);
  ELSIF p_event = 'bank_response' THEN
    PERFORM public.case_sla_stop_one(p_case, 'bank_response', p_now, p_actor, p_actor_role);
  ELSE  -- document_received
    -- 271: nothing left to chase (case_inbox's documents_missing is 0).
    IF NOT EXISTS (
         SELECT 1 FROM public.cases c
           JOIN public.case_doc_requirements r
             ON r.account_id = c.account_id AND r.bank_code = c.bank_code
            AND lower(btrim(r.product)) = lower(btrim(c.product))
          WHERE c.id = p_case
            AND NOT EXISTS (SELECT 1 FROM public.case_documents y
                             WHERE y.case_id = c.id AND y.doc_key = r.doc_key AND y.status = 'received'))
       OR NOT public.case_sla_start_one(p_case, 'document_chase', p_now, p_actor, p_actor_role) THEN
      PERFORM public.case_sla_stop_one(p_case, 'document_chase', p_now, p_actor, p_actor_role);
    END IF;
  END IF;
  RETURN public.case_sla_refresh_case(p_case);
END;
$$;

-- ---------- 3. Rules fire once per MATCHED key ----------

COMMENT ON TABLE public.case_rule_runs IS
  'One row per rule evaluated by case_rules_fire (matched or not); with a fire_key at most one of each. applied = [{kind, ok, refusal}]. Append-only. Migrations 187, 271.';

-- 214's body, 271 edits marked.
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
                             WHERE x.rule_id = r.rule_id AND x.case_id = p_case AND x.fire_key = p_key
                               AND x.matched);   -- 271: an unmatched run does not use the key up
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
    -- 271: one unmatched row per key, however often the sweep asks again.
    CONTINUE WHEN NOT v_matched AND p_key IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.case_rule_runs x
                   WHERE x.rule_id = r.rule_id AND x.case_id = p_case AND x.fire_key = p_key AND NOT x.matched);
    INSERT INTO public.case_rule_runs (account_id, rule_id, case_id, trigger, fire_key, matched, applied, at)
    VALUES (c.account_id, r.rule_id, p_case, p_trigger, p_key, v_matched, v_applied, p_now);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- ---------- 4. Grants ----------

REVOKE ALL ON FUNCTION
  public.case_sla_apply_event(uuid, text, timestamptz, uuid, text),
  public.case_rules_fire(text, uuid, timestamptz, text)
  FROM PUBLIC, anon, authenticated, service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
