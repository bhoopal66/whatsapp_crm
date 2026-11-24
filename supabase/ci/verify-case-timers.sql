-- Behavioural regression suite for migration 271: an event ends a snooze,
-- the last required document stops the chase, and a rule that did not match
-- fires later. ONE statement; the fixtures are rolled back by a sentinel.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000271001';
  u_agent  UUID := '00000000-0000-4000-8000-000000271002';
  u_coord  UUID := '00000000-0000-4000-8000-000000271003';
  a_acct   UUID;
  wa       UUID;
  ca       UUID;
  ga       UUID;
  k1       UUID;
  r1       UUID;
  st       TEXT;
  t0       TIMESTAMPTZ := date_trunc('second', now()) - interval '10 days';
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_ok(p_ok boolean, p_msg text) RETURNS text LANGUAGE sql AS
    $body$ SELECT CASE WHEN p_ok IS TRUE THEN NULL ELSE p_msg END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN SQLSTATE;
    END $body$
  $fn$;
  -- The inbox's answer for a case: shown or hidden, then expired or not.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_inbox(p_actor uuid, p_acct uuid, p_case uuid, p_now timestamptz) RETURNS text
    LANGUAGE sql VOLATILE AS $body$
      SELECT coalesce((SELECT CASE WHEN x.snooze_expired THEN 'shown,expired' ELSE 'shown' END
                         FROM public.case_inbox(p_actor, p_acct, '{}', p_now, 200) x WHERE x.case_id = p_case), 'hidden')
    $body$
  $fn$;
  -- The rows of the snooze log, then the last one: until, actor, role, reason, at.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_log(p_case uuid, p_t0 timestamptz) RETURNS text LANGUAGE sql VOLATILE AS $body$
      SELECT count(*) OVER () || ':' || coalesce((x.snoozed_until - p_t0)::text, '-') || ':'
             || coalesce(x.actor_id::text, '-') || ':' || x.actor_role || ':' || coalesce(x.reason, '-') || ':'
             || (x.at - p_t0)::text
        FROM public.case_snooze_log x WHERE x.case_id = p_case ORDER BY x.id DESC LIMIT 1
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_chase(p_case uuid, p_t0 timestamptz) RETURNS text LANGUAGE sql VOLATILE AS $body$
      SELECT coalesce((SELECT CASE WHEN x.stopped_at IS NULL THEN 'running from ' || (x.started_at - p_t0)::text
                                   ELSE 'stopped at ' || (x.stopped_at - p_t0)::text END
        FROM public.case_sla_timers x WHERE x.case_id = p_case AND x.timer = 'document_chase'), 'none')
    $body$
  $fn$;
  -- The runs of a rule: matched, in order.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ct_runs(p_rule uuid) RETURNS text LANGUAGE sql VOLATILE AS $body$
      SELECT coalesce(string_agg(x.matched::text, ',' ORDER BY x.id), 'none')
        FROM public.case_rule_runs x WHERE x.rule_id = p_rule
    $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ctm-owner@example.invalid'), (u_agent, 'ctm-agent@example.invalid'),
    (u_coord, 'ctm-coord@example.invalid');
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_coord);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CTM-1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500271001', 'CTM one')
    RETURNING id INTO ca;
  ga := (SELECT o.group_id FROM sg_open(a_acct, 'CTM-A', ca, wa, 'a', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                      jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) o);
  k1 := (SELECT x.case_id FROM case_open(ga, 'CTMB', 'Bank CTM', 'Loan', 1000, NULL) x);
  INSERT INTO case_doc_requirements (account_id, bank_code, product, doc_key, label, position) VALUES
    (a_acct, 'CTMB', 'Loan', 'passport', 'Passport', 1), (a_acct, 'CTMB', ' loan ', 'visa', 'Visa', 2);
  SELECT stage INTO st FROM cases WHERE id = k1;

  -- ---------- 1. An event ends a running snooze ----------
  PERFORM case_snooze(u_owner, k1, t0 + interval '5 days', 'later', t0);
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_inbox(u_owner, a_acct, k1, t0 + interval '30 minutes') = 'hidden',
    'fixture: a snoozed case is hidden')); n := n + 1;
  -- not on a bank response
  PERFORM case_sla_event_system(k1, 'bank_response', t0 + interval '40 minutes');
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_inbox(u_owner, a_acct, k1, t0 + interval '50 minutes') = 'hidden',
    'a bank response ended the snooze')); n := n + 1;
  PERFORM case_sla_event_system(k1, 'customer_message', t0 + interval '1 hour');
  failed := array_append(failed, pg_temp.ct_ok(
    (SELECT snoozed_until FROM cases WHERE id = k1) = t0 + interval '1 hour'
    AND pg_temp.ct_inbox(u_owner, a_acct, k1, t0 + interval '1 hour') = 'shown,expired',
    'a customer message did not wake the case: ' || pg_temp.ct_inbox(u_owner, a_acct, k1, t0 + interval '1 hour')));
  n := n + 1;
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_log(k1, t0) = '2:-:-:system:customer_message:01:00:00',
    'the customer message''s log row: ' || pg_temp.ct_log(k1, t0))); n := n + 1;
  -- a second message has nothing to end
  PERFORM case_sla_event_system(k1, 'customer_message', t0 + interval '2 hours');
  failed := array_append(failed, pg_temp.ct_ok(
    (SELECT snoozed_until FROM cases WHERE id = k1) = t0 + interval '1 hour'
    AND pg_temp.ct_log(k1, t0) = '2:-:-:system:customer_message:01:00:00',
    'a second customer message moved the snooze')); n := n + 1;
  -- an agent may report the message, though an agent may not snooze
  PERFORM case_snooze(u_coord, k1, t0 + interval '5 days', NULL, t0 + interval '3 hours');
  PERFORM case_sla_event(k1, u_agent, 'customer_message', t0 + interval '4 hours');
  failed := array_append(failed, pg_temp.ct_ok(
    pg_temp.ct_log(k1, t0) = '4:-:' || u_agent || ':agent:customer_message:04:00:00'
    AND pg_temp.ct_inbox(u_owner, a_acct, k1, t0 + interval '4 hours') = 'shown,expired',
    'the agent''s report: ' || pg_temp.ct_log(k1, t0))); n := n + 1;
  -- the stage moves (the API's move, no actor); the trigger's clock is now()
  PERFORM case_snooze(u_owner, k1, now() + interval '5 days', NULL, now() - interval '1 hour');
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_inbox(u_owner, a_acct, k1, now()) = 'hidden',
    'fixture: snoozed again')); n := n + 1;
  PERFORM case_sync_from_submission(ga, now(), '{"stage":"Query raised"}'::jsonb);
  failed := array_append(failed, pg_temp.ct_ok(
    (SELECT stage <> st AND snoozed_until = now() FROM cases WHERE id = k1)
    AND pg_temp.ct_inbox(u_owner, a_acct, k1, now() + interval '1 minute') = 'shown,expired'
    AND pg_temp.ct_log(k1, now()) = '6:-:-:api:stage_change:00:00:00',
    'the stage change did not wake the case: ' || pg_temp.ct_log(k1, now()))); n := n + 1;
  -- only a person with a snoozing role starts one
  failed := array_append(failed, pg_temp.ct_ok(
    pg_temp.ct_try(format('INSERT INTO case_snooze_log (case_id, account_id, actor_id, actor_role, snoozed_until, at)
      VALUES (%L, %L, NULL, ''admin'', now(), now())', k1, a_acct)) = '23514'
    AND pg_temp.ct_try(format('INSERT INTO case_snooze_log (case_id, account_id, actor_id, actor_role, snoozed_until, at)
      VALUES (%L, %L, %L, ''agent'', now(), now())', k1, a_acct, u_agent)) = '23514',
    'a log row starting a snooze has no person with a snoozing role')); n := n + 1;

  -- ---------- 2. The document chase ----------
  SELECT stage INTO st FROM cases WHERE id = k1;
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'CTMB', st, 'document_chase', 2, 'days');
  PERFORM case_sla_timer(k1, u_coord, 'document_chase', 'start', t0);
  PERFORM case_doc_set_status(k1, u_agent, 'passport', 'received', 'f-1', t0 + interval '1 hour');
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_chase(k1, t0) = 'running from 01:00:00',
    'a document with one still missing restarts the chase: ' || pg_temp.ct_chase(k1, t0))); n := n + 1;
  PERFORM case_doc_set_status(k1, u_agent, 'visa', 'received', 'f-2', t0 + interval '2 hours');
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_chase(k1, t0) = 'stopped at 02:00:00'
    AND (SELECT sla_state IS NULL FROM cases WHERE id = k1)
    AND (SELECT x.documents_missing FROM case_inbox(u_owner, a_acct, '{}', now() + interval '1 minute', 200) x
          WHERE x.case_id = k1) = 0,
    'the last required document stops the chase: ' || pg_temp.ct_chase(k1, t0))); n := n + 1;
  -- received again with the other one rejected: one is missing, so it runs
  PERFORM case_doc_set_status(k1, u_agent, 'passport', 'rejected', NULL, t0 + interval '3 hours');
  PERFORM case_doc_set_status(k1, u_agent, 'visa', 'rejected', NULL, t0 + interval '3 hours');
  PERFORM case_doc_set_status(k1, u_agent, 'visa', 'received', 'f-3', t0 + interval '4 hours');
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_chase(k1, t0) = 'running from 04:00:00',
    'a rejected document counts as missing: ' || pg_temp.ct_chase(k1, t0))); n := n + 1;

  -- ---------- 3. A rule that did not match fires later ----------
  UPDATE cases SET product = NULL WHERE id = k1;
  r1 := (case_rule_save(u_owner, NULL, 'CTM overdue', true, 'sla_overdue', '{"product":"Loan"}'::jsonb,
    '[{"kind":"set_priority","priority":"urgent"}]'::jsonb, 1)).rule_id;
  PERFORM case_sla_evaluate(t0 + interval '5 days', k1);
  FOR i IN 1..3 LOOP
    PERFORM case_rules_sweep(t0 + interval '5 days' + i * interval '5 minutes');
  END LOOP;
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_runs(r1) = 'false',
    'three sweeps of a rule that does not match write one run: ' || pg_temp.ct_runs(r1))); n := n + 1;
  UPDATE cases SET product = 'Loan' WHERE id = k1;
  FOR i IN 4..6 LOOP
    PERFORM case_rules_sweep(t0 + interval '5 days' + i * interval '5 minutes');
  END LOOP;
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_runs(r1) = 'false,true'
    AND (SELECT priority FROM cases WHERE id = k1) = 'urgent',
    'the rule fires once, when it matches: ' || pg_temp.ct_runs(r1))); n := n + 1;
  -- fired: neither a later match nor a later mismatch runs it again
  UPDATE cases SET product = 'Other', priority = 'normal' WHERE id = k1;
  PERFORM case_rules_sweep(t0 + interval '5 days 1 hour');
  UPDATE cases SET product = 'Loan' WHERE id = k1;
  PERFORM case_rules_sweep(t0 + interval '5 days 2 hours');
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_runs(r1) = 'false,true'
    AND (SELECT priority FROM cases WHERE id = k1) = 'normal',
    'a matched key is used up: ' || pg_temp.ct_runs(r1))); n := n + 1;
  failed := array_append(failed, pg_temp.ct_ok(pg_temp.ct_try(format(
    'INSERT INTO case_rule_runs (account_id, rule_id, case_id, trigger, fire_key, matched, applied)
     SELECT account_id, rule_id, case_id, trigger, fire_key, true, applied FROM case_rule_runs
      WHERE rule_id = %L AND matched', r1)) = '23505', 'a second matched run of one key is refused')); n := n + 1;

  -- ---------- Grants ----------
  failed := array_append(failed, pg_temp.ct_ok(NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) g,
                  unnest(ARRAY['public.case_sla_apply_event(uuid,text,timestamptz,uuid,text)',
                               'public.case_rules_fire(text,uuid,timestamptz,text)']) f
     WHERE has_function_privilege(g, f, 'EXECUTE')), 'an API role executes an internal function')); n := n + 1;

  RAISE EXCEPTION 'CTM_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'CTM_ROLLBACK' THEN RAISE; END IF;
  END;

  failed := array_remove(failed, NULL);
  IF n < 17 THEN RAISE EXCEPTION 'verify-case-timers: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-case-timers: % of % failed: %', cardinality(failed), n, array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-case-timers: % checks passed', n;
END $verify$;
