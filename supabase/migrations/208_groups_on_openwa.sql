-- ============================================================
-- 208_groups_on_openwa.sql — WhatsApp groups on company OpenWA numbers
--
-- 114 kept groups on Whapi numbers. A company OpenWA number (144,
-- provider 'openwa', is_personal false) is a linked device too, so it
-- may now host a group. Never a personal number (190: a person's own
-- phone), never Meta (the Cloud API's groups are 088's deal rooms).
--
--  * whatsapp_group_can_create: the number is Whapi, or OpenWA and not
--    personal; everything else as 114 (agent and up, the active
--    workspace, can_use_channel). TS mirror canCreateGroup and
--    isGroupCapableNumber (src/lib/groups/access.ts) — change both.
--  * whatsapp_groups_guard: a new group's number is Whapi or company
--    OpenWA, refused otherwise ("Groups need a Whapi or company OpenWA
--    number"); the rest of 114's guard is unchanged.
--  * Submission groups (115, 136) stay Whapi-only: their gates are not
--    touched here.
--  * Nothing else in 114 or later (146, 173) tests the provider.
--
-- Apply before the build. Apply in order, once: 208 CREATE OR REPLACEs
-- two functions 114 also defines, so re-applying 114 after 208 puts the
-- Whapi-only bodies back; re-apply 208 after it if that ever happens.
--
-- The SECURITY DEFINER bodies read RLS-forced tables, so, as 114, this
-- must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE OR REPLACE only. Apply after 207.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '208 must be applied by a superuser or BYPASSRLS role (the group functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Who creates ----------

-- Agent and up, on a Whapi or company OpenWA number of the active
-- workspace they may use.
CREATE OR REPLACE FUNCTION public.whatsapp_group_can_create(p_channel uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT current_account_id() IS NOT NULL
     AND current_role_rank() >= 2
     AND EXISTS (SELECT 1 FROM whatsapp_config w
                  WHERE w.id = p_channel
                    AND w.account_id = current_account_id()
                    AND w.provider IN ('whapi', 'openwa')
                    AND NOT coalesce(w.is_personal, false))
     AND can_use_channel(current_account_id(), p_channel);
$$;
COMMENT ON FUNCTION public.whatsapp_group_can_create(uuid) IS
  'May the caller create a group on this number? Agent and up, a Whapi or company (not personal) OpenWA number of the active workspace, can_use_channel. TS mirror canCreateGroup. Migrations 114, 208.';

-- ---------- 2. Integrity (every writer, the service role included) ----------

CREATE OR REPLACE FUNCTION public.whatsapp_groups_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account  uuid;
  v_provider text;
  v_personal boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.wa_group_id IS DISTINCT FROM OLD.wa_group_id
       -- An unowned row may be stamped once: the groups.post webhook for a
       -- group our number just created can land before the create route
       -- stamps its creator. A set creator never changes.
       OR NEW.created_by IS DISTINCT FROM OLD.created_by AND OLD.created_by IS NOT NULL THEN
      RAISE EXCEPTION 'A group''s workspace, WhatsApp id and creator cannot be changed'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The number only goes away (ON DELETE SET NULL); it never moves.
    IF NEW.channel_id IS DISTINCT FROM OLD.channel_id AND NEW.channel_id IS NOT NULL THEN
      RAISE EXCEPTION 'A group cannot move to another number'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.channel_id IS NULL THEN
      RAISE EXCEPTION 'A group lives on a Whapi or company OpenWA number'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w.account_id, w.provider, coalesce(w.is_personal, false)
      INTO v_account, v_provider, v_personal
      FROM whatsapp_config w WHERE w.id = NEW.channel_id;
    IF v_account IS NULL OR v_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'That number is not in the group''s workspace'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_provider IS NULL OR v_provider NOT IN ('whapi', 'openwa') OR v_personal THEN
      RAISE EXCEPTION 'Groups need a Whapi or company OpenWA number'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- left_at is trigger-owned.
  IF NEW.our_role = 'left' THEN
    NEW.left_at := CASE WHEN TG_OP = 'UPDATE' AND OLD.our_role = 'left'
                        THEN OLD.left_at ELSE now() END;
  ELSE
    NEW.left_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
