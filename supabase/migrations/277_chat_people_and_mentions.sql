-- ============================================================
-- 277_chat_people_and_mentions.sql — names of people who left, and
-- mentions changed by an edit
--
-- 1. chat_people left out deactivated people, so every message, DM and
--    member entry of someone who left read "Unknown" for everyone. It
--    lists them too, with a flag; the pickers leave them out
--    (src/lib/chat). Someone removed from the workspace has no profile
--    row here and stays unknown. A browser still on the previous build
--    ignores the flag, and offers leavers in its pickers until it reloads.
--
-- Nothing here refuses itself on existing data. Safe to run twice. Apply
-- after 157. Re-applying 157 brings the old chat_edit_message back:
-- re-apply this file after it. 087's chat_people cannot replace this one
-- (another return type): drop public.chat_people(uuid) before re-applying
-- 087, and re-apply this file after it.
-- ============================================================

-- ---------- 1. chat_people (087_internal_chat.sql): deactivated people, flagged ----------

-- The return type changes, so the function is dropped and created in one
-- statement: no reader finds it missing.
DO $do$
BEGIN
  DROP FUNCTION IF EXISTS public.chat_people(uuid);
  EXECUTE $fn$
-- The people list: staff see everyone with a profile in the workspace; a
-- guest sees only the people of channels they belong to.
CREATE FUNCTION public.chat_people(p_ws uuid)
RETURNS TABLE (user_id uuid, full_name text, avatar_url text, role text, bank_code text,
               presence_status text, last_seen_at timestamptz, deactivated boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $body$
  SELECT p.user_id, p.full_name, p.avatar_url, p.account_role::text, p.bank_code, mp.status, mp.last_seen_at,
         p.deactivated_at IS NOT NULL
    FROM (SELECT public.chat_ws_role(p_ws) AS role) me
    JOIN public.profiles p ON p.account_id = p_ws
    LEFT JOIN public.member_presence mp ON mp.user_id = p.user_id AND mp.account_id = p.account_id
   WHERE me.role IS NOT NULL
     AND (me.role <> 'bank_guest'
          OR EXISTS (SELECT 1 FROM public.chat_channel_members mine
                       JOIN public.chat_channels c ON c.id = mine.channel_id AND c.account_id = p_ws
                       JOIN public.chat_channel_members theirs ON theirs.channel_id = mine.channel_id
                      WHERE mine.user_id = auth.uid() AND theirs.user_id = p.user_id))
   ORDER BY p.full_name, p.user_id
$body$
  $fn$;
  -- 087's grants: the browser's signed-in user only.
  REVOKE ALL ON FUNCTION public.chat_people(uuid) FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.chat_people(uuid) TO authenticated;
END $do$;

NOTIFY pgrst, 'reload schema';
