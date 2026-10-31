-- ============================================================
-- 163_bank_coordinator_submission_groups.sql — a coordinator sees and
-- sends in the ACTIVE submission groups of the banks they hold.
--
-- Below admin, a submission group (115) is visible only to the people
-- on its access list (submission_group_access, open row = removed_at
-- IS NULL). Bank coordinators reach that list only when a real
-- WhatsApp group is opened (142, TS side), and since 136 most
-- submissions open with wa_mode = 'none', so a coordinator of ADCB
-- never saw the ADCB submissions. The list is also fixed at creation:
-- a bank given later never reached the older groups. 161 made holding
-- a case's bank a live coordinator role on the case; this does the
-- same for the case's group:
--
--  * sg_holds_group_bank(group, user): the group's case (cases.group_id,
--    one case per group) is of a bank the user holds
--    (case_holds_bank, 161: a live agent / team_leader). Service role
--    only (definer functions call it as owner).
--  * On an ACTIVE group a holder with no open row counts as if they had
--    an open row labelled 'coordinator': sg_read_role / sg_can_read,
--    sg_resolve_role, sg_can_send (so sg_send_begin) and sg_visible_ids
--    (the SELECT policies of the four submission_group* tables). Someone
--    with a real open row keeps their own label.
--  * ENDED groups are unchanged: the audited archive (sg_read_archive,
--    the 60-day supervisor window) stays with the people on the list at
--    the end. Taking the bank away removes the live access at once.
--  * No access rows are written (no backfill): the rule is live.
--
-- TS mirrors: lib/submission-groups/store.ts (openAccessLabel) and the
-- list route's label must learn the bank fallback.
--
-- 161 must be applied first. As 115, this must be applied by a
-- superuser or BYPASSRLS role: the functions read RLS-forced tables.
-- Re-runnable: CREATE OR REPLACE only, same signatures, so 115's grants
-- stay. Asserted by
-- supabase/ci/verify-bank-coordinator-submissions.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '163 must be applied by a superuser or BYPASSRLS role (the functions read RLS-forced tables); apply 161 first';
  END IF;
END $$;

-- ---------- 1. Holding a group's bank ----------

CREATE OR REPLACE FUNCTION public.sg_holds_group_bank(p_group uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.cases c
     WHERE c.group_id = p_group
       AND public.case_holds_bank(c.account_id, p_user, c.bank_code))
$$;

REVOKE ALL ON FUNCTION public.sg_holds_group_bank(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sg_holds_group_bank(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.sg_holds_group_bank(uuid, uuid) IS
  'Does p_user hold the bank of the case of submission group p_group (case_holds_bank)? On an ACTIVE group that counts as an open ''coordinator'' access row. Migration 163.';

-- ---------- 2. Role resolvers ----------

-- 115's resolver: 'owner'/'admin' if an archive reader, else the open
-- access label, else 'coordinator' on an ACTIVE group of a bank held.
CREATE OR REPLACE FUNCTION public.sg_resolve_role(p_group uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(public.sg_archive_role(g.account_id, p_user),
                  (SELECT a.label FROM public.submission_group_access a
                    WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL),
                  CASE WHEN g.status = 'ACTIVE' AND public.sg_holds_group_bank(g.id, p_user)
                       THEN 'coordinator' END)
    FROM public.submission_groups g WHERE g.id = p_group
$$;

-- 115's sg_read_role; on an ACTIVE group with no open row, holding the
-- case's bank reads as an open 'coordinator' row. ENDED unchanged.
CREATE OR REPLACE FUNCTION public.sg_read_role(p_group uuid, p_user uuid, p_now timestamptz, p_window_days int)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  g      public.submission_groups%ROWTYPE;
  v_role text;
  v_open boolean := false;
BEGIN
  SELECT * INTO g FROM public.submission_groups WHERE id = p_group;
  IF NOT FOUND OR p_user IS NULL THEN
    RETURN NULL;
  END IF;
  v_role := public.sg_archive_role(g.account_id, p_user);
  IF v_role IS NULL AND public.sg_is_staff(g.account_id, p_user) THEN
    IF g.status = 'ACTIVE' THEN
      SELECT a.label INTO v_role FROM public.submission_group_access a
       WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL;
      IF v_role IS NULL AND public.sg_holds_group_bank(g.id, p_user) THEN
        v_role := 'coordinator';
      END IF;
      v_open := v_role IS NOT NULL;
    ELSE
      SELECT a.label INTO v_role FROM public.submission_group_access a
       WHERE a.group_id = g.id AND a.user_id = p_user
         AND a.added_at <= g.ended_at AND (a.removed_at IS NULL OR a.removed_at >= g.ended_at)
       ORDER BY a.added_at DESC LIMIT 1;
    END IF;
  END IF;
  IF public.sg_rule_can_read(g.status, v_role, v_open, v_role IS NOT NULL, g.ended_at,
                             coalesce(p_now, now()), p_window_days) THEN
    RETURN v_role;
  END IF;
  RETURN NULL;
END;
$$;

-- ---------- 3. Sending ----------

-- 115's sg_can_send: ACTIVE, live staff, and on the open list or
-- holding the case's bank. sg_send_begin (136) calls this and reads no
-- label, so it needs no change.
CREATE OR REPLACE FUNCTION public.sg_can_send(p_group uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT g.status = 'ACTIVE'
       AND public.sg_is_staff(g.account_id, p_user)
       AND (EXISTS (SELECT 1 FROM public.submission_group_access a
                     WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL)
            OR public.sg_holds_group_bank(g.id, p_user))
      FROM public.submission_groups g WHERE g.id = p_group), false)
$$;

-- ---------- 4. Live visibility (the RLS policies) ----------

-- 115's sg_visible_ids plus the bank: ACTIVE groups of the active
-- workspace that the caller is on the open list of, or whose case's
-- bank they hold, while live staff; all of them for an owner/admin.
CREATE OR REPLACE FUNCTION public.sg_visible_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT g.id FROM public.submission_groups g
   WHERE g.account_id = public.current_account_id()
     AND g.status = 'ACTIVE'
     AND (public.is_account_member(g.account_id, 'admin')
          OR (public.sg_is_staff(g.account_id, auth.uid())
              AND (EXISTS (SELECT 1 FROM public.submission_group_access a
                            WHERE a.group_id = g.id AND a.user_id = auth.uid() AND a.removed_at IS NULL)
                   OR public.sg_holds_group_bank(g.id, auth.uid()))))
$$;

RESET lock_timeout;
