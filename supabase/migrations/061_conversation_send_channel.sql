-- ============================================================
-- 061_conversation_send_channel
--
-- Lets a person working a chat choose which WhatsApp number it sends
-- from — mid-conversation, on any existing chat — and records the
-- switch in the thread so everyone reading it can see what happened.
--
-- ─── The model ────────────────────────────────────────────────────
--
-- `conversations.send_channel_id` is a MANUAL pin:
--
--   * NULL (every existing chat, and every new one) = automatic, the
--     pre-061 behaviour: replies go out on the number the customer last
--     wrote to (`resolveSendChannel`).
--   * set = every outbound message in this chat — agent replies, API
--     replies, and the bots answering in it — goes out on that number
--     until someone changes it again. It is never set or cleared by the
--     system; only a person does that.
--
-- Who may pin what: the numbers they may use — every number for an
-- admin; for anyone else, the numbers they are allocated to plus the
-- shared ones (no allocation at all, see 060). Enforced here by
-- trigger, not just in the UI.
--
-- While a chat is pinned:
--
--   * inbound no longer moves `conversations.channel_id` (060). The chat
--     stays with the team that had it; a customer answering on the new
--     number must not pull it away from the agent who just moved them
--     there.
--   * the pinned number's own people can see it too (the visibility
--     rule below), since messages on their number are arriving in it.
--
-- `conversation_events` is the thread's record of the switch. It is a
-- table of its own rather than a row in `messages` on purpose: messages
-- feed the AI's context, unread counts, the dashboard aggregates, the
-- outbound webhooks and the public API, and a system note must reach
-- none of them.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. The pin
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS send_channel_id UUID
  REFERENCES public.whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_send_channel
  ON public.conversations (send_channel_id) WHERE send_channel_id IS NOT NULL;

COMMENT ON COLUMN public.conversations.send_channel_id IS
  'Manual "send from" number chosen by a person in the thread (migration 061). NULL = automatic: reply on the number the customer last wrote to. Disconnecting the number returns the chat to automatic.';

-- ============================================================
-- 2. May the caller use this number?
-- ============================================================

-- SECURITY DEFINER: reads allocations and the channel's account without
-- the caller's RLS getting in the way, like is_channel_member (060).
CREATE OR REPLACE FUNCTION public.can_use_channel(
  p_account_id UUID,
  p_channel_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_config w
    WHERE w.id = p_channel_id
      AND w.account_id = p_account_id
  )
  AND is_account_member(p_account_id)
  AND (
    is_account_member(p_account_id, 'admin')
    -- A shared number: nobody is allocated, so everyone may use it.
    OR NOT EXISTS (
      SELECT 1 FROM whatsapp_channel_members m WHERE m.config_id = p_channel_id
    )
    OR is_channel_member(p_channel_id)
  );
$$;

