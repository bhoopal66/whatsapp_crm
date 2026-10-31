-- ============================================================
-- 161_bank_coordinator_access.sql — a coordinator sees the cases of
-- the banks they hold.
--
-- 133 gave coordinators banks (coordinator_banks), but nothing read
-- that list for cases: case_role (122) knew only the case's one named
-- coordinator (cases.coordinator_id, from the submission's access
-- list). A coordinator of ADCB therefore saw no ADCB case Compass had
-- not named them on. From here on, holding a case's bank is a live
-- coordinator role on it:
--
--  * case_holds_bank(account, user, bank): the user is a live agent /
--    team_leader of the account holding that bank. coordinator_banks
--    keeps rows for someone deactivated or demoted since (no cleanup
--    trigger, 133), so the profile check is part of the rule. Taking
--    the bank away removes the access at once; giving it back restores
--    it. Service role only (definer functions call it as owner).
--  * case_role(case, user) gains one branch, after the named agent:
--    an agent / team_leader holding the case's bank is 'coordinator'
--    (reads and acts, as the named coordinator; never reassigns). The
--    named roles and the team lead keep their precedence.
--
-- The case lists, bank spaces (162) and submission groups (163) read
-- the same helper. TS mirror: lib/cases/access.ts.
--
-- As 122, this must be applied by a superuser or BYPASSRLS role:
-- coordinator_banks is RLS-forced.
-- Re-runnable: CREATE OR REPLACE only. Asserted by
-- supabase/ci/verify-bank-coordinators.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '161 must be applied by a superuser or BYPASSRLS role (the functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Holding a bank ----------

CREATE OR REPLACE FUNCTION public.case_holds_bank(p_account uuid, p_user uuid, p_bank text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_bank IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.coordinator_banks b
      JOIN public.profiles p
        ON p.user_id = b.user_id AND p.account_id = b.account_id
       AND p.deactivated_at IS NULL
       AND p.account_role::text IN ('agent', 'team_leader')
     WHERE b.account_id = p_account AND b.user_id = p_user AND b.bank_code = p_bank)
$$;

REVOKE ALL ON FUNCTION public.case_holds_bank(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.case_holds_bank(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.case_holds_bank(uuid, uuid, text) IS
  'Is p_user a live agent / team_leader of p_account holding bank p_bank (coordinator_banks)? Grants the coordinator role on that bank''s cases and its ACTIVE submission groups. Migration 161.';

-- ---------- 2. case_role ----------

-- 122's resolver plus the bank branch. Same signature, so 122's
-- grants stay.
CREATE OR REPLACE FUNCTION public.case_role(p_case uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p.account_role = 'owner' THEN 'super_admin'
           WHEN p.account_role = 'admin' THEN 'admin'
           WHEN p.account_role = 'team_leader'
                AND EXISTS (SELECT 1 FROM public.teams t
                              JOIN public.team_members m ON m.team_id = t.id
                             WHERE t.account_id = c.account_id AND m.account_id = c.account_id
                               AND m.user_id = c.agent_id AND t.leader_user_id = p_user)
             THEN 'team_lead'
           WHEN p.account_role IN ('agent', 'team_leader') AND c.coordinator_id = p_user THEN 'coordinator'
           WHEN p.account_role IN ('agent', 'team_leader') AND c.agent_id = p_user THEN 'agent'
           WHEN p.account_role IN ('agent', 'team_leader')
                AND public.case_holds_bank(c.account_id, p_user, c.bank_code) THEN 'coordinator'
         END
    FROM public.cases c
    JOIN public.profiles p
      ON p.user_id = p_user AND p.account_id = c.account_id
     AND p.deactivated_at IS NULL AND p.account_role <> 'bank_guest'
   WHERE c.id = p_case
$$;

RESET lock_timeout;
