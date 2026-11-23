-- ============================================================
-- 265_guards.sql — rules found missing by the 2026-11-23 audit
--
--  1. profiles: what a workspace's admin granted a person (review all
--     calls, a personal WhatsApp number, the department) stayed on the
--     row when remove_account_member moved it to a workspace of their
--     own, and came back with it when they were invited again.
--  2. set_member_role, set_member_active, transfer_account_ownership:
--     the target was read without a lock, so a demotion racing a transfer
--     of ownership could leave a workspace with no owner.
--  3. authorize_member_password_change, authorize_member_details_change:
--     both allow only people below the caller. An admin could lower
--     another admin, set their password and put the role back, and so
--     sign in as them. For 7 days after someone stops being an admin or
--     owner only the owner may do either.
--  4. privacy_whatsapp_group_files_erase: erasing a customer blanked
--     their group messages but left the files they sent in the bucket
--     (the app copies those files since this release).
--  5. bump_conversation_on_inbound takes the message's own time. A
--     message processed late (264 retries it) put its words over a newer
--     message's as the chat's preview.
--
-- Restates bodies of 037, 083, 135, 140 and 167: apply in order, once.
-- Additive for the previous build: 5 keeps the two-argument call.
-- Re-runnable. Asserted by supabase/ci/verify-guards.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '265 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regclass('public.privacy_extensions') IS NULL THEN
    RAISE EXCEPTION '265: apply 229_desk_customer_contacts.sql first (privacy_extensions)';
  END IF;
  IF to_regclass('public.workspace_audit') IS NULL THEN
    RAISE EXCEPTION '265: apply 092 first (workspace_audit)';
  END IF;
END $$;

-- ---------- 1. Grants stay in the workspace that gave them ----------

CREATE OR REPLACE FUNCTION public.profiles_reset_grants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.may_review_all_calls := false;
  NEW.may_connect_personal_whatsapp := false;
  NEW.department := 'sales';
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.profiles_reset_grants() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_reset_grants ON public.profiles;
CREATE TRIGGER profiles_reset_grants
  BEFORE UPDATE OF account_id ON public.profiles
  FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id)
  EXECUTE FUNCTION public.profiles_reset_grants();

-- ---------- 2. Roles and ownership, one at a time ----------

-- 083's body; the target row is locked before its role is read.
CREATE OR REPLACE FUNCTION public.set_member_role(p_user_id uuid, p_new_role account_role_enum)
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
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;
  IF p_new_role IS NULL THEN
    RAISE EXCEPTION 'p_new_role is required' USING ERRCODE = '22023';
  END IF;
  SELECT account_role INTO v_target_role
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id
    FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;
  IF (v_target_role = 'bank_guest') <> (p_new_role = 'bank_guest') THEN
    RAISE EXCEPTION 'A bank guest cannot become staff or staff a bank guest; remove the member and add them again'
      USING ERRCODE = '22023';
  END IF;
  UPDATE profiles SET account_role = p_new_role
   WHERE user_id = p_user_id AND account_id = v_caller_account_id;
END;
$$;

-- 083's body; the target row is locked before its role is read.
CREATE OR REPLACE FUNCTION public.set_member_active(p_user_id uuid, p_active boolean)
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
  IF p_active IS NULL THEN
    RAISE EXCEPTION 'p_active is required' USING ERRCODE = '22023';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot deactivate or reactivate yourself'
      USING ERRCODE = '22023';
  END IF;
  SELECT account_role INTO v_target_role
    FROM profiles WHERE user_id = p_user_id AND account_id = v_caller_account_id
    FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_user_id);
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'The account owner cannot be deactivated'
      USING ERRCODE = '22023';
  END IF;
  IF p_active THEN
    UPDATE profiles SET deactivated_at = NULL, deactivated_by = NULL
     WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  ELSE
    UPDATE profiles
       SET deactivated_at = COALESCE(deactivated_at, NOW()),
           deactivated_by = COALESCE(deactivated_by, auth.uid())
     WHERE user_id = p_user_id AND account_id = v_caller_account_id;
  END IF;
END;
$$;

-- 135's body; the new owner's row is locked too.
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
   WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM raise_not_a_member(p_new_owner_user_id);
  END IF;
  IF v_target_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'The new owner must not be deactivated' USING ERRCODE = '22023';
  END IF;
  IF v_target_role = 'bank_guest' THEN
    RAISE EXCEPTION 'A bank guest cannot own an account' USING ERRCODE = '22023';
  END IF;
  UPDATE profiles SET account_role = 'admin'
   WHERE user_id = auth.uid() AND account_id = v_caller_account_id;
  UPDATE profiles SET account_role = 'owner'
   WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;
  UPDATE accounts SET owner_user_id = p_new_owner_user_id
   WHERE id = v_caller_account_id;
END;
$$;

-- ---------- 3. Nobody signs in as an admin they just lowered ----------

