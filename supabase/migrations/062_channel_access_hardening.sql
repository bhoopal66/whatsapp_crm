-- ============================================================
-- 062_channel_access_hardening
--
-- Fixes from a review of 060 (numbers per account, allocation) and 061
-- (per-chat sending number). No behaviour an honest user relies on
-- changes; each item closes a way to get around the rules those two
-- migrations meant to set.
--
--   1. Cross-account references. Nothing tied an allocation row, or a
--      conversation's channel_id / send_channel_id, to a number in the
--      SAME account. An admin of account A could allocate a user of
--      account B to B's number (granting them B's chats), and a planted
--      foreign id on a conversation made the owning account's own
--      "disconnect number" fail in the channel guard. Composite foreign
--      keys to whatsapp_config(id, account_id) make both impossible.
--
--   2. The guards ran on UPDATE only. An agent could INSERT a
--      conversation already on (or pinned to) a number they may not
--      use, or stamp an empty channel_id with any number. They now run
--      on INSERT too, and stamping a number requires being able to use
--      it (can_use_channel, 061).
--
--   3. A pin set by a direct UPDATE left no note in the thread. A pin
--      can now only be set through set_conversation_send_channel(),
--      which records it. Clearing a pin stays open: it is what the FK
--      does when a number is disconnected, and it can only widen who
--      is answered, never narrow it.
--
--   4. A signed-in user could insert a message with
--      sender_type = 'customer', which steers "reply on the number the
--      customer last wrote to". Customer messages come only from the
--      webhooks, on the service role; users may no longer write them.
--
--   5. Allocation lists and the default number were replaced in two
--      separate requests (delete-then-insert; demote-then-promote), so a
--      failure half way — or two admins at once — left a half-applied
--      state. Both are now one transaction each, in a function.
--
--   6. Performance: the visibility check had become three nested,
--      non-inlinable functions (5 → 4 → 3 arguments), roughly doubling
--      the per-row cost for agents. It is one flat function again.
--      flow_runs_select gains 059's index-usable account predicate, and
--      conversation_events' foreign keys get indexes.
--
-- NOTE ON RE-RUNNING: 060 and 061 each redefine the conversation
-- policies. Re-running either one ALONE after this file puts older
-- policy text back; replay the stack in order (as CI does), or re-run
-- this file afterwards.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Same-account references
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_id_account_key'
  ) THEN
    ALTER TABLE public.whatsapp_config
      ADD CONSTRAINT whatsapp_config_id_account_key UNIQUE (id, account_id);
  END IF;
END $$;

-- Rows that would violate the new keys cannot have been created by the
-- app; clear any that exist so the constraints can be added.
DELETE FROM public.whatsapp_channel_members m
 USING public.whatsapp_config w
 WHERE w.id = m.config_id AND w.account_id <> m.account_id;

DELETE FROM public.whatsapp_channel_members m
 WHERE NOT EXISTS (
   SELECT 1 FROM public.profiles p
   WHERE p.user_id = m.user_id AND p.account_id = m.account_id
 );

UPDATE public.conversations c
   SET channel_id = NULL
  FROM public.whatsapp_config w
 WHERE w.id = c.channel_id AND w.account_id <> c.account_id;

UPDATE public.conversations c
   SET send_channel_id = NULL
  FROM public.whatsapp_config w
 WHERE w.id = c.send_channel_id AND w.account_id <> c.account_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_channel_members_config_account_fkey'
  ) THEN
    ALTER TABLE public.whatsapp_channel_members
      ADD CONSTRAINT whatsapp_channel_members_config_account_fkey
      FOREIGN KEY (config_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id) ON DELETE CASCADE;
  END IF;

  -- The single-column FKs from 060/061 are replaced by composite ones.
  -- `ON DELETE SET NULL (col)` (PostgreSQL 15+) nulls only the number,
  -- never account_id.
  ALTER TABLE public.conversations
    DROP CONSTRAINT IF EXISTS conversations_channel_id_fkey;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_account_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_channel_account_fkey
      FOREIGN KEY (channel_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE SET NULL (channel_id);
  END IF;

  ALTER TABLE public.conversations
    DROP CONSTRAINT IF EXISTS conversations_send_channel_id_fkey;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_send_channel_account_fkey'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_send_channel_account_fkey
      FOREIGN KEY (send_channel_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE SET NULL (send_channel_id);
  END IF;
END $$;

-- Allocating someone requires them to be in the account the row is for.
DROP POLICY IF EXISTS whatsapp_channel_members_modify ON public.whatsapp_channel_members;
CREATE POLICY whatsapp_channel_members_modify ON public.whatsapp_channel_members
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = whatsapp_channel_members.user_id
        AND p.account_id = whatsapp_channel_members.account_id
    )
  );

