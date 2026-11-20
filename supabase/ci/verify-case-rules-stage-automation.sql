-- Behavioural regression suite for migration 214 (package 029e): the
-- stage_entered and last_required_doc_received triggers on 187's case
-- rules engine.
--
-- Validation: a stage_entered rule needs a `stage`; create_task and
-- start_sla are refused on any other trigger, advance_stage likewise, and
-- last_required_doc_received takes advance_stage alone (RULE_INVALID).
-- stage_entered: opening a case fires nothing; entering the named stage
-- creates one task per create_task (created_by NULL, owned by the case's
-- agent or coordinator as ownerRole says, status log actor NULL /
-- system:rules) and starts the SLA timer; leaving and re-entering creates
-- no second task and restarts nothing; SLA_NOT_CONFIGURED, OWNER_MISSING
-- and TEMPLATE_NOT_FOUND are recorded in the run with nothing created; a
-- disabled rule and another workspace's rule do nothing.
-- Auto-advance: only the document that completes the (bank, product)
-- requirements fires it; the case moves exactly one stage forward with
-- one history row (actor NULL, system:rules); re-firing at that stage
-- adds nothing; never into an outcome and never on a closed case
-- (FINAL_STAGE); NO_NEXT_STAGE at the bank list's last stage; the move
-- fires the new stage's stage_changed and stage_entered rules once, and a
-- second advance in the transaction is ADVANCE_CHAINED; a lead is
-- SUBMISSION_REQUIRED while its document write stands; 181's case-files
-- checklist sync does not fire it.
-- Privileges: the case_rule_act_* helpers 214 adds are executable by no
-- API role.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block), and
-- failing assertions are named in the final exception. The advance guard
-- (app.case_rules_advanced) is transaction-local and spans the whole
-- block, so every scenario uses a case of its own.

