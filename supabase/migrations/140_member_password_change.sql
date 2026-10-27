-- ============================================================
-- 140_member_password_change.sql — an owner or admin sets another
-- member's password (Settings → Members).
--
-- Setting someone's password takes over their login, so who may do it
-- is decided here. POST /api/account/members/[userId]/password calls
-- authorize_member_password_change() as the caller; only when it
-- returns does the route ask GoTrue (service role) for the change, and
-- then it records the change with log_member_password_change().
--
-- authorize_member_password_change(p_user_id) checks, in this order:
--   1. The caller is a live owner or admin of their ACTIVE workspace
--      (42501, with the messages of 083's member RPCs).
--   2. It is not their own password (22023): they change theirs in
--      Settings → Login & security, which asks for the current one.
--   3. The person has a row in that workspace, deactivated or not (an
--      admin may set a password before reactivating someone); else
--      raise_not_a_member (42501 if they exist elsewhere, 22023 if not).
--   4. There the caller strictly outranks them (42501): an admin sets a
--      team leader's, agent's, viewer's or bank guest's password, never
--      another admin's or the owner's; the owner sets anyone's.
--   5. One login serves every workspace it has a row in (083), so a
--      password set from this workspace opens the others too. In every
--      other workspace where the person has a row (live or deactivated,
--      archived or not) the caller needs a LIVE owner or admin row that
--      strictly outranks the person's role there (42501).
-- It raises on a refusal and writes nothing. Nothing is locked between
-- this check and the GoTrue call: the RPC's transaction ends when it
-- returns.
--
-- The audit row (`password_changed`) is not a trigger's, unlike 092's:
-- the password lives in auth.users. The route writes it through
-- log_member_password_change() on the service role once GoTrue accepted
-- the change, so a refused or failed change is never logged. It writes
-- one row in EVERY workspace the person has a row in, not only the
-- caller's: the login opens all of them, rule 5 means the caller
-- administers each, and the row then cannot land in the wrong log if the
-- caller switched workspace while the request was in flight. The
-- function writes the RLS-forced workspace_audit, hence the guard below,
-- as in 092.
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
    PERFORM set_config('wacrm.m140_refused', 'yes', false);
    PERFORM set_config('default_transaction_read_only', 'on', false);
  END IF;
END $$;

DO $$ BEGIN
  IF current_setting('wacrm.m140_refused', true) = 'yes' THEN
    RAISE EXCEPTION '140 must be applied by a superuser or BYPASSRLS role (log_member_password_change writes the RLS-forced workspace_audit); nothing changed, and this session is now read-only: reconnect as such a role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- ---------- 1. The audit action (105's list plus password_changed) ----------
ALTER TABLE public.workspace_audit DROP CONSTRAINT IF EXISTS workspace_audit_action_check;
ALTER TABLE public.workspace_audit ADD CONSTRAINT workspace_audit_action_check CHECK (action IN (
    'member_added','member_removed','role_changed','member_deactivated','member_reactivated',
    'bank_changed','workspace_renamed','short_name_changed','ownership_transferred',
    'team_chat_enabled','team_chat_disabled','workspace_archived','workspace_restored',
    'password_changed'));

-- ---------- 2. Who may set whose password ----------
CREATE OR REPLACE FUNCTION public.authorize_member_password_change(p_user_id uuid)
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
    RAISE EXCEPTION 'Change your own password in Settings → Login & security.'
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
    RAISE EXCEPTION 'You can change the password only of people below your own role.'
      USING ERRCODE = '42501';
  END IF;

  -- 5. Below the caller in every other workspace the login opens.
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

REVOKE ALL ON FUNCTION public.authorize_member_password_change(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_member_password_change(uuid) TO authenticated;
COMMENT ON FUNCTION public.authorize_member_password_change(uuid) IS
  'Raises unless the caller may set p_user_id''s password: a live owner/admin of the active workspace, not themselves, strictly outranking the person there and in every other workspace the person belongs to. Writes nothing; see migration 140.';

-- ---------- 3. The audit row ----------
-- One row in every workspace the person has a row in, each with
-- `name` as that workspace knows them (092's member_added records it the
-- same way; the audit view falls back to it once they have left).
CREATE OR REPLACE FUNCTION public.log_member_password_change(
  p_actor_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail)
  SELECT p.account_id, p_actor_id, 'password_changed', p_user_id,
         jsonb_strip_nulls(jsonb_build_object('name', p.full_name))
    FROM public.profiles p
   WHERE p.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_member_password_change(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_member_password_change(uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.log_member_password_change(uuid, uuid) IS
  'Records a password_changed row in every workspace p_user_id belongs to, after POST /api/account/members/[userId]/password changed the password. Service-role only; see migration 140.';
