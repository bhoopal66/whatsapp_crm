-- ============================================================
-- 060_whatsapp_channel_access
--
-- More than one Whapi number per account, each with a name and an
-- optional list of the people who work it.
--
-- ─── Why ──────────────────────────────────────────────────────────
--
-- 046 allowed one Whapi channel and one Meta number, and said a second
-- channel of the same provider was out of scope "without a capability
-- anyone asked for". It has now been asked for: a business runs two
-- WhatsApp numbers (say, Sales and Support), and each is worked by its
-- own people. That needs three things 046 did not have:
--
--   1. several `provider = 'whapi'` rows per account;
--   2. a record of WHICH number each conversation and message is on —
--      `provider` alone stops identifying the number once two rows
--      share it;
--   3. an allocation list per number, which is what lets the people on
--      it see its chats and start new ones from it.
--
-- ─── What "allocated" means ───────────────────────────────────────
--
--   * A number with NO allocation rows is shared, exactly as before
--     this migration. Nothing changes for an install that never opens
--     the new screen.
--   * A number WITH allocation rows: every member on it can see every
--     conversation on that number (a shared inbox for the number), on
--     top of whatever 042/044 already let them see. It is also the
--     number their new chats start from.
--   * Admins and owners still see everything.
--
-- It grants; it never hides. An agent who is assigned a chat on a
-- number they are not allocated to still sees that chat — assignment is
-- an admin's explicit decision and 042 already honours it.
--
-- Conversations stay ONE PER CONTACT (see 046 for why). A conversation's
-- `channel_id` is the number the customer last wrote to, so a contact
-- who switches numbers moves to that number's people.
--
-- The Meta number stays one per account: the template registry, the
-- cost ledger and the Meta webhook all key on "the" WABA, and nobody
-- has asked for two.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. whatsapp_config: many Whapi rows, still one Meta row
-- ============================================================

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_provider_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_meta
  ON public.whatsapp_config (account_id)
  WHERE provider = 'meta';

-- Losing the (account_id, provider) UNIQUE also lost its index, which
-- every per-account channel lookup used.
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account
  ON public.whatsapp_config (account_id);

COMMENT ON COLUMN public.whatsapp_config.label IS
  'Operator-facing name for this number ("Sales", "Support"), shown in the routing selector, the Numbers screen and the inbox. NULL falls back to the phone number.';

