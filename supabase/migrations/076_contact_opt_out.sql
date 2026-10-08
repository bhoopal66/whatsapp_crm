-- ============================================================
-- 076: a contact's opt-out is a column, not a contact tag
--
-- When a customer asks not to be messaged ("stop", "unsubscribe"),
-- the AI bot and the TypeSafe opt-out watch record it by tagging the
-- contact `opted-out`. Nothing reads that tag: a broadcast whose
-- audience happens to include the contact still messages them. And
-- the contact tags (`tags` / `contact_tags`) are being retired in
-- favour of chat tags (migration 075), so the request needs a home
-- that outlives them.
--
-- contacts.opted_out_at records when the customer asked. NULL means
-- they never did. Every broadcast skips a contact with a stamp, and
-- the bot and the watch write the stamp instead of the tag.
--
-- Backfill, once: a contact already carrying a tag named `opted-out`
-- (any case — the tag was created by name, and an admin may have
-- made one by hand) gets the time that tag was first attached, or now()
-- when the join has no timestamp. Only NULL stamps are filled, so a
-- re-run changes nothing and never moves an existing stamp.
--
-- `tags` and `contact_tags` are left exactly as they are; a later
-- migration retires them.
--
-- Only an admin changes it. contacts_update (059) lets any agent update
-- a contact they can see, and a screen that writes a whole contact row
-- back would carry the stamp with it — so without a guard an agent, or
-- a stale form, could clear a customer's request to stop and the next
-- broadcast would message them. contacts_opt_out_guard lets the stamp
-- change (or a new contact arrive already stamped) only for the
-- webhooks and server jobs (service role / no signed-in user) and for
-- an admin of the contact's account; anyone else gets 42501. Every
-- other contact field stays as writable as before.
--
-- Re-runnable: ADD COLUMN / CREATE INDEX IF NOT EXISTS, CREATE OR
-- REPLACE / DROP TRIGGER IF EXISTS, and the backfill only touches rows
-- still NULL. The backfill runs before the guard exists and, on a
-- re-run, as the migration owner with no signed-in user, which the
-- guard lets through.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS opted_out_at timestamptz NULL;

COMMENT ON COLUMN public.contacts.opted_out_at IS
  'When the customer asked not to be messaged; every broadcast skips them. NULL = never asked (migration 076).';

-- The tag lives in the contact's own account: tags.account_id
-- (migration 017) is matched, so one account's `opted-out` tag can
-- never stamp another account's contact. A function rather than a bare
-- UPDATE so verify-contact-opt-out.sql can run this exact statement;
-- owner-only, like 073's backfill.
CREATE OR REPLACE FUNCTION public.contacts_opt_out_backfill()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.contacts c
  SET opted_out_at = o.first_tagged_at
  FROM (
    SELECT ct.contact_id,
           COALESCE(min(ct.created_at), now()) AS first_tagged_at
    FROM public.contact_tags ct
    JOIN public.tags t ON t.id = ct.tag_id
    JOIN public.contacts c2 ON c2.id = ct.contact_id
    WHERE lower(t.name) = 'opted-out'
      AND t.account_id = c2.account_id
    GROUP BY ct.contact_id
  ) o
  WHERE c.id = o.contact_id
    AND c.opted_out_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.contacts_opt_out_backfill() FROM PUBLIC, anon, authenticated, service_role;

-- Before the guard below exists, so the first run is never refused.
SELECT public.contacts_opt_out_backfill();

-- Broadcast audiences subtract an account's opted-out contacts; the
-- set is small, so a partial index keeps that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON public.contacts (account_id)
  WHERE opted_out_at IS NOT NULL;

-- Who may change the stamp. supabase/ci/verify-contact-opt-out.sql
-- asserts it.
CREATE OR REPLACE FUNCTION public.contacts_opt_out_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF tg_op = 'UPDATE' THEN
    IF new.opted_out_at IS NOT DISTINCT FROM old.opted_out_at THEN
      RETURN new;
    END IF;
  ELSIF new.opted_out_at IS NULL THEN
    RETURN new;
  END IF;

  -- The bot, the TypeSafe watch and the webhooks stamp it on the
  -- service role; migrations and the SQL editor have no signed-in user.
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN new;
  END IF;

  IF current_role_rank() >= 4 AND new.account_id = current_account_id() THEN
    RETURN new;
  END IF;

  RAISE EXCEPTION 'Only an admin can change whether a customer has opted out'
    USING ERRCODE = '42501';
END
$$;

-- INSERT too: an agent who may not stamp an existing contact may not
-- create one stamped either. A new contact with no stamp, the only
-- kind the app's screens create, is untouched.
DROP TRIGGER IF EXISTS contacts_opt_out_guard ON public.contacts;
CREATE TRIGGER contacts_opt_out_guard
  BEFORE INSERT OR UPDATE OF opted_out_at ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_opt_out_guard();

REVOKE ALL ON FUNCTION public.contacts_opt_out_guard() FROM PUBLIC, anon, authenticated, service_role;
