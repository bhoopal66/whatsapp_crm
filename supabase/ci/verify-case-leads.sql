-- Behavioural regression suite for case leads (migration 130).
--
-- A case can open at the lead, before any submission: case_open_lead
-- opens it at Interested with no group, for a contact the agent can see
-- (129's memory_can_read), once per open (account, contact, bank), and
-- only for the agent themself, an admin or the agent's team leader. The
-- pre-submission stages (Interested, Data collection, Review) move freely
-- among themselves, a lead leaves them only to Withdrawn, and a submitted
-- case never re-enters them. case_open attaches a group to the open lead
-- of its contact and bank (same case, one stage-history row, the SLA
-- timers reset) or opens a new case at case_submitted_stage. A lead has
-- no group to end, NO_RESPONSE is a Withdrawn reason only, and every
-- stored stage list starts with the three pre-submission stages.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000130001';
  u_admin  UUID := '00000000-0000-4000-8000-000000130002';
  u_lead   UUID := '00000000-0000-4000-8000-000000130003';  -- leads team T (u_agent)
  u_agent  UUID := '00000000-0000-4000-8000-000000130004';  -- the agent of every lead
  u_agent2 UUID := '00000000-0000-4000-8000-000000130005';  -- agent, not in T
  u_viewer UUID := '00000000-0000-4000-8000-000000130006';
  u_guest  UUID := '00000000-0000-4000-8000-000000130007';
  u_bown   UUID := '00000000-0000-4000-8000-000000130008';  -- owner of account B
  a_acct   UUID;
  b_acct   UUID;
  w1       UUID;
  team1    UUID;
  c1       UUID;  -- u_agent's contact
  c2       UUID;  -- u_agent's contact, submitted at ENBD
  c3       UUID;  -- u_agent's contact, lead at HSBC then attached
  c_hidden UUID;  -- the owner's contact, no conversation: u_agent cannot see it
  c_b      UUID;  -- a contact of account B
  g0       UUID;
  g_s      UUID;
  g_a      UUID;
  k0       UUID;
  k_s      UUID;
  l1       UUID;
  l8       UUID;
  l12      UUID;
  l15      UUID;
  ws       UUID;
  v_id     UUID;
  b1       BOOLEAN;
  st       TEXT;
  r        TEXT;
  j        JSONB;
  h0       INT;
  h1       INT;
  n        INT := 0;
  failed   TEXT[] := '{}';
  defaults TEXT[] := ARRAY['Interested', 'Data collection', 'Review', 'Submitted', 'Bank acknowledged', 'Documents requested', 'Documents received',
    'Under review', 'Query raised', 'Query answered', 'Approved', 'Declined', 'Withdrawn', 'Closed'];
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
  -- case_bank_stages_set, then the deferred list check forced at once:
  -- 'ok:<n>' or 'ERROR <sqlstate> <hint>'. A refused list is rolled back.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cs_stages(p_actor uuid, p_account uuid, p_bank text, p_stages text[])
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v int; h text;
    BEGIN
      BEGIN
        v := public.case_bank_stages_set(p_actor, p_account, p_bank, p_stages);
        SET CONSTRAINTS public.case_bank_stages_valid IMMEDIATE;
        SET CONSTRAINTS public.case_bank_stages_valid DEFERRED;
        RETURN 'ok:' || v;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        SET CONSTRAINTS public.case_bank_stages_valid DEFERRED;
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-');
      END;
    END $body$
  $fn$;
  -- case_open_lead(actor, account, contact, bank, product, agent, amount)
  -- as SQL text for cs_check; p_amount is a literal ('NULL', '''NaN''').
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cl_sql(p_actor uuid, p_account uuid, p_contact uuid, p_bank text, p_product text,
      p_agent uuid, p_amount text DEFAULT 'NULL')
    RETURNS text LANGUAGE sql AS $body$
      SELECT format('SELECT case_open_lead(%L, %L, %L, %L, %L, %L, %s::numeric)::text',
                    p_actor, p_account, p_contact, p_bank, p_product, p_agent, p_amount)
    $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'cl-owner@example.invalid'),
    (u_admin,  'cl-admin@example.invalid'),
    (u_lead,   'cl-lead@example.invalid'),
    (u_agent,  'cl-agent@example.invalid'),
    (u_agent2, 'cl-agent2@example.invalid'),
    (u_viewer, 'cl-viewer@example.invalid'),
    (u_guest,  'cl-guest@example.invalid'),
    (u_bown,   'cl-bown@example.invalid')
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
  UPDATE profiles SET account_id = a_acct, account_role = 'bank_guest', bank_code = 'ADCB' WHERE user_id = u_guest;

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'CL T', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CL-130-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500130001', 'CL one')
    RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500130002', 'CL two')
    RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_agent, '971500130003', 'CL three')
    RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500130004', 'CL hidden')
    RETURNING id INTO c_hidden;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b_acct, u_bown, '971500130005', 'CL other')
    RETURNING id INTO c_b;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a_acct, 'ADCB', 'ADCB'), (a_acct, 'ENBD', 'Emirates NBD'), (a_acct, 'FAB', 'FAB'), (a_acct, 'RAK', 'RAKBANK'),
    (a_acct, 'MASHREQ', 'Mashreq'), (a_acct, 'CBD', 'CBD'), (a_acct, 'HSBC', 'HSBC'), (a_acct, 'DIB', 'DIB'),
    (a_acct, 'NBF', 'NBF')
  ON CONFLICT DO NOTHING;

  -- The visibility fixture item 4 relies on.
  n := n + 1; failed := failed || pg_temp.cs_ok(
    memory_can_read(u_agent, a_acct, 'contact', c1) AND NOT memory_can_read(u_agent, a_acct, 'contact', c_hidden),
    'fixture: u_agent should see c1 and not c_hidden (memory_can_read)');

  -- A no-bank case opened through case_open (item 14).
  g0 := (SELECT x.group_id FROM sg_open(a_acct, 'CL-130-0', c1, w1, 'case 0', NULL,
          jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  k0 := (SELECT x.case_id FROM case_open(g0, NULL, NULL, NULL, NULL, NULL) x);
  IF k0 IS NULL THEN RAISE EXCEPTION 'fixture: case_open returned no case for g0'; END IF;

  -- ---------- 1. open a lead ----------
  l1 := case_open_lead(u_agent, a_acct, c1, 'ADCB', 'Personal loan', u_agent, 50000);
  SELECT x.stage, (x.group_id IS NULL AND x.contact_id = c1) INTO st, b1 FROM cases x WHERE x.id = l1;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'Interested' AND b1,
    format('case_open_lead did not open at Interested with no group and contact_id set (stage %s)', st));
  v_id := case_open_lead(u_agent, a_acct, c1, 'ADCB', 'Personal loan', u_agent, 50000);
  n := n + 1; failed := failed || pg_temp.cs_ok(v_id = l1, 'a repeat case_open_lead by the same agent did not return the same id');

  -- ---------- 2. another agent's open lead ----------
  -- u_lead sees c1 (leads its owner) but is not the lead's agent.
  n := n + 1; failed := failed || pg_temp.cs_check(
    'case_open_lead for another agent on an open (contact, bank) lead was not LEAD_EXISTS with no id', NULL, NULL,
    pg_temp.cl_sql(u_lead, a_acct, c1, 'ADCB', 'Personal loan', u_lead), 'ERROR 23505 LEAD_EXISTS:%');

  -- ---------- 9. a fresh group with no lead ----------
  g_s := (SELECT x.group_id FROM sg_open(a_acct, 'CL-130-S', c2, w1, 'case S', NULL,
           jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  SELECT x.case_id, x.created INTO k_s, b1 FROM case_open(g_s, 'ENBD', NULL, 'Mortgage', NULL, NULL) x;
  SELECT x.stage INTO st FROM cases x WHERE x.id = k_s;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    b1 AND st = 'Submitted' AND st = case_submitted_stage(a_acct, 'ENBD'),
    format('case_open of a group with no lead did not open a new case at case_submitted_stage (created %s, stage %s)', b1, st));

  -- ---------- 3. an open submission case for the triple ----------
  n := n + 1; failed := failed || pg_temp.cs_check(
    'case_open_lead with an open submission case for (contact, bank) was not CASE_EXISTS', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c2, 'ENBD', 'Mortgage', u_agent), 'ERROR 23505 CASE_EXISTS:%');

  -- ---------- 10. no re-entry after submission ----------
  n := n + 1; failed := failed || pg_temp.cs_check(
    'a submitted case moved back to Interested (expected PRESUB_REENTRY)', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Interested'') x', k_s, u_agent),
    'ERROR 23514 PRESUB_REENTRY:%');

  -- ---------- 4. LEAD_INVALID ----------
  n := n + 1; failed := failed || pg_temp.cs_check('case_open_lead with amount NaN was not LEAD_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c1, 'FAB', 'Card', u_agent, '''NaN'''), 'ERROR 23514 LEAD_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_open_lead with amount Infinity was not LEAD_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c1, 'FAB', 'Card', u_agent, '''Infinity'''), 'ERROR 23514 LEAD_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_open_lead with amount -1 was not LEAD_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c1, 'FAB', 'Card', u_agent, '-1'), 'ERROR 23514 LEAD_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_open_lead with a spaces-only product was not LEAD_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c1, 'FAB', '  ', u_agent), 'ERROR 23514 LEAD_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_open_lead with a tab-only product was not LEAD_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c1, 'FAB', E'\t', u_agent), 'ERROR 23514 LEAD_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check(
    'case_open_lead for a contact the agent cannot see was not LEAD_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c_hidden, 'FAB', 'Card', u_agent), 'ERROR 23514 LEAD_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check(
    'case_open_lead for another account''s contact was not LEAD_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c_b, 'FAB', 'Card', u_agent), 'ERROR 23514 LEAD_INVALID:%');

  -- ---------- 5. cases_amount_check ----------
  n := n + 1; failed := failed || pg_temp.cs_check('a direct UPDATE of cases.amount to NaN was not refused by cases_amount_check',
    NULL, NULL, format('UPDATE cases SET amount = ''NaN'' WHERE id = %L', l1), 'ERROR 23514 %cases_amount_check%');

  -- ---------- 6. who may open a lead ----------
  n := n + 1; failed := failed || pg_temp.cs_check('the agent could not open their own lead', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c1, 'RAK', 'Card', u_agent), '________-____-____-____-____________');
  n := n + 1; failed := failed || pg_temp.cs_check('an admin could not open a lead for the agent', NULL, NULL,
    pg_temp.cl_sql(u_admin, a_acct, c1, 'MASHREQ', 'Card', u_agent), '________-____-____-____-____________');
  n := n + 1; failed := failed || pg_temp.cs_check('the agent''s team leader could not open a lead for the agent', NULL, NULL,
    pg_temp.cl_sql(u_lead, a_acct, c1, 'CBD', 'Card', u_agent), '________-____-____-____-____________');
  -- The refused actors name a bank with no row: a wrongful allow fails too.
  n := n + 1; failed := failed || pg_temp.cs_check('another agent opened a lead for the agent (expected NOT_ALLOWED)', NULL, NULL,
    pg_temp.cl_sql(u_agent2, a_acct, c1, 'NOPE', 'Card', u_agent), 'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a viewer opened a lead for the agent (expected NOT_ALLOWED)', NULL, NULL,
    pg_temp.cl_sql(u_viewer, a_acct, c1, 'NOPE', 'Card', u_agent), 'ERROR 42501 NOT_ALLOWED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a bank guest opened a lead for the agent (expected NOT_ALLOWED)', NULL, NULL,
    pg_temp.cl_sql(u_guest, a_acct, c1, 'NOPE', 'Card', u_agent), 'ERROR 42501 NOT_ALLOWED:%');

  -- ---------- 7. stage moves of a lead ----------
  n := n + 1; failed := failed || pg_temp.cs_check('a lead could not move Interested -> Review', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Review'') x', l1, u_agent), 'true');
  n := n + 1; failed := failed || pg_temp.cs_check('a lead could not move Review -> Data collection', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Data collection'') x', l1, u_agent), 'true');
  n := n + 1; failed := failed || pg_temp.cs_check('a lead moved to Submitted (expected SUBMISSION_REQUIRED)', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Submitted'') x', l1, u_agent),
    'ERROR 23514 SUBMISSION_REQUIRED:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a lead could not move to Withdrawn', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Withdrawn'') x', l1, u_agent), 'true');
  n := n + 1; failed := failed || pg_temp.cs_check('NO_RESPONSE was refused on a Withdrawn lead', NULL, NULL,
    format('WITH x AS (SELECT case_outcome_reason_set(%L, %L, ''NO_RESPONSE'', NULL)) SELECT ''ok'' FROM x', u_agent, l1), 'ok');
  r := pg_temp.cs_try(NULL, NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Declined'') x', k_s, u_agent));
  IF r <> 'true' THEN RAISE EXCEPTION 'fixture: could not decline k_s (%)', r; END IF;
  n := n + 1; failed := failed || pg_temp.cs_check('NO_RESPONSE on a Declined case was not OUTCOME_REASON', NULL, NULL,
    format('WITH x AS (SELECT case_outcome_reason_set(%L, %L, ''NO_RESPONSE'', NULL)) SELECT ''ok'' FROM x', u_agent, k_s),
    'ERROR 23514 OUTCOME_REASON:%');

  -- ---------- 11. a lead has no group to end ----------
  SELECT x.state INTO st FROM case_claim_group_end(l1, u_agent) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'NO_GROUP',
    format('case_claim_group_end of a closed lead answered %s, not NO_GROUP', st));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    NOT EXISTS (SELECT 1 FROM case_pending_group_end(interval '15 minutes', 10000) x WHERE x.case_id = l1),
    'case_pending_group_end listed a closed lead');

  -- ---------- 8. attach a group to the open lead ----------
  l8 := case_open_lead(u_agent, a_acct, c3, 'HSBC', 'Card', u_agent);
  r := pg_temp.cs_try(NULL, NULL, format('SELECT moved::text FROM case_set_stage(%L, %L, ''Data collection'') x', l8, u_agent));
  IF r <> 'true' THEN RAISE EXCEPTION 'fixture: could not move l8 to Data collection (%)', r; END IF;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    EXISTS (SELECT 1 FROM case_sla_timers t WHERE t.case_id = l8 AND t.timer = 'customer_reply' AND t.stopped_at IS NULL),
    'fixture: Data collection did not start customer_reply on the lead');
  UPDATE case_sla_timers t
     SET started_at = now() - interval '6 days', due_soon_at = now() - interval '2 days',
         due_at = now() - interval '1 day', state = 'overdue'
   WHERE t.case_id = l8 AND t.timer = 'customer_reply';
  SELECT count(*) INTO h0 FROM case_stage_history h WHERE h.case_id = l8;
  g_a := (SELECT x.group_id FROM sg_open(a_acct, 'CL-130-A', c3, w1, 'case A', NULL,
           jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  SELECT x.case_id, x.created INTO v_id, b1 FROM case_open(g_a, 'HSBC', NULL, NULL, NULL, NULL) x;
  n := n + 1; failed := failed || pg_temp.cs_ok(v_id = l8 AND b1 IS FALSE,
    format('attach: case_open did not return the lead with created false (%s, %s)', v_id, b1));
  SELECT x.stage INTO st FROM cases x WHERE x.id = l8;
  n := n + 1; failed := failed || pg_temp.cs_ok(
    st = 'Submitted' AND (SELECT x.group_id FROM cases x WHERE x.id = l8) = g_a,
    format('attach: the lead is not at Submitted with the group (stage %s)', st));
  SELECT count(*) INTO h1 FROM case_stage_history h WHERE h.case_id = l8;
  n := n + 1; failed := failed || pg_temp.cs_ok(h1 = h0 + 1,
    format('attach: wrote %s stage-history rows, not exactly one', h1 - h0));
  n := n + 1; failed := failed || pg_temp.cs_ok(
    EXISTS (SELECT 1 FROM case_sla_timers t
             WHERE t.case_id = l8 AND t.timer = 'customer_reply' AND t.stopped_at IS NOT NULL AND t.state IS NULL),
    'attach: the overdue customer_reply timer was not stopped (stopped_at set, state NULL)');

  -- ---------- 12. a lead is visible to its agent ----------
  l12 := case_open_lead(u_agent, a_acct, c1, 'DIB', 'Auto loan', u_agent, 1000);
  ws := bank_ws_create(u_owner, a_acct, 'DIB', now());
  n := n + 1; failed := failed || pg_temp.cs_ok(
    EXISTS (SELECT 1 FROM case_inbox(u_agent, a_acct, '{}', now(), 200) x WHERE x.case_id = l12),
    'case_inbox did not list the agent''s lead');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    EXISTS (SELECT 1 FROM bank_ws_cases(ws, u_agent) x WHERE x.case_id = l12),
    'bank_ws_cases did not list the agent''s lead');
  n := n + 1; failed := failed || pg_temp.cs_ok(
    EXISTS (SELECT 1 FROM case_timeline(u_agent, l12)),
    'case_timeline was empty for the agent''s lead');
  j := bank_ws_dashboard(u_agent, ws, now());
  n := n + 1; failed := failed || pg_temp.cs_ok(
    (j ->> 'total_cases') = '1' AND (j -> 'cases_by_stage' ->> 'Interested') = '1'
      AND (j ->> 'amount_in_pipeline') = '1000.00',
    format('bank_ws_dashboard did not count the agent''s open lead (%s)', j));

  -- ---------- 13. stage lists ----------
  n := n + 1; failed := failed || pg_temp.cs_ok(case_default_stages() = defaults,
    format('case_default_stages() is %s', case_default_stages()));
  n := n + 1; failed := failed || pg_temp.cs_check('a stored stage list without the pre-submission stages was not refused',
    NULL, NULL, format('SELECT pg_temp.cs_stages(%L, %L, ''NBF'', %L)', u_owner, a_acct,
      ARRAY['Received', 'In progress', 'Approved', 'Declined', 'Withdrawn', 'Closed']),
    'ERROR 23514 PRESUB_STAGES_REQUIRED');
  n := n + 1; failed := failed || pg_temp.cs_check('a stored stage list with the pre-submission stages was refused',
    NULL, NULL, format('SELECT pg_temp.cs_stages(%L, %L, ''NBF'', %L)', u_owner, a_acct,
      ARRAY['Interested', 'Data collection', 'Review', 'Received', 'In progress', 'Approved', 'Declined', 'Withdrawn', 'Closed']),
    'ok:%');

  -- ---------- 14. case_open copies the customer ----------
  SELECT count(*) INTO h0 FROM cases c JOIN submission_groups g ON g.id = c.group_id
   WHERE c.account_id = a_acct AND c.contact_id IS DISTINCT FROM g.contact_id;
  SELECT count(*) INTO h1 FROM cases c WHERE c.account_id = a_acct AND c.group_id IS NOT NULL;
  n := n + 1; failed := failed || pg_temp.cs_ok(h0 = 0 AND h1 >= 3 AND (SELECT x.contact_id FROM cases x WHERE x.id = k0) = c1,
    format('%s of %s cases opened through case_open lack their group''s contact_id', h0, h1));

  -- ---------- 15. review findings (130 fix pass) ----------
  -- PRESUB_STAGES_CONFLICT (130's section 0) refuses the apply itself, so
  -- it cannot be reached from a database 130 already applies to; the
  -- refused-apply-changes-nothing check is a manual run against a 129
  -- database. So is the case_lead_lock race (two sessions).
  n := n + 1; failed := failed || pg_temp.cs_check('case_open_lead with an unknown bank was not BANK_UNKNOWN', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c1, 'NOPE', 'Card', u_agent), 'ERROR 23514 BANK_UNKNOWN:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_open_lead with a viewer as agent was not ASSIGNEE_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_admin, a_acct, c1, 'FAB', 'Card', u_viewer), 'ERROR 23514 ASSIGNEE_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('case_open_lead with amount 1e17 was not LEAD_INVALID', NULL, NULL,
    pg_temp.cl_sql(u_agent, a_acct, c1, 'FAB', 'Card', u_agent, '1e17'), 'ERROR 23514 LEAD_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a grouped case moved to Interested by a direct UPDATE (cases_presub_group)',
    NULL, NULL, format('UPDATE cases SET stage = ''Interested'' WHERE id = %L', k0), 'ERROR 23514 %cases_presub_group%');
  n := n + 1; failed := failed || pg_temp.cs_check('a second open lead of (c1, DIB) was inserted directly (cases_one_open_lead)',
    NULL, NULL, format('INSERT INTO cases (account_id, contact_id, bank_code, product, agent_id, stage) '
                       'VALUES (%L, %L, ''DIB'', ''Card'', %L, ''Interested'')', a_acct, c1, u_agent),
    'ERROR 23505 %cases_one_open_lead%');
  -- A lead's bank change: onto an open lead (c1 has one at RAK), onto an
  -- open submission case (c3 at HSBC, l8 attached), then onto a free pair.
  n := n + 1; failed := failed || pg_temp.cs_check('a lead changed bank onto an open lead of the contact (expected LEAD_INVALID)',
    NULL, NULL, format('SELECT case_set_details(%L, %L, ''RAK'', NULL, NULL)::text', l12, u_agent),
    'ERROR 23514 LEAD_INVALID:%');
  l15 := case_open_lead(u_agent, a_acct, c3, 'FAB', 'Card', u_agent);
  n := n + 1; failed := failed || pg_temp.cs_check(
    'a lead changed bank onto an open submission case of the contact (expected LEAD_INVALID)',
    NULL, NULL, format('SELECT case_set_details(%L, %L, ''HSBC'', NULL, NULL)::text', l15, u_agent),
    'ERROR 23514 LEAD_INVALID:%');
  n := n + 1; failed := failed || pg_temp.cs_check('a lead could not change bank onto a free pair', NULL, NULL,
    format('SELECT case_set_details(%L, %L, ''FAB'', NULL, NULL)::text', l12, u_agent), '{bank_code}');
  SELECT x.bank_code INTO st FROM cases x WHERE x.id = l12;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'FAB', format('the free-pair bank change left the lead at %s', st));
  -- A Withdrawn lead (l1, section 7) may be closed.
  n := n + 1; failed := failed || pg_temp.cs_check('a Withdrawn lead could not move to Closed', NULL, NULL,
    format('SELECT moved::text FROM case_set_stage(%L, %L, ''Closed'') x', l1, u_agent), 'true');
  SELECT x.stage || '/' || coalesce(x.outcome, '-') INTO st FROM cases x WHERE x.id = l1;
  n := n + 1; failed := failed || pg_temp.cs_ok(st = 'Closed/Withdrawn',
    format('the closed lead is %s, not Closed/Withdrawn', st));

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT130', MESSAGE = 'verify-case-leads rollback';
  EXCEPTION WHEN SQLSTATE 'ZT130' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'case leads verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'case leads verification passed (% checks)', n;
END
$verify$;