-- The "shared number" test now also scopes by account (defence in
-- depth; the composite FK already guarantees it).
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
    OR NOT EXISTS (
      SELECT 1 FROM whatsapp_channel_members m
      WHERE m.config_id = p_channel_id AND m.account_id = p_account_id
    )
    OR EXISTS (
      SELECT 1 FROM whatsapp_channel_members m
      WHERE m.config_id = p_channel_id
        AND m.account_id = p_account_id
        AND m.user_id = auth.uid()
    )
  );
$$;

-- ============================================================
-- 2 + 3. Guards on INSERT as well as UPDATE
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_conversation_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
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

  -- Clearing is always allowed: it is what disconnecting a number does
  -- (ON DELETE SET NULL, run as whichever admin disconnected it).
  IF NEW.channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- set_conversation_send_channel() switching a chat back to automatic
  -- catches its number up with the customer's last inbound message —
  -- the same move the webhook would have made. It validated the caller
  -- itself and is the only place this flag is raised.
  IF COALESCE(current_setting('app.send_channel_switch', TRUE), '') = 'on' THEN
    RETURN NEW;
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

DROP TRIGGER IF EXISTS conversations_channel_guard ON public.conversations;
CREATE TRIGGER conversations_channel_guard
  BEFORE INSERT OR UPDATE OF channel_id ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_conversation_channel();

