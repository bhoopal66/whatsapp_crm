-- 102: the automation step "Post to team chat" never posts beside a bank guest.
--
-- The step (lib/automations, post_team_chat) copies customer text such as
-- {{ message.text }} into a team or private channel through
-- chat_post_system_message (087). A private channel can have bank-guest
-- members, and they read its messages, so the step refuses such a
-- channel on every run and the builder leaves it out of its picker.
-- "Has a guest" is the test chat_post_message applies before a
-- conversation card may be shared (087): a member whose channel role is
-- guest, or whose current role in the channel's workspace is bank_guest.
--
-- The service role (the automation engine) may ask about any channel;
-- the engine has already confined the id to the automation's account.
-- A signed-in caller (the builder) learns only about channels they can
-- see. Re-runnable.

CREATE OR REPLACE FUNCTION public.chat_channels_with_guests(p_channels uuid[])
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id
    FROM public.chat_channels c
   WHERE c.id = ANY (coalesce(p_channels, '{}'::uuid[]))
     AND (auth.uid() IS NULL OR public.chat_can_see_channel(c.id))
     AND EXISTS (SELECT 1 FROM public.chat_channel_members cm
                  WHERE cm.channel_id = c.id
                    AND (cm.role = 'guest'
                         OR public.chat_user_role(c.account_id, cm.user_id) = 'bank_guest'))
$$;

REVOKE ALL ON FUNCTION public.chat_channels_with_guests(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_channels_with_guests(uuid[]) TO authenticated, service_role;
