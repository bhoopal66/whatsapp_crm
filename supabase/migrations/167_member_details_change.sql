-- ============================================================
-- 167_member_details_change.sql — an owner or admin edits another
-- member's full name and login email (Settings → Members).
--
-- The login email is how the person signs in, and the name and email
-- are one identity shared by every workspace row the person has (083's
-- profiles_propagate_identity copies them), so who may edit them is the
-- same question as 140's password change and is answered the same way.
-- PATCH /api/account/members/[userId]/details calls
-- authorize_member_details_change() as the caller; only when it returns
-- does the route change the email in GoTrue (service role), then the
-- profiles rows (service role; 135's guard refuses only
-- 'authenticated'), and then record the change with
-- log_member_details_change().
--
-- authorize_member_details_change(p_user_id) runs 140's five checks in
-- the same order with its own wording:
--   1. The caller is a live owner or admin of their ACTIVE workspace
--      (42501).
--   2. Not their own details (22023): theirs are Settings → Profile.
--   3. The person has a row in that workspace, deactivated or not; else
--      raise_not_a_member (42501 if they exist elsewhere, 22023 if not).
--   4. There the caller strictly outranks them (42501).
--   5. In every other workspace where the person has a row (live or
--      deactivated, archived or not) the caller needs a LIVE owner or
--      admin row that strictly outranks the person there (42501): the
--      new name and email show there too, and the email opens them all.
-- It raises on a refusal and writes nothing.
--
-- The audit row (`details_changed`) is the route's, not a trigger's:
-- the email lives in auth.users and 092 deliberately records no name or
-- email edit a person makes to their own profile. It is written once
-- the change landed, in EVERY workspace the person has a row in (as
-- 140's), with the route's detail plus `name`. The function writes the
-- RLS-forced workspace_audit, hence the guard below, as in 092 and 140.
--
-- Re-runnable: CREATE OR REPLACE, DROP CONSTRAINT IF EXISTS.
-- ============================================================

-- A plain `psql -f` keeps going after an error, and functions created
-- by a role without BYPASSRLS would fail every audit insert later,
-- quietly. So a refusal first turns the session read-only (130's way),
-- and only then raises: nothing below can be created by the wrong role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    PERFORM set_config('wacrm.m167_refused', 'yes', false);
    PERFORM set_config('default_transaction_read_only', 'on', false);
  END IF;
END $$;

DO $$ BEGIN
  IF current_setting('wacrm.m167_refused', true) = 'yes' THEN
    RAISE EXCEPTION '167 must be applied by a superuser or BYPASSRLS role (log_member_details_change writes the RLS-forced workspace_audit); nothing changed, and this session is now read-only: reconnect as such a role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- ---------- 1. The audit action (140's list plus details_changed) ----------
ALTER TABLE public.workspace_audit DROP CONSTRAINT IF EXISTS workspace_audit_action_check;
ALTER TABLE public.workspace_audit ADD CONSTRAINT workspace_audit_action_check CHECK (action IN (
    'member_added','member_removed','role_changed','member_deactivated','member_reactivated',
    'bank_changed','workspace_renamed','short_name_changed','ownership_transferred',
    'team_chat_enabled','team_chat_disabled','workspace_archived','workspace_restored',
    'password_changed','details_changed'));

-- ---------- 2. Who may edit whose details ----------
CREATE OR REPLACE FUNCTION public.authorize_member_details_change(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- 083's ladder, lowest first, so a higher position outranks: the order
  -- of current_role_rank() and roleRank() (lib/auth/roles.ts). A role
  -- missing here has no position, and every comparison with it refuses.
  v_ladder CONSTANT account_role_enum[] :=
    ARRAY['bank_guest', 'viewer', 'agent', 'team_leader', 'admin', 'owner']::account_role_enum[];
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
BEGIN
  -- 1. A live owner or admin of the active workspace.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role, deactivated_at
    INTO v_caller_account_id, v_caller_role, v_caller_deactivated
    FROM profiles WHERE user_id = auth.uid() AND is_active;
  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Not their own.
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Change your own name and email in Settings → Profile.'
      USING ERRCODE = '22023';
  END IF;

  -- 3. A member of the active workspace, deactivated or not.
  SELECT account_role INTO v_target_role
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;

  -- 4. Below the caller there.
  IF NOT coalesce(array_position(v_ladder, v_caller_role)
                  > array_position(v_ladder, v_target_role), false) THEN
    RAISE EXCEPTION 'You can edit the details only of people below your own role.'
      USING ERRCODE = '42501';
  END IF;

  -- 5. Below the caller in every other workspace the details show in.
  IF EXISTS (
    SELECT 1
      FROM profiles t
     WHERE t.user_id = p_user_id
       AND t.account_id <> v_caller_account_id
       AND NOT EXISTS (
         SELECT 1
           FROM profiles c
          WHERE c.user_id = auth.uid()
            AND c.account_id = t.account_id
            AND c.deactivated_at IS NULL
            AND c.account_role IN ('owner', 'admin')
            AND array_position(v_ladder, c.account_role)
                > array_position(v_ladder, t.account_role))
  ) THEN
    RAISE EXCEPTION 'This person also belongs to a workspace you don''t manage, so you can''t change their details.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_member_details_change(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_member_details_change(uuid) TO authenticated;
COMMENT ON FUNCTION public.authorize_member_details_change(uuid) IS
  'Raises unless the caller may edit p_user_id''s name and login email: a live owner/admin of the active workspace, not themselves, strictly outranking the person there and in every other workspace the person belongs to. Writes nothing; see migration 167.';

-- ---------- 3. The audit row ----------
-- One row in every workspace the person has a row in. p_detail is the
-- route's description of the change ({changed, name_from, name_to,
-- email_from, email_to}); `name` is added as that workspace knows them
-- now, i.e. the new name (092's member_added records it the same way;
-- the audit view falls back to it once they have left).
CREATE OR REPLACE FUNCTION public.log_member_details_change(
  p_actor_id uuid, p_user_id uuid, p_detail jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail)
  SELECT p.account_id, p_actor_id, 'details_changed', p_user_id,
         coalesce(p_detail, '{}'::jsonb)
           || jsonb_strip_nulls(jsonb_build_object('name', p.full_name))
    FROM public.profiles p
   WHERE p.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_member_details_change(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_member_details_change(uuid, uuid, jsonb) TO service_role;
COMMENT ON FUNCTION public.log_member_details_change(uuid, uuid, jsonb) IS
  'Records a details_changed row in every workspace p_user_id belongs to, after PATCH /api/account/members/[userId]/details changed their name or login email. Service-role only; see migration 167.';
