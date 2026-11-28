-- Behavioural regression suite for migration 330: reactivating a person
-- gives back the report access they had when deactivated, and nothing
-- more. A deactivated member's kept grant opens nothing; the owner
-- saving the list meanwhile does not delete it; a member who never had
-- access gets none. ONE statement on purpose (the pinned CLI rejects
-- several); fixtures are rolled back through a sentinel.

DO $verify$
DECLARE
  u_owner  UUID := '00000000-0000-4000-8000-000000330001';
  u_agent  UUID := '00000000-0000-4000-8000-000000330002';
  u_agent2 UUID := '00000000-0000-4000-8000-000000330003';
  a_acct   UUID;
  r        TEXT;
  n        INT := 0;
  failed   TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.rar_try(p_uid uuid, p_sql text)
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
    (u_owner,  'rar330-owner@example.invalid'),
    (u_agent,  'rar330-agent@example.invalid'),
    (u_agent2, 'rar330-agent2@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a_acct FROM profiles WHERE user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_agent2;

  -- The owner opens the tag report to one agent.
  n := n + 1;
  r := pg_temp.rar_try(u_owner, format('SELECT report_access_set(%L, ARRAY[%L]::uuid[])::text', 'chat_tags', u_agent));
  IF r <> '1' THEN failed := array_append(failed, 'fixture: the owner could not grant the agent: ' || r); END IF;
  n := n + 1;
  r := pg_temp.rar_try(u_agent, 'SELECT report_my_access()::text');
  IF r <> '{chat_tags}' THEN failed := array_append(failed, 'fixture: the grantee has no report access: ' || r); END IF;

  -- Deactivated: no report access, but the grant is kept.
  UPDATE profiles SET deactivated_at = now() WHERE user_id IN (u_agent, u_agent2);
  n := n + 1;
  r := pg_temp.rar_try(u_agent, 'SELECT report_my_access()::text');
  IF r NOT LIKE 'ERROR:%' AND r <> '{}' THEN
    failed := array_append(failed, 'a deactivated member still has report access: ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.rar_try(u_agent, format('SELECT chat_tag_report(%L, %L)::text',
         (now() - interval '7 days')::text, (now() + interval '1 minute')::text));
  IF r NOT LIKE 'ERROR:%' THEN
    failed := array_append(failed, 'a deactivated member still opened the tag report');
  END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM report_access WHERE account_id = a_acct AND user_id = u_agent AND report_key = 'chat_tags') THEN
    failed := array_append(failed, 'deactivation deleted the member''s report grant');
  END IF;

  -- The owner saves the list (which shows live staff only) meanwhile.
  n := n + 1;
  r := pg_temp.rar_try(u_owner, format('SELECT report_access_set(%L, ARRAY[]::uuid[])::text', 'chat_tags'));
  IF r LIKE 'ERROR:%' THEN failed := array_append(failed, 'fixture: the owner could not save the list: ' || r); END IF;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM report_access WHERE account_id = a_acct AND user_id = u_agent AND report_key = 'chat_tags') THEN
    failed := array_append(failed, 'saving the list deleted a deactivated member''s grant');
  END IF;

  -- Reactivated: the same access is back; the never-granted one has none.
  UPDATE profiles SET deactivated_at = NULL WHERE user_id IN (u_agent, u_agent2);
  n := n + 1;
  r := pg_temp.rar_try(u_agent, 'SELECT report_my_access()::text');
  IF r <> '{chat_tags}' THEN
    failed := array_append(failed, 'reactivation did not restore the report access: ' || r);
  END IF;
  n := n + 1;
  r := pg_temp.rar_try(u_agent2, 'SELECT report_my_access()::text');
  IF r <> '{}' THEN
    failed := array_append(failed, 'a member who never had access got some: ' || r);
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM report_access WHERE user_id = u_agent2) THEN
    failed := array_append(failed, 'a member who never had access has a grant row');
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZR330', MESSAGE = 'verify-report-access-reactivation rollback';
  EXCEPTION WHEN SQLSTATE 'ZR330' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'report access reactivation verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'report access reactivation verification passed (% checks)', n;
END
$verify$;
