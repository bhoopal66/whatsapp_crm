-- Behavioural regression suite for migration 310: a coordinator's banks are
-- replaced only when the ones stored are the ones the page showed.
--
-- ONE statement on purpose (`supabase db query --file`). Failing checks are
-- named in the final exception; every fixture is rolled back by the
-- sentinel raised at the end of the inner block. A writing RPC's result is
-- assigned first and its effect read in a later statement.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000310001';
  u_admin UUID := '00000000-0000-4000-8000-000000310002';
  u_coord UUID := '00000000-0000-4000-8000-000000310003';
  a       UUID;
  r       TEXT;
  three   TEXT := 'SELECT public.set_coordinator_banks(p_user_id => %L, p_bank_codes => %L::text[], p_expected => %L::text[])::text';
  two     TEXT := 'SELECT public.set_coordinator_banks(p_user_id => %L, p_bank_codes => %L::text[])::text';
  stored  TEXT := 'SELECT coalesce(string_agg(bank_code, '','' ORDER BY bank_code), '''') FROM public.coordinator_banks WHERE user_id = %L';
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cbe_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; h text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(v, 'null');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || coalesce(nullif(h, ''), '-');
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.cbe_ok(p_cond boolean, p_name text)
    RETURNS text LANGUAGE sql AS $body$ SELECT CASE WHEN p_cond IS TRUE THEN NULL ELSE p_name END $body$
  $fn$;

  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'cbe-owner@example.invalid'),
    (u_admin, 'cbe-admin@example.invalid'),
    (u_coord, 'cbe-coord@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT account_id INTO a FROM profiles WHERE user_id = u_owner;
  IF a IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = u_admin;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = u_coord;
  INSERT INTO case_banks (account_id, code, name) VALUES
    (a, 'ADCB', 'ADCB Bank'), (a, 'ENBD', 'Emirates NBD'), (a, 'FAB', 'First Abu Dhabi Bank');

  -- the screen showed none, and none is stored
  r := pg_temp.cbe_try(u_owner, format(three, u_coord, '{ADCB}', '{}'));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = '{ADCB}', 'the first save was refused (' || r || ')');

  -- a colleague adds ENBD; the stale page, still showing ADCB, may not take it away
  r := pg_temp.cbe_try(u_admin, format(three, u_coord, '{ADCB,ENBD}', '{ADCB}'));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = '{ADCB,ENBD}', 'a save from a fresh page was refused (' || r || ')');
  r := pg_temp.cbe_try(u_owner, format(three, u_coord, '{ADCB,FAB}', '{ADCB}'));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = 'ERROR 22023 banks_changed', 'a save from a stale page went through (' || r || ')');
  EXECUTE format(stored, u_coord) INTO r;
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = 'ADCB,ENBD', 'the refused save changed the banks (' || r || ')');
  r := pg_temp.cbe_try(u_owner, format(three, u_coord, '{}', '{ADCB}'));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = 'ERROR 22023 banks_changed', 'a stale page removed the coordinator (' || r || ')');

  -- the order and a repeat in the list do not matter
  r := pg_temp.cbe_try(u_owner, format(three, u_coord, '{FAB}', '{ENBD,ADCB,ADCB}'));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = '{FAB}', 'the same set in another order was refused (' || r || ')');

  -- 133's own rules still decide
  r := pg_temp.cbe_try(u_owner, format(three, u_coord, '{NOPE}', '{FAB}'));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = 'ERROR 22023 unknown_bank', 'an unknown bank was accepted (' || r || ')');
  r := pg_temp.cbe_try(u_coord, format(three, u_coord, '{ADCB}', '{FAB}'));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = 'ERROR 42501 -', 'an agent could set banks (' || r || ')');
  r := pg_temp.cbe_try(u_owner, format('SELECT public.set_coordinator_banks(p_user_id => %L, p_bank_codes => ''{ADCB}''::text[], p_expected => NULL::text[])::text', u_coord));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = 'ERROR 22023 -', 'a save without the shown banks was taken (' || r || ')');

  -- the old build's two-argument call
  r := pg_temp.cbe_try(u_owner, format(two, u_coord, '{ADCB}'));
  n := n + 1; failed := failed || pg_temp.cbe_ok(r = '{ADCB}', 'the two-argument call no longer works (' || r || ')');

  n := n + 1; failed := failed || pg_temp.cbe_ok(
    NOT has_function_privilege('anon', 'public.set_coordinator_banks(uuid, text[], text[])', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.set_coordinator_banks(uuid, text[], text[])', 'EXECUTE')
    AND (SELECT count(*) = 2 AND sum(pronargdefaults) = 0 FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace AND proname = 'set_coordinator_banks'),
    'grants or signatures');

  RAISE EXCEPTION USING ERRCODE = 'ZT310', MESSAGE = 'verify-coordinator-banks-expected rollback';
  EXCEPTION WHEN SQLSTATE 'ZT310' THEN
    NULL;
  END;

  failed := array_remove(failed, NULL);
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'coordinator banks expected verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'coordinator banks expected verification passed (% checks)', n;
END
$verify$;
