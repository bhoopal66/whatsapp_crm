-- ============================================================
-- 067_conversation_human_engaged
--
-- Splits campaign chats between the two lists, so each chat is in
-- exactly one. The Campaign inbox (Broadcasts → Campaign inbox,
-- migration 048) holds the chats the bot is answering; the Inbox holds
-- every other one. Until now a campaign chat was listed in both, and
-- stayed in the Campaign inbox for good after a person took it over.
--
-- The bot is answering a chat when all of these hold:
--
--   * it came from a campaign (campaign_broadcast_id);
--   * the AI auto-reply is live on the account — ai_auto_reply_live()
--     below;
--   * the AI has replied in it (ai_reply_count > 0), so a reply the
--     bot never answers — one on a number it does not run on, say —
--     stays in the Inbox for a person;
--   * the bot has not handed it off or been paused on it
--     (ai_autoreply_disabled);
--   * no person has stepped in (human_engaged_at, new here).
--
-- conversations.human_engaged_at is the first moment a person took
-- part in a conversation:
--
--   * it was assigned to anyone — from the inbox, by a Flow hand-off
--     node, by an automation, or by the AI hand-off to its configured
--     agent;
--   * a person sent a message in it: sender_type = 'agent' with a
--     sender_id. Flows, automations and the AI auto-reply write
--     sender_type = 'bot', and API-key sends (Compass notices, the MCP
--     server) carry no sender_id, so none of those counts — the same
--     rule lib/inbox/handler.ts uses to name who is on a chat.
--
-- It is write-once. Releasing the assignment does not put a chat back
-- in the Campaign inbox, and neither does the customer answering a
-- later campaign: a chat a person has been on stays with the people.
-- Triggers stamp it rather than each caller, because a thread is
-- assigned from half a dozen places (the inbox, the AI banner's take
-- over, a new chat an agent starts, Flows, automations, both AI
-- hand-offs) and the send core is not the only writer of agent
-- messages.
--
-- The rule itself lives in lib/inbox/campaign-inbox.ts, as the
-- predicate the lists re-apply to realtime updates and as the filters
-- they query with; ai_auto_reply_live() mirrors the auto-reply's own
-- on-switch (loadAiConfig + auto_reply_enabled) — change one, change
-- both.
--
-- Apply without -1: ALTER TABLE takes the conversations table's
-- exclusive lock, and in one transaction it would be held through the
-- backfill. Statement by statement it is held for a moment.
--
-- Idempotent — safe to re-run.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS human_engaged_at timestamptz;

RESET lock_timeout;

COMMENT ON COLUMN public.conversations.human_engaged_at IS
  'First time a person took part: the chat was assigned, or a person (sender_id set) sent a message. Write-once. The Campaign inbox hides chats with it set. Migration 067.';

-- ---------- assignment, and the write-once rule ----------

-- BEFORE, so the stamp lands in the same row version — and the same
-- realtime event — as the assignment that caused it; the list drops
-- the chat in the one update.
CREATE OR REPLACE FUNCTION public.stamp_human_engaged_on_assign()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.human_engaged_at IS NOT NULL THEN
    NEW.human_engaged_at := OLD.human_engaged_at;
    RETURN NEW;
  END IF;

  IF NEW.human_engaged_at IS NULL AND NEW.assigned_agent_id IS NOT NULL THEN
    NEW.human_engaged_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_human_engaged ON public.conversations;
CREATE TRIGGER conversations_human_engaged
  BEFORE INSERT OR UPDATE OF assigned_agent_id, human_engaged_at
  ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_human_engaged_on_assign();

-- ---------- a person's message ----------

-- SECURITY DEFINER: this is bookkeeping on a conversation the sender
-- could already write to, and the sender's RLS should not get a say in
-- it — a WITH CHECK failure here would fail the message insert, after
-- WhatsApp had already accepted the send. For the same reason any
-- error is logged and swallowed: losing a stamp costs a chat lingering
-- in the Campaign inbox; losing the message costs the conversation.
CREATE OR REPLACE FUNCTION public.stamp_human_engaged_on_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE conversations
     SET human_engaged_at = COALESCE(NEW.created_at, now())
   WHERE id = NEW.conversation_id
     AND human_engaged_at IS NULL;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not record a person on conversation %: %',
    NEW.conversation_id, SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS messages_human_engaged ON public.messages;
CREATE TRIGGER messages_human_engaged
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.sender_type = 'agent' AND NEW.sender_id IS NOT NULL)
  EXECUTE FUNCTION public.stamp_human_engaged_on_reply();

-- ---------- whether the bot is on ----------

-- Both lists need to know whether the AI auto-reply is live: switched
-- off, it is answering nothing, and every campaign chat belongs in the
-- Inbox. ai_configs is admin-only (057), so this answers that one
-- question for any member, about their own account, and returns
-- nothing else. Mirrors the auto-reply's own check: loadAiConfig (a
-- row, is_active, a key) and then auto_reply_enabled.
CREATE OR REPLACE FUNCTION public.ai_auto_reply_live()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM ai_configs a
     WHERE a.account_id = current_account_id()
       AND a.is_active
       AND a.auto_reply_enabled
       AND COALESCE(a.api_key, '') <> ''
  )
$$;

REVOKE ALL ON FUNCTION public.ai_auto_reply_live() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_auto_reply_live() TO authenticated, service_role;

-- ---------- chats people are already on ----------

-- After the triggers, so anything that happens while this runs is
-- caught by one or the other. The first message a person sent dates
-- the stamp; an assignment carries no date, so a chat that was only
-- ever assigned is stamped with the moment this ran.
UPDATE public.conversations c
   SET human_engaged_at = COALESCE(
         (SELECT min(m.created_at)
            FROM public.messages m
           WHERE m.conversation_id = c.id
             AND m.sender_type = 'agent'
             AND m.sender_id IS NOT NULL),
         now())
 WHERE c.human_engaged_at IS NULL
   AND (c.assigned_agent_id IS NOT NULL
        OR EXISTS (
          SELECT 1
            FROM public.messages m
           WHERE m.conversation_id = c.id
             AND m.sender_type = 'agent'
             AND m.sender_id IS NOT NULL));
