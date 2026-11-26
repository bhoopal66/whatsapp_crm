-- 284_chat_integrity.sql
--
-- What a signed-in session may write directly to `conversations` and
-- `messages`: exactly what the app writes with the caller's own client.
-- Everything else goes through the service role or a definer function,
-- after its own checks.
--
--   1. A chat's contact_id and account_id never change from a session.
--   2. A session opens a personal chat only as the "Message from my
--      WhatsApp" flow does: owned by the caller, on the caller's own
--      personal number, for a caller who may send (agent and up).
--   3. messages: a session INSERTs only its own agent message, as the
--      send core writes it, into a chat it may write to; it never
--      UPDATEs or DELETEs a message (statuses, echoes and erasure are
--      written by the service role).
--   4. conversations: a session never DELETEs one. A chat goes with its
--      contact (contacts_open_work_guard and the legal hold apply).
--   5. enforce_conversation_channel (062): taking a chat off the number
--      it is on needs the same admin as moving it to another number.
--
-- "A session" is a statement run directly as `authenticated` or `anon`,
-- which is how PostgREST runs a client's request: the guards are SECURITY
-- INVOKER and read current_user. Foreign-key actions (run as the table
-- owner) and SECURITY DEFINER functions are not a session, so deleting a
-- contact still takes its chats, and removing a number still clears it.
-- Keep them INVOKER: as DEFINER they would refuse nothing.
--
-- The guards are triggers of their own, so re-running 042, 060, 191 or
-- 217 (which would bring the older policies back) does not undo 1-4.
-- Re-running 062 does undo 5: apply 284 after it.

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1, 2. Chats: identity, and opening a personal one
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.conversations_session_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
      RAISE EXCEPTION 'A chat cannot be moved to another contact or workspace'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- The caller reads their own number under RLS, as the app does.
  IF NEW.personal_owner_id IS NOT NULL AND NOT (
       NEW.personal_owner_id IS NOT DISTINCT FROM auth.uid()
       AND public.is_account_member(NEW.account_id, 'agent')
       AND EXISTS (
         SELECT 1 FROM public.whatsapp_config w
          WHERE w.id = NEW.channel_id
            AND w.account_id = NEW.account_id
            AND w.is_personal
            AND w.user_id = NEW.personal_owner_id
       )
     ) THEN
    RAISE EXCEPTION 'A personal chat can only be started by its owner, on their own personal number'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.conversations_session_guard() FROM PUBLIC, anon, authenticated;

-- Fires after conversations_personal_guard (191), by name: its 23514
-- PERSONAL_CHAT refusals, which the app words, still come first.
CREATE OR REPLACE TRIGGER conversations_session_guard
  BEFORE INSERT OR UPDATE OF contact_id, account_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_session_guard();

-- ------------------------------------------------------------
-- 3. Messages: a session adds its own, and nothing else
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.messages_session_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.sender_type IS DISTINCT FROM 'agent'
     OR NEW.sender_id IS NULL
     OR NEW.sender_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You can only record a message you sent yourself'
      USING ERRCODE = '42501';
  END IF;
  -- The rest of the row is what lib/whatsapp/send-message.ts writes;
  -- these columns and values it never does.
  IF NEW.status IS DISTINCT FROM 'sent'
     OR NEW.created_at IS DISTINCT FROM now()
     OR NEW.ai_generated
     OR NEW.interactive_reply_id IS NOT NULL
     OR NEW.media_type IS NOT NULL
     OR NEW.contact_cards IS NOT NULL
     OR NEW.content_type NOT IN ('text', 'template', 'interactive',
                                 'image', 'video', 'document', 'audio') THEN
    RAISE EXCEPTION 'This message has details a person''s send does not carry'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.messages_session_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER messages_session_guard
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_session_guard();

-- Statement level: refused in words, whatever the policies say and
-- however many rows they would have let through.
CREATE OR REPLACE FUNCTION public.session_write_refused()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.session_write_refused() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER messages_session_no_change
  BEFORE UPDATE OR DELETE ON public.messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.session_write_refused(
    'Messages cannot be changed or deleted');

-- 217's messages_modify was FOR ALL. Its write rule is kept, word for
-- word, for INSERT alone. Its read was a narrower messages_select, so
-- reading does not change. A coordinator still writes through
-- messages_coordinator_insert (133).
DO $swap$ BEGIN
DROP POLICY IF EXISTS messages_modify ON public.messages;
DROP POLICY IF EXISTS messages_insert ON public.messages;
CREATE POLICY messages_insert ON public.messages
  FOR INSERT
  WITH CHECK (
    sender_type = 'agent'
    AND sender_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
        FROM public.conversations c
       WHERE c.id = messages.conversation_id
         AND c.account_id = (SELECT public.current_account_id())
         AND (SELECT public.current_role_rank()) >= 2
         AND (
           (SELECT public.current_role_rank()) >= 4
           OR CASE
             WHEN c.personal_owner_id IS NULL THEN
               c.user_id IN (SELECT public.contact_visibility_people())
               OR c.assigned_agent_id IN (SELECT public.contact_visibility_people())
               OR c.channel_id IN (SELECT public.personal_number_visible_ids())
             ELSE
               c.personal_owner_id IN (SELECT public.contact_visibility_people())
           END
         )
    )
  );
END $swap$;

-- ------------------------------------------------------------
-- 4. Chats are not deleted from a session
-- ------------------------------------------------------------
CREATE OR REPLACE TRIGGER conversations_session_no_delete
  BEFORE DELETE ON public.conversations
  FOR EACH STATEMENT EXECUTE FUNCTION public.session_write_refused(
    'Chats cannot be deleted; delete the contact instead');

DROP POLICY IF EXISTS conversations_delete ON public.conversations;

-- ------------------------------------------------------------
-- 5. The number a chat is on (062's body; only the clearing differs)
-- DEFINER, unlike 062's: a number the caller cannot read must not look
-- like one that was removed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_conversation_channel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.channel_id IS NOT DISTINCT FROM OLD.channel_id THEN
    RETURN NEW;
  END IF;

  -- The webhooks move a thread to the number the customer wrote to,
  -- on the service role. See 042.
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- set_conversation_send_channel() switching a chat back to automatic
  -- catches its number up with the customer's last inbound message —
  -- the same move the webhook would have made. It validated the caller
  -- itself and is the only place this flag is raised.
  IF COALESCE(current_setting('app.send_channel_switch', TRUE), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- No number: a new chat that has none yet, or the foreign key's SET
  -- NULL after the number itself was removed (run as whoever removed
  -- it). Taking a chat off a number that still exists is a move like
  -- any other and falls through. Two IFs: OLD is not there on INSERT.
  IF NEW.channel_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_config w WHERE w.id = OLD.channel_id) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF is_account_member(NEW.account_id, 'admin') THEN
    RETURN NEW;
  END IF;

  -- Filling in an empty number (the send core does this on an
  -- agent-initiated first message) — only with a number the caller may
  -- use, or the stamp itself would grant them another team's number.
  IF (TG_OP = 'INSERT' OR OLD.channel_id IS NULL)
     AND can_use_channel(NEW.account_id, NEW.channel_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only an admin can move a conversation to another WhatsApp number'
    USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_conversation_channel() FROM PUBLIC, anon, authenticated;

RESET lock_timeout;
