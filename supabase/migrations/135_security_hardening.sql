-- ============================================================
-- 135: security hardening (audit 2026-10-23)
--
-- Five gaps between what the app enforces and what the database
-- enforces. Every statement is re-runnable (DROP POLICY IF EXISTS /
-- CREATE OR REPLACE); no data is touched.
--
-- 1. Automations, flows and broadcasts are admin-only writes.
--    017 gave the six tables below write policies at 'agent'. Every
--    screen (AdminOnlyLayout on /broadcasts, /automations, /flows) and
--    every route (requireRole('admin')) is admin-only, but PostgREST is
--    reachable with the anon key and an agent's own JWT. An agent could
--    insert an active automation with a send_webhook step aimed at their
--    own server and receive every customer message in the workspace (the
--    engine runs on the service role), or insert a 'scheduled' broadcast
--    the cron then sends. The write policies are recreated with the same
--    shape at 'admin'; the SELECT policies are unchanged. No non-admin
--    path writes these tables through a caller's client: the engines,
--    the inbound pipeline, the crons and the v1 API use the service
--    role, and the SQL writers (recipient aggregates, counters,
--    create_broadcast_with_recipients, the 066 reconcile, contact merge)
--    are SECURITY DEFINER.
--
-- 2. transfer_account_ownership takes the per-person lock.
--    Two concurrent calls by the owner naming different people both
--    passed the owner check before either demoted the caller, leaving
--    two owners. It now takes switch_account's per-person row lock on
--    the caller before reading the caller's row, so the second call
--    reads the caller as admin and is refused.
--
-- 3. update_team / set_team_members refuse bank guests and deactivated
--    people as a NEW leader or member. They only checked that the
--    person had a row in the account. Someone already on the team (or
--    the current leader) may stay: the Teams editor sends the whole
--    member list, deactivated members included (pickableMembers keeps
--    them), and refusing them would make such a team unsaveable.
--
-- 4. peek_invitation agrees with redeem_invitation.
--    It answered ok with the workspace name and role for links that
--    redeem refuses: a link whose creator may no longer grant its role
--    (099) and a link into an archived workspace (105). Both now answer
--    the 'expired' shape, as redeem words them.
--
-- 5. profiles.email is not self-editable.
--    profiles_update lets a person update their own rows, and the guard
--    did not cover email, which profiles_propagate_identity then copies
--    to every workspace row: anyone could make the members list show
--    someone else's address. Email changes go through Supabase Auth; the
--    definer-run writers (handle_new_user, propagation) run with
--    current_user the function owner, which the guard does not refuse.
-- ============================================================


-- ---------- 1. admin-only writes ----------

DROP POLICY IF EXISTS broadcasts_insert ON broadcasts;
DROP POLICY IF EXISTS broadcasts_update ON broadcasts;
DROP POLICY IF EXISTS broadcasts_delete ON broadcasts;
CREATE POLICY broadcasts_insert ON broadcasts FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY broadcasts_update ON broadcasts FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY broadcasts_delete ON broadcasts FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS automations_insert ON automations;
DROP POLICY IF EXISTS automations_update ON automations;
DROP POLICY IF EXISTS automations_delete ON automations;
CREATE POLICY automations_insert ON automations FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY automations_update ON automations FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY automations_delete ON automations FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS flows_insert ON flows;
DROP POLICY IF EXISTS flows_update ON flows;
DROP POLICY IF EXISTS flows_delete ON flows;
CREATE POLICY flows_insert ON flows FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY flows_update ON flows FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY flows_delete ON flows FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS broadcast_recipients_modify ON broadcast_recipients;
CREATE POLICY broadcast_recipients_modify ON broadcast_recipients FOR ALL USING (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id, 'admin'))
);

DROP POLICY IF EXISTS automation_steps_modify ON automation_steps;
CREATE POLICY automation_steps_modify ON automation_steps FOR ALL USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'admin'))
);

