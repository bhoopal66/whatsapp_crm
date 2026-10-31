-- Behavioural regression suite for bank coordinators in submission
-- groups (migration 163).
--
-- On an ACTIVE group, a live agent / team_leader holding the bank of
-- the group's case (coordinator_banks, case_holds_bank) counts as if
-- they had an open access row labelled 'coordinator': sg_can_read,
-- sg_read_role, sg_resolve_role, sg_can_send and sg_visible_ids (the
-- RLS policies). A real open row keeps its own label. ENDED groups are
-- unchanged: the archive stays with the people on the list at the end.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The fixtures are
-- rolled back by a sentinel exception; the results survive in plpgsql
-- variables.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000163001';
  u_agent  UUID := '00000000-0000-4000-8000-000000163002';
  u_holder UUID := '00000000-0000-4000-8000-000000163003';
  u_both   UUID := '00000000-0000-4000-8000-000000163004';
  u_viewer UUID := '00000000-0000-4000-8000-000000163005';
  u_gone   UUID := '00000000-0000-4000-8000-000000163006';
  a_acct   UUID;
  w1       UUID;
  c1       UUID;
  gb       UUID;
  gc       UUID;
  ge       UUID;
  kb       UUID;
  acc      JSONB;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a SELECT as p_role (NULL: as the current user) signed in as
  -- p_uid: its value, or 'ERROR <sqlstate>: <message>'.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.bs_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        IF p_role IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', p_role)::text, true);
          EXECUTE format('SET LOCAL ROLE %I', p_role);
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'NULL');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- ---------- fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner,  'bs-owner@example.invalid'),
    (u_agent,  'bs-agent@example.invalid'),
    (u_holder, 'bs-holder@example.invalid'),
    (u_both,   'bs-both@example.invalid'),
    (u_viewer, 'bs-viewer@example.invalid'),
    (u_gone,   'bs-gone@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id IN (u_agent, u_holder, u_both, u_gone);
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer' WHERE user_id = u_viewer;
  INSERT INTO whatsapp_config (user_id, account_id, provider, phone_number_id, access_token, status, is_primary)
  VALUES (u_owner, a_acct, 'whapi', 'BS-163-A1', 'x', 'connected', true) RETURNING id INTO w1;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a_acct, u_owner, '971500163001', 'BS one')
    RETURNING id INTO c1;

  -- gb: case of bank BSB (u_agent the agent, u_both on the list as
  -- 'agent'); gc: case of bank BSC; ge: case of bank BSB, ended later.
  acc := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'),
                           jsonb_build_object('user_id', u_both, 'label', 'agent'));
  gb := (SELECT x.group_id FROM sg_open(a_acct, 'BS-163-B', c1, NULL, 'b', NULL, acc, NULL, 'none') x);
  gc := (SELECT x.group_id FROM sg_open(a_acct, 'BS-163-C', c1, NULL, 'c', NULL, acc, NULL, 'none') x);
  ge := (SELECT x.group_id FROM sg_open(a_acct, 'BS-163-E', c1, NULL, 'e', NULL, acc, NULL, 'none') x);
  IF gb IS NULL OR gc IS NULL OR ge IS NULL THEN
    RAISE EXCEPTION 'fixture: sg_open returned no group';
  END IF;
  kb := (SELECT x.case_id FROM case_open(gb, 'BSB', 'Bank B', NULL, NULL, NULL) x);
  PERFORM case_open(gc, 'BSC', 'Bank C', NULL, NULL, NULL);
  PERFORM case_open(ge, 'BSB', 'Bank B', NULL, NULL, NULL);
  IF kb IS NULL OR (SELECT count(*) FROM cases WHERE group_id IN (gb, gc, ge)) <> 3 THEN
    RAISE EXCEPTION 'fixture: case_open did not open three cases';
  END IF;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES
    (a_acct, u_holder, 'BSB'), (a_acct, u_both, 'BSB'),
    (a_acct, u_viewer, 'BSB'), (a_acct, u_gone, 'BSB');
  UPDATE profiles SET deactivated_at = now() WHERE user_id = u_gone;

  -- ---------- (a) a holder not on the list, ACTIVE group of the bank ----------
  n := n + 1;
  IF EXISTS (SELECT 1 FROM submission_group_access WHERE group_id = gb AND user_id = u_holder) THEN
    failed := failed || 'fixture: the holder is on gb''s access list'::text;
  END IF;
  n := n + 1;
  IF NOT sg_can_read(gb, u_holder) THEN
    failed := failed || 'a bank holder cannot read an ACTIVE group of the bank'::text;
  END IF;
  n := n + 1;
  IF NOT sg_can_send(gb, u_holder) THEN
    failed := failed || 'a bank holder cannot send in an ACTIVE group of the bank'::text;
  END IF;
  n := n + 1;
  IF sg_read_role(gb, u_holder, NULL, 60) IS DISTINCT FROM 'coordinator' THEN
    failed := failed || format('sg_read_role of a bank holder is %s, not coordinator',
                               coalesce(sg_read_role(gb, u_holder, NULL, 60), 'NULL'));
  END IF;
  n := n + 1;
  IF sg_resolve_role(gb, u_holder) IS DISTINCT FROM 'coordinator' THEN
    failed := failed || format('sg_resolve_role of a bank holder is %s, not coordinator',
                               coalesce(sg_resolve_role(gb, u_holder), 'NULL'));
  END IF;
  n := n + 1;
  r := pg_temp.bs_try('authenticated', u_holder,
    format('SELECT (%L::uuid IN (SELECT sg_visible_ids()))::text', gb));
  IF r IS DISTINCT FROM 'true' THEN
    failed := failed || format('gb is not in the bank holder''s sg_visible_ids (%s)', r);
  END IF;
  n := n + 1;
  r := pg_temp.bs_try('authenticated', u_holder,
    format('SELECT count(*)::text FROM submission_groups WHERE id = %L', gb));
  IF r IS DISTINCT FROM '1' THEN
    failed := failed || format('the bank holder cannot SELECT gb through RLS (%s)', r);
  END IF;

  -- ---------- (b) a group of another bank ----------
  n := n + 1;
  IF sg_can_read(gc, u_holder) OR sg_can_send(gc, u_holder)
     OR sg_read_role(gc, u_holder, NULL, 60) IS NOT NULL OR sg_resolve_role(gc, u_holder) IS NOT NULL THEN
    failed := failed || 'a bank holder reached a group of another bank'::text;
  END IF;
  n := n + 1;
  r := pg_temp.bs_try('authenticated', u_holder,
    format('SELECT (%L::uuid IN (SELECT sg_visible_ids()))::text', gc));
  IF r IS DISTINCT FROM 'false' THEN
    failed := failed || format('a group of another bank is in the holder''s sg_visible_ids (%s)', r);
  END IF;

  -- ---------- (d) a viewer or deactivated holder ----------
  n := n + 1;
  IF sg_can_read(gb, u_viewer) OR sg_can_send(gb, u_viewer) OR sg_resolve_role(gb, u_viewer) IS NOT NULL THEN
    failed := failed || 'a viewer holding the bank reached its group'::text;
  END IF;
  n := n + 1;
  IF sg_can_read(gb, u_gone) OR sg_can_send(gb, u_gone) OR sg_resolve_role(gb, u_gone) IS NOT NULL THEN
    failed := failed || 'a deactivated holder of the bank reached its group'::text;
  END IF;
  n := n + 1;
  r := pg_temp.bs_try('authenticated', u_viewer,
    format('SELECT (%L::uuid IN (SELECT sg_visible_ids()))::text', gb));
  IF r IS DISTINCT FROM 'false' THEN
    failed := failed || format('gb is in a viewer holder''s sg_visible_ids (%s)', r);
  END IF;

  -- ---------- (f) a real open row keeps its label ----------
  n := n + 1;
  IF sg_read_role(gb, u_both, NULL, 60) IS DISTINCT FROM 'agent'
     OR sg_resolve_role(gb, u_both) IS DISTINCT FROM 'agent' THEN
    failed := failed || format('an agent on the list who holds the bank is %s / %s, not agent',
                               coalesce(sg_read_role(gb, u_both, NULL, 60), 'NULL'),
                               coalesce(sg_resolve_role(gb, u_both), 'NULL'));
  END IF;

  -- ---------- (e) ENDED is unchanged ----------
  n := n + 1;
  IF NOT sg_can_read(ge, u_holder) THEN
    failed := failed || 'fixture: the holder cannot read ge while ACTIVE'::text;
  END IF;
  PERFORM sg_end(ge, 'done');
  n := n + 1;
  IF (SELECT status FROM submission_groups WHERE id = ge) IS DISTINCT FROM 'ENDED' THEN
    failed := failed || 'fixture: sg_end did not end ge'::text;
  END IF;
  n := n + 1;
  IF sg_can_read(ge, u_holder) OR sg_can_send(ge, u_holder)
     OR sg_resolve_role(ge, u_holder) IS NOT NULL THEN
    failed := failed || 'a bank holder not on the list reads or sends in an ENDED group'::text;
  END IF;
  n := n + 1;
  r := pg_temp.bs_try(NULL, NULL, format(
    'SELECT (sg_read_archive(%L, %L)->>''allowed'')', ge, u_holder));
  IF r IS DISTINCT FROM 'false' THEN
    failed := failed || format('the archive opened to a bank holder not on the list (%s)', r);
  END IF;
  -- Agents have no archive window (115), so the person on the list at
  -- the end is a coordinator of a second ended group of the same bank.
  acc := jsonb_build_array(jsonb_build_object('user_id', u_agent, 'label', 'agent'),
                           jsonb_build_object('user_id', u_both, 'label', 'coordinator'));
  ge := (SELECT x.group_id FROM sg_open(a_acct, 'BS-163-F', c1, NULL, 'f', NULL, acc, NULL, 'none') x);
  PERFORM case_open(ge, 'BSB', 'Bank B', NULL, NULL, NULL);
  PERFORM sg_end(ge, 'done');
  n := n + 1;
  IF NOT sg_can_read(ge, u_both) THEN
    failed := failed || 'a coordinator on the list at the end lost the ENDED group'::text;
  END IF;
  n := n + 1;
  IF sg_can_read(ge, u_holder) THEN
    failed := failed || 'a bank holder not on the list reads the second ENDED group'::text;
  END IF;

  -- ---------- (c) taking the bank away ----------
  DELETE FROM coordinator_banks WHERE account_id = a_acct AND user_id = u_holder;
  n := n + 1;
  IF sg_can_read(gb, u_holder) OR sg_can_send(gb, u_holder) OR sg_resolve_role(gb, u_holder) IS NOT NULL THEN
    failed := failed || 'the group stayed open to a holder whose bank was removed'::text;
  END IF;
  n := n + 1;
  r := pg_temp.bs_try('authenticated', u_holder,
    format('SELECT (%L::uuid IN (SELECT sg_visible_ids()))::text', gb));
  IF r IS DISTINCT FROM 'false' THEN
    failed := failed || format('gb stayed in sg_visible_ids after the bank was removed (%s)', r);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT163', MESSAGE = 'verify-bank-coordinator-submissions rollback';
  EXCEPTION WHEN SQLSTATE 'ZT163' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'bank coordinator submissions verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'bank coordinator submissions verification passed (% checks)', n;
END
$verify$;
