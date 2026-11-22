-- ============================================================
-- 250_saved_views.sql — saved filter sets ("views") for the WhatsApp
-- inbox and the Contacts screen.
--
-- One table for every screen: `screen` names it, `filters` is whatever
-- that screen serialises (the client validates it defensively when it
-- reads one back; the database only insists on a JSON object of sane
-- size). The cases inbox keeps its own 185 views: they run through
-- case-role RPCs and a server-side filter validator that this table
-- has no use for.
--
-- Who sees what is RLS, not application code:
--   * a PERSONAL view (shared = false) is read, changed and deleted by
--     its owner only;
--   * a SHARED view (shared = true) is read by the whole workspace and
--     can only be created or kept shared by a team leader or above.
--     Its owner changes or deletes it; an admin can change or delete
--     any shared view (an owner who left must not leave one behind).
-- Viewers and up may keep personal views; a bank guest has no active
-- account (current_account_id() is NULL) and so reaches nothing.
--
-- Nothing here sends or changes any customer data. Re-runnable.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.saved_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  screen        text NOT NULL,
  name          text NOT NULL,
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  shared        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- [[:space:]], not btrim(): btrim strips spaces only.
  CONSTRAINT saved_views_name_check
    CHECK (name !~ '^[[:space:]]*$' AND char_length(name) <= 60),
  CONSTRAINT saved_views_screen_check CHECK (screen ~ '^[a-z][a-z_]{0,29}$'),
  CONSTRAINT saved_views_filters_check
    CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 16384)
);

CREATE INDEX IF NOT EXISTS saved_views_owner_idx
  ON public.saved_views (account_id, screen, owner_user_id);
CREATE INDEX IF NOT EXISTS saved_views_shared_idx
  ON public.saved_views (account_id, screen) WHERE shared;

-- Identity is frozen; updated_at is the server's.
CREATE OR REPLACE FUNCTION public.saved_views_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       OR NEW.screen IS DISTINCT FROM OLD.screen
       OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'saved_views: identity columns are frozen'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saved_views_guard ON public.saved_views;
CREATE TRIGGER saved_views_guard
  BEFORE INSERT OR UPDATE ON public.saved_views
  FOR EACH ROW EXECUTE FUNCTION public.saved_views_guard();

ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.saved_views FROM PUBLIC, anon, authenticated, service_role;

DROP POLICY IF EXISTS saved_views_select ON public.saved_views;
DROP POLICY IF EXISTS saved_views_insert ON public.saved_views;
DROP POLICY IF EXISTS saved_views_update ON public.saved_views;
DROP POLICY IF EXISTS saved_views_delete ON public.saved_views;

CREATE POLICY saved_views_select ON public.saved_views
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (owner_user_id = (SELECT auth.uid()) OR shared)
  );

CREATE POLICY saved_views_insert ON public.saved_views
  FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND owner_user_id = (SELECT auth.uid())
    AND (SELECT public.current_role_rank()) >= 1
    AND (NOT shared OR (SELECT public.current_role_rank()) >= 3)
  );

CREATE POLICY saved_views_update ON public.saved_views
  FOR UPDATE TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      owner_user_id = (SELECT auth.uid())
      OR (shared AND (SELECT public.current_role_rank()) >= 4)
    )
  )
  WITH CHECK (
    account_id = (SELECT public.current_account_id())
    AND (NOT shared OR (SELECT public.current_role_rank()) >= 3)
  );

CREATE POLICY saved_views_delete ON public.saved_views
  FOR DELETE TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      owner_user_id = (SELECT auth.uid())
      OR (shared AND (SELECT public.current_role_rank()) >= 4)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_views TO authenticated;
GRANT SELECT ON public.saved_views TO service_role;
