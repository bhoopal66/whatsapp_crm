-- Regression check for migration 324: an invitation opens only by its
-- link's token. The hash-taking peek_invitation / redeem_invitation are
-- callable by no client role, the token-taking wrappers still work (they
-- run those bodies as their owner), and re-applying an older file's grant
-- keeps the hash form closed. verify-admin-rules.sql walks the whole token
-- flow with fixtures. ONE statement on purpose (the pinned CLI rejects
-- several); the re-apply is undone by a sentinel.

DO $verify$
DECLARE
  n INT := 0;
  failed TEXT[] := '{}';
  t TEXT;
  r TEXT;
  stranger CONSTANT UUID := '00000000-0000-4000-8000-000000324001';
BEGIN
  -- 1. No client role holds EXECUTE on the hash form.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, 'public.peek_invitation(text)', 'EXECUTE')
       OR has_function_privilege(r, 'public.redeem_invitation(text)', 'EXECUTE') THEN
      failed := failed || (r || ' can call the hash form'); END IF;
    n := n + 1;
  END LOOP;

  -- 2. Called anyway, the database refuses before the body runs.
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.peek_invitation('anything');
    RESET ROLE;
    failed := failed || 'anon peeked by hash'::text;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    IF SQLERRM NOT LIKE 'permission denied for function%' THEN
      failed := failed || ('anon peek: ' || SQLERRM); END IF;
  END;
  n := n + 1;
  -- A signed-in stranger (set outside the blocks: an error in one would
  -- roll the setting back with it).
  PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', stranger, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.redeem_invitation('anything');
    RESET ROLE;
    failed := failed || 'a signed-in caller redeemed by hash'::text;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    IF SQLERRM NOT LIKE 'permission denied for function%' THEN
      failed := failed || ('authenticated redeem: ' || SQLERRM); END IF;
  END;
  n := n + 1;

  -- 3. The token form still reaches the bodies.
  BEGIN
    SET LOCAL ROLE anon;
    t := public.peek_invitation_token('vil-324-no-such-link') ->> 'reason';
    RESET ROLE;
    IF t IS DISTINCT FROM 'not_found' THEN failed := failed || ('anon token peek: ' || coalesce(t, 'NULL')); END IF;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    failed := failed || ('anon token peek raised: ' || SQLERRM);
  END;
  n := n + 1;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.redeem_invitation_token('vil-324-no-such-link');
    RESET ROLE;
    failed := failed || 'token redeem of an unknown link succeeded'::text;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    -- The body's own answer, not a permission refusal.
    IF SQLSTATE <> '22023' THEN failed := failed || ('token redeem: ' || SQLSTATE || ' ' || SQLERRM); END IF;
  END;
  n := n + 1;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- 4. Re-applying an older file's grant (175's, as it now reads) keeps it closed.
  BEGIN
    IF to_regprocedure('public.peek_invitation_token(text)') IS NULL THEN
      GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;
    END IF;
    IF to_regprocedure('public.redeem_invitation_token(text)') IS NULL THEN
      GRANT EXECUTE ON FUNCTION public.redeem_invitation(text) TO authenticated, service_role;
    END IF;
    IF has_function_privilege('anon', 'public.peek_invitation(text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.redeem_invitation(text)', 'EXECUTE') THEN
      failed := failed || 're-applying 175 reopened the hash form'::text; END IF;
    n := n + 1;
    RAISE EXCEPTION 'VIL_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'VIL_ROLLBACK' THEN RAISE; END IF;
  END;

  IF n <> 8 THEN RAISE EXCEPTION 'verify-invitation-lockdown: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-invitation-lockdown: % failed: %', cardinality(failed), array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-invitation-lockdown: % checks passed', n;
END $verify$;