-- ============================================================
-- 2. whatsapp_channel_members — who works each number
-- ============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_channel_members (
  config_id  UUID NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (config_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_channel_members_user
  ON public.whatsapp_channel_members (user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_channel_members_account
  ON public.whatsapp_channel_members (account_id);

ALTER TABLE public.whatsapp_channel_members ENABLE ROW LEVEL SECURITY;

-- Readable by any member: the composer and the contact screen need to
-- know which number the signed-in user's new chats start from, and the
-- list says nothing about customers. Written by admins only — same
-- ladder as the channel itself.
DROP POLICY IF EXISTS whatsapp_channel_members_select ON public.whatsapp_channel_members;
CREATE POLICY whatsapp_channel_members_select ON public.whatsapp_channel_members
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_channel_members_modify ON public.whatsapp_channel_members;
CREATE POLICY whatsapp_channel_members_modify ON public.whatsapp_channel_members
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

COMMENT ON TABLE public.whatsapp_channel_members IS
  'Members allocated to a WhatsApp number. No rows = the number is shared. Rows = those members see every conversation on it and start new chats from it. See migration 060.';

-- ============================================================
-- 3. Which number a conversation / message is on
-- ============================================================

-- ON DELETE SET NULL: disconnecting a number must never delete chat
-- history. A NULL channel is simply "not on any allocated number", so
-- visibility falls back to 042/044 ownership.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS channel_id UUID
  REFERENCES public.whatsapp_config(id) ON DELETE SET NULL;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS channel_id UUID
  REFERENCES public.whatsapp_config(id) ON DELETE SET NULL;

-- The FK's SET NULL on delete scans by channel_id, and the visibility
-- predicate below probes conversations by it.
CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON public.conversations (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_channel
  ON public.messages (channel_id) WHERE channel_id IS NOT NULL;

COMMENT ON COLUMN public.conversations.channel_id IS
  'The number this conversation is on: the one the customer last wrote to, or for an agent-initiated thread the one it was started from. Drives channel-allocation visibility (migration 060).';

COMMENT ON COLUMN public.messages.channel_id IS
  'Exact whatsapp_config row that carried this message. NULL for messages predating migration 060, where `provider` is the only record.';

-- Backfill conversations from the provider of their last inbound
-- message. Before this migration an account held at most one row per
-- provider, so provider → row is unambiguous; the HAVING keeps it that
-- way on a re-run after a second Whapi number has been connected.
WITH last_inbound AS (
  SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.provider
  FROM public.messages m
  WHERE m.sender_type = 'customer' AND m.provider IS NOT NULL
  ORDER BY m.conversation_id, m.created_at DESC
),
sole_channel AS (
  SELECT account_id, provider, (array_agg(id))[1] AS id
  FROM public.whatsapp_config
  GROUP BY account_id, provider
  HAVING count(*) = 1
)
UPDATE public.conversations c
   SET channel_id = s.id
  FROM last_inbound li, sole_channel s
 WHERE c.channel_id IS NULL
   AND li.conversation_id = c.id
   AND s.account_id = c.account_id
   AND s.provider = li.provider;

-- ============================================================
-- 4. Visibility
-- ============================================================

-- SECURITY DEFINER for the same reason as leads_teammate (044): called
-- from inside policies, it must answer the plain question.
CREATE OR REPLACE FUNCTION public.is_channel_member(p_channel_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_channel_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM whatsapp_channel_members
    WHERE config_id = p_channel_id
      AND user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_channel_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_channel_member(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.is_channel_member(UUID) IS
  'True when the calling user is allocated to this WhatsApp number. See migration 060.';

-- The 3-argument rule (042/044) is unchanged and still the core; this
-- overload adds the one new grant on top of it rather than restating
-- it, so the two cannot drift.
CREATE OR REPLACE FUNCTION public.can_view_conversation(
  p_account_id  UUID,
  p_owner_id    UUID,
  p_assigned_id UUID,
  p_channel_id  UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN can_view_conversation(p_account_id, p_owner_id, p_assigned_id) THEN TRUE
    -- On a number I am allocated to.
    WHEN p_channel_id IS NOT NULL
      AND is_account_member(p_account_id)
      AND is_channel_member(p_channel_id) THEN TRUE
    ELSE FALSE
  END;
$$;

COMMENT ON FUNCTION public.can_view_conversation(UUID, UUID, UUID, UUID) IS
  'The 042/044 rule plus migration 060: members allocated to the conversation''s WhatsApp number see it too.';

-- Contacts: the inbox list embeds the contact, so a chat visible on an
-- allocated number has to bring its contact along or the row renders
-- nameless. Identical to 044 plus the one WHEN marked below.
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
    -- 060: a contact whose chat is on a number I am allocated to.
    WHEN EXISTS (
      SELECT 1
      FROM conversations c
      JOIN whatsapp_channel_members wcm ON wcm.config_id = c.channel_id
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

-- ---------- policies: the 059 shapes, now passing channel_id ----------

DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_conversation(account_id, user_id, assigned_agent_id, channel_id)
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
      OR can_view_conversation(account_id, user_id, assigned_agent_id, channel_id)
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
      OR can_view_conversation(account_id, user_id, assigned_agent_id, channel_id)
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
          OR can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id)
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
          OR can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id)
        )
    )
  );

-- 057's flow_runs scoping follows the conversation it belongs to.
DROP POLICY IF EXISTS flow_runs_select ON public.flow_runs;
CREATE POLICY flow_runs_select ON public.flow_runs FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = flow_runs.conversation_id
        AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id)
    )
  );

-- ---------- who may move a conversation to another number ----------

-- Moving a thread onto an allocated number shares it with everyone on
-- that number, which is the same kind of decision as assigning it to
-- someone (042) — so it gets the same guard. A member may stamp the
-- number on a thread that has none (the send core does exactly that on
-- an agent-initiated first message); re-pointing one is admin-only.
CREATE OR REPLACE FUNCTION public.enforce_conversation_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.channel_id IS NOT DISTINCT FROM OLD.channel_id
     OR OLD.channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The inbound webhook re-points a thread to whichever number the
  -- customer just wrote to; it runs on the service role. See 042.
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF is_account_member(NEW.account_id, 'admin') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only an admin can move a conversation to another WhatsApp number'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS conversations_channel_guard ON public.conversations;
CREATE TRIGGER conversations_channel_guard
  BEFORE UPDATE OF channel_id ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_conversation_channel();
