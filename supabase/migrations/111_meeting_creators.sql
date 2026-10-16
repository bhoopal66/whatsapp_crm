-- ============================================================
-- 111_meeting_creators.sql — only team leaders and up create video
-- meetings (on top of 106; docs/meetings.md)
--
--  * meetings_insert: 106 let any staff member (viewer and up) host a
--    new meeting. Agents and viewers now only attend: they join the
--    meetings they are invited to and the ones open to the workspace.
--    Team leader, admin and owner (current_role_rank() >= 3) create,
--    as `canCreateMeetings` (lib/auth/roles.ts) answers for the API.
--    Existing meetings keep their host, whatever that host's role.
--  * The service role is unaffected (it bypasses RLS).
--
-- Re-runnable: DROP POLICY IF EXISTS, then CREATE.
-- ============================================================

SET lock_timeout = '5s';

-- current_account_id() is NULL for a guest or a deactivated row, so
-- this is "a live team leader or up, in their active workspace,
-- hosting".
DROP POLICY IF EXISTS meetings_insert ON public.meetings;
CREATE POLICY meetings_insert ON public.meetings FOR INSERT TO authenticated
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 3
    AND host_user_id = (SELECT auth.uid())
  );
