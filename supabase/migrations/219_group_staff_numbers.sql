-- ============================================================
-- 219_group_staff_numbers.sql — a staff member's saved WhatsApp number
-- links them to the groups that number is in.
--
-- The problem. A coordinator's own number (coordinator_phones, 142) is
-- often a participant of a WhatsApp group (114) or a submission group
-- (115), but the CRM did not connect the two: the person could see
-- their own phone in the group and still not send into it from the
-- CRM, because nobody had made them a manager / put them on the access
-- list by hand.
--
-- The rule now. A number counts only when it is the saved number of
-- exactly one live agent or team leader of the group's workspace
-- (staff_by_saved_phone). Owners and admins already manage everything;
-- viewers, bank guests, deactivated or demoted people and hidden
-- (@lid) participants never match, and a number two people saved
-- matches nobody.
--
--   * WhatsApp groups: a participant row inserted with that number makes
--     the person a manager (whatsapp_group_managers); saving or changing
--     the number makes them a manager of every group of the workspace
--     the number is already in. Existing groups are backfilled once.
--   * Submission groups: sg_staff_number_joined(group, phone), called by
--     the app when a number joins, puts the person on the access list
--     with label 'coordinator' (ACTIVE groups only; added_by NULL marks
--     a system write).
--
-- The participants trigger is AFTER INSERT only, on purpose: an upsert
-- that updates an existing participant row must not re-grant. Removing
-- a manager removes their number from the group, and a removal that
-- failed at WhatsApp leaves the number in the next snapshot; that
-- snapshot must not bring the grant back.
--
-- Neither trigger ever fails the write it rides on: any error becomes
-- a WARNING. Re-running this file re-runs the backfill, which re-grants
-- a manager removed by hand whose number is still a participant.
--
-- Apply after 218, as postgres (superuser) or a BYPASSRLS role, like
-- 114/115/142: the functions read RLS-forced tables as their definer.
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF
-- EXISTS, ON CONFLICT DO NOTHING.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = current_user
       AND (r.rolsuper
            OR (r.rolbypassrls
                AND pg_has_role(current_user,
                      (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.submission_groups'::regclass),
                      'MEMBER')))
  ) THEN
    RAISE EXCEPTION '219 must be applied by a superuser or a BYPASSRLS owner of public.submission_groups';
  END IF;
END $$;

-- ---------- 1. Lookups ----------

CREATE INDEX IF NOT EXISTS coordinator_phones_account_phone_idx
  ON public.coordinator_phones (account_id, phone);

