-- ============================================================
-- Migration 306: leaving a workspace, and coming back to it
-- ============================================================
--
-- 1. Removing a member without deactivating them first left their
--    Yeastar extension mapped to them, softphone on: 199's cleanup runs
--    on deactivated_at only. profiles_leave_account_teams (071; the row
--    moving to another account, and its deletion) now unmaps it too, with
--    199's statement, so pbx_extensions_guard and 101's presence trigger
--    act as they do there. Nothing else of 199's was missing: 071 already
--    drops the team, the leader mark and the number allocations.
-- 2. The same, once, for every extension whose holder has no live profile
--    in its workspace.
-- 3. add_workspace_member (083, last restated by 175) takes back somebody
--    its workspace removed, when all they have is the empty private
--    account the removal gave them: the row is moved as
--    provision_account_member moves a new login's. Until now that was
--    `no_such_user`, and a person deactivated before the removal (their
--    login still banned) could not use an invitation either. The app
--    lifts the ban of whoever it adds (lib/account/add-member.ts); the
--    password is never touched. Owner-only for a removed admin, the
--    mirror of 287's removal rule. Removals older than 092's audit are
--    not known and stay `no_such_user`.
--
-- Both functions are the catalog's bodies with the marked lines added;
-- signatures, search_path and grants (CREATE OR REPLACE keeps them) are
-- unchanged. Re-applying 071 or 175 undoes this: apply in order.
-- Re-runnable. supabase/ci/verify-member-leaving.sql asserts it.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. Leaving unmaps the extension ----------

CREATE OR REPLACE FUNCTION public.profiles_leave_account_teams()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.account_id IS NOT NULL THEN
    -- The account's sync lock before any row (see the header).
    PERFORM pg_advisory_xact_lock(channel_access_lock_key(OLD.account_id));
    DELETE FROM whatsapp_channel_members
     WHERE user_id = OLD.user_id AND account_id = OLD.account_id;
    DELETE FROM team_members
     WHERE user_id = OLD.user_id AND account_id = OLD.account_id;
    UPDATE teams SET leader_user_id = NULL
     WHERE leader_user_id = OLD.user_id AND account_id = OLD.account_id;
    -- 306: the extension too, as 199 does on a deactivation.
    UPDATE pbx_extensions SET user_id = NULL, softphone_enabled = false
     WHERE user_id = OLD.user_id AND account_id = OLD.account_id;
    PERFORM sync_channel_team_members(OLD.account_id);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM sync_channel_team_members(NEW.account_id);
  END IF;
  RETURN NULL;
END;
$function$;

-- ---------- 2. Extensions left behind before 306 ----------
DO $backfill$
DECLARE
  n int;
BEGIN
  UPDATE public.pbx_extensions e
     SET user_id = NULL, softphone_enabled = false
   WHERE e.user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.user_id = e.user_id
                        AND p.account_id = e.account_id
                        AND p.deactivated_at IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '306: % extension(s) taken off people who left', n;
END
$backfill$;

-- ---------- 3. Taking a removed person back ----------

CREATE OR REPLACE FUNCTION public.add_workspace_member(p_email text, p_role account_role_enum, p_bank_code text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_removed_role TEXT;
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
    -- 306: or somebody this workspace removed, who has had nothing since
    -- but the empty private account the removal gave them.
    IF v_user IS NOT NULL THEN
      PERFORM 1 FROM profiles WHERE user_id = v_user ORDER BY id FOR UPDATE;
      SELECT w.detail ->> 'role' INTO v_removed_role
        FROM workspace_audit w
       WHERE w.account_id = v_account AND w.target_user_id = v_user
         AND w.action = 'member_removed'
         AND w.actor_id <> v_user  -- never NULL: somebody here removed them
       ORDER BY w.at DESC LIMIT 1;
      IF FOUND AND disposable_personal_account(v_user) IS NOT NULL THEN
        -- remove_account_member's rule (287): only the owner removes an
        -- admin, so only the owner takes one back, in any role.
        IF v_role <> 'owner'
           AND (v_removed_role IN ('owner', 'admin')
                OR member_lately_admin(v_account, v_user)) THEN
          RAISE EXCEPTION 'Only the owner can add back an admin who was removed'
            USING ERRCODE = '42501';
        END IF;
        PERFORM provision_account_member(v_user, v_account, p_role, v_code);
        RETURN v_user;
      END IF;
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
$function$;

RESET lock_timeout;
