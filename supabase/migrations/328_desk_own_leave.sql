-- ============================================================
-- 328_desk_own_leave.sql — an agent records, changes and cancels their
-- own desk leave (232).
--
-- 232's desk_leave_add / desk_leave_remove already take one's own leave
-- from any live staff (case_account_role: owner, admin, team leader,
-- agent; a viewer and a bank guest are NULL and refused), but the only
-- read of leave is desk_cover_list, team leaders and up. An agent could
-- not see the leave they had entered, so could neither change nor cancel
-- it, and the desk showed them no way to add it. This adds:
--
--  * desk_my_leave(actor, account, now): the caller's own current and
--    future leave, for any live staff.
--  * desk_leave_change(actor, account, leave, first, last, note, now):
--    new days (and note) for one leave row, by the same rule as add and
--    remove: one's own, or anyone's by a team leader and up; the new
--    range obeys add's limits (up to a year, not ending in the past).
--    The person never changes (cancel and add for that). false = no such
--    leave in this workspace, as desk_leave_remove answers.
--
-- Cover is computed from desk_leave on each read (desk_bank_cover), so
-- a change hands work to the second coordinator exactly as an add does.
-- Restates no earlier function. Refusals (HINT): INVALID, NOT_ALLOWED
-- (both 232's, already in DESK_REFUSALS).
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only.
-- Apply as a superuser or BYPASSRLS role after 232. Re-runnable.
-- Asserted by supabase/ci/verify-desk-own-leave.sql. docs/case-desk.md
-- is the contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '328 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regprocedure('public.desk_leave_add(uuid, uuid, uuid, date, date, text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION '328: apply 232_desk_bank_cover.sql first';
  END IF;
END $$;

-- Any live staff: their own leave that has not ended, earliest first.
CREATE OR REPLACE FUNCTION public.desk_my_leave(p_actor uuid, p_account uuid, p_now timestamptz DEFAULT NULL)
RETURNS TABLE (id uuid, first_day date, last_day date, note text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_my_leave', 'NOT_ALLOWED', 'live staff only');
  END IF;
  RETURN QUERY
  SELECT l.id, l.first_day, l.last_day, l.note
    FROM public.desk_leave l
   WHERE l.account_id = p_account AND l.user_id = p_actor
     AND l.last_day >= public.desk_today(p_now)
   ORDER BY l.first_day, l.id;
END;
$$;

-- New days for a leave row: one's own, or anyone's by a team leader and up.
CREATE OR REPLACE FUNCTION public.desk_leave_change(p_actor uuid, p_account uuid, p_leave uuid, p_first date,
  p_last date, p_note text, p_now timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  l public.desk_leave%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.desk_leave x WHERE x.id = p_leave AND x.account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF public.case_account_role(p_account, p_actor) IS NULL
     OR (l.user_id IS DISTINCT FROM p_actor
         AND coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false) IS NOT TRUE) THEN
    PERFORM public.desk_refuse('desk_leave_change', 'NOT_ALLOWED', 'your own leave, or team leaders and up');
  END IF;
  IF p_first IS NULL OR p_last IS NULL OR p_last < p_first OR p_last - p_first > 366
     OR p_last < public.desk_today(p_now)
     OR (p_note IS NOT NULL AND char_length(p_note) > 200) THEN
    PERFORM public.desk_refuse('desk_leave_change', 'INVALID', 'a range of up to a year, not in the past');
  END IF;
  UPDATE public.desk_leave x
     SET first_day = p_first, last_day = p_last, note = public.desk_clean(p_note),
         set_by = p_actor, set_at = coalesce(p_now, now())
   WHERE x.id = p_leave;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION
  public.desk_my_leave(uuid, uuid, timestamptz),
  public.desk_leave_change(uuid, uuid, uuid, date, date, text, timestamptz)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_my_leave(uuid, uuid, timestamptz),
  public.desk_leave_change(uuid, uuid, uuid, date, date, text, timestamptz)
TO service_role;