REVOKE ALL ON FUNCTION public.can_use_channel(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_channel(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.can_use_channel(UUID, UUID) IS
  'May the calling user send from this number? Admins: any number on the account. Others: numbers they are allocated to, and shared numbers (no allocation). See migration 061.';

CREATE OR REPLACE FUNCTION public.enforce_conversation_send_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.send_channel_id IS NOT DISTINCT FROM OLD.send_channel_id THEN
    RETURN NEW;
  END IF;

  -- Server-side callers pass straight through, as in 042/060. That
  -- includes the FK's ON DELETE SET NULL when a number is disconnected.
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Back to automatic: anyone who may update the chat at all.
  IF NEW.send_channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF can_use_channel(NEW.account_id, NEW.send_channel_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'You do not have access to send from that WhatsApp number'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS conversations_send_channel_guard ON public.conversations;
CREATE TRIGGER conversations_send_channel_guard
  BEFORE UPDATE OF send_channel_id ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_conversation_send_channel();

-- ============================================================
-- 3. conversation_events — the switch, as the thread shows it
-- ============================================================

CREATE TABLE IF NOT EXISTS public.conversation_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  -- A CHECK, not an enum, so a new kind is a one-line swap (as in 046).
  kind            TEXT NOT NULL CHECK (kind IN ('channel_switched')),
  actor_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  from_channel_id UUID REFERENCES public.whatsapp_config(id) ON DELETE SET NULL,
  -- NULL = switched back to automatic.
  to_channel_id   UUID REFERENCES public.whatsapp_config(id) ON DELETE SET NULL,
  -- Names as they were at the time, so the note still reads correctly
  -- after a rename or a disconnect nulls the ids above.
  from_label      TEXT,
  to_label        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation
  ON public.conversation_events (conversation_id, created_at);

ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;

-- Visible exactly when the conversation is: the sub-select runs under
-- conversations' own RLS, so this inherits 042/044/060/061 unchanged.
DROP POLICY IF EXISTS conversation_events_select ON public.conversation_events;
CREATE POLICY conversation_events_select ON public.conversation_events
  FOR SELECT USING (
    account_id = (SELECT current_account_id())
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_events.conversation_id
    )
  );

-- No INSERT/UPDATE/DELETE policy: clients cannot write notes directly.
-- The only writer is set_conversation_send_channel() below.
DROP POLICY IF EXISTS conversation_events_insert ON public.conversation_events;

COMMENT ON TABLE public.conversation_events IS
  'Thread timeline notes that are not messages (migration 061): currently only "sending number switched". Never sent to the customer, never counted as a message.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_events;
  END IF;
END $$;

-- ============================================================
-- 4. The switch itself: pin + note, atomically
-- ============================================================

-- SECURITY DEFINER, with every check spelled out. It cannot simply run
-- as the caller: an agent who sees a chat ONLY because it is pinned to
-- their number loses sight of it the moment they switch it elsewhere,
-- and RLS would then reject their own UPDATE (the new row fails the
-- policy's implicit WITH CHECK) with an error nobody could act on.
-- The switch is theirs to make; seeing the chat afterwards is not.
CREATE OR REPLACE FUNCTION public.set_conversation_send_channel(
  p_conversation_id UUID,
  p_channel_id      UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_conv   conversations%ROWTYPE;
  v_from   UUID;
  v_event  UUID;
BEGIN
  SELECT * INTO v_conv FROM conversations
   WHERE id = p_conversation_id
     AND account_id = current_account_id()
   FOR UPDATE;
  -- Not found, and not visible, read the same: no probing other chats.
  IF NOT FOUND
     OR NOT (
       current_role_rank() >= 4
       OR can_view_conversation(
            v_conv.account_id, v_conv.user_id, v_conv.assigned_agent_id,
            v_conv.channel_id, v_conv.send_channel_id)
     ) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
  END IF;

  -- Same bar as conversations_update: agent and up. Viewers read only.
  IF current_role_rank() < 2 THEN
    RAISE EXCEPTION 'You cannot change this conversation' USING ERRCODE = '42501';
  END IF;

  IF p_channel_id IS NOT NULL
     AND NOT can_use_channel(v_conv.account_id, p_channel_id) THEN
    RAISE EXCEPTION 'You do not have access to send from that WhatsApp number'
      USING ERRCODE = '42501';
  END IF;

  IF v_conv.send_channel_id IS NOT DISTINCT FROM p_channel_id THEN
    RETURN NULL;
  END IF;

  -- What the chat was effectively using before: the pin, else the
  -- number it is on.
  v_from := COALESCE(v_conv.send_channel_id, v_conv.channel_id);

  UPDATE conversations
     SET send_channel_id = p_channel_id,
         updated_at = NOW()
   WHERE id = p_conversation_id;

  INSERT INTO conversation_events (
    account_id, conversation_id, kind, actor_user_id,
    from_channel_id, to_channel_id, from_label, to_label
  )
  SELECT
    v_conv.account_id, p_conversation_id, 'channel_switched', auth.uid(),
    v_from, p_channel_id,
    (SELECT COALESCE(label, waba_id, phone_number_id) FROM whatsapp_config WHERE id = v_from),
    (SELECT COALESCE(label, waba_id, phone_number_id) FROM whatsapp_config WHERE id = p_channel_id)
  RETURNING id INTO v_event;

  RETURN v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.set_conversation_send_channel(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_send_channel(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.set_conversation_send_channel(UUID, UUID) IS
  'Pin (or with NULL, un-pin) the number a chat sends from, and record the switch in conversation_events. Checks visibility, role and number access itself; see migration 061.';

-- ============================================================
-- 5. Visibility: the pinned number's people see the chat too
-- ============================================================

CREATE OR REPLACE FUNCTION public.can_view_conversation(
  p_account_id      UUID,
  p_owner_id        UUID,
  p_assigned_id     UUID,
  p_channel_id      UUID,
  p_send_channel_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN can_view_conversation(p_account_id, p_owner_id, p_assigned_id, p_channel_id) THEN TRUE
    WHEN p_send_channel_id IS NOT NULL
      AND is_account_member(p_account_id)
      AND is_channel_member(p_send_channel_id) THEN TRUE
    ELSE FALSE
  END;
$$;

COMMENT ON FUNCTION public.can_view_conversation(UUID, UUID, UUID, UUID, UUID) IS
  'The 060 rule plus migration 061: members allocated to the number a chat is pinned to send from see it too.';

-- Identical to 060 plus the one WHEN marked below.
CREATE OR REPLACE FUNCTION public.can_view_contact(
  p_account_id UUID,
  p_contact_id UUID,
  p_creator_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    WHEN NOT is_account_member(p_account_id) THEN FALSE
    WHEN COALESCE(p_creator_id = auth.uid(), FALSE) THEN TRUE
    WHEN EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.contact_id = p_contact_id
        AND (c.user_id = auth.uid() OR c.assigned_agent_id = auth.uid())
    ) THEN TRUE
    WHEN EXISTS (
      SELECT 1
      FROM conversations c
      JOIN whatsapp_channel_members wcm ON wcm.config_id = c.channel_id
      WHERE c.contact_id = p_contact_id
        AND wcm.user_id = auth.uid()
    ) THEN TRUE
    -- 061: a contact whose chat is pinned to a number I am allocated to.
    WHEN EXISTS (
      SELECT 1
      FROM conversations c
      JOIN whatsapp_channel_members wcm ON wcm.config_id = c.send_channel_id
      WHERE c.contact_id = p_contact_id
        AND wcm.user_id = auth.uid()
    ) THEN TRUE
    WHEN is_account_member(p_account_id, 'team_leader')
      AND (
        leads_teammate(p_account_id, p_creator_id)
        OR EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.contact_id = p_contact_id
            AND (
              leads_teammate(p_account_id, c.user_id)
              OR leads_teammate(p_account_id, c.assigned_agent_id)
            )
        )
      ) THEN TRUE
    ELSE FALSE
  END;
$$;

DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_conversation(account_id, user_id, assigned_agent_id, channel_id, send_channel_id)
    )
  );

DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_conversation(account_id, user_id, assigned_agent_id, channel_id, send_channel_id)
    )
  );

DROP POLICY IF EXISTS conversations_delete ON public.conversations;
CREATE POLICY conversations_delete ON public.conversations
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_conversation(account_id, user_id, assigned_agent_id, channel_id, send_channel_id)
    )
  );

DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id)
        )
    )
  );

DROP POLICY IF EXISTS messages_modify ON public.messages;
CREATE POLICY messages_modify ON public.messages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND c.account_id = (SELECT current_account_id())
        AND (SELECT current_role_rank()) >= 2
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id)
        )
    )
  );

DROP POLICY IF EXISTS flow_runs_select ON public.flow_runs;
CREATE POLICY flow_runs_select ON public.flow_runs FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = flow_runs.conversation_id
        AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id)
    )
  );
