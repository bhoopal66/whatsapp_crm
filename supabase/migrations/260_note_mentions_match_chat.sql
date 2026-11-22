-- 260: a note @mention reaches everyone who can open the chat.
--
-- The first version of 256 (section 2) gave the mention check its own
-- rule for company chats without 190's personal-number arm. But 217's
-- conversations_select still has that arm (channel_id IN
-- personal_number_visible_ids()): the owner of a personal number, and
-- their team leader, can open a company chat on that number (rows from
-- before 191's guard). The check was stricter than the chat, so those
-- people were left out of the mention list and never rung. Nothing
-- leaked; a notification was lost.
--
-- This restores 241's conversation_note_user_can_see, which asks 190's
-- can_view_conversation_for_user (the explicit-user mirror of 217's
-- company branch), and drops 256's helper. 241, the corrected 256 and
-- this file carry the same body, so re-applying any of them, in any
-- order, lands on this rule. Guarded and re-runnable. No build needed.

CREATE OR REPLACE FUNCTION public.conversation_note_user_can_see(p_user uuid, p_conversation uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.conversations c
      JOIN public.profiles p
        ON p.user_id = p_user
       AND p.account_id = c.account_id
       AND p.deactivated_at IS NULL
       AND p.account_role <> 'bank_guest'
     WHERE c.id = p_conversation
       AND CASE
             WHEN c.personal_owner_id IS NULL THEN
               public.can_view_conversation_for_user(
                 p_user, c.account_id, c.user_id, c.assigned_agent_id, c.channel_id)
             -- 191's can_view_personal_chat, for an explicit person.
             ELSE p.account_role IN ('owner', 'admin')
               OR c.personal_owner_id = p_user
               OR (p.account_role = 'team_leader' AND EXISTS (
                     SELECT 1 FROM public.teams t
                       JOIN public.team_members tm ON tm.team_id = t.id
                      WHERE t.account_id = c.account_id
                        AND t.leader_user_id = p_user
                        AND tm.user_id = c.personal_owner_id))
           END
  )
$$;

REVOKE ALL ON FUNCTION public.conversation_note_user_can_see(uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.conversation_note_user_can_see(uuid, uuid) IS
  'Can this live staff person see this chat? 190''s can_view_conversation_for_user (the same people 217''s conversations_select shows, personal-number arm included) plus 191''s personal-chat rule; no coordinator shares. Private: the note triggers and the mention list use it. Migrations 241, 260.';

-- 256's first version added this helper, without the arm.
DROP FUNCTION IF EXISTS public.conversation_note_company_chat_visible(uuid, uuid, uuid, uuid);
