-- ============================================================
-- 279_hr_is_line.sql — is this number an HR line?
--
-- The sales bot must not answer a candidate (200, 213). hr_lines is closed
-- to every role, and the only function the service role had,
-- hr_auto_open_recruiter, answers 'off' without looking at the lines while
-- "open a Recruitment chat" is off, and opens a chat while it is on. This
-- one only looks.
--
-- Nothing here refuses itself on existing data. Safe to run twice. Needs
-- 213.
-- ============================================================

CREATE OR REPLACE FUNCTION public.hr_is_line(p_channel uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.hr_lines l WHERE l.channel_id = p_channel)
$$;

REVOKE ALL ON FUNCTION public.hr_is_line(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hr_is_line(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
