-- Behavioural regression suite for the compose check log (migration
-- 149): an admin reads their own account's compose_check_events rows
-- only, an agent reads nothing, clients cannot insert or update, the
-- service role can; the warnings CHECK refuses an unknown code and an
-- empty array; the conversation FK is same-account and deleting the
-- chat nulls conversation_id while the row stays.
--
-- ONE statement on purpose (the pinned CLI rejects several). Failing
-- assertions are named in the final exception; fixtures are undone by
-- a sentinel exception while the collected results survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000149001';
  u_admin UUID := '00000000-0000-4000-8000-000000149002';
  u_agent UUID := '00000000-0000-4000-8000-000000149003';
  u_other UUID := '00000000-0000-4000-8000-000000149004';
  a_acct  UUID;
  b_acct  UUID;
  ct      UUID;
  cv_a    UUID;
  cv_b    UUID;
  ev_a    UUID;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  -- Run a statement as p_role (a signed-in user when p_uid is given):
  -- the value of a SELECT, the row count of anything else, or the error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cc_try(p_role text, p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', p_uid, 'role', p_role)::text, true);
        EXECUTE format('SET LOCAL ROLE %I', p_role);
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
        RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
      END;
    END $body$
  $fn$;

  -- As the table owner: 'ok' or the SQLSTATE + error.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cc_do(p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    BEGIN
      EXECUTE p_sql;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERROR ' || SQLSTATE || ': ' || SQLERRM;
    END $body$
  $fn$;

  -- Fixture: account A (owner, admin, agent), account B (owner), one
  -- chat in each, one logged warning in each.
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cc-owner@example.invalid'),
    (u_admin, 'cc-admin@example.invalid'),
    (u_agent, 'cc-agent@example.invalid'),
    (u_other, 'cc-other@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  IF a_acct IS NULL OR b_acct IS NULL OR a_acct = b_acct THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision separate accounts';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_agent, '971500149001', 'CC contact A') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (a_acct, u_agent, ct) RETURNING id INTO cv_a;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (b_acct, u_other, '971500149002', 'CC contact B') RETURNING id INTO ct;
  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (b_acct, u_other, ct) RETURNING id INTO cv_b;

  INSERT INTO compose_check_events (account_id, user_id, conversation_id, warnings)
  VALUES (a_acct, u_agent, cv_a, ARRAY['promise', 'tone']) RETURNING id INTO ev_a;
  INSERT INTO compose_check_events (account_id, user_id, conversation_id, warnings)
  VALUES (b_acct, u_other, cv_b, ARRAY['secrets']);

  -- ---------- 1. who reads ----------
  r := pg_temp.cc_try('authenticated', u_admin, 'SELECT count(*) FROM compose_check_events');
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('an admin should read exactly their account''s 1 row, read: ' || r)::text);
  END IF;
  r := pg_temp.cc_try('authenticated', u_admin, format(
         'SELECT count(*) FROM compose_check_events WHERE account_id = %L', b_acct));
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('an admin read another account''s rows: ' || r)::text);
  END IF;
  r := pg_temp.cc_try('authenticated', u_agent, 'SELECT count(*) FROM compose_check_events');
  n := n + 1;
  IF r <> '0' THEN
    failed := array_append(failed, ('an agent read compose check rows: ' || r)::text);
  END IF;

  -- ---------- 2. no client writes ----------
  r := pg_temp.cc_try('authenticated', u_admin, format(
         'INSERT INTO compose_check_events (account_id, user_id, warnings) VALUES (%L, %L, ARRAY[''tone''])',
         a_acct, u_admin));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin inserted a compose check row (want 42501): ' || r)::text);
  END IF;
  r := pg_temp.cc_try('authenticated', u_agent, format(
         'INSERT INTO compose_check_events (account_id, user_id, warnings) VALUES (%L, %L, ARRAY[''tone''])',
         a_acct, u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an agent inserted a compose check row (want 42501): ' || r)::text);
  END IF;
  r := pg_temp.cc_try('authenticated', u_admin, format(
         'UPDATE compose_check_events SET outcome = ''edited'' WHERE id = %L', ev_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin updated a compose check row (want 42501): ' || r)::text);
  END IF;
  r := pg_temp.cc_try('authenticated', u_admin, format(
         'DELETE FROM compose_check_events WHERE id = %L', ev_a));
  n := n + 1;
  IF r NOT LIKE 'ERROR 42501%' THEN
    failed := array_append(failed, ('an admin deleted a compose check row (want 42501): ' || r)::text);
  END IF;

  -- ---------- 3. the service role writes ----------
  r := pg_temp.cc_try('service_role', NULL, format(
         'INSERT INTO compose_check_events (account_id, user_id, conversation_id, warnings) VALUES (%L, %L, %L, ARRAY[''cold_pitch''])',
         a_acct, u_agent, cv_a));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the service role could not log a warning: ' || r)::text);
  END IF;
  r := pg_temp.cc_try('service_role', NULL, format(
         'UPDATE compose_check_events SET outcome = ''sent_anyway'', decided_at = now() WHERE id = %L', ev_a));
  n := n + 1;
  IF r <> '1' THEN
    failed := array_append(failed, ('the service role could not settle a warning: ' || r)::text);
  END IF;

  -- ---------- 4. CHECKs and the FK ----------
  r := pg_temp.cc_do(format(
         'INSERT INTO compose_check_events (account_id, user_id, warnings) VALUES (%L, %L, ARRAY[''promise'', ''rudeness''])',
         a_acct, u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('an unknown warning code was accepted (want 23514): ' || r)::text);
  END IF;
  r := pg_temp.cc_do(format(
         'INSERT INTO compose_check_events (account_id, user_id, warnings) VALUES (%L, %L, ARRAY[]::text[])',
         a_acct, u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('an empty warnings array was accepted (want 23514): ' || r)::text);
  END IF;
  r := pg_temp.cc_do(format(
         'INSERT INTO compose_check_events (account_id, user_id, warnings, outcome) VALUES (%L, %L, ARRAY[''tone''], ''ignored'')',
         a_acct, u_agent));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23514%' THEN
    failed := array_append(failed, ('an unknown outcome was accepted (want 23514): ' || r)::text);
  END IF;
  r := pg_temp.cc_do(format(
         'INSERT INTO compose_check_events (account_id, user_id, conversation_id, warnings) VALUES (%L, %L, %L, ARRAY[''tone''])',
         a_acct, u_agent, cv_b));
  n := n + 1;
  IF r NOT LIKE 'ERROR 23503%' THEN
    failed := array_append(failed, ('a row named another account''s chat (want 23503): ' || r)::text);
  END IF;

  r := pg_temp.cc_do(format('DELETE FROM conversations WHERE id = %L', cv_a));
  n := n + 1;
  IF r <> 'ok' THEN
    failed := array_append(failed, ('deleting the chat failed: ' || r)::text);
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM compose_check_events
                 WHERE id = ev_a AND conversation_id IS NULL AND account_id = a_acct) THEN
    failed := array_append(failed, 'deleting the chat did not null conversation_id (or dropped the row / account_id)'::text);
  END IF;

  n := n + 1;
  IF has_table_privilege('anon', 'public.compose_check_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.compose_check_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.compose_check_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.compose_check_events', 'DELETE') THEN
    failed := array_append(failed, 'anon / clients hold privileges 149 withholds'::text);
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT149', MESSAGE = 'verify-compose-check-events rollback';
  EXCEPTION WHEN SQLSTATE 'ZT149' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'compose check events verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'compose check events verification passed (% checks)', n;
END
$verify$;
