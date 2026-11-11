-- 192: departments and department inboxes.
--
-- Staff get a department besides their role: a fixed list, one per
-- person per workspace (the profile row), 'sales' by default.
--
--   1. profiles.department (sales | hr | it | accounts), guarded like
--      the role: nobody sets their own; only set_member_department().
--   2. account_departments: per-workspace switches per department.
--      own_inbox = the department's chats leave the main and Team inbox
--      for a separate department inbox (owners/admins only, enforced in
--      the app); restricted = no sales areas (enforced in the app). A
--      missing row is the built-in default: hr on/on, the rest off/off.
--      Members read it; only set_department_settings() writes it.
--   3. department_own_inbox / department_restricted: row else default.
--   4. conversations.inbox_department: the department (with its own
--      inbox) of the chat's assignee if there is one, else of its owner
--      (user_id); NULL when that department has no own inbox or the
--      person has no profile in the workspace. Kept by:
--        - a BEFORE INSERT / UPDATE OF user_id, assigned_agent_id,
--          inbox_department trigger, for every writer (service role
--          too). It always recomputes, so a client-supplied value is
--          overwritten rather than refused. Named zz_ so it runs after
--          every other BEFORE trigger on conversations (alphabetical
--          order) and sees the final assignee and owner.
--        - an AFTER trigger on profiles (department, account_id,
--          user_id changes, inserts and deletes) recomputing that
--          person's chats in the workspace(s) involved;
--        - set_department_settings(), recomputing the workspace.
--      The recompute writes only inbox_department, so column-list
--      triggers on other columns (169's contact move, 080/138's deals,
--      191's personal guard, 042's assignment guard) do not fire or
--      return early. It does bump updated_at (001's set_updated_at).
--   5. Backfill (all NULL today, since everyone is sales; run anyway).
--
-- A personal chat (191) has user_id = personal_owner_id, so it follows
-- its owner's department like any other chat.
--
-- Apply as postgres (or superuser). Re-runnable.

-- ---------- 1. profiles.department ----------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS department text NOT NULL DEFAULT 'sales'
    CONSTRAINT profiles_department_check
    CHECK (department IN ('sales', 'hr', 'it', 'accounts'));

COMMENT ON COLUMN public.profiles.department IS
  'The person''s department in this workspace (sales | hr | it | accounts). Written only by set_member_department(). Migration 192.';

-- 190's body with department among the guarded columns: without it a
-- person could move themselves out of (or into) a department inbox.
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
       OR NEW.may_connect_personal_whatsapp IS DISTINCT FROM OLD.may_connect_personal_whatsapp
       OR NEW.department IS DISTINCT FROM OLD.department
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

-- ---------- 2. account_departments ----------

CREATE TABLE IF NOT EXISTS public.account_departments (
  account_id uuid NOT NULL REFERENCES public.accounts (id) ON DELETE CASCADE,
  department text NOT NULL
    CONSTRAINT account_departments_department_check
    CHECK (department IN ('sales', 'hr', 'it', 'accounts')),
  own_inbox  boolean NOT NULL,
  restricted boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, department)
);

COMMENT ON TABLE public.account_departments IS
  'Per-workspace department switches. A missing row is the built-in default (hr: own inbox and restricted; others: neither). Members read; written only by set_department_settings(). Migration 192.';

ALTER TABLE public.account_departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_departments_select ON public.account_departments;
CREATE POLICY account_departments_select ON public.account_departments
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id));

REVOKE ALL ON public.account_departments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.account_departments TO authenticated, service_role;

-- ---------- 3. Department switches (row else default) ----------

CREATE OR REPLACE FUNCTION public.department_own_inbox(p_account uuid, p_department text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT d.own_inbox FROM public.account_departments d
      WHERE d.account_id = p_account AND d.department = p_department),
    p_department IS NOT DISTINCT FROM 'hr');
$$;

CREATE OR REPLACE FUNCTION public.department_restricted(p_account uuid, p_department text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT d.restricted FROM public.account_departments d
      WHERE d.account_id = p_account AND d.department = p_department),
    p_department IS NOT DISTINCT FROM 'hr');
$$;

