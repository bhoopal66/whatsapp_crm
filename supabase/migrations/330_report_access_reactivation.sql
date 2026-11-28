-- ============================================================
-- 330_report_access_reactivation.sql — reactivating a person gives
-- back the report access they had when they were deactivated.
--
-- 256 deleted a person's report_access rows on deactivation, so an
-- owner who reactivated someone had to tick them again in Reports.
-- Now:
--
--  * profiles_drop_report_access (256) deletes the rows only when the
--    person LEAVES the workspace (account change or profile delete),
--    no longer on deactivation. A deactivated member's row is kept and
--    grants nothing: report_can_open (255) already requires
--    deactivated_at IS NULL and a non-guest role. Reactivating makes
--    the kept row count again: the access they had, and nothing more.
--  * report_access_set (255) replaced the grant list with exactly what
--    the owner ticked, and the owner's list (report_access_list) shows
--    live staff only, so saving it while someone was deactivated would
--    have deleted their kept row. It now leaves the rows of members
--    who are deactivated in this workspace alone.
--
-- RESTATES 256's profiles_drop_report_access and 255's
-- report_access_set: apply in order, once. Re-applying 255 or 256
-- reverts this file (256 also re-runs its one-off "stale grants"
-- DELETE, which would drop kept rows); re-apply 330 after them.
-- Re-runnable on its own: CREATE OR REPLACE only.
-- ============================================================

DO $$ BEGIN
  IF to_regprocedure('public.profiles_drop_report_access()') IS NULL
     OR to_regprocedure('public.report_access_set(text, uuid[])') IS NULL THEN
    RAISE EXCEPTION '330: apply 255_chat_tag_report.sql and 256_review_fixes.sql first';
  END IF;
END $$;

-- ---------- 1. Grants end with the membership, not the deactivation ----------

CREATE OR REPLACE FUNCTION public.profiles_drop_report_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Deactivation keeps the rows (report_can_open ignores them while the
  -- person is deactivated), so reactivation restores them. Leaving the
  -- workspace still deletes them: a re-add starts with no access.
  IF OLD.account_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD.account_id IS DISTINCT FROM NEW.account_id) THEN
    DELETE FROM public.report_access ra
     WHERE ra.account_id = OLD.account_id AND ra.user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.profiles_drop_report_access()
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 2. Saving the list spares deactivated members ----------

CREATE OR REPLACE FUNCTION public.report_access_set(p_report text, p_users uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := public.current_account_id();
  v_users   uuid[] := coalesce(p_users, '{}'::uuid[]);
  v_count   integer;
BEGIN
  IF NOT public.report_caller_is_owner() THEN
    RAISE EXCEPTION 'Only the owner manages report access'
      USING ERRCODE = '42501', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_report IS NULL OR p_report NOT IN ('chat_tags') THEN
    RAISE EXCEPTION 'Unknown report' USING ERRCODE = '22023', HINT = 'BAD_REPORT';
  END IF;
  IF cardinality(v_users) > 500 THEN
    RAISE EXCEPTION 'Too many people' USING ERRCODE = '22023', HINT = 'BAD_USERS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_users) u(id)
     WHERE u.id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.user_id = u.id
          AND p.account_id = v_account
          AND p.deactivated_at IS NULL
          AND p.account_role NOT IN ('owner', 'bank_guest'))) THEN
    RAISE EXCEPTION 'Someone in the list is not live staff of this workspace'
      USING ERRCODE = '22023', HINT = 'BAD_USERS';
  END IF;

  -- The owner's list shows live staff only, so a deactivated member's
  -- kept grant is not theirs to untick here (330).
  DELETE FROM public.report_access ra
   WHERE ra.account_id = v_account
     AND ra.report_key = p_report
     AND NOT (ra.user_id = ANY (v_users))
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.user_id = ra.user_id
          AND p.account_id = v_account
          AND p.deactivated_at IS NOT NULL);
  INSERT INTO public.report_access (account_id, user_id, report_key, granted_by)
  SELECT DISTINCT v_account, u.id, p_report, auth.uid()
    FROM unnest(v_users) u(id)
  ON CONFLICT (account_id, user_id, report_key) DO NOTHING;

  SELECT count(*) INTO v_count FROM public.report_access
   WHERE account_id = v_account AND report_key = p_report;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.report_access_set(text, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.report_access_set(text, uuid[]) TO authenticated;
