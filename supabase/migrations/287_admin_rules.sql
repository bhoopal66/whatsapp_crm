-- ============================================================
-- 287_admin_rules.sql — what an admin may do to another admin, and in
-- whose name
--
--  1. member_lately_admin counts a removal of an admin or owner as well
--     as a lowered role. authorize_member_password_change and
--     authorize_member_details_change ask about every workspace
--     (member_login_held), and exempt only the owner of the workspace
--     where the person lately was an admin.
--  2. remove_account_member: only the owner removes an admin, or someone
--     another person lowered from admin in the last 7 days.
--  3. account_invitations: a session inserts a link only as itself, for
--     an assignable role, for at most the route's year; nothing updates
--     one; deleting stays with owners and admins.
--  4. redeem_invitation_token, peek_invitation_token take the link's
--     token and hash it here. redeem_invitation / peek_invitation take
--     the stored hash and stay callable for the previous build only:
--     once it is gone, REVOKE them from anon and authenticated (they
--     remain the bodies the new two call).
--  5. api_keys: a session inserts a key only as itself and updates
--     nothing but revoked_at. Who made a key does not change.
--
-- Restates bodies of 105 and 265: apply in order, once (re-applying
-- either undoes 1 or 2; 017 or 026 undoes 3 or 5).
-- Additive for the previous build. Re-runnable.
-- Asserted by supabase/ci/verify-admin-rules.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '287 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.member_lately_admin(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '287: apply 265_guards.sql first';
  END IF;
END $$;

-- ---------- 1. Nobody signs in as an admin they lowered or removed ----------

