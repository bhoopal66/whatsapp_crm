-- Behavioural regression suite for case SLA (migration 124): SLA
-- timers, the bank contact log and the case timeline on 122's cases.
--
-- Config is owner/admin only, for a bank the account has and a stage in
-- that bank's list. Deadlines are snapshotted when a timer starts:
-- on_track before due_soon_at (the last 20 %, or the last
-- due_soon_minutes), due_soon until due_at, overdue from it. Every stage
-- move (case_open's first stage, case_set_stage, case_apply_submission_
-- status) restarts the configured timers and stops the others; a
-- customer message / bank response stops its timer; a document becoming
-- 'received' restarts document_chase when configured, else stops it.
-- case_sla_evaluate logs each change once. cases.sla_state is the worst
-- running state. Bank contacts are append-only, capped, never blank.
-- The timeline merges every kind in time order for readers only. No API
-- role writes a 124 table; only service_role executes the 8 public
-- functions, nobody the internal ones.
--
-- Stage history uses now(), not an injected clock, so timers started by
-- a stage move start at the transaction time t0; the explicit events
-- run at t0 + offsets.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000124001';
  u_admin  UUID := '00000000-0000-4000-8000-000000124002';
  u_lead   UUID := '00000000-0000-4000-8000-000000124003';  -- leads team T (u_agent)
  u_agent  UUID := '00000000-0000-4000-8000-000000124004';  -- agent of k1 .. k3
  u_agent2 UUID := '00000000-0000-4000-8000-000000124005';  -- on no case
  u_viewer UUID := '00000000-0000-4000-8000-000000124006';
  u_bown   UUID := '00000000-0000-4000-8000-000000124007';  -- owner of account B
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  ca       UUID;
  team1    UUID;
  g        UUID[] := '{}';
  k1       UUID;  -- ADCB, Loan: the main SLA case
  k2       UUID;  -- no bank
  k3       UUID;  -- ADCB: closed by case_apply_submission_status
  tk1      UUID;
  bc1      UUID;
  t0       TIMESTAMPTZ := now();  -- the stage-history clock
  i        INT;
  j        INT;
  lbl      TEXT[];
  usr      UUID[];
  ops      TEXT[];
  arr      TEXT[];
  b1       BOOLEAN;
  st       TEXT;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
  pub_fns  TEXT[] := ARRAY[
    'public.case_sla_timer(uuid,uuid,text,text,timestamptz)',
    'public.case_sla_event(uuid,uuid,text,timestamptz)',
    'public.case_sla_event_system(uuid,text,timestamptz)',
    'public.case_sla_evaluate(timestamptz,uuid)',
    'public.case_bank_contact_add(uuid,uuid,text,timestamptz,text,text,timestamptz,timestamptz)',
    'public.case_timeline(uuid,uuid)',
    'public.case_sla_config_upsert(uuid,uuid,text,text,text,integer,text,integer,integer)',
    'public.case_sla_config_delete(uuid,uuid,text,text,text)'];
  int_fns  TEXT[] := ARRAY[
    'public.case_sla_state_at(timestamptz,timestamptz,timestamptz)',
    'public.case_sla_refresh_case(uuid)',
    'public.case_sla_start_one(uuid,text,timestamptz,uuid,text)',
    'public.case_sla_stop_one(uuid,text,timestamptz,uuid,text)',
    'public.case_sla_apply_event(uuid,text,timestamptz,uuid,text)',
    'public.case_sla_require_now(timestamptz,text)',
    'public.case_sla_on_stage_history()',
    'public.case_sla_on_document()'];
  tbls     TEXT[] := ARRAY['case_sla_config', 'case_sla_timers', 'case_sla_state_log', 'case_bank_contacts'];
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
  -- The running timer p_timer of p_case as 'stage|start|soon|due' offsets
  -- from p_t0 in minutes, 'stopped' or 'none'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_timer(p_case uuid, p_timer text, p_t0 timestamptz)
    RETURNS text LANGUAGE sql AS $body$
      SELECT coalesce((SELECT CASE WHEN x.stopped_at IS NOT NULL THEN 'stopped'
               ELSE x.stage || '|' || x.state || '|' || extract(epoch FROM x.started_at - p_t0)::bigint / 60
                    || '|' || extract(epoch FROM x.due_soon_at - p_t0)::bigint / 60
                    || '|' || extract(epoch FROM x.due_at - p_t0)::bigint / 60 END
        FROM public.case_sla_timers x WHERE x.case_id = p_case AND x.timer = p_timer), 'none')
    $body$
  $fn$;
  -- The state log of p_case, its first p_skip rows skipped, as
  -- 'timer:from>to:role'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_log(p_case uuid, p_skip int)
    RETURNS text[] LANGUAGE sql AS $body$
      SELECT coalesce(array_agg(e ORDER BY id), '{}') FROM (
        SELECT l.id, l.timer || ':' || coalesce(l.from_state, '-') || '>' || l.to_state || ':' || l.actor_role AS e
          FROM public.case_sla_state_log l WHERE l.case_id = p_case ORDER BY l.id OFFSET p_skip) x
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'sla-owner@example.invalid'),
    (u_admin,  'sla-admin@example.invalid'),
    (u_lead,   'sla-lead@example.invalid'),
    (u_agent,  'sla-agent@example.invalid'),
    (u_agent2, 'sla-agent2@example.invalid'),
    (u_viewer, 'sla-viewer@example.invalid'),
    (u_bown,   'sla-bown@example.invalid')
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

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'SLA T', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct);
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-124-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500124001', 'SLA one')
    RETURNING id INTO ca;
  FOR i IN 1 .. 3 LOOP
    g[i] := (SELECT x.group_id FROM sg_open(a_acct, 'CT-124-' || i, ca, wa, 'sla ' || i, NULL,
      jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
    IF g[i] IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group %', i; END IF;
  END LOOP;

  -- ADCB with its own stage list (no 'Query raised'); ENBD on the defaults.
  PERFORM case_bank_upsert(u_owner, a_acct, 'ADCB', 'ADCB Bank');
  PERFORM case_bank_upsert(u_owner, a_acct, 'ENBD', 'Emirates NBD');
  PERFORM case_bank_stages_set(u_owner, a_acct, 'ADCB',
    ARRAY['Submitted', 'Documents requested', 'Under review', 'Approved', 'Declined', 'Withdrawn', 'Closed']);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ADCB', 'Loan', 'eid', 'Emirates ID', 1);
  PERFORM case_doc_requirement_upsert(u_owner, a_acct, 'ADCB', 'Loan', 'salary', 'Salary certificate', 2);
  PERFORM case_task_template_upsert(u_owner, a_acct, 'ADCB', 'collect', 'Collect docs', 1, 48);

  -- ---------- configuration (owner / admin only) ----------
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ADCB', 'Submitted', 'customer_reply', 60, 'minutes');
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ADCB', 'Submitted', 'bank_response', 2, 'days', 20, 120);
  PERFORM case_sla_config_upsert(u_admin, a_acct, 'ADCB', 'Documents requested', 'customer_reply', 10, 'minutes');
  PERFORM case_sla_config_upsert(u_admin, a_acct, 'ADCB', 'Documents requested', 'document_chase', 100, 'minutes');
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ADCB', 'Under review', 'bank_response', 1, 'days');
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ADCB', 'Approved', 'customer_reply', 30, 'minutes');
  PERFORM case_sla_config_upsert(u_owner, a_acct, 'ENBD', 'Query raised', 'customer_reply', 1, 'days');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_sla_config WHERE account_id = a_acct) = 7
    AND (SELECT due_soon_pct = 20 AND due_soon_minutes IS NULL FROM case_sla_config
          WHERE account_id = a_acct AND bank_code = 'ADCB' AND stage = 'Submitted' AND timer = 'customer_reply'),
    'case_sla_config_upsert by the owner / admin did not store the rows (due_soon_pct default 20)');

  lbl := ARRAY['team lead', 'agent', 'another workspace''s owner', 'NULL actor'];
  usr := ARRAY[u_lead, u_agent, u_bown, NULL];
  ops := ARRAY[
    'SELECT amount::text FROM case_sla_config_upsert(%L, %L, ''ADCB'', ''Submitted'', ''document_chase'', 5, ''minutes'')',
    'SELECT case_sla_config_delete(%L, %L, ''ADCB'', ''Submitted'', ''customer_reply'')::text'];
  FOR i IN 1 .. 4 LOOP
    FOR j IN 1 .. 2 LOOP
      n := n + 1; failed := failed || pg_temp.cs_check(format('SLA config op %s by the %s was not NOT_ALLOWED', j, lbl[i]),
        'service_role', NULL, format(ops[j], usr[i], a_acct), 'ERROR 42501 NOT_ALLOWED:%');
    END LOOP;
  END LOOP;
  FOR j IN 1 .. 2 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('SLA config op %s for an unknown bank was not BANK_UNKNOWN', j),
      'service_role', NULL, replace(format(ops[j], u_owner, a_acct), '''ADCB''', '''NOPE'''), 'ERROR 23514 BANK_UNKNOWN:%');
    n := n + 1; failed := failed || pg_temp.cs_check(format('SLA config op %s for another workspace''s bank was not BANK_UNKNOWN', j),
      'service_role', NULL, format(ops[j], u_bown, b_acct), 'ERROR 23514 BANK_UNKNOWN:%');
  END LOOP;
  -- 'Query raised' is a default stage, not one of ADCB's (ENBD has it).
  FOREACH r IN ARRAY ARRAY['''Query raised''', '''Nope''', 'NULL'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('SLA config for ADCB stage %s was not STAGE_NOT_CONFIGURED', r),
      'service_role', NULL, format('SELECT amount::text FROM case_sla_config_upsert(%L, %L, ''ADCB'', %s, ''customer_reply'', 5, ''minutes'')',
        u_owner, a_acct, r), 'ERROR 23514 STAGE_NOT_CONFIGURED:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('SLA config with unit hours was not a CHECK violation',
    'service_role', NULL, format('SELECT amount::text FROM case_sla_config_upsert(%L, %L, ''ADCB'', ''Submitted'', ''document_chase'', 5, ''hours'')',
      u_owner, a_acct), 'ERROR 23514 -: %case_sla_config_unit_check%');
  n := n + 1; failed := failed || pg_temp.cs_check('SLA config for timer bogus was not a CHECK violation',
    'service_role', NULL, format('SELECT amount::text FROM case_sla_config_upsert(%L, %L, ''ADCB'', ''Submitted'', ''bogus'', 5, ''minutes'')',
      u_owner, a_acct), 'ERROR 23514 -: %case_sla_config_timer_check%');
  n := n + 1; failed := failed || pg_temp.cs_check('SLA config with amount 0 was not a CHECK violation',
    'service_role', NULL, format('SELECT amount::text FROM case_sla_config_upsert(%L, %L, ''ADCB'', ''Submitted'', ''document_chase'', 0, ''minutes'')',
      u_owner, a_acct), 'ERROR 23514 -: %case_sla_config_amount_check%');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_sla_config WHERE account_id = a_acct) = 7
    AND NOT EXISTS (SELECT 1 FROM case_sla_config WHERE account_id = b_acct),
    'a refused SLA config call changed a row');
  PERFORM case_sla_config_upsert(u_admin, a_acct, 'ADCB', 'Submitted', 'document_chase', 7, 'minutes');
  b1 := case_sla_config_delete(u_admin, a_acct, 'ADCB', 'Submitted', 'document_chase');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1
    AND NOT EXISTS (SELECT 1 FROM case_sla_config WHERE stage = 'Submitted' AND timer = 'document_chase')
    AND (SELECT count(*) FROM case_sla_config WHERE account_id = a_acct) = 7,
    'case_sla_config_delete did not remove exactly its row');
  b1 := case_sla_config_delete(u_owner, a_acct, 'ADCB', 'Submitted', 'document_chase');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 IS FALSE, 'case_sla_config_delete of a missing row did not answer false');

  -- ---------- case_open starts the first stage's timers (trigger) ----------
  k1 := (SELECT x.case_id FROM case_open(g[1], 'ADCB', NULL, 'Loan', 1000, NULL) x);
  k2 := (SELECT x.case_id FROM case_open(g[2], NULL, NULL, NULL, NULL, NULL) x);
  k3 := (SELECT x.case_id FROM case_open(g[3], 'ADCB', NULL, 'Loan', NULL, NULL) x);
  IF k1 IS NULL OR k2 IS NULL OR k3 IS NULL THEN RAISE EXCEPTION 'fixture: case_open returned no case'; END IF;
  -- customer_reply 60 min, last 20 % due soon; bank_response 2 days, last 120 min.
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.cs_timer(k1, 'customer_reply', t0) = 'Submitted|on_track|0|48|60'
    AND pg_temp.cs_timer(k1, 'bank_response', t0) = 'Submitted|on_track|0|2760|2880'
    AND pg_temp.cs_timer(k1, 'document_chase', t0) = 'none',
    format('case_open did not start the first stage''s configured timers (%s / %s / %s)',
      pg_temp.cs_timer(k1, 'customer_reply', t0), pg_temp.cs_timer(k1, 'bank_response', t0),
      pg_temp.cs_timer(k1, 'document_chase', t0)));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.cs_log(k1, 0) = ARRAY['customer_reply:->on_track:api', 'bank_response:->on_track:api']
    AND (SELECT bool_and(actor_id IS NULL AND changed_at = t0) FROM case_sla_state_log WHERE case_id = k1)
    AND (SELECT sla_state FROM cases WHERE id = k1) = 'on_track',
    format('case_open did not log on_track rows from NULL (%s) or set sla_state on_track', pg_temp.cs_log(k1, 0)));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT EXISTS (SELECT 1 FROM case_sla_timers WHERE case_id = k2)
    AND NOT EXISTS (SELECT 1 FROM case_sla_state_log WHERE case_id = k2)
    AND (SELECT sla_state FROM cases WHERE id = k2) IS NULL,
    'a case with no bank got SLA timers');

  -- Deadlines are snapshotted: a config change does not move a running timer.
  PERFORM case_sla_config_upsert(u_admin, a_acct, 'ADCB', 'Submitted', 'customer_reply', 5, 'minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_sla_config WHERE account_id = a_acct AND bank_code = 'ADCB' AND stage = 'Submitted'
       AND timer = 'customer_reply' AND amount = 5 AND unit = 'minutes') = 1
    AND (SELECT count(*) FROM case_sla_config WHERE account_id = a_acct) = 7,
    'case_sla_config_upsert did not update the row in place');
  n := n + 1; failed := failed || pg_temp.cs_ok(pg_temp.cs_timer(k1, 'customer_reply', t0) = 'Submitted|on_track|0|48|60',
    format('a config change moved a running timer (%s)', pg_temp.cs_timer(k1, 'customer_reply', t0)));

  -- ---------- case_sla_evaluate: each change once ----------
  SELECT coalesce(array_agg(x.timer || ':' || coalesce(x.from_state, '-') || '>' || x.to_state ORDER BY x.timer), '{}')
    INTO arr FROM case_sla_evaluate(t0 + interval '47 minutes 59 seconds', k1) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(arr = '{}' AND pg_temp.cs_log(k1, 0) = ARRAY['customer_reply:->on_track:api', 'bank_response:->on_track:api'],
    format('case_sla_evaluate before due_soon_at (80 %% of 60 min) logged a change (%s)', arr));
  SELECT coalesce(array_agg(x.timer || ':' || coalesce(x.from_state, '-') || '>' || x.to_state ORDER BY x.timer), '{}')
    INTO arr FROM case_sla_evaluate(t0 + interval '48 minutes', k1) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(arr = ARRAY['customer_reply:on_track>due_soon'],
    format('case_sla_evaluate at due_soon_at did not move customer_reply on_track -> due_soon (%s)', arr));
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT sla_state FROM cases WHERE id = k1) = 'due_soon'
    AND pg_temp.cs_timer(k1, 'customer_reply', t0) = 'Submitted|due_soon|0|48|60',
    'cases.sla_state is not due_soon (the worst running state) after the job');
  SELECT coalesce(array_agg(x.timer ORDER BY x.timer), '{}') INTO arr FROM case_sla_evaluate(t0 + interval '48 minutes', k1) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(arr = '{}' AND (SELECT count(*) FROM case_sla_state_log WHERE case_id = k1) = 3,
    format('case_sla_evaluate re-run at the same clock logged again (%s)', arr));
  SELECT coalesce(array_agg(x.timer || ':' || coalesce(x.from_state, '-') || '>' || x.to_state ORDER BY x.timer), '{}')
    INTO arr FROM case_sla_evaluate(t0 + interval '59 minutes 59 seconds', NULL) x;
  -- Every case: k1 is due soon already, k3 (opened with k1) moves now.
  n := n + 1; failed := failed || pg_temp.cs_ok(arr = ARRAY['customer_reply:on_track>due_soon']
    AND (SELECT sla_state FROM cases WHERE id = k3) = 'due_soon'
    AND (SELECT sla_state FROM cases WHERE id = k1) = 'due_soon',
    format('case_sla_evaluate of every case before k1''s due_at did not move only k3''s customer_reply (%s)', arr));
  SELECT coalesce(array_agg(x.timer || ':' || coalesce(x.from_state, '-') || '>' || x.to_state ORDER BY x.timer), '{}')
    INTO arr FROM case_sla_evaluate(t0 + interval '60 minutes', k1) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(arr = ARRAY['customer_reply:due_soon>overdue'],
    format('case_sla_evaluate at due_at did not move customer_reply due_soon -> overdue (%s)', arr));
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT sla_state FROM cases WHERE id = k1) = 'overdue',
    'cases.sla_state is not overdue while one timer is overdue and another on track');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_sla_state_log WHERE case_id = k1 AND to_state IN ('due_soon', 'overdue')
       AND actor_id IS NULL AND actor_role = 'system') = 2
    AND (SELECT count(*) FROM case_sla_state_log WHERE case_id = k1) = 4,
    'case_sla_evaluate rows are not actor NULL / system, once each');

  -- customer_message (a person) stops customer_reply only.
  st := case_sla_event(k1, u_agent, 'customer_message', t0 + interval '61 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'on_track'
    AND pg_temp.cs_timer(k1, 'customer_reply', t0) = 'stopped'
    AND pg_temp.cs_timer(k1, 'bank_response', t0) = 'Submitted|on_track|0|2760|2880'
    AND (pg_temp.cs_log(k1, 0))[5] = 'customer_reply:overdue>stopped:agent'
    AND (SELECT actor_id = u_agent AND changed_at = t0 + interval '61 minutes' FROM case_sla_state_log
          WHERE case_id = k1 ORDER BY id DESC LIMIT 1),
    format('case_sla_event customer_message did not stop customer_reply only (%s, %s)', st, pg_temp.cs_log(k1, 0)));
  -- Days with due_soon_minutes: due soon in the last 120 minutes.
  SELECT coalesce(array_agg(x.timer || ':' || coalesce(x.from_state, '-') || '>' || x.to_state ORDER BY x.timer), '{}')
    INTO arr FROM case_sla_evaluate(t0 + interval '2759 minutes', k1) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(arr = '{}',
    format('bank_response (2 days, due_soon_minutes 120) was due soon before its last 120 minutes (%s)', arr));
  SELECT coalesce(array_agg(x.timer || ':' || coalesce(x.from_state, '-') || '>' || x.to_state ORDER BY x.timer), '{}')
    INTO arr FROM case_sla_evaluate(t0 + interval '2760 minutes', k1) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(arr = ARRAY['bank_response:on_track>due_soon']
    AND (SELECT sla_state FROM cases WHERE id = k1) = 'due_soon',
    format('bank_response (2 days, due_soon_minutes 120) was not due soon in its last 120 minutes (%s)', arr));
  st := case_sla_event(k1, u_lead, 'bank_response', t0 + interval '2800 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL
    AND pg_temp.cs_timer(k1, 'bank_response', t0) = 'stopped'
    AND (SELECT sla_state FROM cases WHERE id = k1) IS NULL
    AND pg_temp.cs_log(k1, 6) = ARRAY['bank_response:due_soon>stopped:team_lead'],
    format('case_sla_event bank_response did not stop bank_response and clear sla_state (%s, %s)', st, pg_temp.cs_log(k1, 6)));

  -- ---------- case_sla_timer ----------
  -- A restart logs from 'stopped' and takes the current config (5 min).
  st := case_sla_timer(k1, u_agent, 'customer_reply', 'start', t0 + interval '3000 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'on_track'
    AND pg_temp.cs_timer(k1, 'customer_reply', t0) = 'Submitted|on_track|3000|3004|3005'
    AND pg_temp.cs_log(k1, 7) = ARRAY['customer_reply:stopped>on_track:agent'],
    format('case_sla_timer start did not restart from stopped on the current config (%s, %s)',
      pg_temp.cs_timer(k1, 'customer_reply', t0), pg_temp.cs_log(k1, 7)));
  st := case_sla_timer(k1, u_agent, 'customer_reply', 'reset', t0 + interval '3002 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'on_track'
    AND pg_temp.cs_timer(k1, 'customer_reply', t0) = 'Submitted|on_track|3002|3006|3007'
    AND pg_temp.cs_log(k1, 8) = ARRAY['customer_reply:on_track>on_track:agent'],
    format('case_sla_timer reset did not restart the running timer (%s)', pg_temp.cs_timer(k1, 'customer_reply', t0)));
  st := case_sla_timer(k1, u_admin, 'customer_reply', 'stop', t0 + interval '3003 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL
    AND pg_temp.cs_timer(k1, 'customer_reply', t0) = 'stopped'
    AND pg_temp.cs_log(k1, 9) = ARRAY['customer_reply:on_track>stopped:admin'],
    'case_sla_timer stop did not stop the timer');
  st := case_sla_timer(k1, u_admin, 'customer_reply', 'stop', t0 + interval '3004 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL AND (SELECT count(*) FROM case_sla_state_log WHERE case_id = k1) = 10,
    'case_sla_timer stop of a stopped timer logged a row');
  FOREACH r IN ARRAY ARRAY['start', 'reset'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('case_sla_timer %s of an unconfigured timer was not SLA_NOT_CONFIGURED', r),
      'service_role', NULL, format('SELECT coalesce(case_sla_timer(%L, %L, ''document_chase'', %L, %L), ''-'')', k1, u_agent, r, t0),
      'ERROR P0002 SLA_NOT_CONFIGURED:%');
    n := n + 1; failed := failed || pg_temp.cs_check(format('case_sla_timer %s on a case with no bank was not SLA_NOT_CONFIGURED', r),
      'service_role', NULL, format('SELECT coalesce(case_sla_timer(%L, %L, ''customer_reply'', %L, %L), ''-'')', k2, u_agent, r, t0),
      'ERROR P0002 SLA_NOT_CONFIGURED:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('case_sla_timer timer bogus was not TIMER_INVALID',
    'service_role', NULL, format('SELECT coalesce(case_sla_timer(%L, %L, ''bogus'', ''start'', %L), ''-'')', k1, u_agent, t0),
    'ERROR 23514 TIMER_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_sla_timer action pause was not ACTION_INVALID',
    'service_role', NULL, format('SELECT coalesce(case_sla_timer(%L, %L, ''customer_reply'', ''pause'', %L), ''-'')', k1, u_agent, t0),
    'ERROR 23514 ACTION_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_sla_event bogus was not EVENT_INVALID',
    'service_role', NULL, format('SELECT coalesce(case_sla_event(%L, %L, ''bogus'', %L), ''-'')', k1, u_agent, t0),
    'ERROR 23514 EVENT_INVALID:%');

  -- customer_message from the system: actor NULL, role 'system'.
  st := case_sla_timer(k1, u_agent, 'customer_reply', 'start', t0 + interval '3010 minutes');
  st := case_sla_event_system(k1, 'customer_message', t0 + interval '3011 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL
    AND pg_temp.cs_timer(k1, 'customer_reply', t0) = 'stopped'
    AND pg_temp.cs_log(k1, 11) = ARRAY['customer_reply:on_track>stopped:system']
    AND (SELECT actor_id IS NULL FROM case_sla_state_log WHERE case_id = k1 ORDER BY id DESC LIMIT 1),
    format('case_sla_event_system customer_message did not stop customer_reply as system (%s)', pg_temp.cs_log(k1, 10)));

  -- ---------- a stage move restarts the configured timers, stops the others ----------
  st := case_sla_timer(k1, u_agent, 'bank_response', 'start', t0 + interval '3020 minutes');
  SELECT x.moved INTO b1 FROM case_set_stage(k1, u_agent, 'Documents requested') x;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1
    AND pg_temp.cs_timer(k1, 'customer_reply', t0) = 'Documents requested|on_track|0|8|10'
    AND pg_temp.cs_timer(k1, 'document_chase', t0) = 'Documents requested|on_track|0|80|100'
    AND pg_temp.cs_timer(k1, 'bank_response', t0) = 'stopped'
    AND pg_temp.cs_log(k1, 13) = ARRAY['customer_reply:stopped>on_track:agent', 'bank_response:on_track>stopped:agent',
                                       'document_chase:->on_track:agent']
    AND (SELECT sla_state FROM cases WHERE id = k1) = 'on_track',
    format('case_set_stage did not restart the new stage''s timers and stop the others (%s / %s / %s; %s)',
      pg_temp.cs_timer(k1, 'customer_reply', t0), pg_temp.cs_timer(k1, 'document_chase', t0),
      pg_temp.cs_timer(k1, 'bank_response', t0), pg_temp.cs_log(k1, 13)));

  -- A document becoming 'received' (INSERT) restarts document_chase.
  st := case_doc_set_status(k1, u_agent, 'eid', 'received', 'file-124-eid', t0 + interval '60 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.cs_timer(k1, 'document_chase', t0) = 'Documents requested|on_track|60|140|160'
    AND pg_temp.cs_log(k1, 16) = ARRAY['document_chase:on_track>on_track:agent'],
    format('a received document did not restart the configured document_chase (%s, %s)',
      pg_temp.cs_timer(k1, 'document_chase', t0), pg_temp.cs_log(k1, 16)));
  -- Requested is no receipt; a re-save of 'received' is none either.
  st := case_doc_set_status(k1, u_agent, 'salary', 'requested', NULL, t0 + interval '70 minutes');
  st := case_doc_set_status(k1, u_agent, 'eid', 'received', 'file-124-eid2', t0 + interval '75 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT count(*) FROM case_sla_state_log WHERE case_id = k1) = 17,
    'a requested document or a re-saved receipt fired an SLA event');
  -- With no config for the stage any more, a receipt (UPDATE) stops it;
  -- the delete itself left the running timer alone.
  b1 := case_sla_config_delete(u_owner, a_acct, 'ADCB', 'Documents requested', 'document_chase');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1 AND pg_temp.cs_timer(k1, 'document_chase', t0) = 'Documents requested|on_track|60|140|160',
    'case_sla_config_delete moved a running timer');
  st := case_doc_set_status(k1, u_agent, 'salary', 'received', 'file-124-sal', t0 + interval '120 minutes');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.cs_timer(k1, 'document_chase', t0) = 'stopped'
    AND pg_temp.cs_log(k1, 17) = ARRAY['document_chase:on_track>stopped:agent']
    AND (SELECT stopped_at FROM case_sla_timers WHERE case_id = k1 AND timer = 'document_chase') = t0 + interval '120 minutes',
    format('a received document did not stop an unconfigured document_chase (%s)', pg_temp.cs_log(k1, 17)));

  -- Days with the default 20 %: 1 day, due soon in the last 288 minutes.
  SELECT x.moved INTO b1 FROM case_set_stage(k1, u_agent, 'Under review') x;
  n := n + 1; failed := failed || pg_temp.cs_ok(b1
    AND pg_temp.cs_timer(k1, 'bank_response', t0) = 'Under review|on_track|0|1152|1440'
    AND pg_temp.cs_timer(k1, 'customer_reply', t0) = 'stopped'
    AND pg_temp.cs_timer(k1, 'document_chase', t0) = 'stopped'
    AND pg_temp.cs_log(k1, 18) = ARRAY['customer_reply:on_track>stopped:agent', 'bank_response:stopped>on_track:agent'],
    format('the move to Under review did not start bank_response (1 day, 20 %%) and stop the rest (%s; %s)',
      pg_temp.cs_timer(k1, 'bank_response', t0), pg_temp.cs_log(k1, 18)));

  -- The v1 API's final status is a stage move too (actor NULL, 'api').
  b1 := case_apply_submission_status(g[3], 'APPROVED');
  n := n + 1; failed := failed || pg_temp.cs_ok(b1
    AND pg_temp.cs_timer(k3, 'customer_reply', t0) = 'Approved|on_track|0|24|30'
    AND pg_temp.cs_timer(k3, 'bank_response', t0) = 'stopped'
    AND pg_temp.cs_log(k3, 0) = ARRAY['customer_reply:->on_track:api', 'bank_response:->on_track:api',
                                      'customer_reply:on_track>due_soon:system',
                                      'customer_reply:due_soon>on_track:api', 'bank_response:on_track>stopped:api']
    AND (SELECT bool_and(actor_id IS NULL AND changed_at = t0) FROM case_sla_state_log
          WHERE case_id = k3 AND actor_role = 'api')
    AND (SELECT sla_state FROM cases WHERE id = k3) = 'on_track',
    format('case_apply_submission_status did not restart / stop the timers (%s / %s; %s)',
      pg_temp.cs_timer(k3, 'customer_reply', t0), pg_temp.cs_timer(k3, 'bank_response', t0), pg_temp.cs_log(k3, 0)));

  -- A bank set through case_set_details fires no SLA event.
  arr := case_set_details(k2, u_agent, 'ADCB', NULL, NULL);
  n := n + 1; failed := failed || pg_temp.cs_ok(arr = ARRAY['bank_code']
    AND NOT EXISTS (SELECT 1 FROM case_sla_timers WHERE case_id = k2)
    AND NOT EXISTS (SELECT 1 FROM case_sla_state_log WHERE case_id = k2),
    'a bank set through case_set_details started SLA timers');

  -- ---------- refusals ----------
  lbl := ARRAY['viewer', 'another agent', 'another workspace''s owner', 'NULL actor'];
  usr := ARRAY[u_viewer, u_agent2, u_bown, NULL];
  ops := ARRAY[
    'SELECT coalesce(case_sla_event(%L, %L, ''bank_response'', %L), ''-'')',
    'SELECT coalesce(case_sla_timer(%L, %L, ''bank_response'', ''stop'', %L), ''-'')',
    'SELECT case_bank_contact_add(%L, %L, ''Ms Bank'', %L, ''Called'')::text'];
  FOR i IN 1 .. 4 LOOP
    FOR j IN 1 .. 3 LOOP
      n := n + 1; failed := failed || pg_temp.cs_check(format('SLA write op %s by the %s was not NOT_ALLOWED', j, lbl[i]),
        'service_role', NULL, format(ops[j], k1, usr[i], t0), 'ERROR 42501 NOT_ALLOWED:%');
    END LOOP;
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_sla_state_log WHERE case_id = k1) = 20
    AND pg_temp.cs_timer(k1, 'bank_response', t0) = 'Under review|on_track|0|1152|1440'
    AND NOT EXISTS (SELECT 1 FROM case_bank_contacts),
    'a refused SLA write changed a row');
  ops := ARRAY[
    format('SELECT coalesce(case_sla_event(%L, %L, ''bank_response'', %%L), ''-'')', k1, u_agent),
    format('SELECT coalesce(case_sla_event_system(%L, ''customer_message'', %%L), ''-'')', k1),
    format('SELECT coalesce(case_sla_timer(%L, %L, ''bank_response'', ''stop'', %%L), ''-'')', k1, u_agent),
    'SELECT count(*)::text FROM case_sla_evaluate(%L)'];
  FOR j IN 1 .. 4 LOOP
    FOREACH r IN ARRAY ARRAY['infinity', '-infinity', NULL] LOOP
      n := n + 1; failed := failed || pg_temp.cs_check(format('SLA op %s at clock %s was not NOW_REQUIRED', j, coalesce(r, 'NULL')),
        'service_role', NULL, format(ops[j], r), 'ERROR 22023 NOW_REQUIRED:%');
    END LOOP;
  END LOOP;

  -- ---------- bank contacts ----------
  bc1 := case_bank_contact_add(k1, u_agent, 'Ms Bank', t0 + interval '5 hours', 'Asked for the statement',
    E' \t', NULL, t0 + interval '5 hours 1 minute');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT case_id = k1 AND account_id = a_acct AND author_id = u_agent AND next_action IS NULL
            AND created_at = t0 + interval '5 hours 1 minute' FROM case_bank_contacts WHERE id = bc1),
    'case_bank_contact_add did not store the contact (a blank next action as NULL)');
  PERFORM case_bank_contact_add(k1, u_lead, repeat('n', 200), t0 + interval '6 hours', repeat('s', 4000),
    repeat('a', 4000), t0 + interval '7 days');
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT count(*) FROM case_bank_contacts WHERE case_id = k1) = 2,
    'a bank contact at its caps (200 / 4000 / 4000) was refused');
  ops := ARRAY[
    format('SELECT case_bank_contact_add(%L, %L, %L, now(), ''x'')::text', k1, u_agent, repeat('n', 201)),
    format('SELECT case_bank_contact_add(%L, %L, ''x'', now(), %L)::text', k1, u_agent, repeat('s', 4001)),
    format('SELECT case_bank_contact_add(%L, %L, ''x'', now(), ''x'', %L)::text', k1, u_agent, repeat('a', 4001))];
  lbl := ARRAY['a 201-character name', 'a 4001-character summary', 'a 4001-character next action'];
  FOR j IN 1 .. 3 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('a bank contact with %s was not TEXT_TOO_LONG', lbl[j]),
      'service_role', NULL, ops[j], 'ERROR 23514 TEXT_TOO_LONG:%');
  END LOOP;
  ops := ARRAY[
    format('SELECT case_bank_contact_add(%L, %L, '''', now(), ''x'')::text', k1, u_agent),
    format('SELECT case_bank_contact_add(%L, %L, %L, now(), ''x'')::text', k1, u_agent, E' \n\t '),
    format('SELECT case_bank_contact_add(%L, %L, NULL, now(), ''x'')::text', k1, u_agent),
    format('SELECT case_bank_contact_add(%L, %L, ''x'', now(), ''   '')::text', k1, u_agent),
    format('SELECT case_bank_contact_add(%L, %L, ''x'', now(), %L)::text', k1, u_agent, E'\t\r\n'),
    format('SELECT case_bank_contact_add(%L, %L, ''x'', now(), NULL)::text', k1, u_agent)];
  lbl := ARRAY['an empty name', 'a whitespace-only name', 'a NULL name', 'a blank summary',
               'a whitespace-only summary', 'a NULL summary'];
  FOR j IN 1 .. 6 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('a bank contact with %s was not CONTACT_INCOMPLETE', lbl[j]),
      'service_role', NULL, ops[j], 'ERROR 23514 CONTACT_INCOMPLETE:%');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['UPDATE public.case_bank_contacts SET summary = summary',
                           'DELETE FROM public.case_bank_contacts', 'TRUNCATE public.case_bank_contacts',
                           'UPDATE public.case_sla_state_log SET to_state = to_state',
                           'DELETE FROM public.case_sla_state_log', 'TRUNCATE public.case_sla_state_log',
                           'TRUNCATE public.case_sla_timers'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s was accepted as the owner', r),
      NULL, NULL, r, 'ERROR 42501 %append-only%');
  END LOOP;
  FOREACH r IN ARRAY tbls[2:4] LOOP
    n := n + 1; failed := failed || pg_temp.cs_ok(EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid = ('public.' || r)::regclass AND tgenabled <> 'D' AND (tgtype & 32) <> 0
          AND tgfoid = 'public.case_append_only()'::regprocedure),
      format('%s has no enabled TRUNCATE trigger', r));
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT count(*) FROM case_bank_contacts) = 2 AND (SELECT count(*) FROM case_sla_state_log WHERE case_id = k1) = 20
    AND (SELECT count(*) FROM case_sla_timers) = 5,
    'an append-only probe removed rows');

  -- ---------- timeline ----------
  tk1 := case_task_create(k1, u_agent, 'collect', NULL, NULL, t0 + interval '2 hours');
  PERFORM case_task_set_status(tk1, u_agent, 'done', t0 + interval '3 hours');
  PERFORM case_note_add(k1, u_agent, 'note ' || repeat('z', 300), t0 + interval '4 hours');
  lbl := ARRAY['agent', 'team lead', 'admin'];
  usr := ARRAY[u_agent, u_lead, u_admin];
  FOR i IN 1 .. 3 LOOP
    SELECT array_agg(DISTINCT x.kind ORDER BY x.kind),
           bool_and(x.ord = x.by_at)
      INTO arr, b1
      FROM (SELECT y.kind, y.ord, row_number() OVER (ORDER BY y.at, y.ord) AS by_at
              FROM case_timeline(usr[i], k1) WITH ORDINALITY AS y(at, kind, ref_id, actor, summary, ord)) x;
    n := n + 1; failed := failed || pg_temp.cs_ok(
      arr = ARRAY['bank_contact', 'document', 'note', 'sla', 'stage', 'task', 'task_status'] AND b1,
      format('case_timeline for the %s is not every kind in time order (%s, ordered %s)', lbl[i], arr, b1));
  END LOOP;
  SELECT count(*) INTO i FROM case_timeline(u_agent, k1) x WHERE x.kind = 'sla';
  n := n + 1; failed := failed || pg_temp.cs_ok(i = 20, format('case_timeline does not carry every SLA log row (%s)', i));
  lbl := ARRAY['viewer', 'another agent', 'another workspace''s owner', 'NULL actor'];
  usr := ARRAY[u_viewer, u_agent2, u_bown, NULL];
  FOR i IN 1 .. 4 LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('case_timeline for the %s was not NOT_ALLOWED', lbl[i]),
      'service_role', NULL, format('SELECT count(*)::text FROM case_timeline(%L, %L)', usr[i], k1),
      'ERROR 42501 NOT_ALLOWED:%');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_check('case_timeline of an unknown case was not CASE_NOT_FOUND',
    'service_role', NULL, format('SELECT count(*)::text FROM case_timeline(%L, %L)', u_agent, gen_random_uuid()),
    'ERROR P0002 CASE_NOT_FOUND:%');

  -- ---------- grants ----------
  FOREACH r IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
    SELECT string_agg(t, ',' ORDER BY t) INTO st FROM unnest(tbls) t
     WHERE has_table_privilege(r, 'public.' || t, 'INSERT') OR has_table_privilege(r, 'public.' || t, 'UPDATE')
        OR has_table_privilege(r, 'public.' || t, 'DELETE') OR has_table_privilege(r, 'public.' || t, 'TRUNCATE');
    n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL, format('%s holds a write privilege on a case SLA table (%s)', r, st));
  END LOOP;
  SELECT string_agg(f, ',' ORDER BY f) INTO st FROM unnest(pub_fns) f
   WHERE NOT has_function_privilege('service_role', f, 'EXECUTE')
      OR has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL,
    format('a public 124 function is not executable by service_role alone (%s)', st));
  SELECT string_agg(f, ',' ORDER BY f) INTO st FROM unnest(int_fns) f
   WHERE has_function_privilege('service_role', f, 'EXECUTE')
      OR has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL,
    format('an internal 124 function is executable by an API role (%s)', st));
  SELECT string_agg(p.proname, ',' ORDER BY p.proname) INTO st FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'case\_%' OR p.proname = 'view_case')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    st = 'case_default_stages,case_rls_can_read,case_rule_can_read,case_rule_can_reassign,case_rule_can_write',
    format('authenticated may execute other case functions (%s)', st));

  -- ---------- lock order ----------
  -- 123's write lock must be FOR NO KEY UPDATE, never FOR SHARE: 124's
  -- case_documents trigger updates cases.sla_state in the same call, and
  -- two receipts on one case that each held FOR SHARE and then upgraded
  -- deadlocked (40P01).
  st := pg_get_functiondef('public.case_tools_lock_for_write(uuid,uuid)'::regprocedure);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    st ~ 'FROM public\.cases x WHERE x\.id = p_case FOR NO KEY UPDATE' AND st !~* 'FOR\s+SHARE',
    'case_tools_lock_for_write does not lock the case FOR NO KEY UPDATE without FOR SHARE (two concurrent document receipts deadlock)');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT124', MESSAGE = 'verify-case-sla rollback';
  EXCEPTION WHEN SQLSTATE 'ZT124' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case SLA verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case SLA verification passed (% checks)', n;
END
$verify$;
