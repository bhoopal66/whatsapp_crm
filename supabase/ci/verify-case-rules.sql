-- Behavioural regression suite for case automation rules (migration 187).
--
-- The store: only owners/admins save and delete, a rule of another
-- workspace is RULE_NOT_FOUND, one validator refuses every malformed
-- trigger, condition and action (RULE_INVALID; there is no add_task), and
-- case_rule_list orders by position. Firing: with no rule nothing runs;
-- case_opened, stage_changed (a real change only) and submission_attached
-- (a lead's group attached) write one run per rule, matched or not; the
-- actions assign (case + one history row, actor NULL, system:rules),
-- add_note (placeholders filled) and set_priority (case + detail log) do
-- what they say, and refuse CASE_CLOSED, MANAGED_EXTERNALLY and a target
-- with no role in the workspace, writing nothing. A failing action stops
-- its rule only; the next rule runs and the firing write stands. The loop
-- guard (app.case_rules_firing) silences the hooks. The sweep: no_activity
-- once per rule, case and idle episode (not again the next day, nor 25
-- days on; again after real activity and `days` more), never below
-- `days`, and a rule's own writes do not count as activity; sla_overdue
-- once per timer run. RLS: rules are read by case-role members only
-- (not a viewer), runs per case.
-- Privileges: service_role runs the staff functions, nobody the internal
-- ones, no API role writes the tables, runs are read per case, and the
-- run log is append-only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back on success too (a sentinel exception ends the block), and
-- failing assertions are named in the final exception.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000187001';
  u_admin  UUID := '00000000-0000-4000-8000-000000187002';
  u_agent  UUID := '00000000-0000-4000-8000-000000187003';  -- agent of k1 and the lead
  u_agent2 UUID := '00000000-0000-4000-8000-000000187004';  -- agent of the other cases
  u_viewer UUID := '00000000-0000-4000-8000-000000187005';
  u_bown   UUID := '00000000-0000-4000-8000-000000187006';  -- owner of account B
  u_lead   UUID := '00000000-0000-4000-8000-000000187007';  -- team_leader, no team
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  wb       UUID;
  ca       UUID;
  cl       UUID;
  cb       UUID;
  g        UUID;
  k0       UUID;
  k1       UUID;
  l1       UUID;
  k_as     UUID;
  k_iso    UUID;
  k_cl     UUID;
  k_idle   UUID;
  k_sla    UUID;
  kb       UUID;
  r_open   UUID;
  r_miss   UUID;
  r_stage  UUID;
  r_att    UUID;
  r_as     UUID;
  r_iso1   UUID;
  r_iso2   UUID;
  r_cl     UUID;
  r_idle   UUID;
  r_sla    UUID;
  r_b      UUID;
  p1       UUID;
  p5       UUID;
  p6       UUID;
  t1       TIMESTAMPTZ := (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '5 days 1 hour') AT TIME ZONE 'UTC';
  v_out    JSONB;
  v_txt    TEXT;
  v_b      BOOLEAN;
  note     JSONB := '[{"kind": "add_note", "body": "x"}]';
  r        TEXT;
  st       TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        IF p_sql ILIKE 'select%' OR p_sql ILIKE 'with%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
        END IF;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-') || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cr_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- Runs of a rule on a case (all triggers).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_runs(p_rule uuid, p_case uuid) RETURNS int LANGUAGE sql AS $body$
      SELECT count(*)::int FROM public.case_rule_runs WHERE rule_id = p_rule AND case_id = p_case
    $body$
  $fn$;
  -- The latest run of a rule on a case: matched and applied.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_last(p_rule uuid, p_case uuid) RETURNS jsonb LANGUAGE sql AS $body$
      SELECT jsonb_build_object('matched', x.matched, 'applied', x.applied, 'trigger', x.trigger)
        FROM public.case_rule_runs x WHERE x.rule_id = p_rule AND x.case_id = p_case ORDER BY x.id DESC LIMIT 1
    $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cr_list(p_actor uuid) RETURNS uuid[] LANGUAGE sql AS $body$
      SELECT coalesce(array_agg(x.rule_id ORDER BY x.ordinality), '{}')
        FROM public.case_rule_list(p_actor) WITH ORDINALITY x
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cr-owner@example.invalid'),
    (u_admin,  'cr-admin@example.invalid'),
    (u_agent,  'cr-agent@example.invalid'),
    (u_agent2, 'cr-agent2@example.invalid'),
    (u_viewer, 'cr-viewer@example.invalid'),
    (u_bown,   'cr-bown@example.invalid'),
    (u_lead,   'cr-lead@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CR-187-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_bown, b_acct, 'whapi', 'CR-187-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500187001', 'CR one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500187002', 'CR lead')
    RETURNING id INTO cl;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500187003', 'CR bee')
    RETURNING id INTO cb;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ADCB', 'Abu Dhabi Commercial Bank')
  ON CONFLICT DO NOTHING;

  -- ---------- 8. no rules: nothing fires ----------
  g := (SELECT x.group_id FROM sg_open(a_acct, 'CR-187-0', ca, wa, 'rules 0', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent')), NULL) x);
  k0 := (SELECT x.case_id FROM case_open(g, NULL, NULL, 'Zero', NULL, NULL) x);
  g := (SELECT x.group_id FROM sg_open(b_acct, 'CR-187-B', cb, wb, 'rules b', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_bown, 'label', 'agent')), NULL) x);
  kb := (SELECT x.case_id FROM case_open(g, NULL, NULL, NULL, NULL, NULL) x);
  IF k0 IS NULL OR kb IS NULL THEN RAISE EXCEPTION 'fixture: case_open returned no case'; END IF;
  UPDATE cases SET stage = 'Bank acknowledged' WHERE id = k0;
  v_out := case_rules_sweep(now() + interval '400 days');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    NOT EXISTS (SELECT 1 FROM case_rule_runs WHERE account_id IN (a_acct, b_acct))
    AND v_out = '{"fired": []}'::jsonb,
    format('with no rules defined something fired (sweep %s)', v_out));

  -- ---------- 1. saving: who, shapes, other workspaces, order ----------
  FOREACH r IN ARRAY ARRAY[u_agent::text, u_agent2::text, u_lead::text, u_viewer::text, gen_random_uuid()::text, 'NULL'] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s saved a rule', r), NULL, NULL,
      format('SELECT (case_rule_save(%s, NULL, ''r'', true, ''case_opened'', ''{}'', %L::jsonb, NULL)).rule_id::text',
             CASE r WHEN 'NULL' THEN 'NULL::uuid' ELSE quote_literal(r) END, note), 'ERROR 42501 NOT_ALLOWED%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY[
      $$'nope', '{}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$NULL, '{}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'case_opened', '{"colour": "red"}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'case_opened', '[]', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'case_opened', '{"amount_min": -1}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'case_opened', '{"pre_submission": "yes"}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'case_opened', '{"days": 3}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'sla_overdue', '{"days": 3}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'no_activity', '{}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'no_activity', '{"days": 0}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'no_activity', '{"days": 366}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'no_activity', '{"days": 1.5}', '[{"kind": "add_note", "body": "x"}]'$$,
      $$'case_opened', '{}', '[{"kind": "add_task", "templateKey": "call_customer", "dueHours": 24, "ownerRole": "agent"}]'$$,
      $$'case_opened', '{}', '[{"kind": "add_task"}]'$$,
      $$'case_opened', '{}', '[{"kind": "assign_agent", "userId": "not-a-uuid"}]'$$,
      $$'case_opened', '{}', '[{"kind": "assign_agent", "userId": "ABCDEF00-0000-4000-8000-000000000000"}]'$$,
      $$'case_opened', '{}', '[{"kind": "assign_coordinator"}]'$$,
      $$'case_opened', '{}', '[{"kind": "set_priority", "priority": "asap"}]'$$,
      $$'case_opened', '{}', '[{"kind": "add_note", "body": " \t"}]'$$,
      $$'case_opened', '{}', '[{"kind": "add_note", "body": "x", "extra": 1}]'$$,
      $$'case_opened', '{}', '[{"kind": "send_whatsapp"}]'$$,
      $$'case_opened', '{}', '[]'$$,
      $$'case_opened', '{}', '[{"kind": "add_note", "body": "1"}, {"kind": "add_note", "body": "2"}, {"kind": "add_note", "body": "3"}, {"kind": "add_note", "body": "4"}, {"kind": "add_note", "body": "5"}, {"kind": "add_note", "body": "6"}]'$$] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check(format('case_rule_save accepted %s', left(r, 90)), NULL, NULL,
      format('SELECT (case_rule_save(%L, NULL, ''r'', true, %s, NULL)).rule_id::text', u_admin, r),
      'ERROR 22023 RULE_INVALID%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['NULL', '''''', format('%L', E'\t\n '), format('%L', repeat('n', 61))] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check(format('case_rule_save accepted the name %s', left(r, 12)), NULL, NULL,
      format('SELECT (case_rule_save(%L, NULL, %s, true, ''case_opened'', ''{}'', %L::jsonb, NULL)).rule_id::text',
             u_admin, r, note), 'ERROR 22023 RULE_INVALID%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cr_check('case_rule_save accepted a negative position', NULL, NULL,
    format('SELECT (case_rule_save(%L, NULL, ''r'', true, ''case_opened'', ''{}'', %L::jsonb, -1)).rule_id::text',
           u_admin, note), 'ERROR 22023 RULE_INVALID%');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    NOT EXISTS (SELECT 1 FROM case_rules WHERE account_id IN (a_acct, b_acct)), 'a refused save wrote a rule');

  -- position order (disabled rules: they never fire)
  p5 := (case_rule_save(u_owner, NULL, 'five', false, 'sla_overdue', '{}', note, 5)).rule_id;
  p1 := (case_rule_save(u_admin, NULL, '  one  ', false, 'sla_overdue', '{}', note, 1)).rule_id;
  p6 := (case_rule_save(u_admin, NULL, 'next', false, 'no_activity', '{"days": 365}',
         '[{"kind": "assign_agent", "userId": "00000000-0000-4000-8000-000000187004"}]', NULL)).rule_id;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_list(u_admin) = ARRAY[p1, p5, p6] AND pg_temp.cr_list(u_agent) = ARRAY[p1, p5, p6]
    AND (SELECT x.position = 6 AND x.created_by = u_admin AND NOT x.enabled FROM case_rules x WHERE x.rule_id = p6)
    AND (SELECT x.name FROM case_rules x WHERE x.rule_id = p1) = 'one',
    format('case_rule_list is not in position order, or a default position is not max + 1 (%s)', pg_temp.cr_list(u_admin)));
  n := n + 1; failed := failed || pg_temp.cr_ok(pg_temp.cr_list(u_bown) = '{}',
    'another workspace lists this one''s rules');
  n := n + 1; failed := failed || pg_temp.cr_check('case_rule_list without an actor', NULL, NULL,
    'SELECT count(*)::text FROM case_rule_list(NULL)', 'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cr_check('another workspace updated a rule', NULL, NULL,
    format('SELECT (case_rule_save(%L, %L, ''x'', true, ''sla_overdue'', ''{}'', %L::jsonb, 0)).rule_id::text',
           u_bown, p5, note), 'ERROR P0002 RULE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cr_check('another workspace deleted a rule', NULL, NULL,
    format('SELECT case_rule_delete(%L, %L)::text', u_bown, p5), 'ERROR P0002 RULE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cr_check('an agent deleted a rule', NULL, NULL,
    format('SELECT case_rule_delete(%L, %L)::text', u_agent, p5), 'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cr_check('an agent updated a rule', NULL, NULL,
    format('SELECT (case_rule_save(%L, %L, ''x'', false, ''sla_overdue'', ''{}'', %L::jsonb, 0)).rule_id::text',
           u_agent, p5, note), 'ERROR 42501 NOT_ALLOWED%');
  n := n + 1; failed := failed || pg_temp.cr_check('the owner could not move a rule first', NULL, NULL,
    format('SELECT (case_rule_save(%L, %L, ''five'', false, ''sla_overdue'', ''{}'', %L::jsonb, 0)).position::text',
           u_owner, p5, note), '0');
  n := n + 1; failed := failed || pg_temp.cr_ok(pg_temp.cr_list(u_owner) = ARRAY[p5, p1, p6]
    AND (SELECT x.name FROM case_rules x WHERE x.rule_id = p5) = 'five',
    'an update did not move the rule in place');
  n := n + 1; failed := failed || pg_temp.cr_check('an unknown rule updated', NULL, NULL,
    format('SELECT (case_rule_save(%L, %L, ''x'', false, ''sla_overdue'', ''{}'', %L::jsonb, 0)).rule_id::text',
           u_owner, gen_random_uuid(), note), 'ERROR P0002 RULE_NOT_FOUND%');
  FOREACH r IN ARRAY ARRAY[p5::text, p1::text, p6::text] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check('an admin could not delete a rule', NULL, NULL,
      format('SELECT case_rule_delete(%L, %L)::text', u_admin, r), '');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cr_check('a deleted rule deleted again', NULL, NULL,
    format('SELECT case_rule_delete(%L, %L)::text', u_owner, p5), 'ERROR P0002 RULE_NOT_FOUND%');
  n := n + 1; failed := failed || pg_temp.cr_ok(NOT EXISTS (SELECT 1 FROM case_rules WHERE account_id = a_acct),
    'a deleted rule is still there');

  -- ---------- 2. firing from the hooks ----------
  r_open := (case_rule_save(u_owner, NULL, 'note on open', true, 'case_opened', '{"bank_code": "ADCB"}',
             '[{"kind": "add_note", "body": "Hi {{customer}} / {{bank}}"}]', NULL)).rule_id;
  r_miss := (case_rule_save(u_owner, NULL, 'never matches', true, 'case_opened', '{"product": "Nope"}',
             '[{"kind": "set_priority", "priority": "urgent"}]', NULL)).rule_id;
  r_stage := (case_rule_save(u_owner, NULL, 'high on stage', true, 'stage_changed', '{"product": "Personal loan"}',
              '[{"kind": "set_priority", "priority": "high"}]', NULL)).rule_id;
  r_att := (case_rule_save(u_owner, NULL, 'attached', true, 'submission_attached', '{"pre_submission": false}',
            '[{"kind": "add_note", "body": "group attached"}]', NULL)).rule_id;

  g := (SELECT x.group_id FROM sg_open(a_acct, 'CR-187-1', ca, wa, 'rules 1', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g, 'ADCB', 'Abu Dhabi Commercial Bank', 'Personal loan', 1000, NULL) x);
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_open, k1) = 1
    AND pg_temp.cr_last(r_open, k1) = '{"matched": true, "trigger": "case_opened", "applied": [{"kind": "add_note", "ok": true, "refusal": null}]}'::jsonb
    AND (SELECT count(*) FROM case_notes WHERE case_id = k1) = 1
    AND (SELECT x.body = 'Hi CR one / Abu Dhabi Commercial Bank' AND x.author_id IS NULL
           FROM case_notes x WHERE x.case_id = k1),
    format('case_opened + add_note did not write one matched run and one system note with placeholders filled (%s / %s)',
      pg_temp.cr_last(r_open, k1), (SELECT string_agg(body, ' | ') FROM case_notes WHERE case_id = k1)));
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_miss, k1) = 1
    AND pg_temp.cr_last(r_miss, k1) = '{"matched": false, "trigger": "case_opened", "applied": []}'::jsonb
    AND NOT EXISTS (SELECT 1 FROM case_detail_log WHERE case_id = k1)
    AND (SELECT priority FROM cases WHERE id = k1) <> 'urgent',
    format('a non-matching rule did more than record an unmatched run (%s)', pg_temp.cr_last(r_miss, k1)));
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT count(*) FROM case_rule_runs WHERE case_id = k1) = 2,
    'opening k1 ran a rule of another trigger');

  -- stage_changed: a real change only
  SELECT priority INTO v_txt FROM cases WHERE id = k1;
  UPDATE cases SET stage = stage WHERE id = k1;
  n := n + 1; failed := failed || pg_temp.cr_ok(pg_temp.cr_runs(r_stage, k1) = 0,
    'stage_changed fired on an UPDATE that left the stage as it was');
  UPDATE cases SET stage = 'Bank acknowledged' WHERE id = k1;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_stage, k1) = 1
    AND pg_temp.cr_last(r_stage, k1) = '{"matched": true, "trigger": "stage_changed", "applied": [{"kind": "set_priority", "ok": true, "refusal": null}]}'::jsonb
    AND (SELECT stage = 'Bank acknowledged' AND priority = 'high' FROM cases WHERE id = k1),
    format('stage_changed + set_priority did not run once and set the priority (%s)', pg_temp.cr_last(r_stage, k1)));
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT count(*) FROM case_detail_log WHERE case_id = k1) = 1
    AND (SELECT x.field = 'priority' AND x.from_value IS NOT DISTINCT FROM v_txt AND x.to_value = 'high'
                AND x.actor_id IS NULL AND x.actor_role = 'system:rules'
           FROM case_detail_log x WHERE x.case_id = k1),
    'set_priority did not log one detail row (priority, from, to, actor NULL, system:rules)');

  -- ---------- 5. the loop guard, set by hand ----------
  PERFORM set_config('app.case_rules_firing', 'on', true);
  UPDATE cases SET stage = 'Under review' WHERE id = k1;
  PERFORM set_config('app.case_rules_firing', '', true);
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_stage, k1) = 1 AND (SELECT stage FROM cases WHERE id = k1) = 'Under review',
    'with app.case_rules_firing on, a stage change still ran rules (or was refused)');

  -- submission_attached: a lead's group attached
  l1 := case_open_lead(u_agent, a_acct, cl, 'ADCB', 'Personal loan', u_agent, 5000);
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_open, l1) = 1 AND pg_temp.cr_runs(r_att, l1) = 0,
    'opening a lead did not run case_opened alone');
  g := (SELECT x.group_id FROM sg_open(a_acct, 'CR-187-L', cl, wa, 'rules lead', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  SELECT x.case_id, x.created INTO k_as, v_b FROM case_open(g, 'ADCB', 'Abu Dhabi Commercial Bank', 'Personal loan', NULL, NULL) x;
  n := n + 1; failed := failed || pg_temp.cr_ok(k_as = l1 AND NOT v_b,
    format('fixture: case_open did not attach the group to the lead (case %s, created %s)', k_as, v_b));
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_att, l1) = 1
    AND pg_temp.cr_last(r_att, l1) = '{"matched": true, "trigger": "submission_attached", "applied": [{"kind": "add_note", "ok": true, "refusal": null}]}'::jsonb
    AND EXISTS (SELECT 1 FROM case_notes WHERE case_id = l1 AND body = 'group attached' AND author_id IS NULL)
    AND pg_temp.cr_runs(r_att, k1) = 0,
    format('attaching a lead''s group did not run submission_attached once (%s)', pg_temp.cr_last(r_att, l1)));

  -- ---------- 3 and 4. actions and isolation ----------
  r_as := (case_rule_save(u_admin, NULL, 'assign', true, 'stage_changed', '{"product": "Assign"}',
           jsonb_build_array(jsonb_build_object('kind', 'assign_agent', 'userId', u_lead),
                             jsonb_build_object('kind', 'assign_coordinator', 'userId', u_admin)), NULL)).rule_id;
  r_iso1 := (case_rule_save(u_admin, NULL, 'iso 1', true, 'stage_changed', '{"product": "Iso"}',
             jsonb_build_array(jsonb_build_object('kind', 'assign_agent', 'userId', u_bown),
                               jsonb_build_object('kind', 'add_note', 'body', 'never written')), NULL)).rule_id;
  r_iso2 := (case_rule_save(u_admin, NULL, 'iso 2', true, 'stage_changed', '{"product": "Iso"}',
             '[{"kind": "add_note", "body": "second rule ran"}]', NULL)).rule_id;
  r_cl := (case_rule_save(u_admin, NULL, 'closed', true, 'stage_changed', '{"product": "Closed"}',
           '[{"kind": "set_priority", "priority": "urgent"}]', NULL)).rule_id;
  FOREACH r IN ARRAY ARRAY['Assign', 'Iso', 'Closed'] LOOP
    g := (SELECT x.group_id FROM sg_open(a_acct, 'CR-187-' || r, ca, wa, 'rules ' || r, NULL,
           jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent')), NULL) x);
    k0 := (SELECT x.case_id FROM case_open(g, NULL, NULL, r, NULL, NULL) x);
    IF r = 'Assign' THEN k_as := k0; ELSIF r = 'Iso' THEN k_iso := k0; ELSE k_cl := k0; END IF;
  END LOOP;

  UPDATE cases SET stage = 'Bank acknowledged' WHERE id = k_as;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_last(r_as, k_as) = '{"matched": true, "trigger": "stage_changed", "applied": [{"kind": "assign_agent", "ok": true, "refusal": null}, {"kind": "assign_coordinator", "ok": true, "refusal": null}]}'::jsonb
    AND (SELECT agent_id = u_lead AND coordinator_id = u_admin FROM cases WHERE id = k_as),
    format('assign_agent / assign_coordinator did not reassign the case (%s)', pg_temp.cr_last(r_as, k_as)));
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT count(*) FROM case_reassign_history WHERE case_id = k_as) = 2
    AND (SELECT count(*) FROM case_reassign_history
          WHERE case_id = k_as AND actor_id IS NULL AND actor_role = 'system:rules'
            AND ((field = 'agent' AND from_user = u_agent2 AND to_user = u_lead)
              OR (field = 'coordinator' AND to_user = u_admin))) = 2,
    'an assign did not write exactly one history row (actor NULL, system:rules, from, to)');

  UPDATE cases SET stage = 'Bank acknowledged' WHERE id = k_iso;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_last(r_iso1, k_iso) = '{"matched": true, "trigger": "stage_changed", "applied": [{"kind": "assign_agent", "ok": false, "refusal": "ASSIGNEE_INVALID"}]}'::jsonb
    AND (SELECT agent_id = u_agent2 FROM cases WHERE id = k_iso)
    AND NOT EXISTS (SELECT 1 FROM case_reassign_history WHERE case_id = k_iso)
    AND NOT EXISTS (SELECT 1 FROM case_notes WHERE case_id = k_iso AND body = 'never written'),
    format('a target with no role in the workspace was not refused alone, or the rule went on (%s)',
      pg_temp.cr_last(r_iso1, k_iso)));
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_last(r_iso2, k_iso) = '{"matched": true, "trigger": "stage_changed", "applied": [{"kind": "add_note", "ok": true, "refusal": null}]}'::jsonb
    AND EXISTS (SELECT 1 FROM case_notes WHERE case_id = k_iso AND body = 'second rule ran')
    AND (SELECT stage FROM cases WHERE id = k_iso) = 'Bank acknowledged',
    'after a failing rule the next rule did not run, or the firing write did not stand');

  UPDATE cases SET stage = 'Withdrawn', closed_at = now() WHERE id = k_cl;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_last(r_cl, k_cl) = '{"matched": true, "trigger": "stage_changed", "applied": [{"kind": "set_priority", "ok": false, "refusal": "CASE_CLOSED"}]}'::jsonb
    AND (SELECT stage = 'Withdrawn' AND closed_at IS NOT NULL AND priority <> 'urgent' FROM cases WHERE id = k_cl)
    AND NOT EXISTS (SELECT 1 FROM case_detail_log WHERE case_id = k_cl),
    format('an action on a closed case was not refused CASE_CLOSED with nothing written (%s)', pg_temp.cr_last(r_cl, k_cl)));

  -- MANAGED_EXTERNALLY: a submitted case of a managed account
  r_b := (case_rule_save(u_bown, NULL, 'B urgent', true, 'stage_changed', '{}',
          '[{"kind": "set_priority", "priority": "urgent"}]', NULL)).rule_id;
  PERFORM case_settings_set(u_bown, b_acct, true);
  UPDATE cases SET stage = 'Bank acknowledged' WHERE id = kb;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_last(r_b, kb) = '{"matched": true, "trigger": "stage_changed", "applied": [{"kind": "set_priority", "ok": false, "refusal": "MANAGED_EXTERNALLY"}]}'::jsonb
    AND (SELECT stage = 'Bank acknowledged' AND priority <> 'urgent' FROM cases WHERE id = kb)
    AND NOT EXISTS (SELECT 1 FROM case_detail_log WHERE case_id = kb),
    format('an action on a submitted case of a managed account was not refused MANAGED_EXTERNALLY with nothing written (%s)',
      pg_temp.cr_last(r_b, kb)));
  n := n + 1; failed := failed || pg_temp.cr_ok(
    NOT EXISTS (SELECT 1 FROM case_rule_runs WHERE account_id = b_acct AND rule_id <> r_b)
    AND NOT EXISTS (SELECT 1 FROM case_rule_runs WHERE account_id = a_acct AND rule_id = r_b),
    'a rule ran in another workspace');

  -- ---------- 6. the sweep ----------
  r_idle := (case_rule_save(u_admin, NULL, 'idle', true, 'no_activity', '{"days": 3, "product": "Idle"}',
             '[{"kind": "set_priority", "priority": "urgent"}]', NULL)).rule_id;
  r_sla := (case_rule_save(u_admin, NULL, 'overdue', true, 'sla_overdue', '{"product": "Sla"}',
            '[{"kind": "add_note", "body": "overdue"}]', NULL)).rule_id;
  FOREACH r IN ARRAY ARRAY['Idle', 'Sla'] LOOP
    g := (SELECT x.group_id FROM sg_open(a_acct, 'CR-187-' || r, ca, wa, 'rules ' || r, NULL,
           jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent')), NULL) x);
    k0 := (SELECT x.case_id FROM case_open(g, NULL, NULL, r, NULL, NULL) x);
    IF r = 'Idle' THEN k_idle := k0; ELSE k_sla := k0; END IF;
  END LOOP;

  v_out := case_rules_sweep(now() + interval '1 day');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    NOT EXISTS (SELECT 1 FROM case_rule_runs WHERE rule_id = r_idle) AND v_out = '{"fired": []}'::jsonb,
    format('no_activity fired on cases idle less than days (%s)', v_out));
  v_out := case_rules_sweep(t1);
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_idle, k_idle) = 1
    AND pg_temp.cr_last(r_idle, k_idle) = '{"matched": true, "trigger": "no_activity", "applied": [{"kind": "set_priority", "ok": true, "refusal": null}]}'::jsonb
    AND (SELECT priority FROM cases WHERE id = k_idle) = 'urgent'
    AND v_out -> 'fired' @> jsonb_build_array(jsonb_build_object('caseId', k_idle, 'trigger', 'no_activity'))
    AND (SELECT bool_and(NOT matched) FROM case_rule_runs WHERE rule_id = r_idle AND case_id <> k_idle)
    AND NOT EXISTS (SELECT 1 FROM case_rule_runs WHERE rule_id = r_idle AND case_id = k_cl),
    format('a case idle past days did not fire no_activity once (or a closed case was swept) (%s / %s)',
      pg_temp.cr_last(r_idle, k_idle), v_out));
  v_out := case_rules_sweep(t1 + interval '2 hours');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_idle, k_idle) = 1 AND v_out = '{"fired": []}'::jsonb,
    format('no_activity fired twice on one UTC day (%s)', v_out));
  v_out := case_rules_sweep(t1 + interval '1 day');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_idle, k_idle) = 1
    AND NOT (v_out -> 'fired' @> jsonb_build_array(jsonb_build_object('caseId', k_idle))),
    format('no_activity fired again the next day on the same idle case (%s)', v_out));
  v_out := case_rules_sweep(t1 + interval '25 days');
  n := n + 1; failed := failed || pg_temp.cr_ok(pg_temp.cr_runs(r_idle, k_idle) = 1,
    format('no_activity fired again within one idle episode (%s)', v_out));
  -- real activity (a person's note) restarts the clock; the rule's own
  -- set_priority (above) did not
  INSERT INTO case_notes (case_id, account_id, author_id, body, created_at)
  VALUES (k_idle, a_acct, u_agent2, 'worked on it', t1 + interval '26 days');
  v_out := case_rules_sweep(t1 + interval '28 days');
  n := n + 1; failed := failed || pg_temp.cr_ok(pg_temp.cr_runs(r_idle, k_idle) = 1,
    format('no_activity fired less than days after real activity (%s)', v_out));
  v_out := case_rules_sweep(t1 + interval '29 days 1 hour');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_idle, k_idle) = 2
    AND (SELECT count(*) FROM case_rule_runs WHERE rule_id = r_idle AND case_id = k_idle AND matched) = 2
    AND v_out -> 'fired' @> jsonb_build_array(jsonb_build_object('caseId', k_idle, 'trigger', 'no_activity')),
    format('no_activity did not fire again after real activity and days more idle (%s)', v_out));
  v_out := case_rules_sweep(t1 + interval '30 days 1 hour');
  n := n + 1; failed := failed || pg_temp.cr_ok(pg_temp.cr_runs(r_idle, k_idle) = 2,
    format('no_activity fired twice in the second idle episode (%s)', v_out));

  INSERT INTO case_sla_timers (case_id, account_id, timer, stage, started_at, due_soon_at, due_at, stopped_at, state)
  VALUES (k_sla, a_acct, 'customer_reply', 'Submitted', now() - interval '2 days', now() - interval '47 hours',
          now() - interval '46 hours', NULL, 'overdue')
  ON CONFLICT (case_id, timer) DO UPDATE
    SET started_at = EXCLUDED.started_at, due_soon_at = EXCLUDED.due_soon_at, due_at = EXCLUDED.due_at,
        stopped_at = NULL, state = 'overdue';
  v_out := case_rules_sweep(now());
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_sla, k_sla) = 1
    AND pg_temp.cr_last(r_sla, k_sla) = '{"matched": true, "trigger": "sla_overdue", "applied": [{"kind": "add_note", "ok": true, "refusal": null}]}'::jsonb
    AND (SELECT count(*) FROM case_notes WHERE case_id = k_sla AND body = 'overdue') = 1
    AND v_out -> 'fired' @> jsonb_build_array(jsonb_build_object('caseId', k_sla, 'trigger', 'sla_overdue')),
    format('an overdue timer did not fire sla_overdue once (%s / %s)', pg_temp.cr_last(r_sla, k_sla), v_out));
  v_out := case_rules_sweep(now());
  n := n + 1; failed := failed || pg_temp.cr_ok(pg_temp.cr_runs(r_sla, k_sla) = 1,
    'sla_overdue fired twice for one timer run');
  UPDATE case_sla_timers SET started_at = now() - interval '1 day', due_soon_at = now() - interval '23 hours',
                             due_at = now() - interval '22 hours'
   WHERE case_id = k_sla AND timer = 'customer_reply';
  v_out := case_rules_sweep(now());
  n := n + 1; failed := failed || pg_temp.cr_ok(
    pg_temp.cr_runs(r_sla, k_sla) = 2 AND (SELECT count(*) FROM case_notes WHERE case_id = k_sla AND body = 'overdue') = 2,
    'a new overdue timer run did not fire sla_overdue again');
  n := n + 1; failed := failed || pg_temp.cr_check('case_rules_sweep accepted no clock', NULL, NULL,
    'SELECT case_rules_sweep(NULL)::text', 'ERROR 22004 NOW_REQUIRED%');

  -- ---------- 7. reading runs ----------
  n := n + 1; failed := failed || pg_temp.cr_check('the agent could not list k1''s runs', NULL, NULL,
    format('SELECT string_agg(rule_id::text, '','' ORDER BY id) FROM case_rule_runs_list(%L, %L)', u_agent, k1),
    (SELECT string_agg(rule_id::text, ',' ORDER BY id) FROM case_rule_runs WHERE case_id = k1));
  FOREACH r IN ARRAY ARRAY[format('%s/%s', u_agent, k_iso), format('%s/%s', u_bown, k1),
                           format('%s/%s', u_viewer, k1), format('%s/%s', u_owner, kb)] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check(format('case_rule_runs_list %s', r), NULL, NULL,
      format('SELECT count(*)::text FROM case_rule_runs_list(%L, %L)', split_part(r, '/', 1), split_part(r, '/', 2)),
      'ERROR P0002 CASE_NOT_FOUND%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cr_check('RLS: the agent reads runs of a case they cannot read',
    'authenticated', u_agent,
    format('SELECT count(*)::text FROM case_rule_runs WHERE case_id NOT IN (%L, %L)', k1, l1), '0');
  n := n + 1; failed := failed || pg_temp.cr_check('RLS: the agent does not read k1''s runs', 'authenticated', u_agent,
    format('SELECT count(*)::text FROM case_rule_runs WHERE case_id = %L', k1),
    (SELECT count(*)::text FROM case_rule_runs WHERE case_id = k1));
  n := n + 1; failed := failed || pg_temp.cr_check('RLS: the owner does not read the account''s runs', 'authenticated',
    u_owner, 'SELECT count(*)::text FROM case_rule_runs',
    (SELECT count(*)::text FROM case_rule_runs WHERE account_id = a_acct));
  FOREACH st IN ARRAY ARRAY[u_viewer::text, u_bown::text] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check(format('RLS: %s reads account A''s runs', st), 'authenticated',
      st::uuid, format('SELECT count(*)::text FROM case_rule_runs WHERE account_id = %L', a_acct), '0');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cr_check('RLS: a viewer reads the account''s rules', 'authenticated',
    u_viewer, format('SELECT count(*)::text FROM case_rules WHERE account_id = %L', a_acct), '0');
  n := n + 1; failed := failed || pg_temp.cr_check('RLS: the agent does not read what case_rule_list lists',
    'authenticated', u_agent,
    'SELECT string_agg(rule_id::text, '','' ORDER BY position, created_at, rule_id) FROM case_rules',
    (SELECT string_agg(x.rule_id::text, ',' ORDER BY x.position, x.created_at, x.rule_id) FROM case_rule_list(u_agent) x));
  n := n + 1; failed := failed || pg_temp.cr_check('RLS: another workspace reads this one''s rules', 'authenticated',
    u_bown, format('SELECT count(*)::text FROM case_rules WHERE account_id = %L', a_acct), '0');
  n := n + 1; failed := failed || pg_temp.cr_check('anon read the run log', 'anon', NULL,
    'SELECT count(*)::text FROM case_rule_runs', 'ERROR 42501 %');

  -- append-only, for every writer
  FOREACH st IN ARRAY ARRAY['UPDATE case_rule_runs SET matched = NOT matched', 'DELETE FROM case_rule_runs',
                           'TRUNCATE case_rule_runs'] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check(format('the table owner ran %s', st), NULL, NULL, st,
      'ERROR 42501 %append-only%');
  END LOOP;
  FOREACH st IN ARRAY ARRAY['authenticated', 'service_role', 'anon'] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s inserted a rule directly', st), st, u_owner,
      format('INSERT INTO case_rules (account_id, name, trigger, actions, created_by) VALUES (%L, ''x'', ''case_opened'', %L::jsonb, %L)',
        a_acct, note, u_owner), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s updated a rule directly', st), st, u_owner,
      format('UPDATE case_rules SET enabled = false WHERE rule_id = %L', r_open), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s deleted a rule directly', st), st, u_owner,
      format('DELETE FROM case_rules WHERE rule_id = %L', r_open), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s inserted a run directly', st), st, u_owner,
      format('INSERT INTO case_rule_runs (account_id, rule_id, case_id, trigger, matched, applied) VALUES (%L, %L, %L, ''case_opened'', true, ''[]'')',
        a_acct, r_open, k1), 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s updated a run directly', st), st, u_owner,
      'UPDATE case_rule_runs SET matched = true', 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s deleted a run directly', st), st, u_owner,
      'DELETE FROM case_rule_runs', 'ERROR 42501 %');
  END LOOP;

  -- ---------- 7. function grants ----------
  FOREACH st IN ARRAY ARRAY['case_rule_list(uuid)', 'case_rule_save(uuid,uuid,text,boolean,text,jsonb,jsonb,integer)',
                           'case_rule_delete(uuid,uuid)', 'case_rule_runs_list(uuid,uuid)',
                           'case_rules_sweep(timestamptz)'] LOOP
    n := n + 1; failed := failed || pg_temp.cr_ok(
      has_function_privilege('service_role', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('anon', ('public.' || st)::regprocedure, 'EXECUTE'),
      format('%s is not executable by service_role alone', st));
  END LOOP;
  FOREACH st IN ARRAY ARRAY['case_rule_refuse(text)', 'case_rule_validate(text,jsonb,jsonb)',
                           'case_rule_action_case(uuid)', 'case_rule_act_assign(uuid,text,uuid,timestamptz)',
                           'case_rule_act_add_note(uuid,text,timestamptz)',
                           'case_rule_act_set_priority(uuid,text,timestamptz)', 'case_rule_last_activity(uuid)',
                           'case_rule_matches(jsonb,public.cases,text,timestamptz)',
                           'case_rules_fire(text,uuid,timestamptz,text)', 'case_rules_on_case()'] LOOP
    n := n + 1; failed := failed || pg_temp.cr_ok(
      NOT has_function_privilege('service_role', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', ('public.' || st)::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('anon', ('public.' || st)::regprocedure, 'EXECUTE'),
      format('the internal %s is executable by an API role', st));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cr_ok(
    to_regprocedure('public.case_rule_act_add_task(uuid,jsonb,timestamptz)') IS NULL,
    'the dropped add_task helper still exists');
  FOREACH st IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s called case_rule_save', st), st, u_owner,
      format('SELECT (case_rule_save(%L, NULL, ''x'', true, ''case_opened'', ''{}'', %L::jsonb, NULL)).name', u_owner, note),
      'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s called case_rules_sweep', st), st, u_owner,
      'SELECT case_rules_sweep(now())::text', 'ERROR 42501 %');
    n := n + 1; failed := failed || pg_temp.cr_check(format('%s called case_rules_fire', st), st, u_owner,
      format('SELECT case_rules_fire(''case_opened'', %L, now(), NULL)::text', k1), 'ERROR 42501 %');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cr_check('service_role called case_rules_fire', 'service_role', NULL,
    format('SELECT case_rules_fire(''case_opened'', %L, now(), NULL)::text', k1), 'ERROR 42501 %');
  n := n + 1; failed := failed || pg_temp.cr_ok(
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.case_rules'::regclass)
    AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.case_rule_runs'::regclass),
    'case_rules / case_rule_runs are not RLS-forced');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT187', MESSAGE = 'verify-case-rules rollback';
  EXCEPTION WHEN SQLSTATE 'ZT187' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case rules verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case rules verification passed (% checks)', n;
END
$verify$;