-- Whether someone else lowered this person from admin or owner there in
-- the last 7 days (092's audit of every role change). Their own step
-- down, an owner handing over, does not count.
CREATE OR REPLACE FUNCTION public.member_lately_admin(p_account uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_audit w
     WHERE w.account_id = p_account
       AND w.target_user_id = p_user
       AND w.action = 'role_changed'
       AND w.detail ->> 'from' IN ('admin', 'owner')
       AND w.detail ->> 'to' NOT IN ('admin', 'owner')
       AND w.actor_id <> p_user  -- never NULL: a change by hand in SQL has no actor
       AND w.at > now() - interval '7 days')
$$;

REVOKE ALL ON FUNCTION public.member_lately_admin(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 140's body; 4a is new.
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
  IF v_caller_role <> 'owner' AND public.member_lately_admin(v_caller_account_id, p_user_id) THEN
    RAISE EXCEPTION 'This person was an admin until a few days ago, so only the owner can change their password for now.'
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
                > array_position(v_ladder, t.account_role)
            AND (c.account_role = 'owner'
                 OR NOT public.member_lately_admin(t.account_id, p_user_id)))
  ) THEN
    RAISE EXCEPTION 'This person also belongs to a workspace you don''t manage, so you can''t change their password. They can change it themselves in Settings → Login & security.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- 167's body; 4a is new.
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
  IF v_caller_role <> 'owner' AND public.member_lately_admin(v_caller_account_id, p_user_id) THEN
    RAISE EXCEPTION 'This person was an admin until a few days ago, so only the owner can change their details for now.'
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
                > array_position(v_ladder, t.account_role)
            AND (c.account_role = 'owner'
                 OR NOT public.member_lately_admin(t.account_id, p_user_id)))
  ) THEN
    RAISE EXCEPTION 'This person also belongs to a workspace you don''t manage, so you can''t change their details.'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ---------- 4. The files an erased customer sent in groups ----------

-- 221 exports the messages themselves, media included.
CREATE OR REPLACE FUNCTION public.privacy_whatsapp_group_files_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT '[]'::jsonb
$$;

-- Runs before 262 blanks the rows (same match); it deletes nothing, and
-- privacy_objects_unreferenced drops what another row still points at.
CREATE OR REPLACE FUNCTION public.privacy_whatsapp_group_files_erase(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('counts', '{}'::jsonb, 'objects', coalesce(
    (SELECT jsonb_agg(DISTINCT jsonb_build_object('bucket', 'chat-media', 'url', m.media ->> 'link'))
       FROM public.contacts c
       JOIN public.whatsapp_group_messages m
         ON m.account_id = p_account
        AND public.privacy_digits(m.sender_wa_id) = public.privacy_digits(coalesce(c.phone_normalized, c.phone))
      WHERE c.id = p_contact AND c.account_id = p_account
        AND public.privacy_digits(coalesce(c.phone_normalized, c.phone)) IS NOT NULL
        AND m.media ->> 'link' LIKE '%/chat-media/account-' || p_account::text || '/%'), '[]'::jsonb))
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('whatsapp_group_files', 'privacy_whatsapp_group_files_export',
        'privacy_whatsapp_group_files_erase', '265')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

REVOKE ALL ON FUNCTION public.privacy_whatsapp_group_files_export(uuid, uuid),
  public.privacy_whatsapp_group_files_erase(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 5. A late message is not the newest ----------

-- Dropped and created in one statement: two overloads would make the
-- two-argument call of the previous build ambiguous.
DO $$
BEGIN
  DROP FUNCTION IF EXISTS public.bump_conversation_on_inbound(uuid, text);
  CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
    p_conversation_id uuid,
    p_last_message_text text,
    p_message_at timestamptz DEFAULT NULL
  )
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
    -- Newest by the time WhatsApp stamped it, which is what created_at
    -- holds: last_message_at is when we processed the one before, and a
    -- backlog arrives long after it was written.
    WITH newer AS (
      SELECT p_message_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM messages m
         WHERE m.conversation_id = p_conversation_id
           AND m.created_at > p_message_at) AS yes
    )
    UPDATE conversations c
       SET unread_count      = COALESCE(c.unread_count, 0) + 1,
           last_message_text = CASE WHEN newer.yes THEN c.last_message_text ELSE p_last_message_text END,
           last_message_at   = CASE WHEN newer.yes THEN c.last_message_at ELSE NOW() END,
           updated_at        = NOW()
      FROM newer
     WHERE c.id = p_conversation_id;
  $fn$;
  REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.bump_conversation_on_inbound(uuid, text, timestamptz) TO service_role;
END $$;

COMMENT ON FUNCTION public.bump_conversation_on_inbound(uuid, text, timestamptz) IS
  'A customer message arrived (037): unread + 1, and the preview and place in the list unless a newer message is already there (265; p_message_at is WhatsApp''s time, NULL means newest).';

DO $$ BEGIN
  IF to_regprocedure('public.bump_conversation_on_inbound(uuid,text,timestamptz)') IS NULL
     OR to_regprocedure('public.bump_conversation_on_inbound(uuid,text)') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'profiles_reset_grants' AND tgrelid = 'public.profiles'::regclass)
     OR NOT EXISTS (SELECT 1 FROM public.privacy_extensions WHERE name = 'whatsapp_group_files') THEN
    RAISE EXCEPTION '265 did not apply completely';
  END IF;
END $$;
