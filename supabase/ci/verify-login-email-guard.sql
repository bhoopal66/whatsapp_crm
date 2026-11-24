-- 288: a login's email changes only with a fresh permit for that address.
DO $verify$
DECLARE
  u uuid := gen_random_uuid();
  failed text[] := ARRAY[]::text[];
  n int := 0;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email, instance_id, aud, role) VALUES (u, 'leg-one@example.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
    n := n + 1;
    BEGIN
      UPDATE auth.users SET email = 'leg-two@example.invalid' WHERE id = u;
      failed := array_append(failed, 'a login email changed without a permit'::text);
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    -- Not a change of address.
    n := n + 1;
    UPDATE auth.users SET email = 'LEG-one@example.invalid', encrypted_password = 'x' WHERE id = u;
    -- For another address.
    PERFORM public.permit_login_email(u, 'leg-three@example.invalid');
    n := n + 1;
    BEGIN
      UPDATE auth.users SET email = 'leg-two@example.invalid' WHERE id = u;
      failed := array_append(failed, 'a permit for one address opened another'::text);
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    -- Permitted, once.
    PERFORM public.permit_login_email(u, ' LEG-two@example.invalid ');
    UPDATE auth.users SET email = 'leg-two@example.invalid' WHERE id = u;
    n := n + 1;
    IF (SELECT email::text FROM auth.users WHERE id = u) <> 'leg-two@example.invalid' THEN
      failed := array_append(failed, 'a permitted change was not made'::text);
    END IF;
    UPDATE auth.users SET email = 'leg-three@example.invalid' WHERE id = u;
    n := n + 1;
    BEGIN
      UPDATE auth.users SET email = 'leg-two@example.invalid' WHERE id = u;
      failed := array_append(failed, 'a permit was good for a second change'::text);
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    -- Stale.
    PERFORM public.permit_login_email(u, 'leg-four@example.invalid');
    UPDATE public.login_email_permits SET created_at = now() - interval '3 minutes' WHERE user_id = u;
    n := n + 1;
    BEGIN
      UPDATE auth.users SET email = 'leg-four@example.invalid' WHERE id = u;
      failed := array_append(failed, 'a stale permit was accepted'::text);
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RAISE EXCEPTION USING ERRCODE = 'ZT288', MESSAGE = 'rollback';
  EXCEPTION WHEN SQLSTATE 'ZT288' THEN NULL;
  END;
  n := n + 1;
  IF has_function_privilege('authenticated', 'public.permit_login_email(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.permit_login_email(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.permit_login_email(uuid, text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.login_email_permits', 'SELECT')
     OR has_table_privilege('service_role', 'public.login_email_permits', 'SELECT') THEN
    failed := array_append(failed, 'permit_login_email or its table is open to more than the service role''s call'::text);
  END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'login email guard: % of % checks failed: %', cardinality(failed), n, array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'login email guard passed (% checks)', n;
END
$verify$;