CREATE OR REPLACE FUNCTION public.enforce_conversation_send_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.send_channel_id IS NOT DISTINCT FROM OLD.send_channel_id THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Automatic (no pin): always allowed, including the FK's SET NULL.
  IF NEW.send_channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A pin is set only through set_conversation_send_channel(), which
  -- writes the note the thread shows. It raises this flag for the
  -- duration of its own UPDATE.
  IF COALESCE(current_setting('app.send_channel_switch', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION 'Use the number picker in the chat to change its sending number'
      USING ERRCODE = '42501';
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
  BEFORE INSERT OR UPDATE OF send_channel_id ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_conversation_send_channel();

-- Same function as 061, now raising the flag the guard above checks.
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
  IF NOT FOUND
     OR NOT (
       current_role_rank() >= 4
       OR can_view_conversation(
            v_conv.account_id, v_conv.user_id, v_conv.assigned_agent_id,
            v_conv.channel_id, v_conv.send_channel_id)
     ) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
  END IF;

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

  v_from := COALESCE(v_conv.send_channel_id, v_conv.channel_id);

  PERFORM set_config('app.send_channel_switch', 'on', TRUE);
  UPDATE conversations
     SET send_channel_id = p_channel_id,
         -- Back to automatic: while pinned, inbound stopped moving the
         -- chat, so catch its number up with where the customer last
         -- actually wrote (exact number, 060+). Keeps the header's
         -- "Automatic · X" and the team that sees it truthful.
         channel_id = CASE
           WHEN p_channel_id IS NULL THEN COALESCE((
             SELECT m.channel_id FROM messages m
              JOIN whatsapp_config w ON w.id = m.channel_id
                                    AND w.account_id = v_conv.account_id
              WHERE m.conversation_id = p_conversation_id
                AND m.sender_type = 'customer'
                AND m.channel_id IS NOT NULL
              ORDER BY m.created_at DESC
              LIMIT 1
           ), channel_id)
           ELSE channel_id
         END,
         updated_at = NOW()
   WHERE id = p_conversation_id;
  PERFORM set_config('app.send_channel_switch', '', TRUE);

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

-- ============================================================
-- 4. Customer messages come only from the webhooks
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_customer_message_origin()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.sender_type = 'customer'
     AND auth.uid() IS NOT NULL
     AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Customer messages can only be recorded by the WhatsApp webhooks'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_customer_origin_guard ON public.messages;
CREATE TRIGGER messages_customer_origin_guard
  BEFORE INSERT OR UPDATE OF sender_type ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_customer_message_origin();

-- ============================================================
-- 5. One transaction each: allocation list, default number
-- ============================================================

-- SECURITY INVOKER: whatsapp_channel_members' and whatsapp_config's own
-- admin-only RLS still decides; this only makes the change atomic and
-- serialises concurrent edits of the same number on its config row.
CREATE OR REPLACE FUNCTION public.set_channel_members(
  p_config_id UUID,
  p_user_ids  UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID;
  v_ids     UUID[] := COALESCE(p_user_ids, '{}');
BEGIN
  SELECT account_id INTO v_account FROM whatsapp_config
   WHERE id = p_config_id AND account_id = current_account_id()
   FOR UPDATE;
  IF NOT FOUND OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS u(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.account_id = v_account
    )
  ) THEN
    RAISE EXCEPTION 'Every allocated person must be a member of this account'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM whatsapp_channel_members
   WHERE config_id = p_config_id
     AND NOT (user_id = ANY (v_ids));

  INSERT INTO whatsapp_channel_members (config_id, user_id, account_id)
  SELECT p_config_id, u.id, v_account
    FROM (SELECT DISTINCT id FROM unnest(v_ids) AS x(id)) u
  ON CONFLICT (config_id, user_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.set_channel_members(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_channel_members(UUID, UUID[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_primary_channel(p_config_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT account_id INTO v_account FROM whatsapp_config
   WHERE id = p_config_id AND account_id = current_account_id();
  IF NOT FOUND OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;

  -- Demote, then promote: the one-primary partial unique index (046)
  -- is checked per row, so the other order trips it. Both in this one
  -- transaction, so the account is never left without a default.
  UPDATE whatsapp_config SET is_primary = FALSE
   WHERE account_id = v_account AND id <> p_config_id AND is_primary;
  UPDATE whatsapp_config SET is_primary = TRUE
   WHERE id = p_config_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_primary_channel(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_primary_channel(UUID) TO authenticated;

-- ============================================================
-- 6. Performance
-- ============================================================

-- One flat predicate. Same answer as 044 + 060 + 061 combined:
--   admin/owner → everything; non-member → nothing; mine; on or pinned
--   to a number I am allocated to; a team leader's team.
-- SECURITY DEFINER so the allocation probe reads the table directly
-- instead of re-running its RLS policy per row; it depends only on its
-- arguments and auth.uid().
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
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    WHEN NOT is_account_member(p_account_id) THEN FALSE
    WHEN COALESCE(p_owner_id = auth.uid(), FALSE)
      OR COALESCE(p_assigned_id = auth.uid(), FALSE) THEN TRUE
    WHEN (p_channel_id IS NOT NULL OR p_send_channel_id IS NOT NULL)
      AND EXISTS (
        SELECT 1 FROM whatsapp_channel_members m
        WHERE m.user_id = auth.uid()
          AND m.account_id = p_account_id
          AND m.config_id IN (p_channel_id, p_send_channel_id)
      ) THEN TRUE
    WHEN is_account_member(p_account_id, 'team_leader')
      AND (
        leads_teammate(p_account_id, p_owner_id)
        OR leads_teammate(p_account_id, p_assigned_id)
      ) THEN TRUE
    ELSE FALSE
  END;
$$;

-- Executable by every role, as before: the conversation and message
-- policies call it for whoever is querying, and a role without EXECUTE
-- would get a permission error where it used to get an empty result.
-- It answers FALSE for anyone who is not a member of the account.
GRANT EXECUTE ON FUNCTION public.can_view_conversation(UUID, UUID, UUID, UUID, UUID) TO PUBLIC;

-- The 4-argument form (060) is kept for any caller of it, as a thin
-- alias rather than a second copy of the rule.
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
  SELECT can_view_conversation(p_account_id, p_owner_id, p_assigned_id, p_channel_id, NULL);
$$;

-- 057's flow_runs scoping, with 059's account predicate and admin
-- short-circuit so it no longer evaluates every tenant's rows.
DROP POLICY IF EXISTS flow_runs_select ON public.flow_runs;
CREATE POLICY flow_runs_select ON public.flow_runs FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id = flow_runs.conversation_id
          AND can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id)
      )
    )
  );

-- conversation_events: every FK that a number/account/user delete
-- follows needs an index, or the delete scans the table.
CREATE INDEX IF NOT EXISTS idx_conversation_events_account
  ON public.conversation_events (account_id);
CREATE INDEX IF NOT EXISTS idx_conversation_events_from_channel
  ON public.conversation_events (from_channel_id) WHERE from_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_events_to_channel
  ON public.conversation_events (to_channel_id) WHERE to_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_events_actor
  ON public.conversation_events (actor_user_id) WHERE actor_user_id IS NOT NULL;

-- The composite FKs are matched on (channel_id, account_id); the 060/061
-- partial indexes on the leading column serve the SET NULL scans.

-- The legacy media proxy (/api/whatsapp/media/<id>) now serves only
-- media that a message the caller can see points at. The lookup is by
-- exact media_url; this partial index covers just the proxy-style URLs
-- (the only ones it is ever asked about), so it stays tiny.
CREATE INDEX IF NOT EXISTS idx_messages_proxy_media_url
  ON public.messages (media_url)
  WHERE media_url LIKE '/api/whatsapp/media/%';
