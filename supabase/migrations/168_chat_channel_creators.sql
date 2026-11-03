-- ============================================================
-- 168_chat_channel_creators.sql — only owners, admins, team leaders
-- and coordinators create team and private channels.
--
-- Until now any staff member could create a channel unless an admin
-- unticked their role in Settings → Team chat → Role permissions (157),
-- and agents filled the sidebar with channels nobody else needed. The
-- product rule is now fixed in SQL, not left to the matrix:
--
--   create_team_channel / create_private_channel are refused to an
--   'agent' or 'viewer', except an agent who is a coordinator.
--
-- A coordinator is 133's: a live agent or team leader holding any
-- coordinator_banks row in the workspace (143 reads it the same way). A
-- viewer is never a coordinator. Owners stay unrestricted, bank guests
-- keep 157's hard refusal, and for everyone the rule lets through the
-- matrix still applies: an admin can still deny admins, team leaders
-- or (through the agent row) coordinators.
--
-- The rule lives in chat_has_permission, so chat_create_channel (157's
-- body) refuses with 157's "chat: your role may not create …" and
-- chat_my_permissions (158's body) reports false, which hides the
-- sidebar's compose button. Deal rooms (088) and DMs are untouched.
--
-- Re-runnable: CREATE OR REPLACE only (the ACL is kept).
-- ============================================================

-- 157's body plus the 168 block.
CREATE OR REPLACE FUNCTION public.chat_has_permission(p_ws uuid, p_user uuid, p_cap text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_class text := public.chat_role_class(p_ws, p_user);
BEGIN
  IF v_class IS NULL OR v_class = 'owner' THEN
    RETURN true;
  END IF;
  IF v_class = 'bank_guest'
     AND p_cap IN ('create_team_channel','create_private_channel','open_group_dm','share_cards','add_members') THEN
    RETURN false;
  END IF;
  -- 168: creating channels is for admins, team leaders and coordinators.
  IF p_cap IN ('create_team_channel','create_private_channel')
     AND v_class IN ('agent','viewer')
     AND NOT (v_class = 'agent'
              AND EXISTS (SELECT 1 FROM public.coordinator_banks cb
                           WHERE cb.account_id = p_ws AND cb.user_id = p_user)) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM public.chat_role_permissions rp
                      WHERE rp.account_id = p_ws AND rp.role_class = v_class AND rp.capability = p_cap);
END $$;
