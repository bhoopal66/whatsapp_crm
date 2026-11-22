-- Behavioural regression suite for the per-person language (migration 259).
--
-- profiles.preferred_language takes en | ar | ko or NULL; set_my_language
-- writes every row of the caller (one per workspace) and nobody else's,
-- refuses an unsupported language and an anonymous caller; a direct
-- client UPDATE of the column is refused; a new workspace row inherits
-- the choice; only `authenticated` may execute the RPC. ONE statement on
-- purpose (the pinned CLI rejects several); fixtures are rolled back
-- through a sentinel.

DO $verify$
DECLARE
  u_me    UUID := '00000000-0000-4000-8000-000000259001';
  u_other UUID := '00000000-0000-4000-8000-000000259002';
  u_third UUID := '00000000-0000-4000-8000-000000259003';
  a_acct  UUID;
  b_acct  UUID;
  c_acct  UUID;
  r       TEXT;
  n       INT := 0;
  failed  TEXT[] := '{}';
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.pl_try(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; c bigint;
    BEGIN
      BEGIN
        IF p_uid IS NOT NULL THEN
          PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        END IF;
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
    (u_me,    'pl-me@example.invalid'),
    (u_other, 'pl-other@example.invalid'),
    (u_third, 'pl-third@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_me;
  SELECT id INTO b_acct FROM accounts WHERE owner_user_id = u_other;
  SELECT id INTO c_acct FROM accounts WHERE owner_user_id = u_third;
  IF a_acct IS NULL OR b_acct IS NULL OR c_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision accounts';
  END IF;
  -- u_me also works (inactive) in u_other's workspace.
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_me, '', 'pl-me@example.invalid', b_acct, 'agent', false);

  -- The RPC writes both of the caller's rows, nobody else's.
  r := pg_temp.pl_try(u_me, 'SELECT public.set_my_language(''ar'')');
  n := n + 1;
  IF r <> 'ar' THEN failed := array_append(failed, 'set_my_language(ar) answered ' || r); END IF;
  n := n + 1;
  IF (SELECT count(*) FROM profiles WHERE user_id = u_me AND preferred_language = 'ar') <> 2 THEN
    failed := array_append(failed, 'not every workspace row of the caller took the language');
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = u_other AND preferred_language IS NOT NULL) THEN
    failed := array_append(failed, 'set_my_language wrote another person''s row');
  END IF;

  -- The caller reads it back through RLS.
  r := pg_temp.pl_try(u_me,
    'SELECT preferred_language FROM profiles WHERE user_id = auth.uid() AND is_active');
  n := n + 1;
  IF r <> 'ar' THEN failed := array_append(failed, 'the caller cannot read their language: ' || r); END IF;

  -- An unsupported language is refused and changes nothing.
  r := pg_temp.pl_try(u_me, 'SELECT public.set_my_language(''fr'')');
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'an unsupported language was accepted: ' || r); END IF;
  n := n + 1;
  IF (SELECT count(*) FROM profiles WHERE user_id = u_me AND preferred_language = 'ar') <> 2 THEN
    failed := array_append(failed, 'a refused call changed the language');
  END IF;

  -- No caller, no write.
  r := pg_temp.pl_try(NULL, 'SELECT public.set_my_language(''ko'')');
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'an anonymous call was accepted: ' || r); END IF;

  -- A direct client UPDATE of the column is refused, of the own row too.
  r := pg_temp.pl_try(u_me,
    'UPDATE profiles SET preferred_language = ''ko'' WHERE user_id = auth.uid() AND is_active');
  n := n + 1;
  IF r NOT LIKE 'ERROR:%' THEN failed := array_append(failed, 'a direct UPDATE of preferred_language was accepted: ' || r); END IF;
  -- … while the person's other columns stay writable.
  r := pg_temp.pl_try(u_me,
    'UPDATE profiles SET full_name = ''Me'' WHERE user_id = auth.uid() AND is_active');
  n := n + 1;
  IF r <> '1' THEN failed := array_append(failed, 'the guard blocked an unrelated profile edit: ' || r); END IF;

  -- The CHECK holds for every writer.
  n := n + 1;
  BEGIN
    UPDATE profiles SET preferred_language = 'fr' WHERE user_id = u_other;
    failed := array_append(failed, 'the CHECK accepted an unsupported language');
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- A new workspace row inherits the choice.
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role, is_active)
  VALUES (u_me, '', 'pl-me@example.invalid', c_acct, 'agent', false);
  n := n + 1;
  IF (SELECT preferred_language FROM profiles WHERE user_id = u_me AND account_id = c_acct)
     IS DISTINCT FROM 'ar' THEN
    failed := array_append(failed, 'a new workspace row did not inherit the language');
  END IF;

  -- NULL goes back to the workspace default, on every row.
  r := pg_temp.pl_try(u_me, 'SELECT coalesce(public.set_my_language(NULL), ''cleared'')');
  n := n + 1;
  IF r <> 'cleared' THEN failed := array_append(failed, 'set_my_language(NULL) answered ' || r); END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = u_me AND preferred_language IS NOT NULL) THEN
    failed := array_append(failed, 'clearing the language left a row set');
  END IF;

  n := n + 1;
  IF has_function_privilege('anon', 'public.set_my_language(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.set_my_language(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_my_language(text)', 'EXECUTE') THEN
    failed := array_append(failed, 'set_my_language grants are wrong');
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT259', MESSAGE = 'verify-preferred-language rollback';
  EXCEPTION WHEN SQLSTATE 'ZT259' THEN
    NULL;
  END;

  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'preferred language verification: % of % checks failed: %',
      array_length(failed, 1), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'preferred language verification passed (% checks)', n;
END
$verify$;