-- The workspaces where someone else took admin or owner from this person
-- in the last 7 days, by lowering the role or by removing them (092).
-- Their own step down, an owner handing over, does not count.
CREATE OR REPLACE FUNCTION public.member_lately_admin_in(p_user uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT w.account_id
    FROM public.workspace_audit w
   WHERE w.target_user_id = p_user
     AND w.actor_id <> p_user  -- never NULL: a change by hand in SQL has no actor
     AND w.at > now() - interval '7 days'
     AND ((w.action = 'role_changed'
           AND w.detail ->> 'from' IN ('admin', 'owner')
           AND w.detail ->> 'to' NOT IN ('admin', 'owner'))
          OR (w.action = 'member_removed'
              AND w.detail ->> 'role' IN ('admin', 'owner')))
$$;

CREATE OR REPLACE FUNCTION public.member_lately_admin(p_account uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_account IN (SELECT public.member_lately_admin_in(p_user))
$$;

-- Whether this person's login is out of this caller's reach for now: they
-- lately were an admin of a workspace the caller does not own.
CREATE OR REPLACE FUNCTION public.member_login_held(p_user uuid, p_caller uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.member_lately_admin_in(p_user) AS l(account_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.profiles c
        WHERE c.user_id = p_caller
          AND c.account_id = l.account_id
          AND c.deactivated_at IS NULL
          AND c.account_role = 'owner'))
$$;

-- Asked by person, in every workspace.
CREATE INDEX IF NOT EXISTS workspace_audit_target_idx
  ON public.workspace_audit (target_user_id, at DESC);

REVOKE ALL ON FUNCTION public.member_lately_admin_in(uuid), public.member_lately_admin(uuid, uuid),
  public.member_login_held(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 265's body; 4a asks about every workspace.
CREATE OR REPLACE FUNCTION public.authorize_member_password_change(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ladder CONSTANT account_role_enum[] :=
    ARRAY['bank_guest', 'viewer', 'agent', 'team_leader', 'admin', 'owner']::account_role_enum[];
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
BEGIN
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
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Change your own password in Settings → Login & security.'
      USING ERRCODE = '22023';
  END IF;
  SELECT account_role INTO v_target_role
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;
  IF NOT coalesce(array_position(v_ladder, v_caller_role)
                  > array_position(v_ladder, v_target_role), false) THEN
    RAISE EXCEPTION 'You can change the password only of people below your own role.'
      USING ERRCODE = '42501';
  END IF;
  -- 4a. Lowering someone's role must not be the way to their login.
  -- 287: in any workspace, and only that workspace's own owner is exempt.
  IF public.member_login_held(p_user_id, auth.uid()) THEN
    RAISE EXCEPTION 'This person was an admin until a few days ago, so only the owner of that workspace can change their password for now.'
      USING ERRCODE = '42501';
  END IF;
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
    RAISE EXCEPTION 'This person also belongs to a workspace you don''t manage, so you can''t change their password. They can change it themselves in Settings → Login & security.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- 265's body; 4a asks about every workspace.
CREATE OR REPLACE FUNCTION public.authorize_member_details_change(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ladder CONSTANT account_role_enum[] :=
    ARRAY['bank_guest', 'viewer', 'agent', 'team_leader', 'admin', 'owner']::account_role_enum[];
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
BEGIN
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
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Change your own name and email in Settings → Profile.'
      USING ERRCODE = '22023';
  END IF;
  SELECT account_role INTO v_target_role
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;
  IF NOT coalesce(array_position(v_ladder, v_caller_role)
                  > array_position(v_ladder, v_target_role), false) THEN
    RAISE EXCEPTION 'You can edit the details only of people below your own role.'
      USING ERRCODE = '42501';
  END IF;
  -- 4a. Lowering someone's role must not be the way to their login.
  -- 287: in any workspace, and only that workspace's own owner is exempt.
  IF public.member_login_held(p_user_id, auth.uid()) THEN
    RAISE EXCEPTION 'This person was an admin until a few days ago, so only the owner of that workspace can change their details for now.'
      USING ERRCODE = '42501';
  END IF;
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

-- ---------- 2. Only the owner removes an admin ----------

-- 105's body; the rule after the owner's refusal is new.
CREATE OR REPLACE FUNCTION public.remove_account_member(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_was_active BOOLEAN;
  v_new_account_id UUID;
BEGIN
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
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  -- switch_account's per-person lock: the active mark read below stays true.
  PERFORM 1 FROM profiles WHERE user_id = p_user_id ORDER BY id FOR UPDATE;

  SELECT account_role, full_name, email
    INTO v_target_role, v_target_name, v_target_email
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;
  -- 287: an admin, or someone another person lowered from admin this week.
  IF v_caller_role <> 'owner'
     AND (v_target_role = 'admin'
          OR public.member_lately_admin(v_caller_account_id, p_user_id)) THEN
    RAISE EXCEPTION 'Only the owner can remove an admin'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles o JOIN accounts a ON a.id = o.account_id
                  WHERE o.user_id = p_user_id AND o.account_id <> v_caller_account_id
                    AND a.archived_at IS NULL) THEN
    INSERT INTO accounts (name, owner_user_id)
    VALUES (COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'), p_user_id)
    RETURNING id INTO v_new_account_id;
    UPDATE profiles SET is_active = false
     WHERE user_id = p_user_id AND is_active AND account_id <> v_caller_account_id;
    UPDATE profiles
       SET account_id = v_new_account_id,
           account_role = CASE WHEN v_target_role = 'bank_guest'
                               THEN 'bank_guest' ELSE 'viewer' END::account_role_enum,
           bank_code = CASE WHEN v_target_role = 'bank_guest' THEN bank_code END,
           deactivated_at = NULL, deactivated_by = NULL, is_active = true
     WHERE user_id = p_user_id AND account_id = v_caller_account_id;
    RETURN v_new_account_id;
  END IF;

  DELETE FROM profiles
   WHERE user_id = p_user_id AND account_id = v_caller_account_id
  RETURNING is_active INTO v_was_active;

  IF v_was_active THEN
    UPDATE profiles SET is_active = true
     WHERE id = (SELECT o.id FROM profiles o JOIN accounts a ON a.id = o.account_id
                  WHERE o.user_id = p_user_id AND a.archived_at IS NULL
                  ORDER BY (o.deactivated_at IS NULL) DESC, o.created_at DESC, o.id DESC
                  LIMIT 1);
  END IF;
  RETURN NULL;
END;
$$;

-- ---------- 3. An invitation is its maker's own ----------

-- redeem_invitation judges a link by its creator, so a link carries only
-- the name of the session that made it. The year is the route's
-- MAX_INVITE_EXPIRY_DAYS, in hours, with room for the app's clock.
DROP POLICY IF EXISTS account_invitations_modify ON public.account_invitations;
DROP POLICY IF EXISTS account_invitations_insert ON public.account_invitations;
CREATE POLICY account_invitations_insert ON public.account_invitations FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'admin')
    AND created_by_user_id = auth.uid()
    AND role::text NOT IN ('owner', 'bank_guest')
    AND expires_at <= now() + interval '8760 hours 10 minutes'
    AND accepted_at IS NULL
    AND accepted_by_user_id IS NULL);
DROP POLICY IF EXISTS account_invitations_delete ON public.account_invitations;
CREATE POLICY account_invitations_delete ON public.account_invitations FOR DELETE
  USING (public.is_account_member(account_id, 'admin'));

-- ---------- 4. The stored hash is not the link ----------

CREATE OR REPLACE FUNCTION public.redeem_invitation_token(p_token text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.redeem_invitation(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex'))
$$;

CREATE OR REPLACE FUNCTION public.peek_invitation_token(p_token text)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.peek_invitation(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex'))
$$;

REVOKE ALL ON FUNCTION public.redeem_invitation_token(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_invitation_token(text) TO authenticated;
REVOKE ALL ON FUNCTION public.peek_invitation_token(text) FROM PUBLIC, service_role;
GRANT EXECUTE ON FUNCTION public.peek_invitation_token(text) TO anon, authenticated;

-- ---------- 5. An API key is its maker's own ----------

DROP POLICY IF EXISTS api_keys_insert ON public.api_keys;
CREATE POLICY api_keys_insert ON public.api_keys FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'admin') AND created_by = auth.uid());

-- Revoking is the only change the app makes to a key as a person;
-- last_used_at is the service role's.
REVOKE UPDATE ON public.api_keys FROM PUBLIC, anon, authenticated;
GRANT UPDATE (revoked_at) ON public.api_keys TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'account_invitations'
              AND cmd IN ('ALL', 'UPDATE'))
     OR has_function_privilege('authenticated', 'public.member_login_held(uuid,uuid)', 'EXECUTE')
     OR has_column_privilege('authenticated', 'public.api_keys', 'created_by', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.api_keys', 'revoked_at', 'UPDATE') THEN
    RAISE EXCEPTION '287 did not apply completely';
  END IF;
END $$;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
