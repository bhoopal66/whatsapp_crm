-- ============================================================
-- 169_contact_follows_assignment.sql — assigning a chat moves its
-- contact to that person; the contact keeps who created it.
--
-- contacts.user_id has meant two things: who created the contact and
-- whose contact it is (043's can_view_contact creator branch, the
-- Contacts screens' "my contacts", PBX missed-call tasks). The product
-- rule is now that a contact belongs to whoever its chat is assigned
-- to, so user_id becomes the owner and moves; the creator is saved in
-- a new column that nothing ever moves:
--
--   contacts.created_by   who created the contact: the signed-in
--                         person who inserted it, else (the service
--                         role: inbound, the API, imports by a job) the
--                         user_id it was created for. Frozen on every
--                         UPDATE by
--                         contacts_created_by_guard (any writer, the
--                         service role included). Existing rows take
--                         their current user_id once, below. Plain
--                         uuid, no FK: deleting the creator's login
--                         must neither delete the contact nor blank
--                         the record, and an FK action would be an
--                         UPDATE the guard has to refuse.
--
--   conversations_move_contact_owner
--                         after a chat's assigned_agent_id is set to a
--                         person (INSERT or a change, from any writer:
--                         the inbox header, Take over, automations,
--                         flows, the API), sets the contact's user_id
--                         to that person. Only a live staff profile in
--                         the chat's own account is moved to (never a
--                         bank guest or a deactivated member).
--                         Unassigning leaves the contact where it is.
--                         Only the chat's own contact moves: an UPDATE
--                         that also changes contact_id moves nothing,
--                         or an agent could re-point a chat they see at
--                         any contact and take it in the same write.
--                         Like 080's tag→deal trigger it never blocks
--                         the assignment: a failure is a WARNING.
--
-- Who may assign whom is unchanged (042/044's enforce_conversation_
-- assignment runs BEFORE this and refuses first). The move runs as the
-- definer because the assigner need not be able to update the contact
-- under RLS (a leader handing a teammate's chat on).
--
-- created_by is not shown anywhere; it is a record only.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, a backfill that only fills
-- NULLs, CREATE OR REPLACE and DROP/CREATE TRIGGER.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS created_by UUID;

COMMENT ON COLUMN public.contacts.created_by IS
  'Who created the contact (the inserting user, else user_id at insert). Never changes; user_id is the current owner and follows chat assignment (migration 169).';

-- Backfill before the guard exists. Only set_updated_at fires on this
-- column (every other contacts trigger names its columns), and a
-- backfill must not make every contact look freshly edited, so it is
-- switched off for this one statement block and on again; the DO
-- block is one transaction, so a failure leaves it on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE created_by IS NULL) THEN
    ALTER TABLE public.contacts DISABLE TRIGGER set_updated_at;
    UPDATE public.contacts SET created_by = user_id WHERE created_by IS NULL;
    ALTER TABLE public.contacts ENABLE TRIGGER set_updated_at;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.contacts_created_by_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(auth.uid(), NEW.user_id);
  ELSE
    NEW.created_by := OLD.created_by;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.contacts_created_by_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS contacts_created_by_guard ON public.contacts;
CREATE TRIGGER contacts_created_by_guard
  BEFORE INSERT OR UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_created_by_guard();

CREATE OR REPLACE FUNCTION public.conversations_move_contact_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.contact_id IS NULL OR NEW.assigned_agent_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = NEW.assigned_agent_id
      AND p.account_id = NEW.account_id
      AND p.deactivated_at IS NULL
      AND p.account_role <> 'bank_guest'
  ) THEN
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE public.contacts
       SET user_id = NEW.assigned_agent_id
     WHERE id = NEW.contact_id
       AND account_id = NEW.account_id
       AND user_id IS DISTINCT FROM NEW.assigned_agent_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '169: contact % was not moved to %: %',
      NEW.contact_id, NEW.assigned_agent_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.conversations_move_contact_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS conversations_move_contact_owner ON public.conversations;
CREATE TRIGGER conversations_move_contact_owner
  AFTER UPDATE OF assigned_agent_id ON public.conversations
  FOR EACH ROW
  WHEN (NEW.assigned_agent_id IS NOT NULL
        AND NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id)
  EXECUTE FUNCTION public.conversations_move_contact_owner();

DROP TRIGGER IF EXISTS conversations_move_contact_owner_ins ON public.conversations;
CREATE TRIGGER conversations_move_contact_owner_ins
  AFTER INSERT ON public.conversations
  FOR EACH ROW
  WHEN (NEW.assigned_agent_id IS NOT NULL)
  EXECUTE FUNCTION public.conversations_move_contact_owner();
