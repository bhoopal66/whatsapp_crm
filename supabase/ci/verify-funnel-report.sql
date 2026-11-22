-- Behavioural regression suite for the funnel report (migration 254).
--
-- Owners and admins only, in their ACTIVE account; the stages are a
-- cohort of company chats started in the period; filters narrow it;
-- nothing crosses accounts. ONE statement on purpose (the pinned CLI
-- rejects several); fixtures are rolled back through a sentinel.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000254001';
  u_admin  UUID := '00000000-0000-4000-8000-000000254002';
  u_lead   UUID := '00000000-0000-4000-8000-000000254003';
  u_agent  UUID := '00000000-0000-4000-8000-000000254004';
  u_other  UUID := '00000000-0000-4000-8000-000000254005';
  a_acct   UUID;
  b_acct   UUID;
  tag_int  UUID;
  c1 UUID; c2 UUID; c3 UUID; c4 UUID; c5 UUID; c6 UUID; c9 UUID;
  k3 UUID;
  r        TEXT;
  j        JSONB;
  n        INT := 0;
  failed   TEXT[] := '{}';
  v_from   TEXT := (now() - interval '7 days')::text;
  v_to     TEXT := (now() + interval '1 minute')::text;
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.fr_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR: ' || SQLERRM;
      END;
    END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'fr254-owner@example.invalid'),
    (u_admin, 'fr254-admin@example.invalid'),
    (u_lead,  'fr254-lead@example.invalid'),
    (u_agent, 'fr254-agent@example.invalid'),
    (u_other, 'fr254-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  SELECT account_id INTO b_acct FROM profiles WHERE user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin'       WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'       WHERE user_id = u_agent;

  INSERT INTO chat_tags (account_id, name) VALUES (a_acct, 'Interested') RETURNING id INTO tag_int;
  INSERT INTO case_banks (account_id, code, name) VALUES (a_acct, 'FR254A', 'Bank A'), (a_acct, 'FR254B', 'Bank B')
    ON CONFLICT DO NOTHING;

  INSERT INTO contacts (account_id, user_id, phone, name, lead_source) VALUES (a_acct, u_agent, '971500254001', 'FR one', 'ad')        RETURNING id INTO c1;
  INSERT INTO contacts (account_id, user_id, phone, name, lead_source) VALUES (a_acct, u_agent, '971500254002', 'FR two', 'ad')        RETURNING id INTO c2;
  INSERT INTO contacts (account_id, user_id, phone, name, lead_source) VALUES (a_acct, u_agent, '971500254003', 'FR three', 'web_form') RETURNING id INTO c3;
  INSERT INTO contacts (account_id, user_id, phone, name)              VALUES (a_acct, u_agent, '971500254004', 'FR four')             RETURNING id INTO c4;
  INSERT INTO contacts (account_id, user_id, phone, name)              VALUES (a_acct, u_agent, '971500254005', 'FR old')              RETURNING id INTO c5;
  INSERT INTO contacts (account_id, user_id, phone, name)              VALUES (a_acct, u_agent, '971500254006', 'FR withdrawn')        RETURNING id INTO c6;
  INSERT INTO contacts (account_id, user_id, phone, name)              VALUES (b_acct, u_other, '971500254009', 'FR other')            RETURNING id INTO c9;

  -- Five chats in the period, one long before it, one in another account.
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id, created_at)
  VALUES (a_acct, u_agent, c1, u_agent, now() - interval '2 days'),
         (a_acct, u_agent, c2, u_agent, now() - interval '2 days'),
         (a_acct, u_agent, c3, NULL,    now() - interval '3 days'),
         (a_acct, u_agent, c4, NULL,    now() - interval '1 day'),
         (a_acct, u_agent, c5, u_agent, now() - interval '60 days'),
         (a_acct, u_agent, c6, u_agent, now() - interval '1 day'),
         (b_acct, u_other, c9, NULL,    now() - interval '1 day');

  -- c1 tagged Interested only; c2 has a lead (Interested); c3 a lead
  -- that went on to a submitted stage, then Approved (Closed);
  -- c5 (outside the period) has a case; c6 a withdrawn lead.
  UPDATE conversations SET chat_tag_id = tag_int WHERE contact_id = c1;
  INSERT INTO cases (account_id, agent_id, contact_id, bank_code, stage)
  VALUES (a_acct, u_agent, c2, 'FR254A', 'Interested');
  INSERT INTO cases (account_id, agent_id, contact_id, bank_code, stage, outcome, closed_at)
  VALUES (a_acct, u_agent, c3, 'FR254B', 'Closed', 'Approved', now()) RETURNING id INTO k3;
  INSERT INTO cases (account_id, agent_id, contact_id, bank_code, stage)
  VALUES (a_acct, u_agent, c5, 'FR254A', 'Interested');
  INSERT INTO cases (account_id, agent_id, contact_id, bank_code, stage, outcome, closed_at)
  VALUES (a_acct, u_agent, c6, 'FR254A', 'Withdrawn', 'Withdrawn', now());

  -- Who may run it.
  FOREACH r IN ARRAY ARRAY[u_lead::text, u_agent::text] LOOP
    n := n + 1;
    IF pg_temp.fr_try(r::uuid, format('SELECT funnel_report(%L, %L, %L)::text', v_from, v_to, 'Asia/Dubai')) NOT LIKE 'ERROR:%' THEN
      failed := array_append(failed, 'a team leader or agent ran the funnel report');
    END IF;
  END LOOP;
  n := n + 1;
  r := pg_temp.fr_try(u_admin, format('SELECT funnel_report(%L, %L, %L)::text', v_from, v_to, 'Asia/Dubai'));
  IF r LIKE 'ERROR:%' THEN failed := array_append(failed, 'an admin could not run the funnel report: ' || r); END IF;

  r := pg_temp.fr_try(u_owner, format('SELECT funnel_report(%L, %L, %L)::text', v_from, v_to, 'Asia/Dubai'));
  n := n + 1;
  IF r LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'the owner could not run the funnel report: ' || r);
  ELSE
    j := r::jsonb;
    n := n + 1;
    IF (j->'totals'->>'new_chats')::int <> 5 THEN failed := array_append(failed, 'new_chats is not 5: ' || (j->'totals')::text); END IF;
    n := n + 1;
    IF (j->'totals'->>'interested')::int <> 4 THEN failed := array_append(failed, 'interested is not 4: ' || (j->'totals')::text); END IF;
    n := n + 1;
    IF (j->'totals'->>'case_opened')::int <> 3 THEN failed := array_append(failed, 'case_opened is not 3: ' || (j->'totals')::text); END IF;
    n := n + 1;
    IF (j->'totals'->>'submitted')::int <> 1 THEN failed := array_append(failed, 'submitted is not 1: ' || (j->'totals')::text); END IF;
    n := n + 1;
    IF (j->'totals'->>'approved')::int <> 1 THEN failed := array_append(failed, 'approved is not 1'); END IF;
    n := n + 1;
    IF (j->'totals'->>'withdrawn')::int <> 1 THEN failed := array_append(failed, 'withdrawn is not 1'); END IF;
    n := n + 1;
    IF (j->>'interested_tag_id')::uuid IS DISTINCT FROM tag_int THEN failed := array_append(failed, 'the Interested tag was not found'); END IF;
    n := n + 1;
    IF jsonb_array_length(j->'options'->'banks') <> 2 THEN failed := array_append(failed, 'bank options are not this account''s two'); END IF;
  END IF;

  -- Filters.
  r := pg_temp.fr_try(u_owner, format('SELECT (funnel_report(%L, %L, %L, %L)->''totals''->>''new_chats'')', v_from, v_to, 'UTC', 'ad'));
  n := n + 1;
  IF r <> '2' THEN failed := array_append(failed, 'lead source filter did not give 2: ' || r); END IF;
  r := pg_temp.fr_try(u_owner, format('SELECT (funnel_report(%L, %L, %L, %L)->''totals''->>''new_chats'')', v_from, v_to, 'UTC', 'none'));
  n := n + 1;
  IF r <> '2' THEN failed := array_append(failed, 'lead source none did not give 2: ' || r); END IF;
  r := pg_temp.fr_try(u_owner, format('SELECT (funnel_report(%L, %L, %L, NULL, %L)->''totals''->>''new_chats'')', v_from, v_to, 'UTC', u_agent));
  n := n + 1;
  IF r <> '3' THEN failed := array_append(failed, 'agent filter did not give 3: ' || r); END IF;
  r := pg_temp.fr_try(u_owner, format('SELECT (funnel_report(%L, %L, %L, NULL, NULL, %L)->''totals''->>''case_opened'')', v_from, v_to, 'UTC', 'FR254B'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'bank filter did not give 1 case: ' || r); END IF;
  r := pg_temp.fr_try(u_owner, format('SELECT (funnel_report(%L, %L, %L, NULL, NULL, %L)->''totals''->>''interested'')', v_from, v_to, 'UTC', 'FR254B'));
  n := n + 1;
  IF r <> '4' THEN failed := array_append(failed, 'the bank filter changed Interested: ' || r); END IF;
  r := pg_temp.fr_try(u_owner, format('SELECT funnel_report(%L, %L, %L, %L)::text', v_from, v_to, 'UTC', 'bogus'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'an unknown lead source was accepted'); END IF;
  r := pg_temp.fr_try(u_owner, format('SELECT funnel_report(%L, %L)::text', v_to, v_from));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'a reversed period was accepted'); END IF;

  -- Another account's owner sees none of A.
  r := pg_temp.fr_try(u_other, format('SELECT (funnel_report(%L, %L)->''totals''->>''new_chats'')', v_from, v_to));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'another account''s owner did not see exactly their own chat: ' || r); END IF;

  n := n + 1;
  IF has_function_privilege('anon', 'public.funnel_report(timestamptz, timestamptz, text, text, uuid, text, uuid)', 'EXECUTE') THEN
    failed := array_append(failed, 'anon can run the funnel report');
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT254', MESSAGE = 'verify-funnel-report rollback';
  EXCEPTION WHEN SQLSTATE 'ZT254' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'funnel report verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'funnel report verification passed (% checks)', n;
END
$verify$;
