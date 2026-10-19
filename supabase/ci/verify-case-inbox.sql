-- Behavioural regression suite for the coordinator inbox (migration
-- 125, case_inbox over 122-124's cases).
--
-- Visibility equals case_can_read for every person of the fixture
-- (owner, admin, team leads, coordinator, agents, viewer, bank guest,
-- deactivated agent, another workspace's admin), and never crosses
-- accounts. Each filter selects exactly what it names, sla_state from the
-- live timers at p_now (not cases.sla_state); unknown keys, wrong types
-- and out-of-range values are FILTER_INVALID. The three sorts order as
-- the reference describes (case id last) and keyset paging returns every
-- case once; a cursor is bound to its sort and clock. The columns
-- (documents_missing, open_task_overdue_count, customer_waiting,
-- bank_query_open, last touch, contact / submission / bank names) hold;
-- the SLA job's 'system' rows are not a touch. case_inbox is STABLE,
-- writes nothing and is executable by service_role alone.
--
-- Stage history, reassignments and detail edits use now(), so they all
-- land at the transaction time t0 (ties broken by source order); notes,
-- tasks, documents and SLA rows take an injected clock t0 + offset.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000125001';
  u_admin  UUID := '00000000-0000-4000-8000-000000125002';
  u_lead   UUID := '00000000-0000-4000-8000-000000125003';  -- leads T1 (u_agent, u_coord)
  u_lead2  UUID := '00000000-0000-4000-8000-000000125004';  -- leads T2 (u_agent2)
  u_coord  UUID := '00000000-0000-4000-8000-000000125005';  -- agent role; coordinator of k1
  u_agent  UUID := '00000000-0000-4000-8000-000000125006';  -- agent of k1, k3
  u_agent2 UUID := '00000000-0000-4000-8000-000000125007';  -- agent of k2, k5
  u_agent3 UUID := '00000000-0000-4000-8000-000000125008';  -- on no case
  u_viewer UUID := '00000000-0000-4000-8000-000000125009';
  u_guest  UUID := '00000000-0000-4000-8000-000000125010';
  u_gone   UUID := '00000000-0000-4000-8000-000000125011';  -- agent of k4, then deactivated
  u_bown   UUID := '00000000-0000-4000-8000-000000125012';  -- owner of account B
  u_badmin UUID := '00000000-0000-4000-8000-000000125013';  -- admin of B, agent of kb
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  wb       UUID;
  ca       UUID;
  ca2      UUID;
  cb       UUID;
  team1    UUID;
  team2    UUID;
  g        UUID[] := '{}';
  gb       UUID;
  k1       UUID;  -- ADCB 'Loan': timers, coordinator u_coord, agent u_agent
  k2       UUID;  -- ENBD (default stages): Query raised, coordinator in T1, agent in T2
  k3       UUID;  -- ADCB 'LOAN': timers, tasks, one document received, high priority
  k4       UUID;  -- no bank: agent deactivated, contact deleted
  k5       UUID;  -- ENBD: closed
  kb       UUID;  -- account B
  kall     UUID[];
  tk1      UUID;
  tk2      UUID;
  t0       TIMESTAMPTZ := now();
  t70      TIMESTAMPTZ;
  i        INT;
  j        INT;
  lbl      TEXT[];
  usr      UUID[];
  ids      UUID[];
  ids2     UUID[];
  acc      UUID[];
  sorts    TEXT[] := ARRAY['most_overdue', 'due_soonest', 'stalest'];
  orders   TEXT[] := ARRAY[
    'overdue_rank DESC, due_at ASC NULLS LAST, case_id',
    'due_at ASC NULLS LAST, overdue_rank DESC, case_id',
    'last_activity_at ASC, overdue_rank DESC, due_at ASC NULLS LAST, case_id'];
  flt      TEXT[];
  prd      TEXT[];
  cur      TEXT;
  cur2     TEXT;
  b1       BOOLEAN;
  b2       BOOLEAN;
  st       TEXT;
  r        TEXT;
  ts1      TIMESTAMPTZ;
  w1       BIGINT;
  w2       BIGINT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (NULL: as the current user) signed in as
  -- p_uid: a SELECT's value, 'ok', or 'ERROR <sqlstate> <hint>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_try(p_role text, p_uid uuid, p_sql text)
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
    CREATE FUNCTION pg_temp.cs_check(p_name text, p_role text, p_uid uuid, p_sql text, p_like text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text := pg_temp.cs_try(p_role, p_uid, p_sql);
    BEGIN
      RETURN CASE WHEN v LIKE p_like THEN NULL ELSE p_name || ' (' || v || ')' END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;
  -- The case ids case_inbox lists (limit 200), sorted by id, restricted
  -- to the rows where p_pred (SQL over the output columns) holds.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_set(p_actor uuid, p_acct uuid, p_filters jsonb, p_now timestamptz, p_pred text)
    RETURNS uuid[] LANGUAGE plpgsql AS $body$
    DECLARE v uuid[];
    BEGIN
      EXECUTE format('SELECT coalesce(array_agg(x.case_id ORDER BY x.case_id), ''{}'')
                        FROM public.case_inbox($1, $2, $3, $4, 200) x WHERE %s', p_pred)
        INTO v USING p_actor, p_acct, p_filters, p_now;
      RETURN v;
    END $body$
  $fn$;
  -- The case ids in the order case_inbox returns them.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_list(p_actor uuid, p_acct uuid, p_filters jsonb, p_now timestamptz)
    RETURNS uuid[] LANGUAGE sql AS $body$
      SELECT coalesce(array_agg(x.case_id ORDER BY x.o), '{}')
        FROM public.case_inbox(p_actor, p_acct, p_filters, p_now, 200) WITH ORDINALITY AS x(
          case_id, bank_code, stage, agent_id, coordinator_id, priority, due_at, sla_state, overdue_rank,
          customer_waiting, documents_missing, bank_query_open, last_activity_at, last_touched_by,
          open_task_overdue_count, submission_ref, contact_id, contact_name, bank_name, product, amount,
          opened_at, closed_at, cursor, o)
    $body$
  $fn$;
  -- The same rows re-sorted by a reference ORDER BY over the output.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_ref(p_actor uuid, p_acct uuid, p_filters jsonb, p_now timestamptz, p_order text)
    RETURNS uuid[] LANGUAGE plpgsql AS $body$
    DECLARE v uuid[];
    BEGIN
      EXECUTE format('SELECT coalesce(array_agg(y.case_id), ''{}'') FROM (SELECT x.case_id
                        FROM public.case_inbox($1, $2, $3, $4, 200) x ORDER BY %s) y', p_order)
        INTO v USING p_actor, p_acct, p_filters, p_now;
      RETURN v;
    END $body$
  $fn$;
  -- Rows written in this transaction so far, across every user table.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.ci_writes() RETURNS bigint LANGUAGE sql AS $body$
      SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint FROM pg_stat_xact_all_tables
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'ci-owner@example.invalid'),
    (u_admin,  'ci-admin@example.invalid'),
    (u_lead,   'ci-lead@example.invalid'),
    (u_lead2,  'ci-lead2@example.invalid'),
    (u_coord,  'ci-coord@example.invalid'),
    (u_agent,  'ci-agent@example.invalid'),
    (u_agent2, 'ci-agent2@example.invalid'),
    (u_agent3, 'ci-agent3@example.invalid'),
    (u_viewer, 'ci-viewer@example.invalid'),
    (u_guest,  'ci-guest@example.invalid'),
    (u_gone,   'ci-gone@example.invalid'),
    (u_bown,   'ci-bown@example.invalid'),
    (u_badmin, 'ci-badmin@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id IN (u_lead, u_lead2);
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_coord, u_agent, u_agent2, u_agent3, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
  UPDATE profiles SET account_id = b_acct, account_role = 'admin' WHERE user_id = u_badmin;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CI T1', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct), (team1, u_coord, a_acct);
  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CI T2', u_lead2) RETURNING id INTO team2;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team2, u_agent2, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-125-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_bown, b_acct, 'whapi', 'CT-125-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500125001', 'CI one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500125002', 'CI two')
    RETURNING id INTO ca2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500125003', 'CI bee')
    RETURNING id INTO cb;

  FOR i IN 1 .. 5 LOOP
    g[i] := (SELECT x.group_id FROM sg_open(a_acct, 'CT-125-' || i, CASE i WHEN 4 THEN ca2 ELSE ca END, wa,
      'inbox ' || i, NULL, CASE i
        WHEN 1 THEN jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                                      jsonb_build_object('user_id', u_agent, 'label', 'agent'))
        WHEN 2 THEN jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'coordinator'),
                                      jsonb_build_object('user_id', u_agent2, 'label', 'agent'))
        WHEN 3 THEN jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'))
        WHEN 4 THEN jsonb_build_array(jsonb_build_object('user_id', u_gone, 'label', 'agent'))
        ELSE jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent')) END, NULL) x);
    IF g[i] IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group %', i; END IF;
  END LOOP;
  gb := (SELECT x.group_id FROM sg_open(b_acct, 'CT-125-B', cb, wb, 'inbox b', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_badmin, 'label', 'agent')), NULL) x);

  -- ADCB with its own stage list (no 'Query raised'); ENBD on the defaults.
  PERFORM case_bank_upsert(u_owner, a_acct, 'ADCB', 'ADCB Bank');
  PERFORM case_bank_upsert(u_owner, a_acct, 'ENBD', 'Emirates NBD');
  PERFORM case_bank_stages_set(u_owner, a_acct, 'ADCB',
    ARRAY['Submitted', 'Documents requested', 'Under review', 'Approved', 'Declined', 'Withdrawn', 'Closed']);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ADCB', 'Loan', 'eid', 'Emirates ID', 1);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ADCB', 'Loan', 'salary', 'Salary certificate', 2);
  PERFORM case_task_template_upsert(u_owner, a_acct, 'ADCB', 'collect', 'Collect docs', 1, 48);
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ADCB', 'Submitted', 'customer_reply', 60, 'minutes');
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ADCB', 'Submitted', 'bank_response', 2, 'days');

  k1 := (SELECT x.case_id FROM case_open(g[1], 'ADCB', NULL, 'Loan', 1000, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g[2], 'ENBD', NULL, 'Loan', 2000, NULL) x);
  k3 := (SELECT x.case_id FROM case_open(g[3], 'ADCB', NULL, 'LOAN', 3000, NULL) x);
  k4 := (SELECT x.case_id FROM case_open(g[4], NULL, NULL, NULL, NULL, NULL) x);
  k5 := (SELECT x.case_id FROM case_open(g[5], 'ENBD', NULL, 'Card', NULL, NULL) x);
  kb := (SELECT x.case_id FROM case_open(gb, NULL, NULL, NULL, NULL, NULL) x);
  IF k1 IS NULL OR k2 IS NULL OR k3 IS NULL OR k4 IS NULL OR k5 IS NULL OR kb IS NULL THEN
    RAISE EXCEPTION 'fixture: case_open returned no case';
  END IF;
  kall := ARRAY[k1, k2, k3, k4, k5, kb];
  -- No writer for these two in 122-124; the fixture sets them directly.
  UPDATE cases SET priority = 'high', due_at = t0 + interval '2 days' WHERE id = k3;
  UPDATE cases SET due_at = t0 + interval '1 day' WHERE id = k2;
  PERFORM case_set_stage(k5, u_owner, 'Closed', NULL, false);
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
  t70 := t0 + interval '70 minutes';

  -- ---------- last touch ----------
  -- k2 has no SLA config (ENBD), so no SLA rows: case_open's history row
  -- (actor NULL) is its only touch.
  SELECT x.last_activity_at, x.last_touched_by::text INTO ts1, st
    FROM case_inbox(u_owner, a_acct, '{}', t0, 200) x WHERE x.case_id = k2;
  n := n + 1; failed := failed || pg_temp.cs_ok(ts1 = t0 AND st IS NULL,
    format('a fresh case''s last touch is not case_open at t0 by nobody (%s, %s)', ts1 - t0, st));
  PERFORM case_set_stage(k2, u_owner, 'Query raised');
  SELECT x.last_touched_by::text INTO st FROM case_inbox(u_owner, a_acct, '{}', t0, 200) x WHERE x.case_id = k2;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = u_owner::text,
    format('a stage move did not become the last touch (%s)', st));
  PERFORM case_reassign(k2, u_admin, 'coordinator', u_coord);
  SELECT x.last_touched_by::text INTO st FROM case_inbox(u_owner, a_acct, '{}', t0, 200) x WHERE x.case_id = k2;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = u_admin::text,
    format('a reassignment did not become the last touch (%s)', st));
  PERFORM case_set_details(k2, u_lead2, NULL, 'Mortgage', NULL);
  SELECT x.last_activity_at, x.last_touched_by::text INTO ts1, st
    FROM case_inbox(u_owner, a_acct, '{}', t0, 200) x WHERE x.case_id = k2;
  n := n + 1; failed := failed || pg_temp.cs_ok(ts1 = t0 AND st = u_lead2::text,
    format('a details edit did not become the last touch (%s, %s)', ts1 - t0, st));
  PERFORM case_note_add(k2, u_agent2, 'called the bank', t0 + interval '5 minutes');
  SELECT x.last_activity_at, x.last_touched_by::text INTO ts1, st
    FROM case_inbox(u_owner, a_acct, '{}', t0, 200) x WHERE x.case_id = k2;
  n := n + 1; failed := failed || pg_temp.cs_ok(ts1 = t0 + interval '5 minutes' AND st = u_agent2::text,
    format('a note did not move the last touch (%s, %s)', ts1 - t0, st));

  -- k1 runs timers: the SLA job and system events after a note are not a touch.
  PERFORM case_note_add(k1, u_agent, 'asked for the salary certificate', t0 + interval '5 minutes');
  PERFORM case_sla_evaluate(t0 + interval '50 minutes', k1);
  b1 := EXISTS (SELECT 1 FROM case_sla_state_log WHERE case_id = k1 AND actor_role = 'system'
                 AND changed_at = t0 + interval '50 minutes');
  SELECT x.last_activity_at, x.last_touched_by::text INTO ts1, st
    FROM case_inbox(u_owner, a_acct, '{}', t70, 200) x WHERE x.case_id = k1;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND ts1 = t0 + interval '5 minutes' AND st = u_agent::text,
    format('case_sla_evaluate moved the last touch (log row %s; %s, %s)', b1, ts1 - t0, st));
  st := case_sla_event_system(k1, 'bank_response', t0 + interval '55 minutes');
  b1 := EXISTS (SELECT 1 FROM case_sla_state_log WHERE case_id = k1 AND actor_role = 'system'
                 AND changed_at = t0 + interval '55 minutes');
  SELECT x.last_activity_at, x.last_touched_by::text INTO ts1, st
    FROM case_inbox(u_owner, a_acct, '{}', t70, 200) x WHERE x.case_id = k1;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND ts1 = t0 + interval '5 minutes' AND st = u_agent::text,
    format('case_sla_event_system moved the last touch (log row %s; %s, %s)', b1, ts1 - t0, st));

  -- k3: tasks (one overdue, one done), documents, a late note.
  tk1 := case_task_create(k3, u_agent, 'collect', NULL, t0 + interval '30 minutes', t0);
  tk2 := case_task_create(k3, u_agent, 'collect', NULL, t0 + interval '30 minutes', t0);
  PERFORM case_task_set_status(tk2, u_agent, 'done', t0 + interval '1 minute');
  PERFORM case_doc_set_status(k3, u_agent, 'eid', 'received', 'file-eid-1', t0 + interval '2 minutes');
  PERFORM case_doc_set_status(k3, u_agent, 'salary', 'requested', NULL, t0 + interval '3 minutes');
  PERFORM case_note_add(k3, u_agent, 'still waiting', t0 + interval '36 hours');

  -- ---------- visibility ----------
  lbl := ARRAY['owner', 'admin', 'team lead', 'other team''s lead', 'coordinator', 'agent', 'agent2',
               'agent on no case', 'viewer', 'bank guest', 'deactivated agent', 'B owner', 'B admin'];
  usr := ARRAY[u_owner, u_admin, u_lead, u_lead2, u_coord, u_agent, u_agent2, u_agent3, u_viewer, u_guest, u_gone,
               u_bown, u_badmin];
  FOR i IN 1 .. array_length(usr, 1) LOOP
    FOR j IN 1 .. array_length(kall, 1) LOOP
      b1 := kall[j] = ANY (pg_temp.ci_set(usr[i], a_acct, '{"include_closed": true}', t0, 'true')
                           || pg_temp.ci_set(usr[i], b_acct, '{"include_closed": true}', t0, 'true'));
      b2 := case_can_read(kall[j], usr[i]);
      n := n + 1; failed := failed || pg_temp.cs_ok(b1 = b2,
        format('inbox visibility of k%s for the %s is %s, case_can_read says %s', j, lbl[i], b1, b2));
    END LOOP;
  END LOOP;
  -- The parity is not vacuous: who sees what, pinned.
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.ci_set(u_owner, a_acct, '{"include_closed": true}', t0, 'true')
      = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k1, k2, k3, k4, k5]) x)
    AND pg_temp.ci_set(u_lead, a_acct, '{"include_closed": true}', t0, 'true')
      = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k1, k3]) x)
    AND pg_temp.ci_set(u_lead2, a_acct, '{"include_closed": true}', t0, 'true')
      = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k2, k5]) x)
    AND pg_temp.ci_set(u_coord, a_acct, '{"include_closed": true}', t0, 'true')
      = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k1, k2]) x)
    AND pg_temp.ci_set(u_badmin, b_acct, '{"include_closed": true}', t0, 'true') = ARRAY[kb]
    AND cardinality(pg_temp.ci_set(u_viewer, a_acct, '{"include_closed": true}', t0, 'true')) = 0
    AND cardinality(pg_temp.ci_set(u_guest, a_acct, '{"include_closed": true}', t0, 'true')) = 0
    AND cardinality(pg_temp.ci_set(u_gone, a_acct, '{"include_closed": true}', t0, 'true')) = 0,
    'the inbox does not list owner {k1..k5}, lead {k1,k3}, lead2 {k2,k5}, coordinator {k1,k2}, B admin {kb}, nothing for viewer / guest / deactivated');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    cardinality(pg_temp.ci_set(u_owner, b_acct, '{"include_closed": true}', t0, 'true')) = 0
    AND cardinality(pg_temp.ci_set(u_bown, a_acct, '{"include_closed": true}', t0, 'true')) = 0
    AND NOT (kb = ANY (pg_temp.ci_set(u_owner, a_acct, '{"include_closed": true}', t0, 'true')))
    AND NOT (k1 = ANY (pg_temp.ci_set(u_bown, b_acct, '{"include_closed": true}', t0, 'true'))),
    'the inbox crossed accounts');
  FOREACH r IN ARRAY ARRAY[format('NULL, %L', a_acct), format('%L, NULL', u_owner)] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('case_inbox(%s) was not NOT_ALLOWED', r),
      'service_role', NULL, format('SELECT count(*)::text FROM case_inbox(%s, ''{}'', now())', r),
      'ERROR 42501 NOT_ALLOWED:%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['NULL', '''infinity''', '''-infinity'''] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('case_inbox at clock %s was not NOW_REQUIRED', r),
      'service_role', NULL, format('SELECT count(*)::text FROM case_inbox(%L, %L, ''{}'', %s)', u_owner, a_acct, r),
      'ERROR 22023 NOW_REQUIRED:%');
  END LOOP;

  -- ---------- columns ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT string_agg(x.case_id::text || ':' || x.documents_missing || '/' || x.open_task_overdue_count || '/'
                       || x.customer_waiting || '/' || x.bank_query_open || '/' || x.overdue_rank::text, ',' ORDER BY x.case_id)
       FROM case_inbox(u_owner, a_acct, '{}', t70, 200) x WHERE x.case_id IN (k1, k2, k3, k4))
    = (SELECT string_agg(e, ',' ORDER BY id) FROM (VALUES
         (k1, k1::text || ':2/0/true/false/{10,0}'),
         (k2, k2::text || ':0/0/false/true/{0,0}'),
         (k3, k3::text || ':1/1/true/false/{10,1}'),
         (k4, k4::text || ':0/0/false/false/{0,0}')) v(id, e)),
    format('documents_missing / open_task_overdue_count / customer_waiting / bank_query_open / overdue_rank at t0+70m are wrong (%s)',
      (SELECT string_agg(x.documents_missing || '/' || x.open_task_overdue_count || '/' || x.customer_waiting || '/'
                         || x.bank_query_open || '/' || x.overdue_rank::text, ',' ORDER BY array_position(ARRAY[k1, k2, k3, k4], x.case_id))
         FROM case_inbox(u_owner, a_acct, '{}', t70, 200) x WHERE x.case_id IN (k1, k2, k3, k4))));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT x.open_task_overdue_count = 0 AND x.overdue_rank = ARRAY[0, 0]
       FROM case_inbox(u_owner, a_acct, '{}', t0, 200) x WHERE x.case_id = k3),
    'k3 at t0 counts a task or a timer as overdue before its due time');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT x.contact_name = 'CI one' AND x.contact_id = ca AND x.submission_ref = 'CT-125-1'
            AND x.bank_name = 'ADCB Bank' AND x.product = 'Loan' AND x.amount = 1000 AND x.stage = 'Submitted'
            AND x.agent_id = u_agent AND x.coordinator_id = u_coord AND x.opened_at IS NOT NULL AND x.closed_at IS NULL
       FROM case_inbox(u_owner, a_acct, '{}', t70, 200) x WHERE x.case_id = k1),
    'k1''s contact / submission / bank / detail columns are wrong');
  DELETE FROM contacts WHERE id = ca2;
  SELECT x.contact_name, x.contact_id::text INTO st, r
    FROM case_inbox(u_owner, a_acct, '{}', t70, 200) x WHERE x.case_id = k4;
  n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL AND r IS NULL
    AND k4 = ANY (pg_temp.ci_set(u_owner, a_acct, '{}', t70, 'true')),
    format('after its contact is deleted k4 is not listed with no contact (%s, %s)', st, r));

  -- ---------- filters ----------
  -- At t0+70m (t0+2d for no_activity_days): each filtered set equals the
  -- unfiltered listing restricted by the filter's meaning, and is a
  -- proper, non-empty subset.
  flt := ARRAY['{"bank": "ADCB"}', '{"stage": "Query raised"}', format('{"agent": "%s"}', u_agent2),
    '{"priority": "high"}', '{"sla_state": "overdue"}', '{"stage": "Submitted"}',
    '{"customer_waiting": true}', '{"customer_waiting": false}', '{"documents_missing": true}',
    '{"documents_missing": false}', '{"bank_query_open": true}', '{"bank_query_open": false}',
    '{"no_activity_days": 1}', '{"include_closed": true, "bank": "ENBD"}', '{"include_closed": true, "stage": "Closed"}'];
  prd := ARRAY['x.bank_code = ''ADCB''', 'x.stage = ''Query raised''', format('x.agent_id = %L', u_agent2),
    'x.priority = ''high''', 'x.sla_state = ''overdue''', 'x.stage = ''Submitted''',
    'x.customer_waiting', 'NOT x.customer_waiting', 'x.documents_missing > 0',
    'x.documents_missing = 0', 'x.bank_query_open', 'NOT x.bank_query_open',
    'x.last_activity_at < $4 - interval ''1 day''', 'x.bank_code = ''ENBD''', 'x.stage = ''Closed'''];
  FOR i IN 1 .. array_length(flt, 1) LOOP
    ts1 := CASE WHEN flt[i] LIKE '%no_activity_days%' THEN t0 + interval '2 days' ELSE t70 END;
    ids := pg_temp.ci_set(u_owner, a_acct, flt[i]::jsonb, ts1, 'true');
    ids2 := pg_temp.ci_set(u_owner, a_acct,
      CASE WHEN flt[i] LIKE '%"include_closed": true%' THEN '{"include_closed": true}' ELSE '{}' END::jsonb, ts1, prd[i]);
    acc := pg_temp.ci_set(u_owner, a_acct,
      CASE WHEN flt[i] LIKE '%"include_closed": true%' THEN '{"include_closed": true}' ELSE '{}' END::jsonb, ts1, 'true');
    n := n + 1; failed := failed || pg_temp.cs_ok(ids = ids2 AND cardinality(ids) BETWEEN 1 AND cardinality(acc) - 1,
      format('filter %s did not select exactly its cases (%s of %s; expected %s)', flt[i], cardinality(ids),
        cardinality(acc), cardinality(ids2)));
  END LOOP;
  -- sla_state is live: cases.sla_state (the job's last run) disagrees.
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.ci_set(u_owner, a_acct, '{"sla_state": "overdue"}', t70, 'true')
      = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k1, k3]) x)
    AND pg_temp.ci_set(u_owner, a_acct, '{"sla_state": "due_soon"}', t0 + interval '50 minutes', 'true')
      = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[k1, k3]) x)
    AND (SELECT sla_state FROM cases WHERE id = k1) = 'due_soon'
    AND (SELECT sla_state FROM cases WHERE id = k3) = 'on_track',
    'filter sla_state does not follow the live timers at p_now (k1, k3 overdue at t0+70m while cases.sla_state says due_soon / on_track)');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT (k5 = ANY (pg_temp.ci_set(u_owner, a_acct, '{}', t70, 'true')))
    AND k5 = ANY (pg_temp.ci_set(u_owner, a_acct, '{"include_closed": true}', t70, 'true'))
    AND pg_temp.ci_set(u_owner, a_acct, '{"include_closed": false}', t70, 'true')
      = pg_temp.ci_set(u_owner, a_acct, '{}', t70, 'true'),
    'include_closed does not default to false (closed k5 hidden, shown with true)');
  FOREACH r IN ARRAY ARRAY['{"nope": 1}', '{"bank": 1}', '{"bank": " "}', '{"stage": ["Submitted"]}',
    '{"agent": "not-a-uuid"}', '{"agent": 7}', '{"priority": "top"}', '{"sla_state": "late"}', '{"sort": "newest"}',
    '{"customer_waiting": "yes"}', '{"documents_missing": 1}', '{"bank_query_open": null}',
    '{"include_closed": "true"}', '{"no_activity_days": 0}', '{"no_activity_days": 3651}',
    '{"no_activity_days": 1.5}', '{"no_activity_days": "3"}', '[]'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('filters %s were not FILTER_INVALID', r),
      'service_role', NULL, format('SELECT count(*)::text FROM case_inbox(%L, %L, %L, now())', u_owner, a_acct, r),
      'ERROR 22023 FILTER_INVALID:%');
  END LOOP;

  -- ---------- sorts and paging ----------
  FOR i IN 1 .. 3 LOOP
    ids := pg_temp.ci_list(u_owner, a_acct, jsonb_build_object('sort', sorts[i], 'include_closed', true), t70);
    ids2 := pg_temp.ci_ref(u_owner, a_acct, jsonb_build_object('sort', sorts[i], 'include_closed', true), t70, orders[i]);
    n := n + 1; failed := failed || pg_temp.cs_ok(ids = ids2 AND cardinality(ids) = 5,
      format('sort %s does not order by %s', sorts[i], orders[i]));
    -- keyset paging, 2 rows a page
    acc := '{}';
    cur := NULL;
    FOR j IN 1 .. 10 LOOP
      ids2 := (SELECT coalesce(array_agg(x.case_id ORDER BY x.o), '{}')
                 FROM case_inbox(u_owner, a_acct, jsonb_build_object('sort', sorts[i], 'include_closed', true), t70, 2, cur)
                      WITH ORDINALITY AS x(case_id, bank_code, stage, agent_id, coordinator_id, priority, due_at,
                        sla_state, overdue_rank, customer_waiting, documents_missing, bank_query_open,
                        last_activity_at, last_touched_by, open_task_overdue_count, submission_ref, contact_id,
                        contact_name, bank_name, product, amount, opened_at, closed_at, cursor, o));
      EXIT WHEN cardinality(ids2) = 0;
      acc := acc || ids2;
      cur := (SELECT x.cursor FROM case_inbox(u_owner, a_acct, jsonb_build_object('sort', sorts[i], 'include_closed', true),
                t70, 2, cur) x WHERE x.case_id = ids2[cardinality(ids2)]);
      EXIT WHEN cardinality(ids2) < 2;
    END LOOP;
    n := n + 1; failed := failed || pg_temp.cs_ok(acc = ids,
      format('keyset paging (2 a page) under sort %s does not return every case once in order (%s of %s)', sorts[i],
        cardinality(acc), cardinality(ids)));
  END LOOP;
  -- pinned: k3 (10 min overdue, 1 overdue task) before k1 (10 min, none)
  -- under most_overdue; due_soonest leads with k2 (due t0+1d), then k3.
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (pg_temp.ci_list(u_owner, a_acct, '{}', t70))[1:2] = ARRAY[k3, k1]
    AND (pg_temp.ci_list(u_owner, a_acct, '{"sort": "due_soonest"}', t70))[1:2] = ARRAY[k2, k3],
    'most_overdue does not lead with k3, k1, or due_soonest with k2, k3');
  cur := (SELECT x.cursor FROM case_inbox(u_owner, a_acct, '{}', t70, 2) x OFFSET 1 LIMIT 1);
  cur2 := (SELECT x.cursor FROM case_inbox(u_owner, a_acct, '{"sort": "stalest"}', t70, 2) x OFFSET 1 LIMIT 1);
  FOREACH r IN ARRAY ARRAY[
    format('%L, %L, ''{"sort": "due_soonest"}'', %L, 2, %L', u_owner, a_acct, t70, cur),
    format('%L, %L, ''{}'', %L, 2, %L', u_owner, a_acct, t70 + interval '1 minute', cur),
    format('%L, %L, ''{}'', %L, 2, %L', u_owner, a_acct, t70, cur2),
    format('%L, %L, ''{}'', %L, 2, ''junk''', u_owner, a_acct, t70),
    format('%L, %L, ''{}'', %L, 2, ''{}''', u_owner, a_acct, t70),
    format('%L, %L, ''{}'', %L, 2, %L', u_owner, a_acct, t70, replace(cur, '"case_id": "', '"case_id": "x'))] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('case_inbox(%s) was not CURSOR_INVALID', left(r, 160)),
      'service_role', NULL, format('SELECT count(*)::text FROM case_inbox(%s)', r), 'ERROR 22023 CURSOR_INVALID:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('case_inbox with limit 0 was not LIMIT_INVALID',
    'service_role', NULL, format('SELECT count(*)::text FROM case_inbox(%L, %L, ''{}'', now(), 0)', u_owner, a_acct),
    'ERROR 22023 LIMIT_INVALID:%');

  -- ---------- a pure read, service_role only ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT provolatile FROM pg_proc WHERE oid = 'public.case_inbox(uuid,uuid,jsonb,timestamptz,integer,text)'::regprocedure) = 's',
    'case_inbox is not STABLE');
  w1 := pg_temp.ci_writes();
  FOR i IN 1 .. array_length(usr, 1) LOOP
    PERFORM count(*) FROM case_inbox(usr[i], a_acct, '{"include_closed": true}', t70, 200);
  END LOOP;
  PERFORM count(*) FROM case_inbox(u_owner, a_acct, '{"sort": "stalest"}', t70, 2, cur2);
  w2 := pg_temp.ci_writes();
  n := n + 1; failed := failed || pg_temp.cs_ok(w1 > 0 AND w2 = w1,
    format('case_inbox wrote %s row(s) (before %s)', w2 - w1, w1));
  st := pg_temp.cs_try('service_role', NULL,
    format('SELECT count(*)::text FROM case_inbox(%L, %L, ''{}'', now())', u_owner, a_acct));
  n := n + 1; failed := failed || pg_temp.cs_ok(st = '4',
    format('service_role cannot list the inbox (%s)', st));
  SELECT string_agg(f || '/' || rl, ',' ORDER BY f, rl) INTO st
    FROM unnest(ARRAY['public.case_inbox(uuid,uuid,jsonb,timestamptz,integer,text)',
                      'public.case_inbox_text_filter(jsonb,text,text[])', 'public.case_inbox_bool_filter(jsonb,text)',
                      'public.case_inbox_k1(text,timestamptz,timestamptz)', 'public.case_inbox_k3(text,timestamptz)']) f,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) rl
   WHERE has_function_privilege(rl, f, 'EXECUTE')
     AND NOT (f LIKE 'public.case_inbox(%' AND rl = 'service_role');
  n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL
    AND has_function_privilege('service_role', 'public.case_inbox(uuid,uuid,jsonb,timestamptz,integer,text)', 'EXECUTE'),
    format('125 functions are not service_role-only for case_inbox and private otherwise (%s)', st));
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s could call case_inbox', r), r, u_owner,
      format('SELECT count(*)::text FROM case_inbox(%L, %L, ''{}'', now())', u_owner, a_acct), 'ERROR 42501 %');
  END LOOP;

  -- ---------- page size (last: it adds 200 cases) ----------
  FOR i IN 1 .. 200 LOOP
    g[5 + i] := (SELECT x.group_id FROM sg_open(a_acct, 'CT-125-P' || i, ca, wa, 'page ' || i, NULL,
      jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent')), NULL) x);
    PERFORM case_open(g[5 + i], NULL, NULL, NULL, NULL, NULL);
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_inbox(u_owner, a_acct, '{}', t70, 500)) = 200
    AND (SELECT count(*) FROM case_inbox(u_owner, a_acct, '{}', t70, NULL)) = 50
    AND (SELECT count(*) FROM case_inbox(u_owner, a_acct, '{}', t70)) = 50,
    'a page is not capped at 200 (limit 500) or does not default to 50');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT125', MESSAGE = 'verify-case-inbox rollback';
  EXCEPTION WHEN SQLSTATE 'ZT125' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case inbox verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case inbox verification passed (% checks)', n;
END
$verify$;
