-- ============================================================
-- 326 — A reply that later fails restarts the customer's wait.
--
-- 237's messages_response_waiting trigger runs on INSERT only: a reply
-- saved as 'sending' or 'sent' ends the waiting episode at once. When
-- the gateway later reports that reply 'failed', nothing put the wait
-- back, so the customer looked answered when nobody had reached them.
--
-- This adds an AFTER UPDATE OF status trigger on messages for agent and
-- bot messages whose status crosses into or out of 'failed':
--
--   * Into 'failed': the chat waits again as if that reply had never
--     been sent, from 237's own definition (its backfill): the first
--     customer message after the last reply that did not fail. So the
--     clock starts at the customer's original unanswered message, not
--     at the failure. Only when that message is older than the failed
--     reply (a failure of a reply older than a newer good one restarts
--     nothing), only on an open company chat, and the start only ever
--     moves earlier.
--   * Out of 'failed' (291: a later delivered/read corrects it): the
--     reply went out after all, so the wait it ended is ended again: the
--     start moves to the first customer message after the last good
--     reply, or clears when there is none. Only a reply at or after the
--     current start, and the start only ever moves later.
--
-- An episode restarted at its original start keeps 237's escalation
-- ledger key (conversation, waiting_since, level), so a level that
-- already rang for it does not ring twice; a level not yet reached rings
-- on the next sweep, which may be at once.
--
-- Like 237's trigger it never fails the statement: any error is a
-- WARNING. It raises 237's app.response_waiting flag for its own UPDATE
-- (conversations_waiting_guard).
--
-- Re-runnable: CREATE OR REPLACE of a function this file owns, DROP
-- TRIGGER IF EXISTS then CREATE. Needs 237. Nothing of 237 is restated.
-- Asserted by supabase/ci/verify-failed-reply-waiting.sql.
-- ============================================================

CREATE OR REPLACE FUNCTION public.response_reply_status_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_since timestamptz;
BEGIN
  IF NEW.conversation_id IS NULL OR NEW.sender_type = 'customer' THEN
    RETURN NULL;
  END IF;
  BEGIN
    -- 237's definition: the first customer message after the last reply
    -- that did not fail (this row's new status included).
    SELECT min(m.created_at) INTO v_since
      FROM public.messages m
     WHERE m.conversation_id = NEW.conversation_id
       AND m.sender_type = 'customer'
       AND m.created_at > coalesce(
             (SELECT max(r.created_at)
                FROM public.messages r
               WHERE r.conversation_id = NEW.conversation_id
                 AND r.sender_type <> 'customer'
                 AND r.status IS DISTINCT FROM 'failed'),
             '-infinity'::timestamptz);

    PERFORM set_config('app.response_waiting', 'on', true);
    IF NEW.status = 'failed' THEN
      UPDATE public.conversations c
         SET customer_waiting_since = v_since
       WHERE c.id = NEW.conversation_id
         AND v_since IS NOT NULL
         AND v_since < NEW.created_at
         AND (c.customer_waiting_since IS NULL OR v_since < c.customer_waiting_since)
         AND c.personal_owner_id IS NULL
         AND c.status <> 'closed';
    ELSE
      UPDATE public.conversations c
         SET customer_waiting_since = v_since
       WHERE c.id = NEW.conversation_id
         AND c.customer_waiting_since IS NOT NULL
         AND NEW.created_at >= c.customer_waiting_since
         AND (v_since IS NULL OR v_since > c.customer_waiting_since);
    END IF;
    PERFORM set_config('app.response_waiting', '', true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'response_reply_status_changed: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.response_reply_status_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_response_waiting_status ON public.messages;
CREATE TRIGGER messages_response_waiting_status
  AFTER UPDATE OF status ON public.messages
  FOR EACH ROW
  WHEN (NEW.sender_type <> 'customer'
        AND coalesce(NEW.status = 'failed', false)
            IS DISTINCT FROM coalesce(OLD.status = 'failed', false))
  EXECUTE FUNCTION public.response_reply_status_changed();

COMMENT ON COLUMN public.conversations.customer_waiting_since IS
  'Since when the customer has been waiting for a reply (237): set by the first customer message after the last reply, cleared by any agent or bot message that did not fail and by closing the chat. A reply that later fails restarts the wait from that first customer message; a failure corrected by a delivery ends it again (326). Company chats only. Read it through conversation_waiting_since(conversations).';