DROP POLICY IF EXISTS flow_nodes_modify ON flow_nodes;
CREATE POLICY flow_nodes_modify ON flow_nodes FOR ALL USING (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'admin'))
);


-- ---------- 2. transfer_account_ownership: one at a time ----------
-- 083's body, plus switch_account's per-person lock on the caller
-- before the caller's row is read.
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(p_new_owner_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_caller_deactivated TIMESTAMPTZ;
  v_target_role account_role_enum;
  v_target_deactivated TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- 135: switch_account's per-person lock. A second concurrent transfer
  -- waits here and then reads the caller as admin, so it is refused.
  PERFORM 1 FROM profiles WHERE user_id = auth.uid() ORDER BY id FOR UPDATE;

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
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;
  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  SELECT account_role, deactivated_at INTO v_target_role, v_target_deactivated
    FROM profiles
   WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_new_owner_user_id);
  END IF;
  IF v_target_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'The new owner must not be deactivated' USING ERRCODE = '22023';
  END IF;
  IF v_target_role = 'bank_guest' THEN
    RAISE EXCEPTION 'A bank guest cannot own an account' USING ERRCODE = '22023';
  END IF;

  -- Demote first; both writes are in this transaction.
  UPDATE profiles SET account_role = 'admin'
   WHERE user_id = auth.uid() AND account_id = v_caller_account_id;
  UPDATE profiles SET account_role = 'owner'
   WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;
  UPDATE accounts SET owner_user_id = p_new_owner_user_id
   WHERE id = v_caller_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_account_ownership(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(uuid) TO authenticated, service_role;


-- ---------- 3. teams: no new guests or deactivated people ----------
-- 071's bodies. A person newly named as a member or leader must be a
-- live, non-guest member of the account; someone already on the team
-- (or already its leader) may stay as they are.
CREATE OR REPLACE FUNCTION public.set_team_members(
  p_team_id  UUID,
  p_user_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID := current_account_id();
  v_ids     UUID[] := COALESCE(p_user_ids, '{}');
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM teams
   WHERE id = p_team_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;

  -- 135: a new member must be live staff (no bank guest, not
  -- deactivated); a current member may stay.
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS u(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = u.id AND p.account_id = v_account
         AND p.account_role <> 'bank_guest' AND p.deactivated_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM team_members tm
       WHERE tm.team_id = p_team_id AND tm.user_id = u.id
    )
  ) THEN
    RAISE EXCEPTION 'Every team member must be a member of this account'
      USING ERRCODE = '22023', HINT = 'member_not_in_account';
  END IF;

  -- One team per person (044's idx_team_members_one_team_per_user).
  -- Checked under the lock so the refusal names the rule; the index
  -- still backs it against a writer that bypasses these RPCs.
  IF EXISTS (
    SELECT 1 FROM team_members tm
     WHERE tm.account_id = v_account
       AND tm.team_id <> p_team_id
       AND tm.user_id = ANY (v_ids)
  ) THEN
    RAISE EXCEPTION 'Someone selected is already in another team. A person can only belong to one team.'
      USING ERRCODE = '23505', HINT = 'member_in_other_team';
  END IF;

  DELETE FROM team_members
   WHERE team_id = p_team_id
     AND NOT (user_id = ANY (v_ids));

  INSERT INTO team_members (team_id, user_id, account_id)
  SELECT p_team_id, u.id, v_account
    FROM (SELECT DISTINCT id FROM unnest(v_ids) AS x(id)) u
  ON CONFLICT (team_id, user_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.set_team_members(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_team_members(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION public.set_team_members(UUID, UUID[]) IS
  'Replaces the members of one team. Admin only; all or nothing. P0002 = team not found in the caller''s account; 22023 = a person outside it, or (135) a bank guest or deactivated person not already on the team; 23505 (hint member_in_other_team) = someone already in another team. See migrations 071, 135.';

CREATE OR REPLACE FUNCTION public.update_team(
  p_team_id        UUID,
  p_name           TEXT    DEFAULT NULL,
  p_set_leader     BOOLEAN DEFAULT FALSE,
  p_leader_user_id UUID    DEFAULT NULL,
  p_member_ids     UUID[]  DEFAULT NULL,
  p_config_ids     UUID[]  DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_account UUID := current_account_id();
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM teams
   WHERE id = p_team_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;

  -- 135: a new leader must be live staff; the current leader may stay.
  IF p_set_leader AND p_leader_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = p_leader_user_id AND p.account_id = v_account
       AND p.account_role <> 'bank_guest' AND p.deactivated_at IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM teams t
     WHERE t.id = p_team_id AND t.leader_user_id = p_leader_user_id
  ) THEN
    RAISE EXCEPTION 'The team leader must be a member of this account'
      USING ERRCODE = '22023', HINT = 'leader_not_in_account';
  END IF;

  BEGIN
    UPDATE teams
       SET name = COALESCE(p_name, name),
           leader_user_id = CASE WHEN p_set_leader THEN p_leader_user_id
                                 ELSE leader_user_id END,
           updated_at = NOW()
     WHERE id = p_team_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A team with that name already exists'
      USING ERRCODE = '23505', HINT = 'team_name_taken';
  END;

  IF p_member_ids IS NOT NULL THEN
    PERFORM set_team_members(p_team_id, p_member_ids);
  END IF;
  IF p_config_ids IS NOT NULL THEN
    PERFORM set_team_channels(p_team_id, p_config_ids);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_team(UUID, TEXT, BOOLEAN, UUID, UUID[], UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_team(UUID, TEXT, BOOLEAN, UUID, UUID[], UUID[]) TO authenticated;

COMMENT ON FUNCTION public.update_team(UUID, TEXT, BOOLEAN, UUID, UUID[], UUID[]) IS
  'Saves a team''s name, leader, members and numbers in one transaction. Admin only; NULL leaves a field alone (the leader is written only when p_set_leader). Errors as set_team_members / set_team_channels, plus 23505 hint team_name_taken and 22023 hint leader_not_in_account (since 135 also a bank guest or deactivated person who is not already the leader). See migrations 071, 135.';


-- ---------- 4. peek_invitation: the links redeem accepts ----------
-- 019's body, plus redeem_invitation's 099 creator check and 105
-- archive check, answered as an expired link.
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
  -- creator's right to grant it.
  IF NOT EXISTS (
       SELECT 1 FROM profiles c
        WHERE c.user_id = v_inv.created_by_user_id
          AND c.account_id = v_inv.account_id
          AND c.deactivated_at IS NULL
          AND (c.account_role IN ('owner', 'admin')
               OR (c.account_role = 'team_leader' AND v_inv.role IN ('agent', 'viewer')))) THEN
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
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;


-- ---------- 5. the profile guard covers email ----------
-- 083's body with email among the columns a signed-in client may not
-- change. Definer-run writers (propagation, handle_new_user, the member
-- RPCs) run as the function owner, not 'authenticated'.
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'authenticated' AND (
       TG_OP = 'INSERT'
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
       OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
       OR NEW.email IS DISTINCT FROM OLD.email
     )
  THEN
    RAISE EXCEPTION
      'account_role, account_id, email and deactivation cannot be changed directly; use the account member/invitation RPCs (email changes go through sign-in settings)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- switch_account() checked the caller itself, and moving out of a
  -- workspace where they were deactivated is what it is for; so is
  -- redeem_invitation(), whose token is the authority. Those are the
  -- only places this flag is raised; clients cannot set it.
  IF COALESCE(current_setting('app.account_switch', TRUE), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND EXISTS (
       SELECT 1 FROM profiles
       WHERE user_id = auth.uid() AND is_active AND deactivated_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;
