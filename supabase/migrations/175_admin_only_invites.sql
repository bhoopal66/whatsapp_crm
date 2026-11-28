-- ============================================================
-- 175_admin_only_invites.sql — only owners and admins add people
--
-- The product owner's decision: adding someone to the application is an
-- owner's or admin's act. 099 had let a team leader add agents and
-- viewers, by email and by invite link. This takes that back and changes
-- nothing else about roles.
--
--  * account_invitations: 099's three leader policies are dropped, so a
--    leader no longer reads, inserts or deletes a link. 017's admin
--    policies stay.
--  * add_workspace_member: 099's body without the team-leader branch.
--    Anyone below admin gets the refusal they got before 099, decided
--    before the email is looked up, so a leader never gets the P0002
--    'no_such_user' on which the members API creates a login, and learns
--    nothing about an address. An owner's or admin's path is untouched,
--    083's one answer for "no login" and "not yours to add" included.
--  * redeem_invitation, peek_invitation: a link is good only while a
--    live owner or admin of its workspace made it. Both change together
--    (135 keeps them agreeing). A link whose creator lost the right
--    answers as an expired one would; a leader's existing links are
--    then deleted below, so they answer as not found.
--  * revoke_ungrantable_invitations(), run here: revocation in this app
--    is a DELETE, and links redeem now refuses would otherwise sit in
--    Settings as live rows nobody can use. It deletes every unaccepted
--    link whose creator fails the check above: a leader's, and also an
--    older one a demoted, deactivated or removed creator left behind,
--    which redeem already refused. Accepted rows are the record of who
--    joined and stay, as does every link of a live owner or admin. A
--    function, as 174's backfill, so the verify file runs this DELETE
--    and not a copy of it. It runs last, once the policies are gone, so
--    no leader's link can be written after it.
--
-- No superuser check: nothing here writes an RLS-forced table, and only
-- the table's owner or a superuser can drop its policies, so whoever can
-- apply this also sees every row for the DELETE.
--
-- The rule's TS mirrors are in src/lib/auth/roles.ts: change one, change
-- both. 129's note on redeem_invitation and add_workspace_member
-- concerns disposable_personal_account, which neither change touches.
--
-- Re-runnable: DROP POLICY IF EXISTS, CREATE OR REPLACE with the same
-- signatures, and a DELETE that finds nothing the second time. Asserted
-- by supabase/ci/verify-workspaces.sql.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. The leader policies ----------

DROP POLICY IF EXISTS account_invitations_leader_select ON public.account_invitations;
DROP POLICY IF EXISTS account_invitations_leader_insert ON public.account_invitations;
DROP POLICY IF EXISTS account_invitations_leader_delete ON public.account_invitations;

-- ---------- 2. add_workspace_member: 099's, without the leader ----------

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
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
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
  -- One error for "no login" and "not yours to add": see 083. Only an
  -- owner or admin gets this far, so only they ever see this P0002, on
  -- which the members API creates the login.
  IF v_user IS NULL OR NOT (
       EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND account_id = v_account)
       OR EXISTS (SELECT 1
                    FROM profiles t
                    JOIN profiles c ON c.account_id = t.account_id
                   WHERE t.user_id = v_user AND t.deactivated_at IS NULL
                     AND c.user_id = auth.uid() AND c.deactivated_at IS NULL
                     AND c.account_role IN ('owner', 'admin'))) THEN
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

-- ---------- 3. redeem_invitation: 105's, an owner's or admin's links only ----------

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
  -- 099: the link dies with its creator's right to grant it. 175: only
  -- a live owner or admin of the workspace has that right.
  IF NOT EXISTS (
       SELECT 1 FROM profiles c
        WHERE c.user_id = v_inv.created_by_user_id
          AND c.account_id = v_inv.account_id
          AND c.deactivated_at IS NULL
          AND c.account_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  -- 105: and with its workspace.
  IF EXISTS (SELECT 1 FROM accounts WHERE id = v_inv.account_id AND archived_at IS NOT NULL) THEN
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
-- Since 324 only the token-taking wrappers (287) are callable: re-applying
-- this file must not reopen the hash-taking form.
DO $grant$ BEGIN
  IF to_regprocedure('public.redeem_invitation_token(text)') IS NULL THEN
    GRANT EXECUTE ON FUNCTION public.redeem_invitation(text) TO authenticated, service_role;
  END IF;
END $grant$;

-- ---------- 4. peek_invitation: 135's, the same creator rule ----------

CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token_hash TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  -- 135 (mirrors redeem_invitation, 099): the link dies with its
  -- creator's right to grant it. 175: only a live owner or admin of the
  -- workspace has that right.
  IF NOT EXISTS (
       SELECT 1 FROM profiles c
        WHERE c.user_id = v_inv.created_by_user_id
          AND c.account_id = v_inv.account_id
          AND c.deactivated_at IS NULL
          AND c.account_role IN ('owner', 'admin')) THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  -- 135 (mirrors redeem_invitation, 105): and with its workspace.
  IF EXISTS (SELECT 1 FROM accounts WHERE id = v_inv.account_id AND archived_at IS NOT NULL) THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'expires_at', v_inv.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
-- Since 324 only the token-taking wrappers (287) are callable: re-applying
-- this file must not reopen the hash-taking form.
DO $grant$ BEGIN
  IF to_regprocedure('public.peek_invitation_token(text)') IS NULL THEN
    GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;
  END IF;
END $grant$;

-- ---------- 5. Links nobody can redeem any more ----------

CREATE OR REPLACE FUNCTION public.revoke_ungrantable_invitations()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  DELETE FROM public.account_invitations i
   WHERE i.accepted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles c
        WHERE c.user_id = i.created_by_user_id
          AND c.account_id = i.account_id
          AND c.deactivated_at IS NULL
          AND c.account_role IN ('owner', 'admin'));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_ungrantable_invitations()
  FROM PUBLIC, anon, authenticated, service_role;

SELECT public.revoke_ungrantable_invitations();

RESET lock_timeout;
