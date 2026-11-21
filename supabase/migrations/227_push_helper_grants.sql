-- ============================================================
-- 227_push_helper_grants.sql — the push visibility helpers are not
-- callable over the API, by any role.
--
-- 109 and 190 revoke EXECUTE on push_eligible and both
-- can_view_conversation_for_user overloads from PUBLIC, anon and
-- authenticated, and verify-push.sql asserts that service_role cannot
-- execute them either: they answer "can user X see this chat" for any
-- X, and only the SECURITY DEFINER push functions (owned by the
-- migration owner) call them. On a classic Supabase project the
-- default privileges grant EXECUTE on every new public function to
-- service_role as well, and the revokes above never named it, so there
-- the service role could still call them over PostgREST. Nothing in the
-- app does; this makes the database match the rule.
--
-- Re-runnable; each statement is skipped when its function is missing.
-- Apply after 226.
-- ============================================================

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.push_eligible(uuid, uuid, text)',
    'public.can_view_conversation_for_user(uuid, uuid, uuid, uuid)',
    'public.can_view_conversation_for_user(uuid, uuid, uuid, uuid, uuid)'
  ] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role', f);
    END IF;
  END LOOP;
END $$;
