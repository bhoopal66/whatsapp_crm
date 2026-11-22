-- Behavioural regression suite for saved views (migration 250).
--
-- RLS is the enforcement point: a personal view is its owner's alone,
-- a shared view is read by the workspace and written only by a team
-- leader or above, an admin may change or delete a shared view, and
-- nothing crosses accounts. ONE statement on purpose (the pinned CLI
-- rejects several); fixtures are rolled back through a sentinel.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000250001';
  u_admin  UUID := '00000000-0000-4000-8000-000000250002';
  u_lead   UUID := '00000000-0000-4000-8000-000000250003';
  u_agent  UUID := '00000000-0000-4000-8000-000000250004';
  u_agent2 UUID := '00000000-0000-4000-8000-000000250005';
  u_view   UUID := '00000000-0000-4000-8000-000000250006';
  u_other  UUID := '00000000-0000-4000-8000-000000250007';
  a_acct   UUID;
  b_acct   UUID;
  v_pers   UUID;
  v_shared UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.sv_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        IF p_sql ILIKE 'select%' THEN
          EXECUTE p_sql INTO v;
        ELSE
          EXECUTE p_sql;
          GET DIAGNOSTICS c = ROW_COUNT;
          v := c::text;
        END IF;
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
    (u_owner,  'sv-owner@example.invalid'),
    (u_admin,  'sv-admin@example.invalid'),
    (u_lead,   'sv-lead@example.invalid'),
    (u_agent,  'sv-agent@example.invalid'),
    (u_agent2, 'sv-agent2@example.invalid'),
    (u_view,   'sv-view@example.invalid'),
    (u_other,  'sv-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin'       WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'team_leader' WHERE user_id = u_lead;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'       WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent'       WHERE user_id = u_agent2;
  UPDATE profiles SET account_id = a_acct, account_role = 'viewer'      WHERE user_id = u_view;

  -- An agent saves a personal view.
  r := pg_temp.sv_try(u_agent, format(
    'INSERT INTO saved_views (account_id, owner_user_id, screen, name, filters) VALUES (%L, %L, %L, %L, %L)',
    a_acct, u_agent, 'contacts', 'My hot leads', '{"search":"x"}'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'an agent could not save a personal view: ' || r); END IF;
  SELECT id INTO v_pers FROM saved_views WHERE owner_user_id = u_agent AND name = 'My hot leads';

  -- A viewer may keep a personal view too.
  r := pg_temp.sv_try(u_view, format(
    'INSERT INTO saved_views (account_id, owner_user_id, screen, name) VALUES (%L, %L, %L, %L)',
    a_acct, u_view, 'inbox', 'Viewer view'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'a viewer could not save a personal view: ' || r); END IF;

  -- Nobody else sees it, not even an admin.
  FOREACH r IN ARRAY ARRAY[u_agent2::text, u_lead::text, u_admin::text, u_owner::text] LOOP
    n := n + 1;
    IF pg_temp.sv_try(r::uuid, format('SELECT count(*) FROM saved_views WHERE id = %L', v_pers)) <> '0' THEN
      failed := array_append(failed, 'a personal view was visible to someone else');
    END IF;
  END LOOP;
  n := n + 1;
  IF pg_temp.sv_try(u_agent, format('SELECT count(*) FROM saved_views WHERE id = %L', v_pers)) <> '1' THEN
    failed := array_append(failed, 'the owner cannot read their own personal view');
  END IF;

  -- Saving as someone else, or as another account, is refused.
  r := pg_temp.sv_try(u_agent, format(
    'INSERT INTO saved_views (account_id, owner_user_id, screen, name) VALUES (%L, %L, %L, %L)',
    a_acct, u_agent2, 'inbox', 'Forged owner'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'an agent saved a view in another person''s name: ' || r); END IF;
  r := pg_temp.sv_try(u_agent, format(
    'INSERT INTO saved_views (account_id, owner_user_id, screen, name) VALUES (%L, %L, %L, %L)',
    b_acct, u_agent, 'inbox', 'Cross account'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'an agent saved a view into another account: ' || r); END IF;

  -- An agent cannot share; a team leader can.
  r := pg_temp.sv_try(u_agent, format(
    'INSERT INTO saved_views (account_id, owner_user_id, screen, name, shared) VALUES (%L, %L, %L, %L, true)',
    a_acct, u_agent, 'inbox', 'Agent shared'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'an agent saved a shared view: ' || r); END IF;
  r := pg_temp.sv_try(u_agent, format('UPDATE saved_views SET shared = true WHERE id = %L', v_pers));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' AND r <> '0' THEN failed := array_append(failed, 'an agent shared their own view: ' || r); END IF;
  r := pg_temp.sv_try(u_lead, format(
    'INSERT INTO saved_views (account_id, owner_user_id, screen, name, shared, filters) VALUES (%L, %L, %L, %L, true, %L)',
    a_acct, u_lead, 'inbox', 'Team: unanswered', '{"unread":true}'));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'a team leader could not save a shared view: ' || r); END IF;
  SELECT id INTO v_shared FROM saved_views WHERE owner_user_id = u_lead AND shared;

  -- The whole workspace reads it; another account does not.
  FOREACH r IN ARRAY ARRAY[u_agent::text, u_agent2::text, u_view::text, u_admin::text] LOOP
    n := n + 1;
    IF pg_temp.sv_try(r::uuid, format('SELECT count(*) FROM saved_views WHERE id = %L', v_shared)) <> '1' THEN
      failed := array_append(failed, 'a shared view was not visible to its workspace');
    END IF;
  END LOOP;
  n := n + 1;
  IF pg_temp.sv_try(u_other, format('SELECT count(*) FROM saved_views WHERE id = %L', v_shared)) <> '0' THEN
    failed := array_append(failed, 'a shared view leaked to another account');
  END IF;

  -- An agent cannot edit or delete it; an admin can.
  r := pg_temp.sv_try(u_agent, format('UPDATE saved_views SET name = %L WHERE id = %L', 'hijack', v_shared));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'an agent edited a shared view: ' || r); END IF;
  r := pg_temp.sv_try(u_agent, format('DELETE FROM saved_views WHERE id = %L', v_shared));
  n := n + 1;
  IF r <> '0' THEN failed := array_append(failed, 'an agent deleted a shared view: ' || r); END IF;
  r := pg_temp.sv_try(u_admin, format('UPDATE saved_views SET name = %L WHERE id = %L', 'Team: renamed', v_shared));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'an admin could not edit a shared view: ' || r); END IF;

  -- Identity is frozen even for the owner.
  r := pg_temp.sv_try(u_agent, format('UPDATE saved_views SET screen = %L WHERE id = %L', 'inbox', v_pers));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'a view changed screen: ' || r); END IF;

  -- Bad shapes are refused.
  r := pg_temp.sv_try(u_agent, format(
    'INSERT INTO saved_views (account_id, owner_user_id, screen, name) VALUES (%L, %L, %L, %L)',
    a_acct, u_agent, 'contacts', E' \t\n'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'a blank name was accepted: ' || r); END IF;
  r := pg_temp.sv_try(u_agent, format(
    'INSERT INTO saved_views (account_id, owner_user_id, screen, name, filters) VALUES (%L, %L, %L, %L, %L)',
    a_acct, u_agent, 'contacts', 'Array filters', '[1]'));
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'non-object filters were accepted: ' || r); END IF;

  -- The owner deletes their own.
  r := pg_temp.sv_try(u_agent, format('DELETE FROM saved_views WHERE id = %L', v_pers));
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'an owner could not delete their view: ' || r); END IF;

  n := n + 1;
  IF has_table_privilege('anon', 'public.saved_views', 'SELECT') THEN
    failed := array_append(failed, 'anon can read saved views');
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT250', MESSAGE = 'verify-saved-views rollback';
  EXCEPTION WHEN SQLSTATE 'ZT250' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'saved views verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'saved views verification passed (% checks)', n;
END
$verify$;
