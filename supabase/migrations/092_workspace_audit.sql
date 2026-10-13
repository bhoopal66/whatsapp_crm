-- 092_workspace_audit.sql — who changed a workspace's people and settings
--
-- An append-only log of membership and workspace changes, read by the
-- workspace's owners and admins (Settings → Team → Audit log). It is
-- filled by triggers on `profiles` and `accounts`, not by the 083 RPCs,
-- so every writer is covered: the member RPCs, PATCH /api/account, the
-- service role, a hand-run UPDATE.
--
--   profiles INSERT                     member_added        {role, name?, bank_code?}
--   profiles DELETE                     member_removed      {role, name?}
--   profiles UPDATE moving account_id   member_removed in the old account,
--                                       member_added in the new one
--   account_role changed                role_changed        {from, to}
--   deactivated_at NULL <-> set         member_deactivated / member_reactivated
--   bank_code changed                   bank_changed        {from, to}
--   accounts.name                       workspace_renamed   {from, to}
--   accounts.short_name                 short_name_changed  {from, to}
--   accounts.owner_user_id              ownership_transferred {from_user_id}
--   accounts.internal_chat_enabled      team_chat_enabled / team_chat_disabled
--
-- actor_id is auth.uid(): NULL for the service role or a session with
-- no JWT (the server). One UPDATE changing two tracked columns writes
-- one row per change. is_active flips (every workspace switch, and the
-- demote-then-promote writes profiles_one_active_per_user forces),
-- full_name, avatar and updated_at write nothing: the UPDATE triggers
-- are `UPDATE OF <tracked columns>` with a WHEN clause, so a switch
-- never even calls the function.
--
-- A move records both sides. remove_account_member moves someone's only
-- membership to a fresh account; redeem_invitation and
-- provision_account_member move a new login's empty personal row INTO
-- the workspace (the normal path for a provisioned member), so logging
-- the old account alone would never show those people as added.
--
-- The triggers are AFTER ROW: a write a guard trigger refuses is never
-- logged, and the values recorded are the final ones. The audit insert
-- runs in the same transaction as the change, so a change cannot land
-- unaudited; an insert can only fail on a broken invariant (an action
-- missing from the CHECK), and then the change rolls back with it.
--
-- Deleting an account (and the cascade to its profiles) still works:
-- account_id cascades, the append-only guard lets a DELETE through only
-- once the account row is gone, and a profile that leaves with its
-- account is not logged (there is no account left to log it in).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '092 must be applied by a superuser or BYPASSRLS role (its trigger functions write an RLS-forced table)';
  END IF;
END $$;

-- ---------- 1. The log ----------

CREATE TABLE IF NOT EXISTS public.workspace_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_id       uuid,   -- NULL: the server (service role, no JWT)
  action         text NOT NULL,
  target_user_id uuid,   -- NULL: a workspace-level change
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_audit_action_check CHECK (action IN (
    'member_added','member_removed','role_changed','member_deactivated','member_reactivated',
    'bank_changed','workspace_renamed','short_name_changed','ownership_transferred',
    'team_chat_enabled','team_chat_disabled'))
);
CREATE INDEX IF NOT EXISTS workspace_audit_account_idx ON public.workspace_audit (account_id, at DESC);

-- ---------- 2. Append-only ----------
-- UPDATE, DELETE and TRUNCATE are refused for every writer, the table
-- owner included. The one way out is the cascade of a deleted account.
-- SECURITY DEFINER so the existence check is not narrowed by the
-- caller's RLS on accounts: an account the caller cannot see must not
-- pass for a deleted one.
CREATE OR REPLACE FUNCTION public.workspace_audit_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = OLD.account_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS workspace_audit_append_only ON public.workspace_audit;
CREATE TRIGGER workspace_audit_append_only BEFORE UPDATE OR DELETE ON public.workspace_audit
  FOR EACH ROW EXECUTE FUNCTION public.workspace_audit_append_only();
-- TRUNCATE bypasses row triggers.
DROP TRIGGER IF EXISTS workspace_audit_no_truncate ON public.workspace_audit;
CREATE TRIGGER workspace_audit_no_truncate BEFORE TRUNCATE ON public.workspace_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.workspace_audit_append_only();

