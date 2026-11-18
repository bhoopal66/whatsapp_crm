-- ============================================================
-- 209: Compass notifications on the Meta number.
--
-- Compass status notifications (056) now go out on the Meta Cloud API
-- number instead of a linked-device number (Whapi / OpenWA), whose
-- numbers were being restricted by the unsolicited volume. Meta allows
-- free text only inside the 24-hour window a customer's own message
-- opens; outside it, the update is sent as one approved utility
-- template that carries the Compass text in its single body variable.
-- An admin picks that template here.
--
--   1. compass_settings: one row per workspace. No row, or a NULL
--      template name, means "no template chosen": an update outside
--      the window is then refused (meta_template_not_set) and nothing
--      is sent. The template is addressed as Meta addresses it, by
--      (name, language), and checked at send time (approved, utility,
--      one body variable), so a template edited or re-synced later is
--      judged as it is then.
--   2. A trigger stamps updated_at / updated_by.
--   3. RLS: owners and admins of the active account read, insert and
--      update (Compass data is admin-only, as 056); nobody deletes;
--      the service role (the public API's Compass route) reads.
--
-- Re-runnable. Apply after 208.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The table.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compass_settings (
  account_id             uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  meta_template_name     text,
  meta_template_language text,
  -- auth user id of the last writer (auth.uid(), NULL for the service role).
  updated_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'compass_settings_template_check'
       AND conrelid = 'public.compass_settings'::regclass
  ) THEN
    -- A language only with a name; neither blank nor over-long.
    ALTER TABLE public.compass_settings
      ADD CONSTRAINT compass_settings_template_check
      CHECK (
        (meta_template_name IS NULL AND meta_template_language IS NULL)
        OR (meta_template_name IS NOT NULL
            AND char_length(meta_template_name) BETWEEN 1 AND 512
            AND meta_template_name !~ '^[[:space:]]*$'
            AND (meta_template_language IS NULL
                 OR (char_length(meta_template_language) BETWEEN 1 AND 20
                     AND meta_template_language !~ '^[[:space:]]*$')))
      );
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Stamp the writer.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compass_settings_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.compass_settings_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS compass_settings_stamp ON public.compass_settings;
CREATE TRIGGER compass_settings_stamp
  BEFORE INSERT OR UPDATE ON public.compass_settings
  FOR EACH ROW EXECUTE FUNCTION public.compass_settings_stamp();

-- ------------------------------------------------------------
-- 3. RLS and grants. No DELETE: clearing it is a NULL name.
-- ------------------------------------------------------------
ALTER TABLE public.compass_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.compass_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.compass_settings TO authenticated;
GRANT SELECT ON public.compass_settings TO service_role;

DROP POLICY IF EXISTS compass_settings_read ON public.compass_settings;
CREATE POLICY compass_settings_read ON public.compass_settings
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND (SELECT public.current_role_rank()) >= 4);

DROP POLICY IF EXISTS compass_settings_insert ON public.compass_settings;
CREATE POLICY compass_settings_insert ON public.compass_settings
  FOR INSERT TO authenticated
  WITH CHECK (account_id = (SELECT public.current_account_id())
              AND (SELECT public.current_role_rank()) >= 4);

DROP POLICY IF EXISTS compass_settings_update ON public.compass_settings;
CREATE POLICY compass_settings_update ON public.compass_settings
  FOR UPDATE TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND (SELECT public.current_role_rank()) >= 4)
  WITH CHECK (account_id = (SELECT public.current_account_id())
              AND (SELECT public.current_role_rank()) >= 4);
