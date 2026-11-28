-- ============================================================
-- 322_invitation_hash_calls_closed.sql — an invitation opens only by
-- its link's token
--
-- 287 added peek_invitation_token / redeem_invitation_token, which take
-- the link's token and hash it in the database, and left the older
-- peek_invitation / redeem_invitation (which take the stored hash)
-- callable for the build before it. That build is gone: every build
-- since 287 calls only the token form (src/app/api/invitations/[token]).
-- While the hash form stays callable, anyone who can read a stored hash
-- (an owner or admin reading account_invitations, a leaked backup or
-- export) can redeem someone else's link as themselves.
--
-- So: EXECUTE on the two hash-taking functions is revoked from every
-- client role. They stay as the bodies the token wrappers run: those are
-- SECURITY DEFINER, owned by the migration role, which keeps EXECUTE.
-- 019, 099, 105, 135 and 175 now grant the hash form only while the
-- wrappers do not exist yet, so re-applying any of them keeps it closed.
--
-- Safe with the current build (no code path calls the hash form).
-- Re-runnable. Asserted by supabase/ci/verify-invitation-lockdown.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF to_regprocedure('public.peek_invitation_token(text)') IS NULL
     OR to_regprocedure('public.redeem_invitation_token(text)') IS NULL THEN
    RAISE EXCEPTION '322: apply 287_admin_rules.sql first (the token-taking calls replace these)';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.peek_invitation(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.redeem_invitation(text) FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, 'public.peek_invitation(text)', 'EXECUTE')
       OR has_function_privilege(r, 'public.redeem_invitation(text)', 'EXECUTE') THEN
      RAISE EXCEPTION '322 did not apply completely: % can still call a hash-taking invitation function', r;
    END IF;
  END LOOP;
  -- The token form is untouched: a visitor peeks, a signed-in person redeems.
  IF NOT has_function_privilege('anon', 'public.peek_invitation_token(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.peek_invitation_token(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.redeem_invitation_token(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.redeem_invitation_token(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '322: the token-taking invitation calls are not granted as 287 left them';
  END IF;
END $$;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