-- ---------- 3. Membership changes (profiles) ----------
CREATE OR REPLACE FUNCTION public.workspace_audit_profiles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
    -- A profile leaving with its deleted account: nothing to log it in.
    IF EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = OLD.account_id) THEN
      INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail)
      VALUES (OLD.account_id, v_actor, 'member_removed', OLD.user_id,
              jsonb_strip_nulls(jsonb_build_object('role', OLD.account_role, 'name', OLD.full_name)));
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN NULL;
    END IF;
  END IF;

  -- An insert, or the arriving side of a move (role, deactivation and
  -- bank code are part of the new membership, not changes to log).
  IF TG_OP = 'INSERT' OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail)
    VALUES (NEW.account_id, v_actor, 'member_added', NEW.user_id,
            jsonb_strip_nulls(jsonb_build_object('role', NEW.account_role, 'name', NEW.full_name,
                                                 'bank_code', NEW.bank_code)));
    RETURN NULL;
  END IF;

  IF NEW.account_role IS DISTINCT FROM OLD.account_role THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail)
    VALUES (NEW.account_id, v_actor, 'role_changed', NEW.user_id,
            jsonb_build_object('from', OLD.account_role, 'to', NEW.account_role));
  END IF;
  IF (OLD.deactivated_at IS NULL) <> (NEW.deactivated_at IS NULL) THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id)
    VALUES (NEW.account_id, v_actor,
            CASE WHEN NEW.deactivated_at IS NULL THEN 'member_reactivated' ELSE 'member_deactivated' END,
            NEW.user_id);
  END IF;
  IF NEW.bank_code IS DISTINCT FROM OLD.bank_code THEN
    INSERT INTO public.workspace_audit (account_id, actor_id, action, target_user_id, detail)
    VALUES (NEW.account_id, v_actor, 'bank_changed', NEW.user_id,
            jsonb_build_object('from', OLD.bank_code, 'to', NEW.bank_code));
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS workspace_audit_profiles_insdel ON public.profiles;
CREATE TRIGGER workspace_audit_profiles_insdel AFTER INSERT OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.workspace_audit_profiles();
DROP TRIGGER IF EXISTS workspace_audit_profiles_update ON public.profiles;
CREATE TRIGGER workspace_audit_profiles_update
  AFTER UPDATE OF account_id, account_role, deactivated_at, bank_code ON public.profiles
  FOR EACH ROW
  WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id
        OR OLD.account_role IS DISTINCT FROM NEW.account_role
        OR (OLD.deactivated_at IS NULL) <> (NEW.deactivated_at IS NULL)
        OR OLD.bank_code IS DISTINCT FROM NEW.bank_code)
  EXECUTE FUNCTION public.workspace_audit_profiles();

-- ---------- 4. Workspace changes (accounts) ----------
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
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS workspace_audit_accounts_update ON public.accounts;
CREATE TRIGGER workspace_audit_accounts_update
  AFTER UPDATE OF name, short_name, owner_user_id, internal_chat_enabled ON public.accounts
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name
        OR OLD.short_name IS DISTINCT FROM NEW.short_name
        OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
        OR OLD.internal_chat_enabled IS DISTINCT FROM NEW.internal_chat_enabled)
  EXECUTE FUNCTION public.workspace_audit_accounts();

-- ---------- 5. Row-level security (reads only; the triggers write) ----------
ALTER TABLE public.workspace_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_audit_read ON public.workspace_audit;
CREATE POLICY workspace_audit_read ON public.workspace_audit
  FOR SELECT TO authenticated USING (public.is_account_member(account_id, 'admin'));

-- ---------- 6. Privileges ----------
-- Supabase grants ALL on new tables and EXECUTE on new functions to
-- anon / authenticated / service_role (and EXECUTE to PUBLIC): revoke
-- everything, then grant the minimum.
REVOKE ALL ON public.workspace_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.workspace_audit TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.workspace_audit_append_only(), public.workspace_audit_profiles(),
  public.workspace_audit_accounts()
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------- accounts: the column grants 057 §8 never extended ----------
-- 057 §8 revoked UPDATE on accounts and re-granted it column by column,
-- on the columns of the day. short_name (083) and internal_chat_enabled
-- (087) came later and were never granted, so PATCH /api/account's short
-- name and Settings -> Team chat's on/off switch (a browser UPDATE) both
-- failed with "permission denied" for everyone. The accounts_update
-- policy still holds the write to the account's admins. owner_user_id
-- and id stay ungranted: transfer_account_ownership() owns the first.
GRANT UPDATE (short_name, internal_chat_enabled) ON public.accounts TO authenticated;
