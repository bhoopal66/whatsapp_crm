-- Behavioural regression suite for the bank dashboard after case leads
-- (migration 131).
--
-- bank_ws_dashboard splits open cases into pre_submission / with_bank,
-- splits the pipeline into account openings (a count: amount NULL or 0)
-- and financing (amount > 0, summed as an exact decimal string, which
-- amount_in_pipeline repeats), and reports lead conversion (cases whose
-- history reached Interested, of which those that reached the
-- submission stage). Every figure is over the actor's readable cases,
-- so another agent's lead changes nothing for an agent. bank_ws_cases
-- carries the contact, SLA state, next due date and a lead flag, open
-- and most overdue first; bank_ws_summary counts open cases, members by
-- role, open actions and the actor's role, and answers NULL without
-- access.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000131001';
  u_admin  UUID := '00000000-0000-4000-8000-000000131002';
  u_lead   UUID := '00000000-0000-4000-8000-000000131003';  -- leads team T (u_agent, u_agent2)
  u_agent  UUID := '00000000-0000-4000-8000-000000131004';
  u_agent2 UUID := '00000000-0000-4000-8000-000000131005';
  u_coord  UUID := '00000000-0000-4000-8000-000000131006';  -- coordinates d1
  u_agent3 UUID := '00000000-0000-4000-8000-000000131007';  -- no case at the bank
  u_bown   UUID := '00000000-0000-4000-8000-000000131008';  -- owner of account B
  a_acct   UUID;
  b_acct   UUID;
  w1       UUID;
  team1    UUID;
  ct       UUID[] := '{}';
  g        UUID;
  l1       UUID;  -- lead, Interested, amount NULL
  l2       UUID;  -- lead, Data collection, amount 0
  l3       UUID;  -- lead, Withdrawn, amount 250000.50
  l4       UUID;  -- lead attached to a group (Submitted), amount 100000.25
  d1       UUID;  -- direct submission, amount 5000
  l6       UUID;  -- u_agent2's lead
  d2       UUID;  -- direct submission at FAB
  ws       UUID;
  ws_fab   UUID;
  th       UUID;
  tk       UUID;
  ids      UUID[];
  ts       TIMESTAMPTZ;
  r        TEXT;
  j        JSONB;
  j0       JSONB;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- NULL when p_cond is true, else p_name (so `failed := failed || …`
  -- records failures only).
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bd_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'bd-owner@example.invalid'),
    (u_admin,  'bd-admin@example.invalid'),
    (u_lead,   'bd-lead@example.invalid'),
    (u_agent,  'bd-agent@example.invalid'),
    (u_agent2, 'bd-agent2@example.invalid'),
    (u_coord,  'bd-coord@example.invalid'),
    (u_agent3, 'bd-agent3@example.invalid'),
    (u_bown,   'bd-bown@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_bown;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_agent2, u_coord, u_agent3);

  INSERT INTO teams (account_id, name, leader_user_id) VALUES (a_acct, 'BD T', u_lead) RETURNING id INTO team1;
  INSERT INTO team_members (team_id, user_id, account_id) VALUES (team1, u_agent, a_acct), (team1, u_agent2, a_acct);

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'BD-131-A1', 'x', 'connected', true) RETURNING id INTO w1;
  FOR i IN 1..6 LOOP
    INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (a_acct, CASE WHEN i = 6 THEN u_agent2 ELSE u_agent END, '97150013100' || i, 'BD ' || i)
    RETURNING id INTO g;
    ct := ct || g;
  END LOOP;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'ENBD', 'Emirates NBD'), (a_acct, 'FAB', 'FAB')
  ON CONFLICT DO NOTHING;
  ws := bank_ws_create(u_owner, a_acct, 'ENBD', now());
  ws_fab := bank_ws_create(u_owner, a_acct, 'FAB', now());

  l1 := case_open_lead(u_agent, a_acct, ct[1], 'ENBD', 'Current account', u_agent, NULL);
  l2 := case_open_lead(u_agent, a_acct, ct[2], 'ENBD', 'Current account', u_agent, 0);
  SELECT x.moved::text INTO r FROM case_set_stage(l2, u_agent, 'Data collection') x;
  IF r IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture: l2 did not move to Data collection (%)', r; END IF;
  l3 := case_open_lead(u_agent, a_acct, ct[3], 'ENBD', 'Personal loan', u_agent, 250000.50);
  SELECT x.moved::text INTO r FROM case_set_stage(l3, u_agent, 'Withdrawn') x;
  IF r IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture: l3 did not move to Withdrawn (%)', r; END IF;
  l4 := case_open_lead(u_agent, a_acct, ct[4], 'ENBD', 'Mortgage', u_agent, 100000.25);
  g := (SELECT x.group_id FROM sg_open(a_acct, 'BD-131-4', ct[4], w1, 'case 4', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  IF (SELECT x.case_id FROM case_open(g, 'ENBD', NULL, NULL, NULL, NULL) x) IS DISTINCT FROM l4 THEN
    RAISE EXCEPTION 'fixture: case_open did not attach the group to l4';
  END IF;
  g := (SELECT x.group_id FROM sg_open(a_acct, 'BD-131-5', ct[5], w1, 'case 5', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'),
                           jsonb_build_object('user_id', u_coord, 'label', 'coordinator')), NULL) x);
  d1 := (SELECT x.case_id FROM case_open(g, 'ENBD', NULL, 'Mortgage', 5000, NULL) x);
  IF (SELECT x.coordinator_id FROM cases x WHERE x.id = d1) IS DISTINCT FROM u_coord THEN
    RAISE EXCEPTION 'fixture: d1 has no coordinator u_coord';
  END IF;
  g := (SELECT x.group_id FROM sg_open(a_acct, 'BD-131-F', ct[1], w1, 'case F', NULL,
         jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  d2 := (SELECT x.case_id FROM case_open(g, 'FAB', NULL, 'Card', 0, NULL) x);

  -- ---------- 1. the agent's dashboard ----------
  j0 := bank_ws_dashboard(u_agent, ws, now());
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j0 ->> 'pre_submission') = '2' AND (j0 ->> 'with_bank') = '2',
    format('pre_submission / with_bank split is not 2 / 2 (%s / %s)', j0 ->> 'pre_submission', j0 ->> 'with_bank'));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j0 -> 'pipeline' ->> 'accounts') = '2' AND (j0 -> 'pipeline' ->> 'financing_cases') = '2',
    format('pipeline accounts / financing split by amount > 0 is not 2 / 2 (amount NULL and 0 are accounts): %s', j0 -> 'pipeline'));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j0 -> 'pipeline' ->> 'financing_amount') = '105000.25' AND jsonb_typeof(j0 -> 'pipeline' -> 'financing_amount') = 'string',
    format('pipeline.financing_amount is not the string 105000.25 (%s)', j0 -> 'pipeline' -> 'financing_amount'));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j0 -> 'amount_in_pipeline') = (j0 -> 'pipeline' -> 'financing_amount'),
    format('amount_in_pipeline %s is not pipeline.financing_amount', j0 -> 'amount_in_pipeline'));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j0 -> 'conversion') = jsonb_build_object('leads', 4, 'submitted', 1, 'rate', 0.2500),
    format('conversion is not 4 leads (a Withdrawn lead counted, a direct submission not), 1 submitted, rate 0.2500: %s',
           j0 -> 'conversion'));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j0 ->> 'total_cases') = '5' AND (j0 -> 'cases_by_stage' ->> 'Interested') = '1'
      AND (j0 -> 'cases_by_stage' ->> 'Data collection') = '1'
      AND (j0 -> 'avg_days_per_stage') ? 'Interested' AND (j0 -> 'avg_days_per_stage') ? 'Data collection'
      AND NOT (j0 -> 'avg_days_per_stage') ? 'Withdrawn',
    format('cases_by_stage / avg_days_per_stage do not cover the pre-submission stages (finals out): %s / %s',
           j0 -> 'cases_by_stage', j0 -> 'avg_days_per_stage'));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    j0 ?& ARRAY['scope', 'total_cases', 'cases_by_stage', 'avg_days_per_stage', 'approval', 'declined_reasons',
                'withdrawn_reasons', 'overdue_count', 'amount_in_pipeline'],
    format('a 127 dashboard key is missing: %s', (SELECT array_agg(k) FROM jsonb_object_keys(j0) k)));

  -- ---------- 2. another agent's lead ----------
  l6 := case_open_lead(u_agent2, a_acct, ct[6], 'ENBD', 'Card', u_agent2, 999);
  j := bank_ws_dashboard(u_agent, ws, now());
  n := n + 1; failed := failed || pg_temp.bd_ok(j = j0,
    format('another agent''s lead changed the agent''s figures (%s, was %s)', j, j0));
  j := bank_ws_dashboard(u_admin, ws, now());
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j -> 'conversion') = jsonb_build_object('leads', 5, 'submitted', 1, 'rate', 0.2000)
      AND (j ->> 'pre_submission') = '3' AND (j -> 'pipeline' ->> 'financing_amount') = '105999.25',
    format('the admin''s dashboard does not count every agent''s leads: %s', j));

  -- ---------- 3. no leads ----------
  j := bank_ws_dashboard(u_agent, ws_fab, now());
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j -> 'conversion') = jsonb_build_object('leads', 0, 'submitted', 0, 'rate', NULL)
      AND (j ->> 'with_bank') = '1' AND (j -> 'pipeline' ->> 'accounts') = '1',
    format('a bank with only a direct submission is not 0 leads, rate null: %s', j));

  -- ---------- 4. bank_ws_cases ----------
  UPDATE cases SET sla_state = 'overdue' WHERE id = l4;
  UPDATE cases SET sla_state = 'due_soon' WHERE id = d1;
  UPDATE cases SET sla_state = 'on_track' WHERE id IN (l1, l2);
  ids := (SELECT array_agg(x.case_id ORDER BY x.ordinality) FROM bank_ws_cases(ws, u_agent) WITH ORDINALITY x);
  n := n + 1; failed := failed || pg_temp.bd_ok(
    array_length(ids, 1) = 5 AND ids[1] = l4 AND ids[2] = d1 AND ids[5] = l3 AND ids[3:4] @> ARRAY[l1, l2],
    format('bank_ws_cases is not ordered open and most overdue first, closed last: %s (l4 %s, d1 %s, l3 %s)', ids, l4, d1, l3));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    EXISTS (SELECT 1 FROM bank_ws_cases(ws, u_agent) x
             WHERE x.case_id = l1 AND x.is_lead AND x.contact_id = ct[1] AND x.contact_name = 'BD 1'
               AND x.sla_state = 'on_track')
      AND EXISTS (SELECT 1 FROM bank_ws_cases(ws, u_agent) x
                   WHERE x.case_id = d1 AND NOT x.is_lead AND x.sla_state = 'due_soon' AND x.contact_name = 'BD 5'),
    'bank_ws_cases does not carry contact_id / contact_name / sla_state / is_lead');
  ts := (SELECT min(t.due_at) FROM case_sla_timers t WHERE t.case_id = l2 AND t.stopped_at IS NULL);
  n := n + 1; failed := failed || pg_temp.bd_ok(
    ts IS NOT NULL AND (SELECT x.next_due_at FROM bank_ws_cases(ws, u_agent) x WHERE x.case_id = l2) = ts
      AND (SELECT x.next_due_at FROM bank_ws_cases(ws, u_agent) x WHERE x.case_id = l3) IS NULL,
    format('bank_ws_cases.next_due_at is not the earliest running timer (expected %s for l2, NULL for l3)', ts));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    NOT EXISTS (SELECT 1 FROM bank_ws_cases(ws, u_agent3)) AND NOT EXISTS (SELECT 1 FROM bank_ws_cases(ws, u_bown)),
    'bank_ws_cases listed cases to someone with no access');

  -- ---------- 5. bank_ws_summary ----------
  -- Two unlinked actions stay open; a case-linked one whose task is done does not count.
  FOR i IN 1..2 LOOP
    th := bank_ws_thread_create(ws, u_agent, 'BD thread ' || i, 'body', NULL, NULL, now());
    PERFORM bank_ws_action_mark(th, u_agent, u_agent, now() + interval '1 day', now());
  END LOOP;
  th := bank_ws_thread_create(ws, u_agent, 'BD thread 3', 'body', d1, NULL, now());
  PERFORM bank_ws_action_mark(th, u_agent, u_agent, now() + interval '1 day', now());
  tk := (SELECT a.task_id FROM bank_ws_actions a WHERE a.thread_id = th);
  SELECT x.to_status INTO r FROM case_task_set_status(tk, u_agent, 'done', now()) x;
  IF r IS DISTINCT FROM 'done' THEN RAISE EXCEPTION 'fixture: the linked action''s task is not done (%)', r; END IF;

  j := bank_ws_summary(ws, u_owner);
  n := n + 1; failed := failed || pg_temp.bd_ok(
    j = jsonb_build_object('open_cases', 5, 'open_actions', 2, 'my_role', 'admin',
          'members', jsonb_build_object('agents', 2, 'coordinators', 1, 'team_leads', 1, 'total', 4)),
    format('bank_ws_summary for the owner is not 5 open cases, members 2/1/1 of 4, 2 open actions, admin: %s', j));
  j := bank_ws_summary(ws, u_agent);
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j ->> 'my_role') = 'agent' AND (j ->> 'open_cases') = '4' AND (j -> 'members' ->> 'total') = '4',
    format('bank_ws_summary for the agent is not agent with 4 open cases: %s', j));
  j := bank_ws_summary(ws, u_coord);
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j ->> 'my_role') = 'coordinator' AND (j ->> 'open_cases') = '1',
    format('bank_ws_summary for the coordinator is not coordinator with 1 open case: %s', j));
  j := bank_ws_summary(ws, u_lead);
  n := n + 1; failed := failed || pg_temp.bd_ok(
    (j ->> 'my_role') = 'team_lead' AND (j ->> 'open_cases') = '5',
    format('bank_ws_summary for the team lead is not team_lead with 5 open cases: %s', j));
  n := n + 1; failed := failed || pg_temp.bd_ok(
    bank_ws_summary(ws, u_agent3) IS NULL AND bank_ws_summary(ws, u_bown) IS NULL AND bank_ws_summary(ws, NULL) IS NULL
      AND bank_ws_summary(gen_random_uuid(), u_owner) IS NULL,
    'bank_ws_summary answered someone with no access (or an unknown workspace)');
  n := n + 1; failed := failed || pg_temp.bd_ok(
    has_function_privilege('service_role', 'public.bank_ws_summary(uuid, uuid)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.bank_ws_cases(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.bank_ws_summary(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.bank_ws_cases(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.bank_ws_cases(uuid, uuid)', 'EXECUTE'),
    'bank_ws_summary / bank_ws_cases are not service_role only');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT131', MESSAGE = 'verify-bank-dashboard-leads rollback';
  EXCEPTION WHEN SQLSTATE 'ZT131' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'bank dashboard leads verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'bank dashboard leads verification passed (% checks)', n;
END
$verify$;
