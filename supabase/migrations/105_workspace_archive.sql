-- 105_workspace_archive.sql — archive and restore a workspace
--
-- Module 014 §2.1: workspaces are created (083's create_workspace),
-- renamed (PATCH /api/account, audited by 092) and archived. Archiving
-- closes a workspace without deleting anything: its data stays, nobody
-- can work in it, and an owner can restore it.
--
-- archive_workspace(p_account_id, p_archive) is the one writer of
-- accounts.archived_at / archived_by (a guard refuses a client's own
-- UPDATE of them). The caller needs a live owner row in that workspace,
-- not necessarily the active one, so a workspace is restored from
-- another. Archiving refuses, each with its own SQLSTATE:
--   WS001  the caller has no other live, non-archived workspace;
--   WS002  a WhatsApp number (whatsapp_config) or a phone system
--          (pbx_connections) is still connected: inbound traffic would
--          keep landing in a workspace nobody can open;
--   WS003  live members (staff or bank guests) have no other live,
--          non-archived workspace; the count is the DETAIL. The owner
--          deactivates or removes them first.
-- Then, in one transaction: the pending invitations are revoked
-- (deleted, as DELETE /api/account/invitations/[id] revokes one), the
-- stamp is written, and everyone whose ACTIVE row is there moves to the
-- first of their other live, non-archived workspaces by name, then id:
-- the switcher's order, which is what the client's fallbackWorkspace
-- picks after a deactivation. A deactivated person with nowhere to go
-- stays where they are: their row there reads nothing. Restoring clears
-- the stamp and nothing else: nobody moves back, and revoked links stay
-- revoked.
--
-- Nobody becomes active in an archived workspace, so no policy (each
-- reads the caller's ACTIVE live row) reaches it:
--   - switch_account refuses it (42501), and redeem_invitation answers
--     as for an expired link (22023); each is re-created from its
--     latest body (083, 099) with that one check added;
--   - remove_account_member (083) no longer hands someone's active mark
--     to a row there; when their other rows are all archived it treats
--     the removed row as their only membership, as 083 does (a fresh
--     account, as a viewer);
--   - a trigger on profiles refuses every other write that would make a
--     row there active: provision_account_member, add_workspace_member's
--     move of a disposable personal row, the service role, a hand-run
--     UPDATE.
--
-- Locks. An archive takes the pending invitations, then every member's
-- profile rows in id order (the order switch_account and the member RPCs
-- take one person's rows), then the account row. The activation trigger
-- takes the account row FOR SHARE, after its writer already holds the
-- person's rows: both sides take profiles before accounts. A concurrent
-- switch or join into the workspace either commits first, and the
-- archive then sees that person (and moves or counts them), or waits for
-- the archive and is refused. The account row is taken FOR NO KEY
-- UPDATE, which leaves foreign-key inserts (a message, a contact) free
-- to proceed meanwhile.
--
-- my_workspaces() gains `archived`: an owner still sees an archived
-- workspace (to restore it), nobody else does. Its RETURNS TABLE
-- changes, so it is dropped and re-created with 083's grants.
--
-- workspace_audit (092): workspace_archived / workspace_restored, from
-- the accounts trigger, re-created with archived_at among its columns;
-- the action CHECK is re-created with 092's list plus the two.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, and DROP
-- ... IF EXISTS before each trigger, the constraint and my_workspaces.
-- Like 092, it rewrites a SECURITY DEFINER trigger function that writes
-- the RLS-forced workspace_audit, so it is applied as a superuser or a
-- BYPASSRLS role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '105 must be applied by a superuser or BYPASSRLS role (its trigger function writes the RLS-forced workspace_audit)';
  END IF;
END $$;

-- ---------- 1. The stamp ----------
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ---------- 2. Only archive_workspace writes it ----------
-- 057 §8 grants UPDATE on accounts column by column, on the columns that
-- exist when it runs, so a re-run of 057 would grant these two. The
-- trigger holds whatever the grants say: a client's own UPDATE (the
-- authenticated or anon role, outside any SECURITY DEFINER function)
-- cannot touch them.
REVOKE UPDATE (archived_at, archived_by) ON public.accounts FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.accounts_archive_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND (
       NEW.archived_at IS DISTINCT FROM OLD.archived_at
       OR NEW.archived_by IS DISTINCT FROM OLD.archived_by) THEN
    RAISE EXCEPTION 'A workspace is archived and restored with archive_workspace()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS accounts_archive_guard ON public.accounts;
CREATE TRIGGER accounts_archive_guard BEFORE UPDATE OF archived_at, archived_by ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_archive_guard();

-- ---------- 3. Nobody becomes active in an archived workspace ----------
-- The account row is read FOR SHARE so an archive of it in flight (which
-- holds the row FOR NO KEY UPDATE) is waited for and its outcome read.
-- Unconditionally: a WHERE on archived_at would skip, unlocked, a row
-- that is not archived yet in this statement's snapshot.
CREATE OR REPLACE FUNCTION public.profiles_archived_activation_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_archived timestamptz;
BEGIN
  -- Already the active row there: not an activation.
  IF TG_OP = 'UPDATE' AND OLD.is_active AND OLD.account_id = NEW.account_id THEN
    RETURN NEW;
  END IF;
  SELECT archived_at INTO v_archived FROM public.accounts WHERE id = NEW.account_id FOR SHARE;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'That workspace is archived' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_archived_activation_guard ON public.profiles;
CREATE TRIGGER profiles_archived_activation_guard
  BEFORE INSERT OR UPDATE OF is_active, account_id ON public.profiles
  FOR EACH ROW WHEN (NEW.is_active)
  EXECUTE FUNCTION public.profiles_archived_activation_guard();

-- ---------- 4. Archive and restore ----------
CREATE OR REPLACE FUNCTION public.archive_workspace(p_account_id uuid, p_archive boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_archived_at timestamptz;
  v_revoked int := 0;
  v_moved int := 0;
  v_stranded int;
  v_active uuid;
  v_active_role account_role_enum;
  r record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_archive IS NULL THEN
    RAISE EXCEPTION 'p_archive must be true or false' USING ERRCODE = '22023';
  END IF;
  -- Any of the caller's rows: an owner restores from another workspace.
  -- Checked again under the locks; this first read only spares a
  -- non-owner's call the locking.
  IF NOT EXISTS (SELECT 1 FROM profiles
                  WHERE user_id = v_uid AND account_id = p_account_id
                    AND account_role = 'owner' AND deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'Only an owner of that workspace can archive or restore it'
      USING ERRCODE = '42501';
  END IF;

  IF NOT p_archive THEN
    -- Restore: the stamp only. Members switch back in themselves.
    UPDATE accounts SET archived_at = NULL, archived_by = NULL
     WHERE id = p_account_id AND archived_at IS NOT NULL;
  ELSE
    -- Lock order: invitations, profiles (id order), the account row.
    DELETE FROM account_invitations
     WHERE account_id = p_account_id AND accepted_at IS NULL;
    GET DIAGNOSTICS v_revoked = ROW_COUNT;

    PERFORM 1 FROM profiles
     WHERE user_id IN (SELECT user_id FROM profiles WHERE account_id = p_account_id)
     ORDER BY id FOR UPDATE;

    SELECT archived_at INTO v_archived_at FROM accounts
     WHERE id = p_account_id FOR NO KEY UPDATE;

    IF NOT EXISTS (SELECT 1 FROM profiles
                    WHERE user_id = v_uid AND account_id = p_account_id
                      AND account_role = 'owner' AND deactivated_at IS NULL) THEN
      RAISE EXCEPTION 'Only an owner of that workspace can archive or restore it'
        USING ERRCODE = '42501';
    END IF;

    -- Archiving an archived workspace changes nothing.
    IF v_archived_at IS NULL THEN
      IF NOT EXISTS (
           SELECT 1 FROM profiles o JOIN accounts a ON a.id = o.account_id
            WHERE o.user_id = v_uid AND o.account_id <> p_account_id
              AND o.deactivated_at IS NULL AND a.archived_at IS NULL) THEN
        RAISE EXCEPTION 'You have no other workspace to move to'
          USING ERRCODE = 'WS001';
      END IF;

      IF EXISTS (SELECT 1 FROM whatsapp_config WHERE account_id = p_account_id)
         OR EXISTS (SELECT 1 FROM pbx_connections WHERE account_id = p_account_id) THEN
        RAISE EXCEPTION 'The workspace still has a WhatsApp number or phone system connected; disconnect its numbers first'
          USING ERRCODE = 'WS002';
      END IF;

      SELECT count(*) INTO v_stranded FROM profiles p
       WHERE p.account_id = p_account_id AND p.deactivated_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM profiles o JOIN accounts a ON a.id = o.account_id
            WHERE o.user_id = p.user_id AND o.account_id <> p_account_id
              AND o.deactivated_at IS NULL AND a.archived_at IS NULL);
      IF v_stranded > 0 THEN
        RAISE EXCEPTION '% member(s) have no other workspace to move to; deactivate or remove them first', v_stranded
          USING ERRCODE = 'WS003', DETAIL = v_stranded::text;
      END IF;

      UPDATE accounts SET archived_at = now(), archived_by = v_uid WHERE id = p_account_id;

      -- Demote, then promote: profiles_one_active_per_user is not
      -- deferrable. The flag as switch_account raises it: the guard
      -- would otherwise refuse is_active writes while the caller's own
      -- active row is deactivated.
      PERFORM set_config('app.account_switch', 'on', TRUE);
      FOR r IN
        SELECT p.user_id,
               (SELECT o.id FROM profiles o JOIN accounts a ON a.id = o.account_id
                 WHERE o.user_id = p.user_id AND o.account_id <> p_account_id
                   AND o.deactivated_at IS NULL AND a.archived_at IS NULL
                 ORDER BY a.name, a.id LIMIT 1) AS landing
          FROM profiles p
         WHERE p.account_id = p_account_id AND p.is_active
         ORDER BY p.id
      LOOP
        CONTINUE WHEN r.landing IS NULL;
        UPDATE profiles SET is_active = false
         WHERE user_id = r.user_id AND account_id = p_account_id;
        UPDATE profiles SET is_active = true WHERE id = r.landing;
        v_moved := v_moved + 1;
      END LOOP;
      PERFORM set_config('app.account_switch', '', TRUE);
    END IF;
  END IF;

  SELECT account_id, account_role INTO v_active, v_active_role
    FROM profiles WHERE user_id = v_uid AND is_active;
  RETURN jsonb_build_object(
    'account_id', p_account_id,
    'archived', p_archive,
    'active_account_id', v_active,
    'active_role', v_active_role,
    'moved', v_moved,
    'invitations_revoked', v_revoked);
END;
$$;

REVOKE ALL ON FUNCTION public.archive_workspace(uuid, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.archive_workspace(uuid, boolean) TO authenticated;

-- ---------- 5. switch_account: 083's, refusing an archived workspace ----------
CREATE OR REPLACE FUNCTION public.switch_account(p_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- One switch at a time per person.
  PERFORM 1 FROM profiles WHERE user_id = v_uid ORDER BY id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE user_id = v_uid
       AND account_id = p_account_id
       AND deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'You are not an active member of that workspace'
      USING ERRCODE = '42501';
  END IF;

  -- 105: an archived workspace is closed to everyone, its owners too.
  IF EXISTS (SELECT 1 FROM accounts WHERE id = p_account_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'That workspace is archived' USING ERRCODE = '42501';
  END IF;

  -- Demote, then promote: profiles_one_active_per_user is not deferrable.
  PERFORM set_config('app.account_switch', 'on', TRUE);
  UPDATE profiles SET is_active = false
   WHERE user_id = v_uid AND is_active AND account_id <> p_account_id;
  UPDATE profiles SET is_active = true
   WHERE user_id = v_uid AND account_id = p_account_id AND NOT is_active;
  PERFORM set_config('app.account_switch', '', TRUE);

  RETURN p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.switch_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_account(uuid) TO authenticated;

-- ---------- 6. redeem_invitation: 099's, refusing an archived workspace ----------
-- Archiving deletes the workspace's pending links; this answers for one
-- written afterwards (the service role, a hand-run INSERT) as for an
-- expired link, as 099 answers for a link whose creator lost the right.
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
GRANT EXECUTE ON FUNCTION public.redeem_invitation(text) TO authenticated, service_role;

-- ---------- 7. remove_account_member: 083's, never landing in an archived workspace ----------
-- Two changes. "Their only membership" now means their only row in a
-- workspace that is not archived: such a person gets 083's fresh
-- account (a person deactivated and left active in an archived
-- workspace is demoted there first). And the row that inherits the
-- active mark is chosen among rows in workspaces that are not archived.
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

-- ---------- 8. my_workspaces: + archived ----------
-- An owner sees an archived workspace, to restore it; nobody else does.
-- Archived ones sort after the others.
DROP FUNCTION IF EXISTS public.my_workspaces();
CREATE FUNCTION public.my_workspaces()
RETURNS TABLE (
  account_id  uuid,
  name        text,
  short_name  text,
  role        account_role_enum,
  is_active   boolean,
  deactivated boolean,
  archived    boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.name, a.short_name, p.account_role, p.is_active,
         p.deactivated_at IS NOT NULL, a.archived_at IS NOT NULL
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
   WHERE p.user_id = auth.uid()
     AND (a.archived_at IS NULL OR p.account_role = 'owner')
   ORDER BY p.is_active DESC, a.archived_at IS NOT NULL, a.name, a.id;
$$;

REVOKE ALL ON FUNCTION public.my_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_workspaces() TO authenticated, service_role;

-- ---------- 9. The audit log (092) ----------
ALTER TABLE public.workspace_audit DROP CONSTRAINT IF EXISTS workspace_audit_action_check;
ALTER TABLE public.workspace_audit ADD CONSTRAINT workspace_audit_action_check CHECK (action IN (
    'member_added','member_removed','role_changed','member_deactivated','member_reactivated',
    'bank_changed','workspace_renamed','short_name_changed','ownership_transferred',
    'team_chat_enabled','team_chat_disabled','workspace_archived','workspace_restored'));

-- 092's function, plus the archive stamp.
CREATE OR REPLACE FUNCTION public.workspace_audit_accounts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action, detail)
    VALUES (NEW.id, v_actor, 'workspace_renamed', jsonb_build_object('from', OLD.name, 'to', NEW.name));
  END IF;
  IF NEW.short_name IS DISTINCT FROM OLD.short_name THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action, detail)
    VALUES (NEW.id, v_actor, 'short_name_changed', jsonb_build_object('from', OLD.short_name, 'to', NEW.short_name));
  END IF;
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail)
    VALUES (NEW.id, v_actor, 'ownership_transferred', NEW.owner_user_id,
            jsonb_build_object('from_user_id', OLD.owner_user_id));
  END IF;
  IF NEW.internal_chat_enabled IS DISTINCT FROM OLD.internal_chat_enabled THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action)
    VALUES (NEW.id, v_actor, CASE WHEN NEW.internal_chat_enabled THEN 'team_chat_enabled' ELSE 'team_chat_disabled' END);
  END IF;
  IF (NEW.archived_at IS NULL) <> (OLD.archived_at IS NULL) THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action)
    VALUES (NEW.id, v_actor, CASE WHEN NEW.archived_at IS NULL THEN 'workspace_restored' ELSE 'workspace_archived' END);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS workspace_audit_accounts_update ON public.accounts;
CREATE TRIGGER workspace_audit_accounts_update
  AFTER UPDATE OF name, short_name, owner_user_id, internal_chat_enabled, archived_at ON public.accounts
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name
        OR OLD.short_name IS DISTINCT FROM NEW.short_name
        OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
        OR OLD.internal_chat_enabled IS DISTINCT FROM NEW.internal_chat_enabled
        OR (OLD.archived_at IS NULL) <> (NEW.archived_at IS NULL))
  EXECUTE FUNCTION public.workspace_audit_accounts();

-- ---------- 10. Privileges ----------
REVOKE ALL ON FUNCTION public.accounts_archive_guard(), public.profiles_archived_activation_guard(),
  public.workspace_audit_accounts()
  FROM PUBLIC, anon, authenticated, service_role;