-- coordinator_phones keeps the row of a person deactivated or demoted
-- since (no cleanup trigger), so the staff filter here is the check.
CREATE OR REPLACE FUNCTION public.staff_saved_phone(p_account uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT cp.phone
    FROM coordinator_phones cp
   WHERE cp.account_id = p_account
     AND cp.user_id = p_user
     AND EXISTS (
       SELECT 1 FROM profiles p
        WHERE p.user_id = cp.user_id
          AND p.account_id = cp.account_id
          AND p.deactivated_at IS NULL
          AND p.account_role::text IN ('agent', 'team_leader'));
$$;

REVOKE ALL ON FUNCTION public.staff_saved_phone(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_saved_phone(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.staff_saved_phone(uuid, uuid) IS
  'The saved WhatsApp number (digits) of a live agent / team leader of the account, else NULL. Service role only. Migration 219.';

-- Digits only, a leading 00 dropped. NULL for NULL, blank or anything
-- with '@' (a hidden @lid participant never matches), and when no one
-- or more than one person saved the number.
CREATE OR REPLACE FUNCTION public.staff_by_saved_phone(p_account uuid, p_phone text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH n AS (
    SELECT regexp_replace(regexp_replace(p_phone, '[^0-9]', '', 'g'), '^00', '') AS digits
     WHERE p_phone IS NOT NULL
       AND p_phone !~ '^[[:space:]]*$'
       AND strpos(p_phone, '@') = 0
  ), m AS (
    SELECT cp.user_id
      FROM coordinator_phones cp, n
     WHERE n.digits <> ''
       AND cp.account_id = p_account
       AND cp.phone = n.digits
       AND EXISTS (
         SELECT 1 FROM profiles p
          WHERE p.user_id = cp.user_id
            AND p.account_id = cp.account_id
            AND p.deactivated_at IS NULL
            AND p.account_role::text IN ('agent', 'team_leader'))
  )
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(m.user_id))[1] END FROM m;
$$;

REVOKE ALL ON FUNCTION public.staff_by_saved_phone(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_by_saved_phone(uuid, text) TO service_role;

COMMENT ON FUNCTION public.staff_by_saved_phone(uuid, text) IS
  'The one live agent / team leader of the account whose saved WhatsApp number is p_phone (digits compared, leading 00 dropped); NULL for no match, several matches, blank or an @lid id. Service role only. Migration 219.';

-- ---------- 2. WhatsApp groups: a participant joins ----------

CREATE OR REPLACE FUNCTION public.whatsapp_group_participants_staff_manager()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  BEGIN
    v_user := staff_by_saved_phone(NEW.account_id, NEW.wa_id);
    IF v_user IS NOT NULL THEN
      INSERT INTO whatsapp_group_managers (group_id, account_id, user_id)
      VALUES (NEW.group_id, NEW.account_id, v_user)
      ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'whatsapp_group_participants_staff_manager: group %: % (%)',
      NEW.group_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_group_participants_staff_manager() FROM PUBLIC, anon, authenticated;

-- AFTER INSERT only: see the header (a snapshot upsert must not re-grant).
DROP TRIGGER IF EXISTS whatsapp_group_participants_staff_manager ON public.whatsapp_group_participants;
CREATE TRIGGER whatsapp_group_participants_staff_manager
  AFTER INSERT ON public.whatsapp_group_participants
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_group_participants_staff_manager();

-- ---------- 3. WhatsApp groups: a number is saved ----------

-- Same matching rule as the participant side: only when the number is
-- this person's alone and they are live agent / team leader staff.
CREATE OR REPLACE FUNCTION public.coordinator_phones_staff_manager()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF staff_by_saved_phone(NEW.account_id, NEW.phone) IS NOT DISTINCT FROM NEW.user_id THEN
      INSERT INTO whatsapp_group_managers (group_id, account_id, user_id)
      SELECT DISTINCT p.group_id, p.account_id, NEW.user_id
        FROM whatsapp_group_participants p
       WHERE p.account_id = NEW.account_id
         AND p.wa_id = NEW.phone
      ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'coordinator_phones_staff_manager: user %: % (%)',
      NEW.user_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.coordinator_phones_staff_manager() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS coordinator_phones_staff_manager ON public.coordinator_phones;
CREATE TRIGGER coordinator_phones_staff_manager
  AFTER INSERT OR UPDATE OF phone ON public.coordinator_phones
  FOR EACH ROW EXECUTE FUNCTION public.coordinator_phones_staff_manager();

-- ---------- 4. Backfill (re-runnable) ----------

-- staff_by_saved_phone only returns live agents / team leaders, so the
-- managers guard never refuses a row here.
INSERT INTO public.whatsapp_group_managers (group_id, account_id, user_id)
SELECT DISTINCT p.group_id, p.account_id, s.user_id
  FROM public.whatsapp_group_participants p
  CROSS JOIN LATERAL (SELECT public.staff_by_saved_phone(p.account_id, p.wa_id) AS user_id) s
 WHERE strpos(p.wa_id, '@') = 0
   AND EXISTS (SELECT 1 FROM public.coordinator_phones cp
                WHERE cp.account_id = p.account_id AND cp.phone = p.wa_id)
   AND s.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------- 5. Submission groups: a number joins ----------

-- Returns the staff member the number belongs to once they are on the
-- access list, else NULL (group missing or not ACTIVE, number matches
-- no one). An open row already there, whatever its label, is left as
-- it is. added_by NULL: this is the system's write, not a person's.
CREATE OR REPLACE FUNCTION public.sg_staff_number_joined(p_group uuid, p_phone text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_user    uuid;
BEGIN
  -- FOR SHARE, as the access guard takes it: the group cannot end
  -- between this check and the insert.
  SELECT g.account_id INTO v_account FROM submission_groups g
   WHERE g.id = p_group AND g.status = 'ACTIVE' FOR SHARE;
  IF v_account IS NULL THEN
    RETURN NULL;
  END IF;
  v_user := staff_by_saved_phone(v_account, p_phone);
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM submission_group_access a
              WHERE a.group_id = p_group AND a.user_id = v_user AND a.removed_at IS NULL) THEN
    RETURN v_user;
  END IF;
  BEGIN
    INSERT INTO submission_group_access (group_id, account_id, user_id, label, added_by, added_at)
    VALUES (p_group, v_account, v_user, 'coordinator', NULL, clock_timestamp());
  EXCEPTION WHEN unique_violation THEN
    NULL; -- a concurrent call added them first
  END;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_staff_number_joined(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sg_staff_number_joined(uuid, text) TO service_role;

COMMENT ON FUNCTION public.sg_staff_number_joined(uuid, text) IS
  'A number joined an ACTIVE submission group: if it is the saved number of one live agent / team leader, put them on the access list as ''coordinator'' (added_by NULL; an open row of theirs is left alone) and return their id; else NULL. Service role only. Migration 219.';

RESET lock_timeout;
