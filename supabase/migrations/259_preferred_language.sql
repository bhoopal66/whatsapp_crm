-- ============================================================
-- 259_preferred_language.sql — a per-person interface language.
--
-- The app used to be built for one language (NEXT_PUBLIC_APP_LOCALE).
-- Each person may now pick English, Arabic or Korean; the choice is
-- kept here so it follows them to every device, and src/i18n/request.ts
-- reads it per request from the NEXT_LOCALE cookie that sign-in (and
-- the Settings → Appearance picker) writes from this column.
--
--  1. profiles.preferred_language: 'en' | 'ar' | 'ko', NULL = follow
--     the workspace default. The list mirrors LOCALES in
--     src/i18n/locales.ts (locales.test.ts reads this file): change
--     both.
--  2. set_my_language(p_language): the only writer for a signed-in
--     person. It writes every profiles row of the CALLER (one per
--     workspace since 083) and nobody else's, so the language is the
--     same whichever workspace is active.
--  3. profiles_language_guard: a direct UPDATE of the column by the
--     `authenticated` role is refused unless set_my_language raised its
--     transaction-local flag (app.language_set), so the rows cannot
--     drift apart. Deliberately its own trigger: 057's
--     enforce_profile_privilege_columns (last restated by 198) is left
--     alone so re-running this file restates nothing.
--  4. profiles_language_inherit: a new profiles row (added to another
--     workspace, an invitation redeemed) starts with the language the
--     person already chose.
--
-- Idempotent; re-runnable. verify-preferred-language.sql.
-- ============================================================

-- ---------- 1. the column ----------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_language TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'profiles_preferred_language_check'
       AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_preferred_language_check
      CHECK (preferred_language IS NULL
             OR preferred_language IN ('en', 'ar', 'ko'));
  END IF;
END
$$;

COMMENT ON COLUMN public.profiles.preferred_language IS
  'Interface language chosen by this person (en | ar | ko); NULL follows the workspace default. Same on every row of the person; written through set_my_language (259).';

-- ---------- 2. the writer ----------
CREATE OR REPLACE FUNCTION public.set_my_language(p_language text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_language IS NOT NULL AND p_language NOT IN ('en', 'ar', 'ko') THEN
    RAISE EXCEPTION 'unsupported language: %', p_language
      USING ERRCODE = '22023', HINT = 'UNSUPPORTED_LANGUAGE';
  END IF;

  PERFORM set_config('app.language_set', 'on', true);
  UPDATE profiles
     SET preferred_language = p_language
   WHERE user_id = v_uid
     AND preferred_language IS DISTINCT FROM p_language;
  PERFORM set_config('app.language_set', '', true);

  RETURN p_language;
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_language(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_my_language(text) TO authenticated;

-- ---------- 3. no direct writes by a client ----------
CREATE OR REPLACE FUNCTION public.profiles_language_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'authenticated'
     AND NEW.preferred_language IS DISTINCT FROM OLD.preferred_language
     AND COALESCE(current_setting('app.language_set', TRUE), '') <> 'on'
  THEN
    RAISE EXCEPTION 'preferred_language is changed through set_my_language'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_language_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS profiles_language_guard ON public.profiles;
CREATE TRIGGER profiles_language_guard
  BEFORE UPDATE OF preferred_language ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_language_guard();

-- ---------- 4. a new row inherits the person's choice ----------
CREATE OR REPLACE FUNCTION public.profiles_language_inherit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.preferred_language IS NULL AND NEW.user_id IS NOT NULL THEN
    SELECT p.preferred_language INTO NEW.preferred_language
      FROM profiles p
     WHERE p.user_id = NEW.user_id
       AND p.preferred_language IS NOT NULL
     ORDER BY p.is_active DESC, p.id
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_language_inherit()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS profiles_language_inherit ON public.profiles;
CREATE TRIGGER profiles_language_inherit
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_language_inherit();
