-- ============================================================
-- 042: per-user conversation visibility
--
-- Until now every member of an account could read every conversation
-- and every message in it. That is wrong for a team of agents each
-- handling their own customers: an agent should see the chats they
-- own or have been given, and nothing else.
--
--   agent / viewer : conversations they created (`user_id`) or are
--                    assigned (`assigned_agent_id`)
--   admin / owner  : everything, and the sole power to hand a
--                    conversation to someone else
--
-- Enforced in RLS rather than in the app because the browser talks to
-- PostgREST directly for the inbox — the conversation list, the
-- message thread and the realtime subscriptions all issue their own
-- queries. A filter added in the UI would be advisory; this is not.
-- It also means Realtime stops delivering postgres_changes for
-- conversations a user cannot see, because it replays RLS per
-- subscriber.
--
-- `messages` has no owner column of its own; its visibility is
-- entirely derived from the conversation it belongs to, which is why
-- both message policies re-enter the same predicate rather than
-- repeating the rule.
-- ============================================================

-- ---------- the predicate ----------

CREATE OR REPLACE FUNCTION public.can_view_conversation(
  p_account_id  UUID,
  p_owner_id    UUID,
  p_assigned_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    -- Admins and owners see the whole account. They are the ones who
    -- triage inbound chats from unknown numbers, which land owned by
    -- whoever connected the channel and would otherwise be invisible
    -- to the agent who should handle them.
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    -- Everyone else: only what is theirs. COALESCE because
    -- `assigned_agent_id` is usually NULL, and NULL = uuid is NULL,
    -- not FALSE — harmless inside a policy but confusing to read.
    WHEN is_account_member(p_account_id) THEN
      COALESCE(p_owner_id = auth.uid(), FALSE)
      OR COALESCE(p_assigned_id = auth.uid(), FALSE)
    ELSE FALSE
  END;
$$;

COMMENT ON FUNCTION public.can_view_conversation(UUID, UUID, UUID) IS
  'Row-visibility rule for conversations and, transitively, messages. Admin+ sees the account; everyone else sees what they own or are assigned. See migration 042.';

-- ---------- conversations ----------

DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations
  FOR SELECT
  USING (can_view_conversation(account_id, user_id, assigned_agent_id));

-- Writes need the agent role AND visibility: marking read, closing,
-- renaming — all only on a conversation you can actually see.
DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations
  FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_view_conversation(account_id, user_id, assigned_agent_id)
  );

DROP POLICY IF EXISTS conversations_delete ON public.conversations;
CREATE POLICY conversations_delete ON public.conversations
  FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_view_conversation(account_id, user_id, assigned_agent_id)
  );

-- ---------- messages ----------

DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id)
    )
  );

DROP POLICY IF EXISTS messages_modify ON public.messages;
CREATE POLICY messages_modify ON public.messages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND is_account_member(c.account_id, 'agent')
        AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id)
    )
  );

-- ---------- who may reassign ----------

-- RLS cannot express "you may update this row but not THAT column":
-- a policy's USING sees the old row and WITH CHECK the new one, never
-- both, so a change of ownership is invisible to it. A trigger can
-- compare them, which is what this does.
CREATE OR REPLACE FUNCTION public.enforce_conversation_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  -- Server-side callers pass straight through. The service role already
  -- bypasses RLS by design, so a trigger that were STRICTER than RLS
  -- would only break trusted paths while stopping no attacker: the AI
  -- hand-off assigning a thread to the configured human agent
  -- (lib/ai/auto-reply.ts), the webhook, and migrations all run without
  -- an end-user JWT. `auth.uid()` is NULL in exactly those contexts.
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Admins hand work to anyone; that is the triage power the whole
  -- scheme depends on.
  IF is_account_member(NEW.account_id, 'admin') THEN
    RETURN NEW;
  END IF;

  -- A member may take a visible conversation for themselves, or hand
  -- it back. This is the "take over from the AI" button in the thread
  -- banner, which self-assigns, and its counterpart that releases.
  -- Handing it to a THIRD person is an admin decision.
  IF NEW.assigned_agent_id IS NULL OR NEW.assigned_agent_id = auth.uid() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only an admin can assign a conversation to someone else'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS conversations_assignment_guard ON public.conversations;
CREATE TRIGGER conversations_assignment_guard
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_conversation_assignment();

COMMENT ON FUNCTION public.enforce_conversation_assignment() IS
  'Restricts changes to conversations.assigned_agent_id: admins may assign anyone, members may only self-assign or release. See migration 042.';
