-- ============================================================
-- 099: a team leader adds agents and viewers
--
-- Module 014's roles matrix: "Manage members and roles: Owner/Admin —
-- yes; Supervisor — invite RMs/agents; RM/Agent — no; Bank guest — no".
-- Here a supervisor is a team_leader and an RM an agent. Until now only
-- an owner or admin of the active workspace could add anyone.
--
-- A team leader may now add a person as an agent or a viewer, by an
-- invite link, or by email when the person already has a login the
-- leader may add (083's rule). Creating a login stays an owner's or
-- admin's: whoever creates one chooses its password and claims its
-- address.
--
--   - add_workspace_member (an existing login, by email): one more
--     branch in the caller check. The leader's role rule is checked
--     BEFORE the email is looked up, and a leader never gets the P0002
--     'no_such_user' on which the members API creates a login with the
--     service role (provision_account_member): an address that is no
--     login they may add is 42501, one answer for both cases as 083
--     gives one. provision_account_member has no caller to check
--     (service role only) and stays as 083 left it; the API reaches it
--     only after an owner's or admin's add_workspace_member said P0002.
--   - account_invitations (an invite link): leader policies beside 017's
--     admin ones. A leader inserts only agent/viewer rows in their
--     active workspace, as themselves, no longer-lived than the API
--     allows (MAX_INVITE_EXPIRY_DAYS, 365, plus a day for clock skew),
--     and reads and revokes only those rows. They never read anyone
--     else's: redeem_invitation takes the token's HASH, so reading a
--     row's token_hash is holding its link. No UPDATE: a leader could
--     otherwise turn their own agent link into an admin one.
--   - redeem_invitation: a link is only as good as its creator's right
--     to grant it, judged when it is redeemed. A link whose creator was
--     demoted, deactivated or removed, or whose login is gone, no longer
--     works, so a leader's links do not outlive their leadership (nor an
--     admin's their admin role).
--
-- Changing a role, deactivating, removing and transferring ownership
-- stay admin/owner-only (set_member_role, set_member_active,
-- remove_account_member, transfer_account_ownership are untouched), as
-- does create_workspace. The rule's TS mirror is canGrantRole /
-- LEADER_GRANTABLE_ROLES in src/lib/auth/roles.ts — change one, change
-- both. supabase/ci/verify-workspaces.sql asserts it.
--
-- Re-runnable: CREATE OR REPLACE with 083's signatures, and DROP POLICY
-- IF EXISTS before each CREATE POLICY.
-- ============================================================

-- 083's function with two changes: the caller check admits a live team
-- leader for p_role agent or viewer, and a leader is told 42501 where an
-- owner or admin is told P0002. Everything else is 083's, in 083's
-- order: the active row is the workspace, a deactivated caller is
-- refused first, the target must be someone the caller administers
-- elsewhere (an owner/admin row, as before: being a leader somewhere
-- adds no one to that list), and the per-person row lock.
CREATE OR REPLACE FUNCTION public.add_workspace_member(
  p_email text,
  p_role account_role_enum,
  p_bank_code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account UUID;
  v_role account_role_enum;
  v_deactivated TIMESTAMPTZ;
  v_code TEXT := NULLIF(btrim(p_bank_code), '');
  v_email_in TEXT := lower(btrim(p_email));
  v_user UUID;
  v_auth_email TEXT;
  v_meta JSONB;
  v_full TEXT;
  v_email TEXT;
  v_avatar TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id, account_role, deactivated_at
    INTO v_account, v_role, v_deactivated
    FROM profiles WHERE user_id = auth.uid() AND is_active;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    IF v_role <> 'team_leader' THEN
      RAISE EXCEPTION 'This action requires the admin role or higher'
        USING ERRCODE = '42501';
    END IF;
    -- 099: a team leader adds agents and viewers, no other role.
    IF p_role IS NULL OR p_role NOT IN ('agent', 'viewer') THEN
      RAISE EXCEPTION 'A team leader can add agents and viewers only'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_email_in IS NULL OR v_email_in = '' THEN
    RAISE EXCEPTION 'An email is required' USING ERRCODE = '22023';
  END IF;
  IF p_role IS NULL OR p_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot add a member as owner; transfer ownership instead'
      USING ERRCODE = '22023';
  END IF;
  IF p_role = 'bank_guest' AND v_code IS NULL THEN
    RAISE EXCEPTION 'A bank guest needs a bank code' USING ERRCODE = '22023';
  END IF;
  IF p_role <> 'bank_guest' AND v_code IS NOT NULL THEN
    RAISE EXCEPTION 'Only a bank guest carries a bank code' USING ERRCODE = '22023';
  END IF;

  SELECT id, email, raw_user_meta_data INTO v_user, v_auth_email, v_meta
    FROM auth.users WHERE lower(email) = v_email_in
   ORDER BY created_at, id LIMIT 1;
  -- One error for "no login" and "not yours to add": see 083.
  IF v_user IS NULL OR NOT (
       EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND account_id = v_account)
       OR EXISTS (SELECT 1
                    FROM profiles t
                    JOIN profiles c ON c.account_id = t.account_id
                   WHERE t.user_id = v_user AND t.deactivated_at IS NULL
                     AND c.user_id = auth.uid() AND c.deactivated_at IS NULL
                     AND c.account_role IN ('owner', 'admin'))) THEN
    -- 099: P0002 is what makes the members API create the login, with a
    -- password the caller chose; only an owner or admin gets it. A
    -- leader brings anyone else in with an invite link. The message is
    -- INVITE_BY_LINK in src/lib/account/add-member.ts.
    IF v_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'This email is not a login you can add. Invite them with a link instead.'
        USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'no_such_user' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM profiles WHERE user_id = v_user ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND account_id = v_account) THEN
    RAISE EXCEPTION 'That person is already a member of this workspace'
      USING ERRCODE = '23505';
  END IF;

  SELECT full_name, email, avatar_url INTO v_full, v_email, v_avatar
    FROM profiles WHERE user_id = v_user
   ORDER BY is_active DESC, created_at DESC, id DESC LIMIT 1;
  IF NOT FOUND THEN
    v_full := COALESCE(v_meta->>'full_name', '');
    v_email := COALESCE(v_auth_email, '');
  END IF;

  INSERT INTO profiles (user_id, full_name, email, avatar_url, account_id,
                        account_role, bank_code, is_active)
  VALUES (v_user, v_full, v_email, v_avatar, v_account, p_role, v_code,
          NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND is_active));
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.add_workspace_member(text, account_role_enum, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_workspace_member(text, account_role_enum, text) TO authenticated, service_role;

-- 083's function with one more refusal, after the link's own checks:
-- its creator must still have a live row in the link's workspace with a
-- role that may give the link's role (canGrantRole): an owner or admin
-- any, a team leader an agent or viewer. Nothing else is judged from
-- the creator's row, which need not be their active one. A creator who
-- was demoted, deactivated or removed, or whose login was deleted
-- (created_by_user_id is ON DELETE SET NULL), leaves links that answer
-- like expired ones: to whoever holds one, it has. Everything else is
-- 083's, in 083's order, the per-person row lock and the
-- app.account_switch flag included.
CREATE OR REPLACE FUNCTION public.redeem_invitation(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_personal UUID;
  v_name TEXT;
  v_email TEXT;
  v_avatar TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv FROM account_invitations
   WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed' USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  -- A guest row needs a bank_code, which an invitation does not carry.
  IF v_inv.role = 'bank_guest' THEN
    RAISE EXCEPTION 'A bank guest is added with add_workspace_member, not by invitation'
      USING ERRCODE = '22023';
  END IF;
  -- 099: the link dies with its creator's right to grant it.
  IF NOT EXISTS (
       SELECT 1 FROM profiles c
        WHERE c.user_id = v_inv.created_by_user_id
          AND c.account_id = v_inv.account_id
          AND c.deactivated_at IS NULL
          AND (c.account_role IN ('owner', 'admin')
               OR (c.account_role = 'team_leader' AND v_inv.role IN ('agent', 'viewer')))) THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM profiles WHERE user_id = v_caller_id ORDER BY id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM profiles
              WHERE user_id = v_caller_id AND account_id = v_inv.account_id) THEN
    RAISE EXCEPTION 'You are already a member of this account' USING ERRCODE = '23505';
  END IF;

  v_personal := disposable_personal_account(v_caller_id);
  SELECT full_name, email, avatar_url INTO v_name, v_email, v_avatar
    FROM profiles WHERE user_id = v_caller_id
   ORDER BY is_active DESC, created_at DESC, id DESC LIMIT 1;

  PERFORM set_config('app.account_switch', 'on', TRUE);
  IF v_personal IS NOT NULL THEN
    UPDATE profiles
       SET account_id = v_inv.account_id, account_role = v_inv.role,
           is_active = true, deactivated_at = NULL, deactivated_by = NULL
     WHERE user_id = v_caller_id;
  ELSE
    -- Demote, then insert: profiles_one_active_per_user is not deferrable.
    UPDATE profiles SET is_active = false WHERE user_id = v_caller_id AND is_active;
    INSERT INTO profiles (user_id, full_name, email, avatar_url, account_id, account_role, is_active)
    VALUES (v_caller_id, v_name, v_email, v_avatar, v_inv.account_id, v_inv.role, true);
  END IF;
  PERFORM set_config('app.account_switch', '', TRUE);

  UPDATE account_invitations
     SET accepted_at = NOW(), accepted_by_user_id = v_caller_id
   WHERE id = v_inv.id;

  IF v_personal IS NOT NULL THEN
    DELETE FROM accounts WHERE id = v_personal;
  END IF;

  RETURN v_inv.account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_invitation(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(text) TO authenticated, service_role;

-- Invite links. is_account_member reads the caller's ACTIVE, live,
-- non-guest row, so a leader reaches only the workspace they are working
-- in, and a deactivated or demoted leader reaches nothing. 017's
-- account_invitations_select / _modify (admin+, every row) stay; these
-- add to them (permissive policies are OR'd per command).
DROP POLICY IF EXISTS account_invitations_leader_select ON public.account_invitations;
CREATE POLICY account_invitations_leader_select ON public.account_invitations
  FOR SELECT
  USING (
    is_account_member(account_id, 'team_leader')
    AND created_by_user_id = auth.uid()
    AND role IN ('agent', 'viewer')
  );

DROP POLICY IF EXISTS account_invitations_leader_insert ON public.account_invitations;
CREATE POLICY account_invitations_leader_insert ON public.account_invitations
  FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'team_leader')
    AND created_by_user_id = auth.uid()
    AND role IN ('agent', 'viewer')
    AND accepted_at IS NULL
    AND accepted_by_user_id IS NULL
    AND expires_at <= now() + interval '366 days'
  );

DROP POLICY IF EXISTS account_invitations_leader_delete ON public.account_invitations;
CREATE POLICY account_invitations_leader_delete ON public.account_invitations
  FOR DELETE
  USING (
    is_account_member(account_id, 'team_leader')
    AND created_by_user_id = auth.uid()
    AND role IN ('agent', 'viewer')
  );
