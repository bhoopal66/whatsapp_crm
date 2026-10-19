-- Behavioural regression suite for the bank dashboard and the decline /
-- withdraw reasons (migration 127) and the take-over log (migration
-- 128), over 122-126's cases, stage history, case tasks, SLA timers and
-- bank workspaces.
--
-- bank_ws_dashboard answers owner / admin ('all') and members ('own')
-- and refuses everyone else, a NULL actor included (NOT_ALLOWED), an
-- unknown workspace (BANK_WS_NOT_FOUND) and a NULL or infinite clock
-- (NOW_REQUIRED), in that order; a member whose last open case of the
-- bank closes is refused at once. A member's figures cover exactly the
-- bank's cases case_can_read lets them read. The maths are pinned on a
-- controlled fixture: cases by stage, average days per non-final stage
-- (intervals between history rows, the current stage ending at p_now),
-- the approval rate (withdrawn outside the denominator, the outcome kept
-- after Closed), overdue cases (a running timer overdue at p_now or a
-- task not done past due, each case once), the amount in the pipeline
-- and the reasons by code. The output carries no identifier or free text
-- of the fixture. Reasons are refused in their documented order, once
-- per case, only for a Declined / Withdrawn outcome, readable under RLS
-- only with the case. Take-over is the coordinator's and the team
-- lead's only. Both tables are append-only; the three functions are
-- service_role's only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000127001';
  u_admin  UUID := '00000000-0000-4000-8000-000000127002';
  u_lead   UUID := '00000000-0000-4000-8000-000000127003';  -- leads T1 (u_agent)
  u_coord  UUID := '00000000-0000-4000-8000-000000127004';  -- agent role; coordinator of k1, k2
  u_agent  UUID := '00000000-0000-4000-8000-000000127005';  -- agent of k1, k2, k6
  u_agent2 UUID := '00000000-0000-4000-8000-000000127006';  -- agent of k3, k4, k7, k8
  u_agent3 UUID := '00000000-0000-4000-8000-000000127007';  -- agent of k5 only (withdrawn mid-suite)
  u_viewer UUID := '00000000-0000-4000-8000-000000127008';
  u_agent4 UUID := '00000000-0000-4000-8000-000000127009';  -- on no case
  u_bown   UUID := '00000000-0000-4000-8000-000000127010';  -- owner of account B
  u_guest  UUID := '00000000-0000-4000-8000-000000127011';  -- bank_guest, made holder of k1 and k3 below
  u_gone   UUID := '00000000-0000-4000-8000-000000127012';  -- deactivated agent, made holder of k1 and k3 below
  a_acct   UUID;
  b_acct   UUID;
  wa       UUID;
  wb       UUID;
  ca       UUID;
  cb       UUID;
  team1    UUID;
  g        UUID[] := '{}';
  gb       UUID;
  k        UUID[] := '{}';
  -- ADCB in A: k1 Documents requested (history 0 / +2 / +5 days), 1000;
  -- k2 Submitted, 2000.50, overdue tasks and timer; k3 Declined then
  -- Closed, 4000; k4 Approved, 8000; k5 Withdrawn; k6 Declined; k7
  -- Submitted, overdue running timer; k8 Declined. k9 is ENBD, kb is B.
  kb       UUID;
  ws_a     UUID;
  ws_e     UUID;
  ws_b     UUID;
  t0       TIMESTAMPTZ := now();
  t_now    TIMESTAMPTZ := now() + interval '10 days';
  d        JSONB;
  usr      UUID[];
  lbl      TEXT[];
  leaks    TEXT[];
  i        INT;
  st       TEXT;
  r        TEXT;
  r2       TEXT;
  b1       BOOLEAN;
  v_id     BIGINT;
  v_id2    BIGINT;
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
  -- p_sql, called as service_role, must fail with hint p_hint.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bw_err(p_name text, p_sql text, p_hint text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT pg_temp.cs_check(p_name || ' was not ' || p_hint, 'service_role', NULL, p_sql,
                              'ERROR _____ ' || p_hint || ':%')
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'bd-owner@example.invalid'),
    (u_admin,  'bd-admin@example.invalid'),
    (u_lead,   'bd-lead@example.invalid'),
    (u_coord,  'bd-coord@example.invalid'),
    (u_agent,  'bd-agent@example.invalid'),
    (u_agent2, 'bd-agent2@example.invalid'),
    (u_agent3, 'bd-agent3@example.invalid'),
    (u_viewer, 'bd-viewer@example.invalid'),
    (u_agent4, 'bd-agent4@example.invalid'),
    (u_bown,   'bd-bown@example.invalid'),
    (u_guest,  'bd-guest@example.invalid'),
    (u_gone,   'bd-gone@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'
   WHERE user_id IN (u_coord, u_agent, u_agent2, u_agent3, u_agent4, u_guest, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'BD T1', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-127-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_bown, b_acct, 'whapi', 'CT-127-B1', 'x', 'connected', true) RETURNING id INTO wb;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500127001', 'BD one')
    RETURNING id INTO ca;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500127002', 'BD bee')
    RETURNING id INTO cb;

  FOR i IN 1 .. 9 LOOP
    g[i] := (SELECT x.group_id FROM sg_open(a_acct, 'SUB-127-' || i, ca, wa, 'bank dash ' || i, NULL, CASE
        WHEN i IN (1, 2) THEN jsonb_build_array(jsonb_build_object('user_id', u_coord, 'label', 'coordinator'),
                                                jsonb_build_object('user_id', u_agent, 'label', 'agent'))
        WHEN i IN (6, 9) THEN jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'))
        WHEN i = 5 THEN jsonb_build_array(jsonb_build_object('user_id', u_agent3, 'label', 'agent'))
        ELSE jsonb_build_array(jsonb_build_object('user_id', u_agent2, 'label', 'agent')) END, NULL) x);
    IF g[i] IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group %', i; END IF;
  END LOOP;
  gb := (SELECT x.group_id FROM sg_open(b_acct, 'SUB-127-B', cb, wb, 'bank dash b', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_bown, 'label', 'agent')), NULL) x);

  PERFORM case_bank_upsert(u_owner, a_acct, 'ADCB', 'ADCB Bank');
  PERFORM case_bank_upsert(u_owner, a_acct, 'ENBD', 'Emirates NBD');
  PERFORM case_bank_upsert(u_bown, b_acct, 'ADCB', 'ADCB in B');
  FOR i IN 1 .. 9 LOOP
    k[i] := (SELECT x.case_id FROM case_open(g[i], CASE i WHEN 9 THEN 'ENBD' ELSE 'ADCB' END, NULL,
      'Prod-127-k' || i, CASE i WHEN 1 THEN 1000 WHEN 2 THEN 2000.50 WHEN 3 THEN 4000 WHEN 4 THEN 8000
                                WHEN 9 THEN 50000 END, NULL) x);
    IF k[i] IS NULL THEN RAISE EXCEPTION 'fixture: case_open returned no case %', i; END IF;
  END LOOP;
  kb := (SELECT x.case_id FROM case_open(gb, 'ADCB', NULL, 'Prod-127-kb', NULL, NULL) x);
  ws_a := bank_ws_create(u_owner, a_acct, 'ADCB', t0);
  ws_e := bank_ws_create(u_owner, a_acct, 'ENBD', t0);
  ws_b := bank_ws_create(u_bown, b_acct, 'ADCB', t0);

  -- k1's stages at controlled times (case_set_stage would stamp now() = t0).
  INSERT INTO case_stage_history (case_id, account_id, from_stage, to_stage, actor_id, actor_role, changed_at) VALUES
    (k[1], a_acct, 'Submitted', 'Bank acknowledged', u_owner, 'super_admin', t0 + interval '2 days'),
    (k[1], a_acct, 'Bank acknowledged', 'Documents requested', u_owner, 'super_admin', t0 + interval '5 days');
  UPDATE cases SET stage = 'Documents requested' WHERE id = k[1];
  -- Timers after every stage move of their case (a move stops unconfigured timers).
  INSERT INTO case_sla_timers (case_id, account_id, timer, stage, started_at, due_soon_at, due_at, stopped_at, state) VALUES
    -- k1: stopped though overdue; running, stored 'overdue' but not due until +20 days: neither counts.
    (k[1], a_acct, 'customer_reply', 'Documents requested', t0, t0 + interval '1 day', t0 + interval '2 days', t0 + interval '3 days', NULL),
    (k[1], a_acct, 'bank_response', 'Documents requested', t0, t0 + interval '15 days', t0 + interval '20 days', NULL, 'overdue'),
    -- k2: overdue running timer, and overdue tasks below: counted once.
    (k[2], a_acct, 'bank_response', 'Submitted', t0, t0 + interval '1 day', t0 + interval '2 days', NULL, 'overdue'),
    -- k7: stored 'on_track', computed overdue at p_now: counts.
    (k[7], a_acct, 'customer_reply', 'Submitted', t0, t0 + interval '1 day', t0 + interval '2 days', NULL, 'on_track');
  INSERT INTO case_tasks (case_id, account_id, template_key, title, owner_id, due_at, status, created_by) VALUES
    (k[1], a_acct, 'bd', 'done, past due', u_agent, t0 + interval '1 day', 'done', u_owner),
    (k[1], a_acct, 'bd', 'due exactly at p_now', u_agent, t_now, 'open', u_owner),
    (k[1], a_acct, 'bd', 'due later', u_agent, t0 + interval '30 days', 'open', u_owner),
    (k[1], a_acct, 'bd', 'no due date', u_agent, NULL, 'open', u_owner),
    (k[2], a_acct, 'bd', 'open, past due', u_agent, t0 + interval '9 days', 'open', u_owner),
    (k[2], a_acct, 'bd', 'blocked, past due', u_agent, t0 + interval '1 day', 'blocked', u_owner);

  usr := ARRAY[u_owner, u_admin, u_lead, u_coord, u_agent, u_agent2, u_agent3, u_viewer, u_agent4, u_bown];
  lbl := ARRAY['owner', 'admin', 'team lead', 'coordinator', 'agent', 'agent2', 'agent3', 'viewer',
               'agent on no case', 'B owner'];

  -- ---------- dashboard: refusals, in order ----------
  FOREACH r IN ARRAY ARRAY[format('%L, %L, %L', u_viewer, ws_a, t_now), format('%L, %L, %L', u_agent4, ws_a, t_now),
    format('%L, %L, %L', u_bown, ws_a, t_now), format('%L, %L, %L', u_owner, ws_b, t_now),
    format('%L, %L, %L', u_agent2, ws_e, t_now), format('NULL, %L, %L', ws_a, t_now)] LOOP
    n := n + 1; failed := failed || pg_temp.bw_err(format('bank_ws_dashboard(%s)', r),
      format('SELECT bank_ws_dashboard(%s)::text', r), 'NOT_ALLOWED');
  END LOOP;
  FOREACH r IN ARRAY ARRAY[format('%L, %L, %L', u_owner, gen_random_uuid(), t_now),
    format('NULL, %L, %L', gen_random_uuid(), t_now), format('%L, %L, %L', u_owner, ws_a, t_now)] LOOP
    n := n + 1; failed := failed || pg_temp.bw_err(format('bank_ws_dashboard(%s) of an unknown workspace', r),
      format('SELECT bank_ws_dashboard(%s)::text', replace(r, ws_a::text, k[1]::text)), 'BANK_WS_NOT_FOUND');
  END LOOP;
  FOREACH r IN ARRAY ARRAY[format('%L, %L, NULL', u_owner, ws_a), format('%L, %L, ''infinity''', u_owner, ws_a),
    format('%L, %L, ''-infinity''', u_owner, ws_a), format('NULL, %L, NULL', gen_random_uuid())] LOOP
    n := n + 1; failed := failed || pg_temp.bw_err(format('bank_ws_dashboard(%s)', r),
      format('SELECT bank_ws_dashboard(%s)::text', r), 'NOW_REQUIRED');
  END LOOP;

  -- ---------- lapse: k5 is u_agent3's only case ----------
  st := pg_temp.cs_try('service_role', NULL, format('SELECT bank_ws_dashboard(%L, %L, %L)->>''total_cases''',
    u_agent3, ws_a, t_now));
  n := n + 1; failed := failed || pg_temp.cs_ok(st = '1',
    format('agent3 (one open case) did not get a one-case dashboard (%s)', st));
  d := bank_ws_dashboard(u_agent3, ws_a, t_now);
  n := n + 1; failed := failed || pg_temp.cs_ok(d->>'amount_in_pipeline' = '0.00' AND d->>'scope' = 'own'
    AND d->'approval'->'rate' = 'null'::jsonb AND d->'declined_reasons' = '{}'::jsonb,
    format('a dashboard with no amount and no decision is not 0.00 / rate null / no reasons (%s)', d));
  PERFORM case_set_stage(k[5], u_agent3, 'Withdrawn', 'Withdrawn', false);
  n := n + 1; failed := failed || pg_temp.bw_err('the dashboard after the member''s last open case closed',
    format('SELECT bank_ws_dashboard(%L, %L, %L)::text', u_agent3, ws_a, t_now), 'NOT_ALLOWED');

  -- ---------- outcomes (at t0) ----------
  PERFORM case_set_stage(k[3], u_owner, 'Declined', 'Declined', false);
  PERFORM case_set_stage(k[3], u_owner, 'Closed', NULL, false);
  PERFORM case_set_stage(k[4], u_owner, 'Approved', 'Approved', false);
  PERFORM case_set_stage(k[6], u_owner, 'Declined', 'Declined', false);
  PERFORM case_set_stage(k[8], u_owner, 'Declined', 'Declined', false);
  PERFORM case_set_stage(kb, u_bown, 'Closed', NULL, false);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT string_agg(coalesce(c.stage, '-') || '/' || coalesce(c.outcome, '-'), ',' ORDER BY o)
       FROM unnest(k) WITH ORDINALITY AS x(id, o) JOIN cases c ON c.id = x.id)
    = 'Documents requested/-,Submitted/-,Closed/Declined,Approved/Approved,Withdrawn/Withdrawn,Declined/Declined,Submitted/-,Declined/Declined,Submitted/-',
    'fixture: the cases are not at the stages / outcomes the maths below assume');

  -- ---------- reasons: refusals in order, each isolated ----------
  n := n + 1; failed := failed || pg_temp.bw_err('reason for an unknown case',
    format('SELECT case_outcome_reason_set(%L, %L, ''NOPE'', NULL)::text', u_owner, gen_random_uuid()), 'NOT_ALLOWED');
  FOREACH r IN ARRAY ARRAY[format('%L', u_viewer), format('%L', u_agent4), format('%L', u_bown), format('%L', u_coord),
                           format('%L', u_lead), 'NULL'] LOOP
    -- k3 is Declined; none of these may write it; a bad code and text come after the role.
    n := n + 1; failed := failed || pg_temp.bw_err(format('reason on k3 by %s', r),
      format('SELECT case_outcome_reason_set(%s, %L, ''NOPE'', %L)::text', r, k[3], repeat('x', 501)), 'NOT_ALLOWED');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['''NOPE''', 'NULL', '''credit_policy''', ''' CREDIT_POLICY'''] LOOP
    -- k1 has no outcome and the text is too long: the code is checked first.
    n := n + 1; failed := failed || pg_temp.bw_err(format('reason code %s', r),
      format('SELECT case_outcome_reason_set(%L, %L, %s, %L)::text', u_owner, k[1], r, repeat('x', 501)),
      'REASON_INVALID');
  END LOOP;
  FOREACH r IN ARRAY ARRAY[repeat('x', 501), ' ' || repeat('x', 500)] LOOP
    n := n + 1; failed := failed || pg_temp.bw_err(format('reason text of %s characters', char_length(r)),
      format('SELECT case_outcome_reason_set(%L, %L, ''OTHER'', %L)::text', u_owner, k[1], r), 'REASON_TEXT_TOO_LONG');
  END LOOP;
  FOREACH r IN ARRAY ARRAY[k[1]::text, k[2]::text, k[4]::text] LOOP
    n := n + 1; failed := failed || pg_temp.bw_err(format('reason on a case with outcome %s',
        (SELECT coalesce(outcome, 'none') FROM cases WHERE id = r::uuid)),
      format('SELECT case_outcome_reason_set(%L, %L, ''OTHER'', %L)::text', u_owner, r, repeat('x', 500)),
      'OUTCOME_NOT_DECLINED');
  END LOOP;
  -- Writers: the case agent (k3 after Closed, k8), the withdrawn case's agent, the team lead (k6).
  PERFORM case_outcome_reason_set(u_agent2, k[3], 'CREDIT_POLICY', '  as given  ');
  PERFORM case_outcome_reason_set(u_agent2, k[8], 'CREDIT_POLICY', repeat('y', 500));
  PERFORM case_outcome_reason_set(u_lead, k[6], 'KYC_AML', repeat(' ', 600));
  st := pg_temp.cs_try('service_role', NULL,
    format('SELECT case_outcome_reason_set(%L, %L, ''CUSTOMER_WITHDREW'', E'' \t\n'')::text', u_agent3, k[5]));
  n := n + 1; failed := failed || pg_temp.cs_ok(st = '', format('service_role could not set a reason (%s)', st));
  SELECT string_agg(concat_ws('/', x.o, c.reason_code, coalesce(c.reason_text, 'NULL'), c.outcome, c.actor_role,
                              c.actor_id = u.id, c.account_id = a_acct, c.created_at = t0), ',' ORDER BY x.o) INTO st
    FROM unnest(ARRAY[3, 5, 6, 8]) AS x(o)
    JOIN case_outcome_reasons c ON c.case_id = k[x.o]
    JOIN LATERAL (SELECT CASE x.o WHEN 6 THEN u_lead WHEN 5 THEN u_agent3 ELSE u_agent2 END AS id) u ON true;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = concat_ws(',',
      '3/CREDIT_POLICY/  as given  /Declined/agent/t/t/t', '5/CUSTOMER_WITHDREW/NULL/Withdrawn/agent/t/t/t',
      '6/KYC_AML/NULL/Declined/team_lead/t/t/t',
      '8/CREDIT_POLICY/' || repeat('y', 500) || '/Declined/agent/t/t/t')
    AND (SELECT count(*) FROM case_outcome_reasons) = 4,
    format('the reasons are not stored as given (whitespace-only as NULL, outcome kept after Closed): %s', left(st, 300)));
  n := n + 1; failed := failed || pg_temp.bw_err('a second reason on k3',
    format('SELECT case_outcome_reason_set(%L, %L, ''OTHER'', NULL)::text', u_owner, k[3]), 'REASON_ALREADY_SET');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT reason_code || '/' || actor_role FROM case_outcome_reasons WHERE case_id = k[3]) = 'CREDIT_POLICY/agent',
    'the refused second reason changed the first');

  -- ---------- dashboard maths (owner: every ADCB case of A) ----------
  d := bank_ws_dashboard(u_owner, ws_a, t_now);
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(d) x) = ARRAY['amount_in_pipeline', 'approval',
      'avg_days_per_stage', 'cases_by_stage', 'declined_reasons', 'overdue_count', 'scope', 'total_cases',
      'withdrawn_reasons'],
    format('the dashboard keys are not exactly the documented ones (%s)',
      (SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_object_keys(d) x)));
  n := n + 1; failed := failed || pg_temp.cs_ok(d->>'scope' = 'all' AND d->>'total_cases' = '8',
    format('owner: scope / total_cases are %s / %s, expected all / 8', d->>'scope', d->>'total_cases'));
  n := n + 1; failed := failed || pg_temp.cs_ok(d->'cases_by_stage' = '{"Submitted": 2, "Documents requested": 1,
      "Closed": 1, "Approved": 1, "Withdrawn": 1, "Declined": 2}'::jsonb,
    format('cases_by_stage is %s', d->'cases_by_stage'));
  -- Submitted: k1 2 d, k2 and k7 10 d (to p_now), five cases left at t0: 22 / 8. Final stages left out.
  n := n + 1; failed := failed || pg_temp.cs_ok((d->'avg_days_per_stage')::text = '{"Submitted":
      {"avg_days": 2.75, "intervals": 8}, "Bank acknowledged": {"avg_days": 3.00, "intervals": 1},
      "Documents requested": {"avg_days": 5.00, "intervals": 1}}'::jsonb::text,
    format('avg_days_per_stage is %s', d->'avg_days_per_stage'));
  n := n + 1; failed := failed || pg_temp.cs_ok((d->'approval')::text
      = '{"rate": 0.2500, "approved": 1, "declined": 3, "withdrawn": 1}'::jsonb::text,
    format('approval is %s, expected 1 / (1 + 3) = 0.2500 with the withdrawn case outside the rate', d->'approval'));
  n := n + 1; failed := failed || pg_temp.cs_ok(d->'overdue_count' = '2'::jsonb,
    format('overdue_count is %s, expected 2 (k2 once, k7)', d->'overdue_count'));
  n := n + 1; failed := failed || pg_temp.cs_ok(d->>'amount_in_pipeline' = '3000.50',
    format('amount_in_pipeline is %s, expected 3000.50', d->>'amount_in_pipeline'));
  n := n + 1; failed := failed || pg_temp.cs_ok(d->'declined_reasons' = '{"CREDIT_POLICY": 2, "KYC_AML": 1}'::jsonb
      AND d->'withdrawn_reasons' = '{"CUSTOMER_WITHDREW": 1}'::jsonb,
    format('reasons by code are %s / %s', d->'declined_reasons', d->'withdrawn_reasons'));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    pg_temp.cs_try('service_role', NULL, format('SELECT bank_ws_dashboard(%L, %L, %L)::text', u_admin, ws_a, t_now))::jsonb
      = d,
    'the admin''s dashboard (through service_role) differs from the owner''s');
  -- No identifier or free text of the fixture in the output.
  leaks := ARRAY[a_acct::text, b_acct::text, ca::text, cb::text, ws_a::text, wa::text]
    || (SELECT array_agg(x::text) FROM unnest(k || g || usr) x)
    || (SELECT array_agg('SUB-127-' || j) FROM generate_series(1, 9) j)
    || (SELECT array_agg('Prod-127-k' || j) FROM generate_series(1, 9) j)
    || ARRAY['as given', repeat('y', 20), 'BD one', '971500127001'];
  FOREACH r IN ARRAY ARRAY[d::text, bank_ws_dashboard(u_agent, ws_a, t_now)::text] LOOP
    st := (SELECT string_agg(x, ',') FROM unnest(leaks) x WHERE strpos(r, x) > 0);
    n := n + 1; failed := failed || pg_temp.cs_ok(st IS NULL, format('the dashboard output carries %s', st));
  END LOOP;
  -- B's only case is closed: nothing in the pipeline.
  d := bank_ws_dashboard(u_bown, ws_b, t_now);
  n := n + 1; failed := failed || pg_temp.cs_ok(d->>'total_cases' = '1' AND d->>'amount_in_pipeline' = '0.00'
    AND d->'overdue_count' = '0'::jsonb AND d->'approval'->'rate' = 'null'::jsonb,
    format('B''s dashboard is %s', d));

  -- ---------- member scope: exactly the readable cases ----------
  FOR i IN 1 .. array_length(usr, 1) LOOP
    IF bank_ws_access(ws_a, usr[i]) IS NULL THEN
      CONTINUE;
    END IF;
    d := bank_ws_dashboard(usr[i], ws_a, t_now);
    SELECT concat_ws('|', count(*),
             coalesce((SELECT jsonb_object_agg(s.stage, s.c) FROM (SELECT c2.stage, count(*) AS c FROM cases c2
                         WHERE c2.id = ANY (array_agg(c.id)) GROUP BY c2.stage) s), '{}'::jsonb),
             count(*) FILTER (WHERE c.outcome = 'Approved'), count(*) FILTER (WHERE c.outcome = 'Declined'),
             count(*) FILTER (WHERE c.outcome = 'Withdrawn'),
             coalesce(sum(c.amount) FILTER (WHERE c.closed_at IS NULL), 0)::numeric(18, 2))
      INTO r2
      FROM cases c
     WHERE c.account_id = a_acct AND c.bank_code = 'ADCB' AND case_can_read(c.id, usr[i]);
    st := concat_ws('|', d->>'total_cases', d->'cases_by_stage', d->'approval'->>'approved',
      d->'approval'->>'declined', d->'approval'->>'withdrawn', d->>'amount_in_pipeline');
    n := n + 1; failed := failed || pg_temp.cs_ok(st = r2,
      format('%s: the dashboard covers %s, the readable cases give %s', lbl[i], st, r2));
  END LOOP;
  -- Not vacuous: who sees what, pinned (scope, total, overdue, rate).
  SELECT string_agg(concat_ws('/', l, x->>'scope', x->>'total_cases', x->>'overdue_count',
                              coalesce(x->'approval'->>'rate', 'null')), ',' ORDER BY o) INTO st
    FROM (SELECT lbl[o] AS l, o, bank_ws_dashboard(usr[o], ws_a, t_now) AS x
            FROM generate_series(1, 6) o) z;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = concat_ws(',', 'owner/all/8/2/0.2500', 'admin/all/8/2/0.2500',
      'team lead/own/3/1/0.0000', 'coordinator/own/2/1/null', 'agent/own/3/1/0.0000', 'agent2/own/4/1/0.3333'),
    format('member dashboards are not as pinned (%s)', st));

  -- ---------- reasons under RLS (authenticated, active account) ----------
  FOR i IN 1 .. array_length(usr, 1) LOOP
    st := pg_temp.cs_try('authenticated', usr[i], 'SELECT count(*)::text FROM public.case_outcome_reasons');
    r2 := (SELECT count(*)::text FROM case_outcome_reasons x WHERE case_can_read(x.case_id, usr[i]));
    n := n + 1; failed := failed || pg_temp.cs_ok(st = r2,
      format('%s reads %s reasons under RLS, can read the case of %s', lbl[i], st, r2));
  END LOOP;
  SELECT string_agg(pg_temp.cs_try('authenticated', u, 'SELECT count(*)::text FROM public.case_outcome_reasons'), ',')
    INTO st FROM unnest(ARRAY[u_owner, u_agent2, u_agent, u_agent4, u_bown]) u;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = '4,2,1,0,0',
    format('reason reads under RLS are not as pinned (owner, agent2, agent, agent on no case, B owner): %s', st));
  -- u_agent2 works on k3 and k8 in A but is active in B: the policy's account
  -- conjunct is the only thing that hides A's reasons from that session.
  UPDATE profiles SET is_active = false WHERE user_id = u_agent2 AND account_id = a_acct;
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_agent2, '', 'bd-agent2@example.invalid', b_acct, 'agent', true);
  st := pg_temp.cs_try('authenticated', u_agent2, 'SELECT count(*)::text FROM public.case_outcome_reasons');
  r2 := (SELECT count(*)::text FROM case_outcome_reasons x WHERE case_can_read(x.case_id, u_agent2));
  n := n + 1; failed := failed || pg_temp.cs_ok(st = '0' AND r2 <> '0',
    format('u_agent2 active in B reads %s of A''s reasons under RLS (the case rule alone gives %s)', st, r2));
  DELETE FROM profiles WHERE user_id = u_agent2 AND account_id = b_acct;
  UPDATE profiles SET is_active = true WHERE user_id = u_agent2 AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.cs_check('authenticated inserted a reason', 'authenticated', u_owner,
    format('INSERT INTO public.case_outcome_reasons (case_id, account_id, reason_code, outcome, actor_id, actor_role) VALUES (%L, %L, ''OTHER'', ''Declined'', %L, ''super_admin'')',
      k[4], a_acct, u_owner), 'ERROR 42501 %');
  FOREACH r IN ARRAY ARRAY['service_role', 'anon'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s read case_outcome_reasons', r), r, NULL,
      'SELECT count(*)::text FROM public.case_outcome_reasons', 'ERROR 42501 %');
  END LOOP;

  -- ---------- a bank guest and a deactivated agent who hold the cases ----------
  -- case_role gives neither a role, whatever the case lists. Each in turn
  -- becomes agent and coordinator of k1 and agent of k3 (k3 is Declined),
  -- then the cases go back.
  FOREACH r IN ARRAY ARRAY[u_guest::text, u_gone::text] LOOP
    IF r = u_guest::text THEN
      UPDATE profiles SET account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;
    ELSE
      UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;
    END IF;
    UPDATE cases SET agent_id = r::uuid, coordinator_id = r::uuid WHERE id IN (k[1], k[3]);
    n := n + 1; failed := failed || pg_temp.cs_ok(
      (SELECT count(*) FROM cases WHERE id IN (k[1], k[3]) AND agent_id = r::uuid AND coordinator_id = r::uuid) = 2
      AND case_role(k[1], r::uuid) IS NULL AND case_role(k[3], r::uuid) IS NULL,
      format('fixture: %s does not hold k1 and k3 without a role', r));
    n := n + 1; failed := failed || pg_temp.bw_err(format('bank_ws_dashboard by %s', r),
      format('SELECT bank_ws_dashboard(%L, %L, %L)::text', r, ws_a, t_now), 'NOT_ALLOWED');
    n := n + 1; failed := failed || pg_temp.bw_err(format('reason on k3 by %s', r),
      format('SELECT case_outcome_reason_set(%L, %L, ''NOPE'', %L)::text', r, k[3], repeat('x', 501)), 'NOT_ALLOWED');
    n := n + 1; failed := failed || pg_temp.bw_err(format('take-over of k1 by %s', r),
      format('SELECT case_takeover_record(%L, %L, ''v1'')::text', r, k[1]), 'NOT_ALLOWED');
  END LOOP;
  UPDATE cases SET agent_id = u_agent, coordinator_id = u_coord WHERE id = k[1];
  UPDATE cases SET agent_id = u_agent2, coordinator_id = NULL WHERE id = k[3];
  n := n + 1; failed := failed || pg_temp.cs_ok(case_role(k[1], u_coord) = 'coordinator'
    AND case_role(k[1], u_agent) = 'agent' AND case_role(k[3], u_agent2) = 'agent',
    'fixture: k1 and k3 are not back to their holders');

  -- ---------- take-over ----------
  n := n + 1; failed := failed || pg_temp.bw_err('take-over of an unknown case',
    format('SELECT case_takeover_record(%L, %L, NULL)::text', u_coord, gen_random_uuid()), 'NOT_ALLOWED');
  FOREACH r IN ARRAY ARRAY[format('%L', u_agent), format('%L', u_admin), format('%L', u_owner), format('%L', u_agent2),
                           format('%L', u_viewer), format('%L', u_bown), 'NULL'] LOOP
    -- k1: agent u_agent, coordinator u_coord, team lead u_lead. A bad template comes after the role.
    n := n + 1; failed := failed || pg_temp.bw_err(format('take-over of k1 by %s', r),
      format('SELECT case_takeover_record(%s, %L, ''v1'')::text', r, k[1]), 'NOT_ALLOWED');
    n := n + 1; failed := failed || pg_temp.bw_err(format('take-over of k1 with a NULL template by %s', r),
      format('SELECT case_takeover_record(%s, %L, NULL)::text', r, k[1]), 'NOT_ALLOWED');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['NULL', '''  ''', format('%L', E'\t\n'), format('%L', repeat('t', 41))] LOOP
    n := n + 1; failed := failed || pg_temp.bw_err(format('take-over template %s', left(r, 12)),
      format('SELECT case_takeover_record(%L, %L, %s)::text', u_coord, k[1], r), 'TEMPLATE_INVALID');
  END LOOP;
  n := n + 1; failed := failed || pg_temp.cs_ok((SELECT count(*) FROM case_takeover_log) = 0,
    'a refused take-over wrote a row');
  v_id := pg_temp.cs_try('service_role', NULL,
    format('SELECT case_takeover_record(%L, %L, ''v1'')::text', u_coord, k[1]))::bigint;
  v_id2 := case_takeover_record(u_coord, k[1], 'v1');
  PERFORM case_takeover_record(u_lead, k[6], repeat('t', 40));
  n := n + 1; failed := failed || pg_temp.cs_ok(v_id IS NOT NULL AND v_id2 > v_id
    AND (SELECT string_agg(concat_ws('/', l.id = v_id, l.id = v_id2, l.case_id = k[1], l.account_id = a_acct,
             l.actor = u_coord, l.actor = u_lead, char_length(l.template_version), l.taken_at = t0), ',' ORDER BY l.id)
           FROM case_takeover_log l)
        = 't/f/t/t/t/f/2/t,f/t/t/t/t/f/2/t,f/f/f/t/f/t/40/t',
    format('the take-over log is not one row per call (coordinator twice, team lead once): %s',
      (SELECT string_agg(concat_ws('/', l.id, l.actor, l.template_version), ',' ORDER BY l.id) FROM case_takeover_log l)));
  FOREACH r IN ARRAY ARRAY['service_role', 'authenticated', 'anon'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('%s read case_takeover_log', r), r, u_owner,
      'SELECT count(*)::text FROM public.case_takeover_log', 'ERROR 42501 %');
  END LOOP;

  -- ---------- grants ----------
  SELECT string_agg(rl || '/' || pv || '/' || t, ',' ORDER BY rl, pv, t) INTO st
    FROM unnest(ARRAY['case_outcome_reasons', 'case_takeover_log']) t,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) rl,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pv
   WHERE has_table_privilege(rl, 'public.' || t, pv);
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'authenticated/SELECT/case_outcome_reasons' AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) rl,
                    unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) pv
       WHERE has_sequence_privilege(rl, 'public.case_takeover_log_id_seq', pv)),
    format('127 / 128 table privileges are not exactly authenticated SELECT on case_outcome_reasons (%s)', st));
  SELECT string_agg(rl || '/' || f, ',' ORDER BY rl, f) INTO st
    FROM unnest(ARRAY['bank_ws_dashboard(uuid,uuid,timestamptz)', 'case_outcome_reason_set(uuid,uuid,text,text)',
                      'case_takeover_record(uuid,uuid,text)']) f,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) rl
   WHERE has_function_privilege(rl, 'public.' || f, 'EXECUTE');
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'service_role/bank_ws_dashboard(uuid,uuid,timestamptz),'
      'service_role/case_outcome_reason_set(uuid,uuid,text,text),service_role/case_takeover_record(uuid,uuid,text)',
    format('127 / 128 function privileges are not exactly the three functions to service_role (%s)', st));

  -- ---------- append-only, the owner included (last: some of these succeed on a broken tree) ----------
  FOREACH r IN ARRAY ARRAY['case_outcome_reasons', 'case_takeover_log'] LOOP
    n := n + 1; failed := failed || pg_temp.cs_check(format('UPDATE of %s as the owner was not refused', r), NULL, NULL,
      format('UPDATE public.%I SET account_id = account_id', r), format('ERROR 42501 -: public.%s is append-only (UPDATE refused)', r));
    n := n + 1; failed := failed || pg_temp.cs_check(format('DELETE from %s as the owner was not refused', r), NULL, NULL,
      format('DELETE FROM public.%I', r), format('ERROR 42501 -: public.%s is append-only (DELETE refused)', r));
    n := n + 1; failed := failed || pg_temp.cs_check(format('TRUNCATE of %s as the owner was not refused', r), NULL, NULL,
      format('TRUNCATE public.%I', r), format('ERROR 42501 -: public.%s is append-only (TRUNCATE refused)', r));
  END LOOP;

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT127', MESSAGE = 'verify-bank-dashboard rollback';
  EXCEPTION WHEN SQLSTATE 'ZT127' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'bank dashboard verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'bank dashboard verification passed (% checks)', n;
END
$verify$;
