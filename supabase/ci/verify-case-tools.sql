-- Behavioural regression suite for case tools (migration 123): tasks,
-- the document checklist and internal notes on 122's cases.
--
-- Tasks come only from a template of the case's own account and bank;
-- the owner defaults to the case agent and must be able to act on the
-- case; due = the clock + the template's due_hours (NULL without one),
-- never infinite; every status, the initial 'open' included, is a log
-- row; overdue is computed (past due, not done, blocked included) over
-- cases the actor reads. Documents are the case's own account / bank /
-- product requirements (product case-insensitive, trimmed); file_ref is
-- an id, never a path or dot-file; 'received' needs one. Notes resolve
-- only lowercase @<uuid> of people who may act on the case. Config is
-- owner/admin only, for a bank the account has. The log, notes and
-- mentions are append-only, tasks and documents untruncatable, for
-- every writer; no API role writes a 123 table or executes a 123
-- function but the service role.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000123001';
  u_admin  UUID := '00000000-0000-4000-8000-000000123002';
  u_lead   UUID := '00000000-0000-4000-8000-000000123003';  -- leads team T (u_agent)
  u_coord  UUID := '00000000-0000-4000-a000-000000123004';  -- agent, coordinator on g1 (hex 'a': upper() differs)
  u_agent  UUID := '00000000-0000-4000-8000-000000123005';  -- agent of k1 .. k3
  u_agent2 UUID := '00000000-0000-4000-8000-000000123006';  -- agent of k4 only
  u_viewer UUID := '00000000-0000-4000-8000-000000123007';
  u_bown   UUID := '00000000-0000-4000-8000-000000123008';  -- owner of account B
  u_badmin UUID := '00000000-0000-4000-8000-000000123009';  -- admin of account B
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  wb       UUID;
  ca       UUID;
  cb       UUID;
  team1    UUID;
  g        UUID[] := '{}';
  k1       UUID;  -- A, ADCB, ' loan ', agent u_agent, coordinator u_coord
  k2       UUID;  -- A, no bank
  k3       UUID;  -- A, ADCB, no product
  k4       UUID;  -- A, ADCB, 'LOAN', agent u_agent2
  kb       UUID;  -- B, ADCB, 'Loan'
  tk1      UUID;
  tk2      UUID;
  tk3      UUID;
  tk4      UUID;
  tk5      UUID;
  tk6      UUID;
  tkb      UUID;
  nt1      UUID;
  nt2      UUID;
  t0       TIMESTAMPTZ := '2026-01-01 00:00:00+00';
  rec      RECORD;
  acc      JSONB;
  i        INT;
  j        INT;
  u        UUID;
  lbl      TEXT[];
  usr      UUID[];
  ops      TEXT[];
  arr      TEXT[];
  ids      UUID[];
  b1       BOOLEAN;
  st       TEXT;
  rd       TEXT;
  r        TEXT;
  v_body   TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
  fns      TEXT[] := ARRAY['case_tools_lock_for_write', 'case_task_create', 'case_task_set_status',
    'case_task_overdue', 'case_doc_set_status', 'case_doc_request_begin', 'case_doc_mark_requested',
    'case_note_add', 'case_task_template_upsert', 'case_task_template_delete', 'case_doc_requirement_upsert',
    'case_doc_requirement_delete'];
  tbls     TEXT[] := ARRAY['case_task_templates', 'case_doc_requirements', 'case_tasks', 'case_task_status_log',
    'case_documents', 'case_notes', 'case_note_mentions'];
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
  -- NULL when cs_try's result is LIKE p_like, else the check's name and
  -- the result (so `failed := failed || cs_check(…)` records failures only).
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

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'ct-owner@example.invalid'),
    (u_admin,  'ct-admin@example.invalid'),
    (u_lead,   'ct-lead@example.invalid'),
    (u_coord,  'ct-coord@example.invalid'),
    (u_agent,  'ct-agent@example.invalid'),
    (u_agent2, 'ct-agent2@example.invalid'),
    (u_viewer, 'ct-viewer@example.invalid'),
    (u_bown,   'ct-bown@example.invalid'),
    (u_badmin, 'ct-badmin@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_coord, u_agent, u_agent2);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  UPDATE profiles SET account_id = b_acct, account_role = 'admin' WHERE user_id = u_badmin;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CT T', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-123-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_bown, b_acct, 'whapi', 'CT-123-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500123001', 'CT one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500123002', 'CT two')
    RETURNING id INTO cb;

  FOR i IN 1 .. 4 LOOP
    acc := CASE i
      WHEN 1 THEN jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                                    jsonb_build_object('user_id', u_agent, 'label', 'agent'))
      WHEN 4 THEN jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent'))
      ELSE jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')) END;
    g[i] := (SELECT x.group_id FROM sg_open(a_acct, 'CT-123-' || i, ca, wa, 'tools ' || i, NULL, acc, NULL) x);
    IF g[i] IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group %', i; END IF;
  END LOOP;
  g[5] := (SELECT x.group_id FROM sg_open(b_acct, 'CT-123-5', cb, wb, 'tools 5', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_badmin, 'label', 'agent')), NULL) x);
  k1 := (SELECT x.case_id FROM case_open(g[1], 'ADCB', 'ADCB Bank', ' loan ', 1000, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g[2], NULL, NULL, NULL, NULL, NULL) x);
  k3 := (SELECT x.case_id FROM case_open(g[3], 'ADCB', NULL, NULL, NULL, NULL) x);
  k4 := (SELECT x.case_id FROM case_open(g[4], 'ADCB', NULL, 'LOAN', NULL, NULL) x);
  kb := (SELECT x.case_id FROM case_open(g[5], 'ADCB', 'B ADCB', 'Loan', NULL, NULL) x);
  IF k1 IS NULL OR k2 IS NULL OR k3 IS NULL OR k4 IS NULL OR kb IS NULL THEN
    RAISE EXCEPTION 'fixture: case_open returned no case';
  END IF;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ENBD', 'Emirates NBD');

  -- ---------- configuration (owner / admin only) ----------
  PERFORM case_task_template_upsert(u_owner, a_acct, 'ADCB', 'collect', 'Collect docs', 1, 48);
  PERFORM case_task_template_upsert(u_owner, a_acct, 'ADCB', 'nodue', 'No due date', 2, NULL);
  PERFORM case_task_template_upsert(u_owner, a_acct, 'ENBD', 'enbd_only', 'ENBD only', 1, 24);
  PERFORM case_task_template_upsert(u_bown, b_acct, 'ADCB', 'b_only', 'B only', 1, 24);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ADCB', 'Loan', 'eid', 'Emirates ID', 1);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ADCB', 'Loan', 'salary', 'Salary certificate', 2);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ADCB', 'Loan', 'bank_stmt', 'Bank statement', 3);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ADCB', 'Card', 'card_doc', 'Card form', 1);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ENBD', 'Loan', 'enbd_doc', 'ENBD form', 1);
  PERFORM case_doc_requirement_upsert(u_bown, b_acct, 'ADCB', 'Loan', 'b_doc', 'B form', 1);

  -- The admin updates in place (a template, and a requirement under
  -- another spelling of the product).
  PERFORM case_task_template_upsert(u_admin, a_acct, 'ADCB', 'collect', 'Collect documents', 1, 48);
  PERFORM case_doc_requirement_upsert(u_admin, a_acct, 'ADCB', ' LOAN ', 'eid', 'Emirates ID (both sides)', 1);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_task_templates WHERE account_id = a_acct AND bank_code = 'ADCB'
       AND template_key = 'collect') = 1
    AND (SELECT title FROM case_task_templates WHERE account_id = a_acct AND bank_code = 'ADCB'
           AND template_key = 'collect') = 'Collect documents',
    'case_task_template_upsert by the admin did not update the template in place');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_doc_requirements WHERE account_id = a_acct AND bank_code = 'ADCB'
       AND doc_key = 'eid') = 1
    AND (SELECT product || '/' || label FROM case_doc_requirements WHERE account_id = a_acct AND bank_code = 'ADCB'
           AND doc_key = 'eid') = 'Loan/Emirates ID (both sides)',
    'case_doc_requirement_upsert under '' LOAN '' did not update the ''Loan'' row in place');

  lbl := ARRAY['team lead', 'agent', 'another workspace''s owner', 'NULL actor'];
  usr := ARRAY[u_lead, u_agent, u_bown, NULL];
  ops := ARRAY[
    'SELECT template_key FROM case_task_template_upsert(%L, %L, ''ADCB'', ''x_new'', ''X'', 1, 1)',
    'SELECT case_task_template_delete(%L, %L, ''ADCB'', ''collect'')::text',
    'SELECT doc_key FROM case_doc_requirement_upsert(%L, %L, ''ADCB'', ''Loan'', ''x_new'', ''X'', 1)',
    'SELECT case_doc_requirement_delete(%L, %L, ''ADCB'', ''Loan'', ''eid'')::text'];
  FOR i IN 1 .. 4 LOOP
    FOR j IN 1 .. 4 LOOP
      n := n + 1; failed := failed || pg_temp.cs_check(format('config op %s by the %s was not NOT_ALLOWED', j, lbl[i]),
        'service_role', NULL, format(ops[j], usr[i], a_acct), 'ERROR 42501 NOT_ALLOWED:%');
    END LOOP;
  END LOOP;
  -- ENBD is a bank of A, not of B.
  FOR j IN 1 .. 4 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('config op %s for another workspace''s bank was not BANK_UNKNOWN', j),
      'service_role', NULL, replace(format(ops[j], u_bown, b_acct), '''ADCB''', '''ENBD'''), 'ERROR 23514 BANK_UNKNOWN:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_task_templates WHERE template_key = 'x_new') = 0
    AND (SELECT count(*) FROM case_doc_requirements WHERE doc_key = 'x_new') = 0
    AND (SELECT count(*) FROM case_task_templates WHERE account_id = a_acct) = 3
    AND (SELECT count(*) FROM case_doc_requirements WHERE account_id = a_acct) = 5,
    'a refused config call changed a row');

  -- Delete removes only that row; a missing one answers false.
  PERFORM case_task_template_upsert(u_admin, a_acct, 'ADCB', 'tmp', 'Temp', 9, NULL);
  PERFORM case_doc_requirement_upsert(u_admin, a_acct, 'ADCB', 'Loan', 'tmp', 'Temp', 9);
  b1 := case_task_template_delete(u_admin, a_acct, 'ADCB', 'tmp');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1
    AND NOT EXISTS (SELECT 1 FROM case_task_templates WHERE template_key = 'tmp')
    AND (SELECT count(*) FROM case_task_templates WHERE account_id = a_acct) = 3
    AND (SELECT count(*) FROM case_task_templates WHERE account_id = b_acct) = 1,
    'case_task_template_delete did not remove exactly its row');
  b1 := case_task_template_delete(u_owner, a_acct, 'ADCB', 'tmp');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 IS FALSE, 'case_task_template_delete of a missing row did not answer false');
  b1 := case_doc_requirement_delete(u_admin, a_acct, 'ADCB', ' LOAN', 'tmp');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1
    AND NOT EXISTS (SELECT 1 FROM case_doc_requirements WHERE doc_key = 'tmp')
    AND (SELECT count(*) FROM case_doc_requirements WHERE account_id = a_acct) = 5
    AND (SELECT count(*) FROM case_doc_requirements WHERE account_id = b_acct) = 1,
    'case_doc_requirement_delete did not remove exactly its row');
  b1 := case_doc_requirement_delete(u_owner, a_acct, 'ADCB', 'Loan', 'tmp');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 IS FALSE, 'case_doc_requirement_delete of a missing row did not answer false');

  -- ---------- tasks ----------
  tk1 := case_task_create(k1, u_agent, 'collect', NULL, NULL, t0);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT owner_id = u_agent AND due_at = t0 + interval '48 hours' AND status = 'open' AND created_by = u_agent
            AND title = 'Collect documents' AND account_id = a_acct AND case_id = k1
       FROM case_tasks WHERE id = tk1),
    'a default task is not owned by the case agent, due now + due_hours, open');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_task_status_log WHERE task_id = tk1) = 1
    AND (SELECT count(*) FROM case_task_status_log WHERE task_id = tk1 AND from_status IS NULL AND to_status = 'open'
           AND actor_id = u_agent AND actor_role = 'agent' AND changed_at = t0 AND case_id = k1) = 1,
    'the initial open is not one status-log row');
  tk2 := case_task_create(k1, u_coord, 'nodue', u_coord, NULL, t0);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT owner_id = u_coord AND due_at IS NULL FROM case_tasks WHERE id = tk2),
    'a task from a template with no due_hours is not due NULL (or the owner was not kept)');
  tk3 := case_task_create(k1, u_lead, 'collect', NULL, t0 - interval '1 day', t0);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT due_at = t0 - interval '1 day' AND owner_id = u_agent FROM case_tasks WHERE id = tk3),
    'an explicit past due date was not kept');
  lbl := ARRAY['another bank''s', 'another workspace''s', 'an unknown'];
  arr := ARRAY['enbd_only', 'b_only', 'nope'];
  FOR i IN 1 .. 3 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('a task from %s template was not TEMPLATE_NOT_FOUND', lbl[i]),
      'service_role', NULL, format('SELECT case_task_create(%L, %L, %L, NULL, NULL, %L)::text', k1, u_agent, arr[i], t0),
      'ERROR P0002 TEMPLATE_NOT_FOUND:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('a task on a case with no bank was not TEMPLATE_NOT_FOUND',
    'service_role', NULL, format('SELECT case_task_create(%L, %L, ''collect'', NULL, NULL, %L)::text', k2, u_agent, t0),
    'ERROR P0002 TEMPLATE_NOT_FOUND:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a task on an unknown case was not CASE_NOT_FOUND',
    'service_role', NULL, format('SELECT case_task_create(%L, %L, ''collect'', NULL, NULL, %L)::text', gen_random_uuid(), u_agent, t0),
    'ERROR P0002 CASE_NOT_FOUND:%');
  lbl := ARRAY['viewer', 'another agent', 'another workspace''s admin'];
  usr := ARRAY[u_viewer, u_agent2, u_badmin];
  FOR i IN 1 .. 3 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('a task owned by the %s was not OWNER_INVALID', lbl[i]),
      'service_role', NULL, format('SELECT case_task_create(%L, %L, ''collect'', %L, NULL, %L)::text', k1, u_agent, usr[i], t0),
      'ERROR 23514 OWNER_INVALID:%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['infinity', '-infinity'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('a task due %s was not DUE_INVALID', r),
      'service_role', NULL, format('SELECT case_task_create(%L, %L, ''collect'', NULL, %L, %L)::text', k1, u_agent, r, t0),
      'ERROR 23514 DUE_INVALID:%');
  END LOOP;

  -- Status changes: each one logged, a repeat a no-op.
  SELECT x.changed, x.from_status, x.to_status INTO b1, st, rd
    FROM case_task_set_status(tk1, u_agent, 'blocked', t0 + interval '1 hour') x;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND st = 'open' AND rd = 'blocked',
    format('case_task_set_status open -> blocked answered %s %s %s', b1, st, rd));
  SELECT x.changed, x.from_status, x.to_status INTO b1, st, rd
    FROM case_task_set_status(tk1, u_coord, 'blocked', t0 + interval '2 hours') x;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 IS FALSE AND st = 'blocked' AND rd = 'blocked',
    'a same-status change was not a no-op');
  SELECT x.changed INTO b1 FROM case_task_set_status(tk1, u_admin, 'done', t0 + interval '3 hours') x;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT status FROM case_tasks WHERE id = tk1) = 'done'
    AND (SELECT array_agg(coalesce(from_status, '-') || '>' || to_status || ':' || actor_role ORDER BY id)
           FROM case_task_status_log WHERE task_id = tk1) = ARRAY['->open:agent', 'open>blocked:agent', 'blocked>done:admin'],
    'the status log of a task is not one row per change');
  FOREACH r IN ARRAY ARRAY['closed', 'Done'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('task status %s was not STATUS_INVALID', r),
      'service_role', NULL, format('SELECT changed::text FROM case_task_set_status(%L, %L, %L, NULL)', tk2, u_agent, r),
      'ERROR 23514 STATUS_INVALID:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('task status NULL was not STATUS_INVALID',
    'service_role', NULL, format('SELECT changed::text FROM case_task_set_status(%L, %L, NULL, NULL)', tk2, u_agent),
    'ERROR 23514 STATUS_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('an unknown task was not TASK_NOT_FOUND',
    'service_role', NULL, format('SELECT changed::text FROM case_task_set_status(%L, %L, ''done'', NULL)', gen_random_uuid(), u_agent),
    'ERROR P0002 TASK_NOT_FOUND:%');

  -- Overdue at t0 + 72 h: tk3 (open, past due) and tk4 (blocked, past
  -- due) for u_agent; tk1 done, tk2 no due, tk6 not yet due; tk5 is
  -- k4's (u_agent2), tkb is account B's.
  tk4 := case_task_create(k1, u_agent, 'collect', NULL, NULL, t0);
  PERFORM case_task_set_status(tk4, u_agent, 'blocked', t0);
  tk5 := case_task_create(k4, u_agent2, 'collect', NULL, NULL, t0);
  tk6 := case_task_create(k1, u_agent, 'collect', NULL, t0 + interval '100 hours', t0);
  tkb := case_task_create(kb, u_badmin, 'b_only', NULL, NULL, t0);
  lbl := ARRAY['the agent', 'another agent', 'the admin', 'the viewer', 'another workspace''s admin'];
  usr := ARRAY[u_agent, u_agent2, u_admin, u_viewer, u_badmin];
  FOR i IN 1 .. 5 LOOP
    ids := CASE i WHEN 1 THEN ARRAY[tk3, tk4] WHEN 2 THEN ARRAY[tk5] WHEN 3 THEN ARRAY[tk3, tk4, tk5]
                  WHEN 4 THEN '{}'::uuid[] ELSE ARRAY[tkb] END;
    n := n + 1; failed := failed || pg_temp.cs_ok(
      coalesce((SELECT array_agg(x.task_id ORDER BY x.task_id) FROM case_task_overdue(usr[i], t0 + interval '72 hours') x), '{}')
      = coalesce((SELECT array_agg(y ORDER BY y) FROM unnest(ids) y), '{}'),
      format('case_task_overdue for %s is not exactly its readable past-due, not-done tasks', lbl[i]));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('case_task_overdue without a clock was not NOW_REQUIRED',
    'service_role', NULL, format('SELECT count(*)::text FROM case_task_overdue(%L, NULL)', u_agent),
    'ERROR 22004 NOW_REQUIRED:%');

  -- ---------- documents ----------
  SELECT * INTO rec FROM case_doc_request_begin(k1, u_agent);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    rec.account_id = a_acct AND rec.group_id = g[1] AND rec.submission_ref = 'CT-123-1' AND rec.bank_name = 'ADCB Bank'
    AND rec.doc_keys = ARRAY['eid', 'salary', 'bank_stmt']
    AND rec.doc_labels = ARRAY['Emirates ID (both sides)', 'Salary certificate', 'Bank statement'],
    format('case_doc_request_begin on '' loan '' did not list exactly ''Loan''''s ADCB docs of A (%s / %s)',
      rec.doc_keys, rec.doc_labels));
  st := case_doc_set_status(k1, u_agent, 'eid', 'received', 'file-123_a:b.pdf', t0);
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'received'
    AND (SELECT status || '/' || file_ref || '/' || updated_by FROM case_documents WHERE case_id = k1 AND doc_key = 'eid')
        = 'received/file-123_a:b.pdf/' || u_agent,
    'case_doc_set_status received did not store the status and file ref');
  st := case_doc_set_status(k1, u_coord, 'salary', 'rejected', repeat('a', 128), t0);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT status FROM case_documents WHERE case_id = k1 AND doc_key = 'salary') = 'rejected',
    'a 128-character file ref was refused');
  lbl := ARRAY['.', '..', '.env', repeat('a', 129), 'a/b', '../etc/passwd'];
  FOR i IN 1 .. 6 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('file ref %s was not FILE_REF_INVALID', left(lbl[i], 20)),
      'service_role', NULL, format('SELECT case_doc_set_status(%L, %L, ''bank_stmt'', ''received'', %L, NULL)', k1, u_agent, lbl[i]),
      'ERROR 23514 FILE_REF_INVALID:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('received without a file ref was not FILE_REF_REQUIRED',
    'service_role', NULL, format('SELECT case_doc_set_status(%L, %L, ''bank_stmt'', ''received'', NULL, NULL)', k1, u_agent),
    'ERROR 23514 FILE_REF_REQUIRED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('document status ''missing'' was not STATUS_INVALID',
    'service_role', NULL, format('SELECT case_doc_set_status(%L, %L, ''bank_stmt'', ''missing'', NULL, NULL)', k1, u_agent),
    'ERROR 23514 STATUS_INVALID:%');
  FOREACH r IN ARRAY ARRAY['b_doc', 'enbd_doc', 'card_doc', 'nope'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('document %s on k1 was not DOC_NOT_REQUIRED', r),
      'service_role', NULL, format('SELECT case_doc_set_status(%L, %L, %L, ''requested'', NULL, NULL)', k1, u_agent, r),
      'ERROR 23514 DOC_NOT_REQUIRED:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('a document on a case with no bank was not DOC_NOT_REQUIRED',
    'service_role', NULL, format('SELECT case_doc_set_status(%L, %L, ''eid'', ''requested'', NULL, NULL)', k2, u_agent),
    'ERROR 23514 DOC_NOT_REQUIRED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a document on a case with no product was not DOC_NOT_REQUIRED',
    'service_role', NULL, format('SELECT case_doc_set_status(%L, %L, ''eid'', ''requested'', NULL, NULL)', k3, u_agent),
    'ERROR 23514 DOC_NOT_REQUIRED:%');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_documents WHERE case_id = k1) = 2 AND NOT EXISTS (SELECT 1 FROM case_documents WHERE case_id IN (k2, k3)),
    'a refused case_doc_set_status wrote a row');

  SELECT * INTO rec FROM case_doc_request_begin(k1, u_coord);
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.doc_keys = ARRAY['salary', 'bank_stmt'],
    format('case_doc_request_begin did not list exactly the docs not received (%s)', rec.doc_keys));
  i := case_doc_mark_requested(k1, u_agent, ARRAY['salary', 'bank_stmt', 'eid', 'b_doc', 'card_doc'], t0);
  n := n + 1; failed := failed || pg_temp.cs_ok(i = 2
    AND (SELECT string_agg(doc_key || '=' || status || '/' || coalesce(file_ref, '-'), ',' ORDER BY doc_key)
           FROM case_documents WHERE case_id = k1)
        = 'bank_stmt=requested/-,eid=received/file-123_a:b.pdf,salary=requested/-',
    format('case_doc_mark_requested did not mark exactly the listed required docs not received (%s)', i));
  SELECT * INTO rec FROM case_doc_request_begin(k2, u_agent);
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.doc_keys = '{}'::text[] AND rec.doc_labels = '{}'::text[]
    AND rec.bank_name IS NULL AND rec.group_id = g[2],
    'case_doc_request_begin on a case with no bank is not one row with empty arrays');
  SELECT * INTO rec FROM case_doc_request_begin(k3, u_agent);
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.doc_keys = '{}'::text[] AND rec.doc_labels = '{}'::text[]
    AND rec.bank_name = 'ADCB Bank',
    'case_doc_request_begin on a case with no product is not one row with empty arrays');
  SELECT * INTO rec FROM case_doc_request_begin(kb, u_badmin);
  n := n + 1; failed := failed || pg_temp.cs_ok(rec.doc_keys = ARRAY['b_doc'] AND rec.bank_name = 'B ADCB',
    format('case_doc_request_begin in account B did not list only B''s requirements (%s)', rec.doc_keys));

  -- ---------- notes ----------
  n := n + 1; failed := failed || pg_temp.cs_check('an empty note was not NOTE_EMPTY',
    'service_role', NULL, format('SELECT note_id::text FROM case_note_add(%L, %L, '''', NULL)', k1, u_agent),
    'ERROR 23514 NOTE_EMPTY:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a blank note was not NOTE_EMPTY',
    'service_role', NULL, format('SELECT note_id::text FROM case_note_add(%L, %L, %L, NULL)', k1, u_agent, '   '),
    'ERROR 23514 NOTE_EMPTY:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a tabs-and-newlines note was not NOTE_EMPTY',
    'service_role', NULL, format('SELECT note_id::text FROM case_note_add(%L, %L, %L, NULL)', k1, u_agent, E' \n\t\r '),
    'ERROR 23514 NOTE_EMPTY:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a 10001-character note was not NOTE_TOO_LONG',
    'service_role', NULL, format('SELECT note_id::text FROM case_note_add(%L, %L, %L, NULL)', k1, u_agent, repeat('x', 10001)),
    'ERROR 23514 NOTE_TOO_LONG:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a 10000-character note was refused',
    'service_role', NULL, format('SELECT (note_id IS NOT NULL)::text FROM case_note_add(%L, %L, %L, NULL)', k1, u_agent, repeat('x', 10000)),
    'true');
  v_body := format('ping @%s and @%s. not @%s @%s @%s @junk_handle thanks',
    u_coord, u_lead, u_viewer, u_badmin, upper(u_coord::text));
  SELECT x.note_id, x.mentioned, x.ignored INTO nt1, usr, arr FROM case_note_add(k1, u_agent, v_body, t0) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT array_agg(y ORDER BY y) FROM unnest(usr) y) = (SELECT array_agg(y ORDER BY y) FROM unnest(ARRAY[u_coord, u_lead]) y),
    format('case_note_add mentioned %s, not exactly the coordinator and team lead', usr));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT array_agg(y ORDER BY y) FROM unnest(arr) y)
    = (SELECT array_agg(y ORDER BY y) FROM unnest(ARRAY[u_viewer::text, u_badmin::text, upper(u_coord::text), 'junk_handle']) y),
    format('case_note_add ignored %s, not the viewer, the other workspace''s admin, the uppercase uuid and the junk handle', arr));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT array_agg(user_id ORDER BY user_id) FROM case_note_mentions WHERE note_id = nt1)
      = (SELECT array_agg(y ORDER BY y) FROM unnest(ARRAY[u_coord, u_lead]) y)
    AND (SELECT author_id = u_agent AND body = v_body AND case_id = k1 FROM case_notes WHERE id = nt1),
    'case_note_mentions does not hold exactly the allowed mentions of the note');
  -- u_coord's id has a hex letter, so its uppercase form is a different string.
  SELECT x.note_id, x.mentioned, x.ignored INTO nt2, usr, arr
    FROM case_note_add(k1, u_admin, 'cc @' || upper(u_coord::text) || '-', t0) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    usr = '{}'::uuid[] AND arr = ARRAY[upper(u_coord::text)]
    AND NOT EXISTS (SELECT 1 FROM case_note_mentions WHERE note_id = nt2),
    format('an uppercase mention of a case member was stored (%s / %s)', usr, arr));

  -- ---------- writes refused to non-members ----------
  lbl := ARRAY['viewer', 'another agent', 'another workspace''s admin', 'NULL actor'];
  usr := ARRAY[u_viewer, u_agent2, u_badmin, NULL];
  ops := ARRAY[
    'SELECT case_task_create(%L, %L, ''collect'', NULL, NULL, NULL)::text',
    'SELECT changed::text FROM case_task_set_status(%3$L, %2$L, ''open'', NULL)',
    'SELECT case_doc_set_status(%L, %L, ''bank_stmt'', ''rejected'', NULL, NULL)',
    'SELECT case_doc_mark_requested(%L, %L, ARRAY[''bank_stmt''], NULL)::text',
    'SELECT array_length(doc_keys, 1)::text FROM case_doc_request_begin(%L, %L)',
    'SELECT note_id::text FROM case_note_add(%L, %L, ''hello'', NULL)'];
  FOR i IN 1 .. 4 LOOP
    FOR j IN 1 .. 6 LOOP
      n := n + 1; failed := failed || pg_temp.cs_check(format('case tool op %s by the %s was not NOT_ALLOWED', j, lbl[i]),
        'service_role', NULL, format(ops[j], k1, usr[i], tk2), 'ERROR 42501 NOT_ALLOWED:%');
    END LOOP;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_tasks WHERE case_id = k1) = 5
    AND (SELECT status FROM case_tasks WHERE id = tk2) = 'open'
    AND (SELECT count(*) FROM case_task_status_log WHERE task_id = tk2) = 1
    AND (SELECT count(*) FROM case_notes WHERE case_id = k1) = 3
    AND (SELECT string_agg(doc_key || '=' || status, ',' ORDER BY doc_key) FROM case_documents WHERE case_id = k1)
        = 'bank_stmt=requested,eid=received,salary=requested',
    'a refused case tool write changed a row');

  -- ---------- reads (RLS, active workspace) ----------
  lbl := ARRAY['owner', 'admin', 'team lead', 'coordinator', 'agent'];
  usr := ARRAY[u_owner, u_admin, u_lead, u_coord, u_agent];
  FOR i IN 1 .. 5 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s cannot read k1''s tasks, log, documents, notes and mentions through RLS', lbl[i]),
      'authenticated', usr[i], format(
      'SELECT ((SELECT count(*) FROM case_tasks WHERE case_id = %1$L) = 5
           AND (SELECT count(*) FROM case_task_status_log WHERE case_id = %1$L) = 8
           AND (SELECT count(*) FROM case_documents WHERE case_id = %1$L) = 3
           AND (SELECT count(*) FROM case_notes WHERE case_id = %1$L) = 3
           AND (SELECT count(*) FROM case_note_mentions WHERE case_id = %1$L) = 2)::text', k1), 'true');
  END LOOP;
  lbl := ARRAY['viewer', 'another agent', 'another workspace''s admin', 'another workspace''s owner'];
  usr := ARRAY[u_viewer, u_agent2, u_badmin, u_bown];
  FOR i IN 1 .. 4 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('the %s reads k1''s case tool rows through RLS', lbl[i]),
      'authenticated', usr[i], format(
      'SELECT ((SELECT count(*) FROM case_tasks WHERE case_id = %1$L)
           + (SELECT count(*) FROM case_task_status_log WHERE case_id = %1$L)
           + (SELECT count(*) FROM case_documents WHERE case_id = %1$L)
           + (SELECT count(*) FROM case_notes WHERE case_id = %1$L)
           + (SELECT count(*) FROM case_note_mentions WHERE case_id = %1$L))::text', k1), '0');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('another workspace''s admin reads account A''s tasks through RLS',
    'authenticated', u_badmin, format('SELECT count(*)::text FROM case_tasks WHERE account_id = %L', a_acct), '0');

  -- ---------- locks ----------
  FOREACH r IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
    SELECT string_agg(t, ',' ORDER BY t) INTO rd FROM unnest(tbls) t
     WHERE has_table_privilege(r, 'public.' || t, 'INSERT') OR has_table_privilege(r, 'public.' || t, 'UPDATE')
        OR has_table_privilege(r, 'public.' || t, 'DELETE') OR has_table_privilege(r, 'public.' || t, 'TRUNCATE');
    n := n + 1; failed := failed || pg_temp.cs_ok(rd IS NULL, format('%s holds a write privilege on a case tool table (%s)', r, rd));
  END LOOP;
  FOREACH r IN ARRAY ARRAY['case_task_status_log', 'case_notes', 'case_note_mentions'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s accepted UPDATE as the owner (append-only)', r),
      NULL, NULL, format('UPDATE public.%I SET account_id = account_id', r), 'ERROR 42501 %append-only%');
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s accepted DELETE as the owner (append-only)', r),
      NULL, NULL, format('DELETE FROM public.%I', r), 'ERROR 42501 %append-only%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['case_task_status_log', 'case_note_mentions', 'case_documents'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s accepted TRUNCATE as the owner', r),
      NULL, NULL, format('TRUNCATE public.%I', r), 'ERROR 42501 %append-only%');
  END LOOP;
  -- case_tasks and case_notes are referenced (by the log, by mentions),
  -- so a plain TRUNCATE stops at the foreign keys; CASCADE reaches the
  -- triggers, and each table must have its own.
  FOREACH r IN ARRAY ARRAY['case_tasks', 'case_notes'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s accepted TRUNCATE CASCADE as the owner', r),
      NULL, NULL, format('TRUNCATE public.%I CASCADE', r), 'ERROR 42501 %append-only%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['case_task_status_log', 'case_notes', 'case_note_mentions', 'case_tasks', 'case_documents'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_ok(EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid = ('public.' || r)::regclass AND tgenabled <> 'D' AND (tgtype & 32) <> 0
          AND tgfoid = 'public.case_append_only()'::regprocedure),
      format('%s has no enabled TRUNCATE trigger', r));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_tasks) = 7 AND (SELECT count(*) FROM case_task_status_log) = 10
    AND (SELECT count(*) FROM case_documents) = 3 AND (SELECT count(*) FROM case_notes) = 3
    AND (SELECT count(*) FROM case_note_mentions) = 2,
    'an append-only probe removed rows');

  SELECT string_agg(p.proname, ',' ORDER BY p.proname) INTO r FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (fns)
     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    r = (SELECT string_agg(f, ',' ORDER BY f) FROM unnest(fns) f)
    AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (fns)) = 12,
    format('the 123 functions are not each executable by service_role alone (%s)', r));
  SELECT string_agg(p.proname, ',' ORDER BY p.proname) INTO r FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'case\_%' OR p.proname = 'view_case')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    r = 'case_default_stages,case_rls_can_read,case_rule_can_read,case_rule_can_reassign,case_rule_can_write',
    format('authenticated may execute other case functions (%s)', r));

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT123', MESSAGE = 'verify-case-tools rollback';
  EXCEPTION WHEN SQLSTATE 'ZT123' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case tools verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case tools verification passed (% checks)', n;
END
$verify$;
