-- ============================================================
-- 288_login_email_guard.sql — a login's email is changed by an
-- administrator, through the app
--
-- The profile screen shows one's own email read-only (167: an
-- administrator changes it), but the sign-in service takes a signed-in
-- person's own request too, and whether it asks for a confirmation depends
-- on its version and settings. The address decides more than the sign-in:
-- cases and submission groups that arrive with a colleague's email are
-- given to the login that holds it (sg_staff_by_email, 115).
--
-- A BEFORE UPDATE trigger on auth.users refuses a changed email unless the
-- app's server asked for exactly that change in the last two minutes
-- (permit_login_email, service role, called by the member details route
-- after 167's authorisation). Creating a login, banning one, a password
-- change and a change of case only are not affected.
--
-- Nothing here refuses itself on existing data. Re-runnable. Apply after
-- 167; with the build (the build asks for the permit and tolerates this
-- file's absence; the build before it cannot change a member's email once
-- this is applied). As a role that may create triggers on auth.users, as
-- 017.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.login_email_permits (
  user_id     uuid NOT NULL,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, email)
);
ALTER TABLE public.login_email_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_email_permits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_email_permits FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.login_email_permits IS
  '288: login email changes the app''s server has authorised, for two minutes. Definer functions only.';

CREATE OR REPLACE FUNCTION public.permit_login_email(p_user uuid, p_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.login_email_permits WHERE created_at < now() - interval '1 day';
  INSERT INTO public.login_email_permits (user_id, email) VALUES (p_user, lower(btrim(p_email)))
  ON CONFLICT (user_id, email) DO UPDATE SET created_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_login_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.login_email_permits p
   WHERE p.user_id = NEW.id AND p.email = lower(NEW.email::text)
     AND p.created_at > now() - interval '2 minutes';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a login email is changed by an administrator, in Settings, Members'
      USING ERRCODE = '42501', HINT = 'LOGIN_EMAIL_GUARD';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.permit_login_email(uuid, text), public.guard_login_email()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.permit_login_email(uuid, text) TO service_role;

CREATE OR REPLACE TRIGGER guard_login_email
  BEFORE UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (lower(OLD.email::text) IS DISTINCT FROM lower(NEW.email::text) AND NEW.email IS NOT NULL)
  EXECUTE FUNCTION public.guard_login_email();

NOTIFY pgrst, 'reload schema';
