-- ============================================================
-- 072 — Number allocation no longer reveals every chat on the number
--
-- Since 060, a member allocated to a WhatsApp number saw EVERY
-- conversation on it (and every contact with a chat on it) — a shared
-- inbox. With 071's team allocation that went account-wide in one click:
-- allocating a number to a team showed each agent in it every other
-- agent's chats on that number. That is not what allocation is for here.
--
-- Allocation now decides only which numbers someone may send from and
-- start new chats on (`can_use_channel`, `pickChannelForUser`, the
-- thread's number picker — unchanged). What a person can SEE is back to
-- the 042/043/044 rules: their own chats, chats assigned to them, and a
-- team leader's team; admins and owners see everything.
--
-- Only the two visibility predicates change; each keeps its signature,
-- SECURITY DEFINER, search_path and grants (CREATE OR REPLACE keeps the
-- ACL). The 4-argument can_view_conversation (062) is an alias of the
-- 5-argument one and follows automatically. Re-runnable.
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
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    WHEN NOT is_account_member(p_account_id) THEN FALSE
    WHEN COALESCE(p_owner_id = auth.uid(), FALSE)
      OR COALESCE(p_assigned_id = auth.uid(), FALSE) THEN TRUE
    WHEN is_account_member(p_account_id, 'team_leader')
      AND (
        leads_teammate(p_account_id, p_owner_id)
        OR leads_teammate(p_account_id, p_assigned_id)
      ) THEN TRUE
    ELSE FALSE
  END;
$$;

COMMENT ON FUNCTION public.can_view_conversation(UUID, UUID, UUID, UUID, UUID) IS
  'Admin/owner: everything. Others: chats they own or are assigned, and a team leader''s team. Number allocation grants no visibility since 072. The channel arguments are kept for the callers'' signature.';

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

COMMENT ON FUNCTION public.can_view_contact(UUID, UUID, UUID) IS
  'Admin/owner: everything. Others: contacts they created or have a chat with (own/assigned), and a team leader''s team. Number allocation grants no visibility since 072.';
