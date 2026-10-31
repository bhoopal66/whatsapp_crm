-- Behavioural regression suite for bank coordinators on cases
-- (migrations 161 and 162).
--
-- Holding a bank (coordinator_banks, 133) makes a live agent / team
-- leader a coordinator of every case of that bank: case_role answers
-- 'coordinator' (161) and the case lists and bank spaces show the case
-- (162), with no named role on it. A case of a bank not held stays
-- hidden. The access ends when the bank is taken away and for a
-- deactivated holder, and a viewer holding a bank gets nothing. A
-- holder is a 'member' of that bank's space even with no open case
-- there, and the space is listed to them. The named agent keeps the
-- 'agent' role (precedence unchanged).
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.
-- A writing function's result is assigned first and its effect read in
-- a later statement (a subquery in the same expression would read the
-- snapshot taken before the call).

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000162001';
  u_hold   UUID := '00000000-0000-4000-8000-000000162002';  -- agent; holds ADCB and FAB
  u_agent  UUID := '00000000-0000-4000-8000-000000162003';  -- agent; the named agent of both cases
  u_view   UUID := '00000000-0000-4000-8000-000000162004';  -- viewer with a (stale) ADCB row
  a_acct   UUID;
  wa       UUID;
  ca       UUID;
  g1       UUID;
  g2       UUID;
  k_adcb   UUID;  -- a case of a bank u_hold holds
  k_enbd   UUID;  -- a case of a bank u_hold does not hold
  ws_adcb  UUID;
  ws_fab   UUID;  -- FAB has no case at all
  t0       TIMESTAMPTZ := now();
  v        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bc_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'ci-bc-owner@example.invalid'),
    (u_hold,  'ci-bc-hold@example.invalid'),
    (u_agent, 'ci-bc-agent@example.invalid'),
    (u_view,  'ci-bc-view@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_hold, u_agent);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_view;

  PERFORM case_bank_upsert(u_owner, a_acct, 'ADCB', 'ADCB Bank');
  PERFORM case_bank_upsert(u_owner, a_acct, 'ENBD', 'Emirates NBD');
  PERFORM case_bank_upsert(u_owner, a_acct, 'FAB', 'First Abu Dhabi Bank');

  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'CT-162-A1', 'x', 'connected', true) RETURNING id INTO wa;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500162001', 'CI bank coord')
    RETURNING id INTO ca;

  g1 := (SELECT x.group_id FROM sg_open(a_acct, 'CT-162-1', ca, wa, 'bank coord 1', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  g2 := (SELECT x.group_id FROM sg_open(a_acct, 'CT-162-2', ca, wa, 'bank coord 2', NULL,
    jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent')), NULL) x);
  IF g1 IS NULL OR g2 IS NULL THEN RAISE EXCEPTION 'fixture: sg_open returned no group'; END IF;
  k_adcb := (SELECT x.case_id FROM case_open(g1, 'ADCB', NULL, 'Loan', 1000, NULL) x);
  k_enbd := (SELECT x.case_id FROM case_open(g2, 'ENBD', NULL, 'Loan', 2000, NULL) x);
  IF k_adcb IS NULL OR k_enbd IS NULL THEN RAISE EXCEPTION 'fixture: case_open returned no case'; END IF;
  ws_adcb := bank_ws_create(u_owner, a_acct, 'ADCB', t0);
  ws_fab := bank_ws_create(u_owner, a_acct, 'FAB', t0);
  IF ws_adcb IS NULL OR ws_fab IS NULL THEN RAISE EXCEPTION 'fixture: bank_ws_create returned no space'; END IF;

  -- The holder is named on nothing.
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM cases c WHERE c.id IN (k_adcb, k_enbd)
        AND (c.agent_id = u_hold OR c.coordinator_id IS NOT DISTINCT FROM u_hold)) = 0
    AND (SELECT c.agent_id FROM cases c WHERE c.id = k_adcb) = u_agent,
    'fixture: the holder is named on a case, or the agent is not');

  -- Before holding anything: no role, no list entry, no space.
  n := n + 1; failed := failed || pg_temp.bc_ok(case_role(k_adcb, u_hold) IS NULL,
    'a non-holder has a role on the ADCB case');
  n := n + 1; failed := failed || pg_temp.bc_ok(bank_ws_access(ws_fab, u_hold) IS NULL,
    'a non-holder is a member of the FAB space');

  INSERT INTO coordinator_banks (account_id, user_id, bank_code, created_by)
  VALUES (a_acct, u_hold, 'ADCB', u_owner), (a_acct, u_hold, 'FAB', u_owner), (a_acct, u_view, 'ADCB', u_owner);

  -- (a) holding ADCB: coordinator of the ADCB case, and it is listed.
  v := case_role(k_adcb, u_hold);
  n := n + 1; failed := failed || pg_temp.bc_ok(v = 'coordinator',
    format('the ADCB holder''s role on the ADCB case is %s, not coordinator', coalesce(v, 'NULL')));
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM case_inbox(u_hold, a_acct, '{}'::jsonb, t0, 200) x WHERE x.case_id = k_adcb) = 1,
    'case_inbox does not list the ADCB case to the ADCB holder');
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM bank_ws_cases(ws_adcb, u_hold) x WHERE x.case_id = k_adcb) = 1,
    'bank_ws_cases does not list the ADCB case to the ADCB holder');
  BEGIN
    v := bank_ws_dashboard(u_hold, ws_adcb, t0) ->> 'scope';
  EXCEPTION WHEN OTHERS THEN
    v := 'ERROR ' || SQLERRM;
  END;
  n := n + 1; failed := failed || pg_temp.bc_ok(v = 'own',
    format('bank_ws_dashboard for the ADCB holder: %s', coalesce(v, 'NULL')));

  -- (b) ENBD is not held: no role, not listed.
  n := n + 1; failed := failed || pg_temp.bc_ok(case_role(k_enbd, u_hold) IS NULL,
    'the ADCB holder has a role on the ENBD case');
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM case_inbox(u_hold, a_acct, '{}'::jsonb, t0, 200) x WHERE x.case_id = k_enbd) = 0,
    'case_inbox lists the ENBD case to the ADCB holder');

  -- (f) a member of the FAB space with no case there, and it is listed.
  v := bank_ws_access(ws_fab, u_hold);
  n := n + 1; failed := failed || pg_temp.bc_ok(v = 'member',
    format('the FAB holder''s access to the FAB space is %s, not member', coalesce(v, 'NULL')));
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM bank_ws_list(u_hold, a_acct) x WHERE x.bank_ws_id = ws_fab AND x.access = 'member') = 1,
    'bank_ws_list does not list the FAB space to the FAB holder');
  v := bank_ws_summary(ws_fab, u_hold) ->> 'my_role';
  n := n + 1; failed := failed || pg_temp.bc_ok(v = 'coordinator',
    format('the FAB holder''s summary role is %s, not coordinator', coalesce(v, 'NULL')));
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (bank_ws_summary(ws_fab, u_hold) -> 'members' ->> 'coordinators')::int >= 1,
    'bank_ws_summary does not count the FAB holder among its coordinators');

  -- (g) the named agent keeps 'agent'.
  v := case_role(k_adcb, u_agent);
  n := n + 1; failed := failed || pg_temp.bc_ok(v = 'agent',
    format('the named agent''s role is %s, not agent', coalesce(v, 'NULL')));

  -- (e) a viewer with an ADCB row gets nothing.
  n := n + 1; failed := failed || pg_temp.bc_ok(case_role(k_adcb, u_view) IS NULL,
    'a viewer holding ADCB has a role on the ADCB case');
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM case_inbox(u_view, a_acct, '{}'::jsonb, t0, 200) x) = 0,
    'case_inbox lists cases to a viewer holding ADCB');
  n := n + 1; failed := failed || pg_temp.bc_ok(bank_ws_access(ws_adcb, u_view) IS NULL,
    'a viewer holding ADCB is a member of the ADCB space');

  -- (c) taking ADCB away ends it at once.
  DELETE FROM coordinator_banks WHERE account_id = a_acct AND user_id = u_hold AND bank_code = 'ADCB';
  n := n + 1; failed := failed || pg_temp.bc_ok(case_role(k_adcb, u_hold) IS NULL,
    'the ADCB case''s role outlived the removed bank');
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM case_inbox(u_hold, a_acct, '{}'::jsonb, t0, 200) x WHERE x.case_id = k_adcb) = 0,
    'case_inbox still lists the ADCB case after the bank was removed');

  -- (d) a deactivated holder gets nothing.
  INSERT INTO coordinator_banks (account_id, user_id, bank_code, created_by) VALUES (a_acct, u_hold, 'ADCB', u_owner);
  n := n + 1; failed := failed || pg_temp.bc_ok(case_role(k_adcb, u_hold) = 'coordinator',
    'giving ADCB back did not restore the coordinator role');
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_hold AND account_id = a_acct;
  n := n + 1; failed := failed || pg_temp.bc_ok(case_role(k_adcb, u_hold) IS NULL,
    'a deactivated holder has a role on the ADCB case');
  n := n + 1; failed := failed || pg_temp.bc_ok(
    (SELECT count(*) FROM case_inbox(u_hold, a_acct, '{}'::jsonb, t0, 200) x) = 0,
    'case_inbox lists cases to a deactivated holder');
  n := n + 1; failed := failed || pg_temp.bc_ok(bank_ws_access(ws_fab, u_hold) IS NULL,
    'a deactivated holder is a member of the FAB space');

  -- Undo every fixture; `failed` and `n` survive the rollback.
  RAISE EXCEPTION USING ERRCODE = 'ZT162', MESSAGE = 'verify-bank-coordinator-cases rollback';
  EXCEPTION WHEN SQLSTATE 'ZT162' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'bank coordinator cases verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'bank coordinator cases verification passed (% checks)', n;
END
$verify$;