REVOKE ALL ON FUNCTION public.department_own_inbox(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.department_restricted(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.department_own_inbox(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.department_restricted(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.department_own_inbox(uuid, text) IS
  'Does this department have its own inbox in this workspace (account_departments row, else hr only). Migration 192.';
COMMENT ON FUNCTION public.department_restricted(uuid, text) IS
  'Is this department kept out of the sales areas in this workspace (account_departments row, else hr only). Migration 192.';

-- ---------- 4. conversations.inbox_department ----------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS inbox_department text NULL
    CONSTRAINT conversations_inbox_department_check
    CHECK (inbox_department IN ('sales', 'hr', 'it', 'accounts'));

COMMENT ON COLUMN public.conversations.inbox_department IS
  'The department inbox this chat sits in: the assignee''s department (else the owner''s) when that department has its own inbox; NULL = the main inbox. Derived by trigger for every writer; never written directly. Migration 192.';

CREATE INDEX IF NOT EXISTS conversations_inbox_department_idx
  ON public.conversations (account_id, inbox_department)
  WHERE inbox_department IS NOT NULL;

-- The one definition of a chat's department inbox.
CREATE OR REPLACE FUNCTION public.conversation_inbox_department(
  p_account uuid, p_user uuid, p_assignee uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.department
    FROM public.profiles p
   WHERE p.account_id = p_account
     AND p.user_id = COALESCE(p_assignee, p_user)
     AND public.department_own_inbox(p_account, p.department)
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.conversation_inbox_department(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.conversations_inbox_department()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.inbox_department := public.conversation_inbox_department(
    NEW.account_id, NEW.user_id, NEW.assigned_agent_id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.conversations_inbox_department() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_conversations_inbox_department ON public.conversations;
CREATE TRIGGER zz_conversations_inbox_department
  BEFORE INSERT OR UPDATE OF user_id, assigned_agent_id, inbox_department
  ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.conversations_inbox_department();

-- Set-based recompute of a workspace's chats, or of one person's chats
-- in it (those they are assigned, and those they own unassigned).
-- Only rows whose value changes are written. No client grant.
CREATE OR REPLACE FUNCTION public.refresh_inbox_departments(
  p_account uuid, p_user uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_account IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.conversations c
     SET inbox_department = public.conversation_inbox_department(
           c.account_id, c.user_id, c.assigned_agent_id)
   WHERE c.account_id = p_account
     AND (p_user IS NULL
          OR c.assigned_agent_id = p_user
          OR (c.assigned_agent_id IS NULL AND c.user_id = p_user))
     AND c.inbox_department IS DISTINCT FROM public.conversation_inbox_department(
           c.account_id, c.user_id, c.assigned_agent_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_inbox_departments(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- A person's department, workspace or identity changing (or the
-- profile arriving or leaving) moves their chats. Account changes
-- matter: removing someone moves their row to a fresh account, and
-- their old chats must not stay stuck in a department inbox.
CREATE OR REPLACE FUNCTION public.profiles_refresh_inbox_departments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.refresh_inbox_departments(OLD.account_id, OLD.user_id);
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT')
     AND (TG_OP = 'INSERT'
          OR NEW.account_id IS DISTINCT FROM OLD.account_id
          OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    PERFORM public.refresh_inbox_departments(NEW.account_id, NEW.user_id);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_refresh_inbox_departments() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_refresh_inbox_departments ON public.profiles;
CREATE TRIGGER profiles_refresh_inbox_departments
  AFTER UPDATE OF department, account_id, user_id ON public.profiles
  FOR EACH ROW
  WHEN (OLD.department IS DISTINCT FROM NEW.department
        OR OLD.account_id IS DISTINCT FROM NEW.account_id
        OR OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION public.profiles_refresh_inbox_departments();

DROP TRIGGER IF EXISTS profiles_refresh_inbox_departments_insdel ON public.profiles;
CREATE TRIGGER profiles_refresh_inbox_departments_insdel
  AFTER INSERT OR DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_refresh_inbox_departments();

-- ---------- RPCs ----------

-- Definer: runs as the function owner, so the profile guard above
-- (current_user = 'authenticated') lets its write through, as it does
-- for set_member_personal_whatsapp (190).
CREATE OR REPLACE FUNCTION public.set_member_department(p_user_id uuid, p_department text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can set a member''s department'
      USING ERRCODE = '42501', HINT = 'not_admin';
  END IF;
  IF p_user_id IS NULL OR p_department IS NULL
     OR p_department NOT IN ('sales', 'hr', 'it', 'accounts') THEN
    RAISE EXCEPTION 'Unknown department: %', coalesce(p_department, 'NULL')
      USING ERRCODE = '22023', HINT = 'bad_department';
  END IF;

  -- One writer per person at a time (the row lock switch_account takes).
  PERFORM 1 FROM public.profiles p
    WHERE p.user_id = p_user_id AND p.account_id = v_acct
      AND p.deactivated_at IS NULL
      AND p.account_role::text <> 'bank_guest'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found' USING ERRCODE = 'P0002', HINT = 'no_member';
  END IF;

  UPDATE public.profiles p
     SET department = p_department
   WHERE p.user_id = p_user_id AND p.account_id = v_acct
     AND p.department IS DISTINCT FROM p_department;
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_department(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_department(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_member_department(uuid, text) IS
  'Set a live staff member''s department in the caller''s active account (owner/admin only); their chats move inbox by trigger. Migration 192.';

CREATE OR REPLACE FUNCTION public.set_department_settings(
  p_department text, p_own_inbox boolean, p_restricted boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can change department settings'
      USING ERRCODE = '42501', HINT = 'not_admin';
  END IF;
  IF p_department IS NULL OR p_department NOT IN ('sales', 'hr', 'it', 'accounts') THEN
    RAISE EXCEPTION 'Unknown department: %', coalesce(p_department, 'NULL')
      USING ERRCODE = '22023', HINT = 'bad_department';
  END IF;
  IF p_own_inbox IS NULL OR p_restricted IS NULL THEN
    RAISE EXCEPTION 'Both switches are required'
      USING ERRCODE = '22023', HINT = 'bad_settings';
  END IF;

  INSERT INTO public.account_departments AS d
         (account_id, department, own_inbox, restricted, updated_at)
  VALUES (v_acct, p_department, p_own_inbox, p_restricted, now())
  ON CONFLICT (account_id, department) DO UPDATE
     SET own_inbox  = EXCLUDED.own_inbox,
         restricted = EXCLUDED.restricted,
         updated_at = now();

  PERFORM public.refresh_inbox_departments(v_acct);
END;
$$;

REVOKE ALL ON FUNCTION public.set_department_settings(text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_department_settings(text, boolean, boolean) TO authenticated;

COMMENT ON FUNCTION public.set_department_settings(text, boolean, boolean) IS
  'Set a department''s own-inbox and restricted switches in the caller''s active account (owner/admin only), then move the workspace''s chats accordingly. Migration 192.';

-- ---------- 5. Backfill ----------

UPDATE public.conversations c
   SET inbox_department = public.conversation_inbox_department(
         c.account_id, c.user_id, c.assigned_agent_id)
 WHERE c.inbox_department IS DISTINCT FROM public.conversation_inbox_department(
         c.account_id, c.user_id, c.assigned_agent_id);