DO $verify$
DECLARE
  u_own   UUID := '00000000-0000-4000-8000-000000214001';
  u_ag    UUID := '00000000-0000-4000-8000-000000214002';
  u_co    UUID := '00000000-0000-4000-8000-000000214003';
  u_bown  UUID := '00000000-0000-4000-8000-000000214004';
  a       UUID;
  b       UUID;
  wa      UUID;
  wb      UUID;
  ca      UUID;
  cb      UUID;
  k       UUID;
  r       UUID;
  r2      UUID;
  r3      UUID;
  f_dir   UUID;
  f_doc   UUID;
  f_file  UUID;
  v_txt   TEXT;
  st      TEXT;
  se_act  JSONB := '[{"kind":"create_task","templateKey":"chase_ack","ownerRole":"agent"},
                     {"kind":"create_task","templateKey":"review_docs","ownerRole":"coordinator"},
                     {"kind":"start_sla","timer":"bank_response"}]';
  adv     JSONB := '[{"kind":"advance_stage"}]';
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- case_rule_validate's verdict: 'ACCEPTED' or the refusal's hint.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sa_validate(p_trigger text, p_cond jsonb, p_actions jsonb)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE h text;
    BEGIN
      PERFORM public.case_rule_validate(p_trigger, p_cond, p_actions);
      RETURN 'ACCEPTED';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
      RETURN coalesce(nullif(h, ''), SQLSTATE);
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sa_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- A submitted case (case_open puts it at Submitted) with agent and coordinator set.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sa_case(p_acct uuid, p_wa uuid, p_contact uuid, p_agent uuid, p_coord uuid,
                                    p_bank text, p_product text, p_ref text)
    RETURNS uuid LANGUAGE plpgsql AS $body$
    DECLARE g uuid; k uuid;
    BEGIN
      g := (SELECT x.group_id FROM public.sg_open(p_acct, p_ref, p_contact, p_wa, p_ref, NULL,
             jsonb_build_array(jsonb_build_object('user_id', p_agent, 'label', 'agent')), NULL) x);
      k := (SELECT x.case_id FROM public.case_open(g, p_bank, NULL, p_product, NULL, NULL) x);
      UPDATE public.cases SET agent_id = p_agent, coordinator_id = p_coord WHERE id = k;
      RETURN k;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sa_rule(p_acct uuid, p_by uuid, p_trigger text, p_cond jsonb, p_actions jsonb,
                                    p_enabled boolean DEFAULT true)
    RETURNS uuid LANGUAGE sql AS $body$
      INSERT INTO public.case_rules (account_id, name, enabled, trigger, conditions, actions, created_by)
      VALUES (p_acct, 'verify 214', p_enabled, p_trigger, p_cond, p_actions, p_by) RETURNING rule_id
    $body$
  $fn$;
  -- The refusal of a rule's first action on a case (latest run).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sa_refusal(p_rule uuid, p_case uuid) RETURNS text LANGUAGE sql AS $body$
      SELECT x.applied -> 0 ->> 'refusal' FROM public.case_rule_runs x
       WHERE x.rule_id = p_rule AND x.case_id = p_case ORDER BY x.id DESC LIMIT 1
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sa_runs(p_rule uuid, p_case uuid) RETURNS int LANGUAGE sql AS $body$
      SELECT count(*)::int FROM public.case_rule_runs x WHERE x.rule_id = p_rule AND x.case_id = p_case
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sa_moves(p_case uuid) RETURNS int LANGUAGE sql AS $body$
      SELECT count(*)::int FROM public.case_stage_history x WHERE x.case_id = p_case AND x.actor_role = 'system:rules'
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_own,  'sa214-own@example.invalid'),
    (u_ag,   'sa214-agent@example.invalid'),
    (u_co,   'sa214-coord@example.invalid'),
    (u_bown, 'sa214-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM public.profiles WHERE user_id = u_own;
  SELECT account_id INTO b FROM public.profiles WHERE user_id = u_bown;
  UPDATE public.profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (u_ag, u_co);
  INSERT INTO public.whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
    VALUES (u_own, a, 'whapi', 'SA214-A', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO public.whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
    VALUES (u_bown, b, 'whapi', 'SA214-B', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO public.contacts (account_id, user_id, phone, name) VALUES (a, u_own, '971500214101', 'SA one')
    RETURNING id INTO ca;
  INSERT INTO public.contacts (account_id, user_id, phone, name) VALUES (b, u_bown, '971500214102', 'SA bee')
    RETURNING id INTO cb;
  INSERT INTO public.case_banks (account_id, code, name)
    VALUES (a, 'ADCB', 'ADCB'), (b, 'ADCB', 'ADCB'), (a, 'SA214N', 'Short list bank') ON CONFLICT DO NOTHING;
  -- A valid list whose last stage is not an outcome (the check wants the
  -- four outcomes present, not last).
  INSERT INTO public.case_bank_stages (account_id, bank_code, position, stage)
  SELECT a, 'SA214N', o, s FROM unnest(ARRAY['Interested', 'Data collection', 'Review', 'Submitted', 'Approved',
                                            'Declined', 'Withdrawn', 'Closed', 'Final review']) WITH ORDINALITY x(s, o);
  INSERT INTO public.case_task_templates (account_id, bank_code, template_key, title, position, due_hours) VALUES
    (a, 'ADCB', 'chase_ack', 'Chase acknowledgement', 1, 24),
    (a, 'ADCB', 'review_docs', 'Review documents', 2, 48),
    (b, 'ADCB', 'chase_ack', 'Chase acknowledgement', 1, 24),
    (b, 'ADCB', 'review_docs', 'Review documents', 2, 48);
  INSERT INTO public.case_sla_config (account_id, bank_code, stage, timer, amount, unit) VALUES
    (a, 'ADCB', 'Bank acknowledged', 'bank_response', 2, 'days'),
    (b, 'ADCB', 'Bank acknowledged', 'bank_response', 2, 'days');
  INSERT INTO public.case_doc_requirements (account_id, bank_code, product, doc_key, label, position)
  SELECT acc, bank, p, d, d, o
    FROM (VALUES (a, 'ADCB'), (b, 'ADCB'), (a, 'SA214N')) ab(acc, bank),
         unnest(ARRAY['p_adv', 'p_fin', 'p_last', 'p_off', 'p_chain', 'p_ws', 'p_lead', 'p_files']) p,
         (VALUES ('passport', 1), ('bank_stmt', 2)) q(d, o);

  -- ---------- validation ----------
  DECLARE
    rec RECORD;
  BEGIN
    FOR rec IN SELECT * FROM (VALUES
      ('stage_entered without a stage', 'stage_entered', '{}', se_act),
      ('create_task on stage_changed', 'stage_changed', '{"stage":"Bank acknowledged"}',
         '[{"kind":"create_task","templateKey":"chase_ack","ownerRole":"agent"}]'::jsonb),
      ('start_sla on case_opened', 'case_opened', '{}', '[{"kind":"start_sla","timer":"bank_response"}]'::jsonb),
      ('start_sla with an unknown timer', 'stage_entered', '{"stage":"Bank acknowledged"}',
         '[{"kind":"start_sla","timer":"x"}]'::jsonb),
      ('create_task with an unknown ownerRole', 'stage_entered', '{"stage":"Bank acknowledged"}',
         '[{"kind":"create_task","templateKey":"chase_ack","ownerRole":"me"}]'::jsonb),
      ('advance_stage on stage_changed', 'stage_changed', '{}', adv),
      ('advance_stage on stage_entered', 'stage_entered', '{"stage":"Submitted"}', adv),
      ('add_note on last_required_doc_received', 'last_required_doc_received', '{}',
         '[{"kind":"add_note","body":"x"}]'::jsonb),
      ('set_priority beside advance_stage', 'last_required_doc_received', '{}',
         '[{"kind":"advance_stage"},{"kind":"set_priority","priority":"high"}]'::jsonb),
      ('advance_stage with a target', 'last_required_doc_received', '{}',
         '[{"kind":"advance_stage","to":"Approved"}]'::jsonb)
    ) q(name, trig, cond, act) LOOP
      v_txt := pg_temp.sa_validate(rec.trig, rec.cond::jsonb, rec.act);
      n := n + 1; failed := failed || pg_temp.sa_ok(v_txt = 'RULE_INVALID',
        format('validate: %s not refused RULE_INVALID (%s)', rec.name, v_txt));
    END LOOP;
  END;
  v_txt := pg_temp.sa_validate('stage_entered', '{"stage":"Bank acknowledged"}', se_act);
  n := n + 1; failed := failed || pg_temp.sa_ok(v_txt = 'ACCEPTED',
    format('validate: a good stage_entered rule refused (%s)', v_txt));
  v_txt := pg_temp.sa_validate('last_required_doc_received', '{"product":"p_adv"}', adv);
  n := n + 1; failed := failed || pg_temp.sa_ok(v_txt = 'ACCEPTED',
    format('validate: a good last_required_doc_received rule refused (%s)', v_txt));

  -- ---------- stage_entered ----------
  -- Opening a case fires nothing, even a rule for the stage it opens at.
  r := pg_temp.sa_rule(a, u_own, 'stage_entered', '{"product":"p_open","stage":"Submitted"}',
                       '[{"kind":"create_task","templateKey":"chase_ack","ownerRole":"agent"}]');
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_open', 'SA214-OPEN');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    pg_temp.sa_runs(r, k) = 0 AND NOT EXISTS (SELECT 1 FROM public.case_tasks WHERE case_id = k),
    'opening a case fired a stage_entered rule');

  -- Entering the stage: one task per create_task, owner per ownerRole, and the timer.
  r := pg_temp.sa_rule(a, u_own, 'stage_entered', '{"product":"p_se","stage":"Bank acknowledged"}', se_act);
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_se', 'SA214-SE');
  n := n + 1; failed := failed || pg_temp.sa_ok(pg_temp.sa_runs(r, k) = 0,
    'a stage_entered rule ran before its stage was entered');
  v_txt := public.case_set_stage(k, u_own, 'Bank acknowledged')::text;
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT count(*) FROM public.case_tasks WHERE case_id = k) = 2
    AND (SELECT count(*) FROM public.case_tasks WHERE case_id = k AND template_key = 'chase_ack'
           AND owner_id = u_ag AND created_by IS NULL AND due_at IS NOT NULL) = 1
    AND (SELECT count(*) FROM public.case_tasks WHERE case_id = k AND template_key = 'review_docs'
           AND owner_id = u_co AND created_by IS NULL) = 1,
    format('stage entry tasks wrong: %s', (SELECT jsonb_agg(jsonb_build_array(template_key, owner_id, created_by))
                                             FROM public.case_tasks WHERE case_id = k)));
  n := n + 1; failed := failed || pg_temp.sa_ok(
    EXISTS (SELECT 1 FROM public.case_task_status_log WHERE case_id = k)
    AND NOT EXISTS (SELECT 1 FROM public.case_task_status_log WHERE case_id = k
                     AND (actor_id IS NOT NULL OR actor_role IS DISTINCT FROM 'system:rules')),
    'a rule-created task logged a person');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT count(*) FROM public.case_sla_timers WHERE case_id = k AND timer = 'bank_response'
       AND stage = 'Bank acknowledged' AND stopped_at IS NULL) = 1
    AND (SELECT count(*) FROM public.case_sla_state_log WHERE case_id = k AND timer = 'bank_response'
           AND actor_id IS NULL AND actor_role = 'system:rules') = 1,
    'stage entry did not start the SLA timer as system:rules');
  -- 187's invariant: the rule's task and timer (written at the rule's later clock_timestamp)
  -- are not activity, so the idle clock stays at the person's move (transaction time).
  n := n + 1; failed := failed || pg_temp.sa_ok(
    public.case_rule_last_activity(k) < (SELECT max(changed_at) FROM public.case_task_status_log WHERE case_id = k)
    AND public.case_rule_last_activity(k) < (SELECT max(changed_at) FROM public.case_sla_state_log
                                              WHERE case_id = k AND actor_role = 'system:rules'),
    'a rule-created task or timer counted as case activity');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT jsonb_agg(jsonb_build_array(fire_key, matched, applied)) FROM public.case_rule_runs
      WHERE rule_id = r AND case_id = k)
    = '[["Bank acknowledged", true, [{"kind":"create_task","ok":true,"refusal":null},
         {"kind":"create_task","ok":true,"refusal":null},{"kind":"start_sla","ok":true,"refusal":null}]]]'::jsonb,
    format('stage entry run wrong: %s', (SELECT jsonb_agg(applied) FROM public.case_rule_runs WHERE case_id = k)));
  -- Leave and re-enter: no second task, no restart, no second run.
  v_txt := public.case_set_stage(k, u_own, 'Documents requested')::text;
  v_txt := public.case_set_stage(k, u_own, 'Bank acknowledged')::text;
  n := n + 1; failed := failed || pg_temp.sa_ok((SELECT count(*) FROM public.case_tasks WHERE case_id = k) = 2,
    format('re-entering the stage created tasks (%s)', (SELECT count(*) FROM public.case_tasks WHERE case_id = k)));
  n := n + 1; failed := failed || pg_temp.sa_ok(
    pg_temp.sa_runs(r, k) = 1
    AND (SELECT count(*) FROM public.case_sla_state_log WHERE case_id = k AND actor_role = 'system:rules') = 1,
    're-entering the stage ran the rule again or restarted the timer');

  -- Refusals recorded in the run, nothing created.
  r := pg_temp.sa_rule(a, u_own, 'stage_entered', '{"product":"p_nc","stage":"Bank acknowledged"}',
                       '[{"kind":"start_sla","timer":"document_chase"}]');
  r2 := pg_temp.sa_rule(a, u_own, 'stage_entered', '{"product":"p_nc","stage":"Bank acknowledged"}',
                        '[{"kind":"create_task","templateKey":"chase_ack","ownerRole":"coordinator"}]');
  r3 := pg_temp.sa_rule(a, u_own, 'stage_entered', '{"product":"p_nc","stage":"Bank acknowledged"}',
                        '[{"kind":"create_task","templateKey":"nope","ownerRole":"agent"}]');
  k := pg_temp.sa_case(a, wa, ca, u_ag, NULL, 'ADCB', 'p_nc', 'SA214-NC');
  v_txt := public.case_set_stage(k, u_own, 'Bank acknowledged')::text;
  n := n + 1; failed := failed || pg_temp.sa_ok(pg_temp.sa_refusal(r, k) = 'SLA_NOT_CONFIGURED'
    AND NOT EXISTS (SELECT 1 FROM public.case_sla_timers WHERE case_id = k AND timer = 'document_chase'),
    format('start_sla without config: %s', pg_temp.sa_refusal(r, k)));
  n := n + 1; failed := failed || pg_temp.sa_ok(pg_temp.sa_refusal(r2, k) = 'OWNER_MISSING',
    format('create_task with no coordinator: %s', pg_temp.sa_refusal(r2, k)));
  n := n + 1; failed := failed || pg_temp.sa_ok(pg_temp.sa_refusal(r3, k) = 'TEMPLATE_NOT_FOUND'
    AND NOT EXISTS (SELECT 1 FROM public.case_tasks WHERE case_id = k),
    format('create_task with no template: %s', pg_temp.sa_refusal(r3, k)));

  -- A disabled rule, and another workspace's rule, do nothing.
  r := pg_temp.sa_rule(a, u_own, 'stage_entered', '{"product":"p_seoff","stage":"Bank acknowledged"}', se_act, false);
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_seoff', 'SA214-SEOFF');
  v_txt := public.case_set_stage(k, u_own, 'Bank acknowledged')::text;
  n := n + 1; failed := failed || pg_temp.sa_ok(pg_temp.sa_runs(r, k) = 0
    AND NOT EXISTS (SELECT 1 FROM public.case_tasks WHERE case_id = k), 'a disabled stage_entered rule acted');
  r := pg_temp.sa_rule(a, u_own, 'stage_entered', '{"product":"p_sews","stage":"Bank acknowledged"}', se_act);
  k := pg_temp.sa_case(b, wb, cb, u_bown, NULL, 'ADCB', 'p_sews', 'SA214-SEWS');
  v_txt := public.case_set_stage(k, u_bown, 'Bank acknowledged')::text;
  n := n + 1; failed := failed || pg_temp.sa_ok(
    NOT EXISTS (SELECT 1 FROM public.case_rule_runs WHERE case_id = k)
    AND NOT EXISTS (SELECT 1 FROM public.case_tasks WHERE case_id = k),
    'a stage_entered rule acted on another workspace''s case');

  -- ---------- last_required_doc_received / advance_stage ----------
  r := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_adv"}', adv);
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_adv', 'SA214-ADV');
  v_txt := public.case_set_stage(k, u_own, 'Documents requested')::text;
  v_txt := public.case_doc_set_status(k, u_own, 'passport', 'received', 'f-passport');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT stage FROM public.cases WHERE id = k) = 'Documents requested' AND pg_temp.sa_runs(r, k) = 0,
    'an incomplete document set fired the advance');
  v_txt := public.case_doc_set_status(k, u_own, 'bank_stmt', 'received', 'f-bank_stmt');
  n := n + 1; failed := failed || pg_temp.sa_ok((SELECT stage FROM public.cases WHERE id = k) = 'Documents received',
    format('the last document did not advance one stage (%s)', (SELECT stage FROM public.cases WHERE id = k)));
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT jsonb_agg(jsonb_build_array(from_stage, to_stage, actor_id, actor_role)) FROM public.case_stage_history
      WHERE case_id = k AND actor_role = 'system:rules')
    = '[["Documents requested", "Documents received", null, "system:rules"]]'::jsonb,
    'the advance wrote no system:rules history row, or several');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT jsonb_agg(jsonb_build_array(fire_key, matched, applied)) FROM public.case_rule_runs WHERE rule_id = r)
    = '[["Documents requested", true, [{"kind":"advance_stage","ok":true,"refusal":null}]]]'::jsonb,
    'the advance run is not keyed by the stage it left');
  -- Re-saving a received document and re-firing at the old stage add nothing.
  v_txt := public.case_doc_set_status(k, u_own, 'bank_stmt', 'received', 'f-bank_stmt');
  v_txt := public.case_rules_fire('last_required_doc_received', k, clock_timestamp(), 'Documents requested')::text;
  n := n + 1; failed := failed || pg_temp.sa_ok(
    pg_temp.sa_runs(r, k) = 1 AND pg_temp.sa_moves(k) = 1
    AND (SELECT stage FROM public.cases WHERE id = k) = 'Documents received',
    'a re-fire at the same stage advanced or ran again');

  -- Never into an outcome, never on a closed case.
  r := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_fin"}', adv);
  FOREACH st IN ARRAY ARRAY['Withdrawn', 'Approved', 'Query answered'] LOOP
    k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_fin', 'SA214-FIN-' || st);
    v_txt := public.case_set_stage(k, u_own, st, CASE WHEN st IN ('Withdrawn', 'Approved') THEN st END)::text;
    v_txt := public.case_doc_set_status(k, u_own, 'passport', 'received', 'f-passport');
    v_txt := public.case_doc_set_status(k, u_own, 'bank_stmt', 'received', 'f-bank_stmt');
    n := n + 1; failed := failed || pg_temp.sa_ok(
      (SELECT stage FROM public.cases WHERE id = k) = st AND pg_temp.sa_moves(k) = 0
      AND pg_temp.sa_refusal(r, k) = 'FINAL_STAGE',
      format('advance at %s: %s, stage %s', st, pg_temp.sa_refusal(r, k), (SELECT stage FROM public.cases WHERE id = k)));
  END LOOP;

  -- NO_NEXT_STAGE at the bank list's last stage.
  r := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_last"}', adv);
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'SA214N', 'p_last', 'SA214-LAST');
  v_txt := public.case_set_stage(k, u_own, 'Final review')::text;
  v_txt := public.case_doc_set_status(k, u_own, 'passport', 'received', 'f-passport');
  v_txt := public.case_doc_set_status(k, u_own, 'bank_stmt', 'received', 'f-bank_stmt');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT stage FROM public.cases WHERE id = k) = 'Final review' AND pg_temp.sa_refusal(r, k) = 'NO_NEXT_STAGE',
    format('advance at the last stage: %s', pg_temp.sa_refusal(r, k)));

  -- A disabled rule does nothing.
  r := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_off"}', adv, false);
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_off', 'SA214-AOFF');
  v_txt := public.case_set_stage(k, u_own, 'Documents requested')::text;
  v_txt := public.case_doc_set_status(k, u_own, 'passport', 'received', 'f-passport');
  v_txt := public.case_doc_set_status(k, u_own, 'bank_stmt', 'received', 'f-bank_stmt');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT stage FROM public.cases WHERE id = k) = 'Documents requested' AND pg_temp.sa_runs(r, k) = 0,
    'a disabled advance rule acted');

  -- The move fires the new stage's rules once; a second advance is ADVANCE_CHAINED.
  r := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_chain"}', adv);
  r2 := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_chain"}', adv);
  r3 := pg_temp.sa_rule(a, u_own, 'stage_changed', '{"product":"p_chain","stage":"Documents received"}',
                        '[{"kind":"add_note","body":"docs complete"}]');
  f_dir := pg_temp.sa_rule(a, u_own, 'stage_entered', '{"product":"p_chain","stage":"Documents received"}',
                           '[{"kind":"create_task","templateKey":"review_docs","ownerRole":"coordinator"}]');
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_chain', 'SA214-CHAIN');
  v_txt := public.case_set_stage(k, u_own, 'Documents requested')::text;
  v_txt := public.case_doc_set_status(k, u_own, 'passport', 'received', 'f-passport');
  v_txt := public.case_doc_set_status(k, u_own, 'bank_stmt', 'received', 'f-bank_stmt');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    pg_temp.sa_runs(f_dir, k) = 1
    AND (SELECT count(*) FROM public.case_tasks WHERE case_id = k AND template_key = 'review_docs' AND owner_id = u_co) = 1
    AND (SELECT count(*) FROM public.case_rule_runs WHERE rule_id = r3 AND case_id = k AND matched) = 1,
    format('the advance did not fire the new stage''s rules once: %s',
           (SELECT jsonb_agg(jsonb_build_array(trigger, applied)) FROM public.case_rule_runs WHERE case_id = k)));
  n := n + 1; failed := failed || pg_temp.sa_ok(
    -- Rules created in one transaction share created_at, so which of the
    -- two runs first is the rule_id order: one advances, the other is refused.
    (SELECT array_agg(y ORDER BY y) FROM (SELECT coalesce(pg_temp.sa_refusal(x, k), 'ok') y
       FROM unnest(ARRAY[r, r2]) x) z) = ARRAY['ADVANCE_CHAINED', 'ok']
    AND pg_temp.sa_moves(k) = 1
    AND (SELECT stage FROM public.cases WHERE id = k) = 'Documents received',
    format('a second advance in one transaction: %s / %s, stage %s', pg_temp.sa_refusal(r, k), pg_temp.sa_refusal(r2, k),
           (SELECT stage FROM public.cases WHERE id = k)));

  -- Another workspace's rule never advances a case.
  r := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_ws"}', adv);
  k := pg_temp.sa_case(b, wb, cb, u_bown, NULL, 'ADCB', 'p_ws', 'SA214-AWS');
  v_txt := public.case_set_stage(k, u_bown, 'Documents requested')::text;
  v_txt := public.case_doc_set_status(k, u_bown, 'passport', 'received', 'f-passport');
  v_txt := public.case_doc_set_status(k, u_bown, 'bank_stmt', 'received', 'f-bank_stmt');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT stage FROM public.cases WHERE id = k) = 'Documents requested'
    AND NOT EXISTS (SELECT 1 FROM public.case_rule_runs WHERE case_id = k),
    'an advance rule acted on another workspace''s case');

  -- A lead never leaves the pre-submission stages; the document write stands.
  r := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_lead"}', adv);
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_lead', 'SA214-LEAD');
  UPDATE public.cases SET group_id = NULL, stage = 'Review' WHERE id = k;
  v_txt := public.case_doc_set_status(k, u_own, 'passport', 'received', 'f-passport');
  v_txt := public.case_doc_set_status(k, u_own, 'bank_stmt', 'received', 'f-bank_stmt');
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT stage FROM public.cases WHERE id = k) = 'Review' AND pg_temp.sa_refusal(r, k) = 'SUBMISSION_REQUIRED',
    format('a lead advanced: %s', pg_temp.sa_refusal(r, k)));
  n := n + 1; failed := failed || pg_temp.sa_ok(
    (SELECT count(*) FROM public.case_documents WHERE case_id = k AND status = 'received') = 2,
    'a refused advance undid the lead''s document write');

  -- 181's checklist sync marks the last document received without firing.
  r := pg_temp.sa_rule(a, u_own, 'last_required_doc_received', '{"product":"p_files"}', adv);
  k := pg_temp.sa_case(a, wa, ca, u_ag, u_co, 'ADCB', 'p_files', 'SA214-FILES');
  v_txt := public.case_set_stage(k, u_own, 'Documents requested')::text;
  v_txt := public.case_doc_set_status(k, u_own, 'passport', 'received', 'f-passport');
  INSERT INTO public.case_account_settings (account_id, files_checklist_sync) VALUES (a, true)
  ON CONFLICT (account_id) DO UPDATE SET files_checklist_sync = true;
  INSERT INTO public.customer_doc_folders (account_id, contact_id, ref) VALUES (a, ca, 'TC-SA214')
  ON CONFLICT (contact_id) DO UPDATE SET ref = public.customer_doc_folders.ref RETURNING id INTO f_dir;
  INSERT INTO public.customer_documents (account_id, folder_id, contact_id, source, kind, media_url, received_at)
  VALUES (a, f_dir, ca, 'chat', 'document', 'https://example.invalid/sa214.pdf', now()) RETURNING id INTO f_doc;
  INSERT INTO public.case_document_files (account_id, case_id, customer_document_id, doc_key, version, status,
                                          renamed_name, classified_at)
  VALUES (a, k, f_doc, 'bank_stmt', 1, 'pending_checks', 'sa214.pdf', now()) RETURNING id INTO f_file;
  v_txt := public.case_document_file_check_result(f_file, 'bank_stmt', 0, '[{"name":"readable","ok":true}]', 1, NULL);
  n := n + 1; failed := failed || pg_temp.sa_ok(
    v_txt = 'passed'
    AND (SELECT count(*) FROM public.case_documents WHERE case_id = k AND status = 'received') = 2
    AND (SELECT stage FROM public.cases WHERE id = k) = 'Documents requested' AND pg_temp.sa_runs(r, k) = 0,
    format('the case-files path: %s, stage %s, runs %s', v_txt, (SELECT stage FROM public.cases WHERE id = k),
           pg_temp.sa_runs(r, k)));

  -- ---------- privileges ----------
  FOREACH st IN ARRAY ARRAY['case_rule_act_create_task(uuid,text,text,integer,timestamptz)',
                           'case_rule_act_start_sla(uuid,text,timestamptz)',
                           'case_rule_act_advance_stage(uuid,timestamptz)'] LOOP
    n := n + 1; failed := failed || pg_temp.sa_ok(
      NOT has_function_privilege('service_role', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('anon', ('public.' || st)::regprocedure, 'EXECUTE'),
      format('the internal %s is executable by an API role', st));
  END LOOP;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT214', MESSAGE = 'verify-case-rules-stage-automation rollback';
  EXCEPTION WHEN SQLSTATE 'ZT214' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case rules stage automation verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case rules stage automation verification: all % checks passed', n;
END
$verify$;
