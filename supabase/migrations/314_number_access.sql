-- 314: a restricted number stays restricted, and two admins cannot
-- overwrite each other's access or team lists.
--
-- 1. "No allocation rows" meant "everyone may use the number" (060, 071).
--    The rows also go when the last person leaves the account or is
--    deactivated, or the number's only team is deleted or emptied, so a
--    restricted number then opened to all staff by itself.
--    whatsapp_config.access_restricted remembers the admin's choice:
--      - any row written to whatsapp_channel_members or
--        whatsapp_channel_teams sets it (a trigger, so every writer does);
--      - only set_channel_access with BOTH lists empty clears it.
--    can_use_channel: restricted with nobody allocated = owners and admins.
--    Backfilled true where a number has rows today. That includes a number
--    allocated only to a team with nobody in it, which 071 left shared.
--    TypeScript mirrors: usableNumbers (channel-management.ts), startFor
--    (channels.ts), chooseHostingNumber (submission-groups/api-input.ts).
--
-- 2. set_channel_access and update_team replace whole lists. The overloads
--    take the lists the screen showed and refuse when the stored ones
--    differ: 22023, hint access_changed / members_changed. The expected
--    arguments are REQUIRED, so a call without them fits only the older
--    function and the old build keeps working.
--
-- Apply before the build that reads it; safe to run twice. Re-running 285
-- takes the column grant below away again: re-run this file after it.
-- supabase/ci/verify-number-access.sql asserts it.

SET lock_timeout = '5s';

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS access_restricted boolean NOT NULL DEFAULT false;

-- whatsapp_config grants SELECT column by column (the tokens are not read
-- by browsers).
GRANT SELECT (access_restricted) ON public.whatsapp_config TO authenticated;

COMMENT ON COLUMN public.whatsapp_config.access_restricted IS
  'An admin limited who may use this number; with nobody allocated it is for owners and admins. Set by whatsapp_channel_restrict(), cleared by set_channel_access with both lists empty. Migration 314.';

CREATE OR REPLACE FUNCTION public.whatsapp_channel_restrict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  UPDATE public.whatsapp_config
     SET access_restricted = true
   WHERE id = NEW.config_id AND NOT access_restricted;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_channel_restrict() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_channel_members_restrict ON public.whatsapp_channel_members;
CREATE TRIGGER whatsapp_channel_members_restrict
  AFTER INSERT OR UPDATE OF config_id ON public.whatsapp_channel_members
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_channel_restrict();

DROP TRIGGER IF EXISTS whatsapp_channel_teams_restrict ON public.whatsapp_channel_teams;
CREATE TRIGGER whatsapp_channel_teams_restrict
  AFTER INSERT OR UPDATE OF config_id ON public.whatsapp_channel_teams
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_channel_restrict();

-- Backfill, after the triggers so that no row falls between the two.
UPDATE public.whatsapp_config w
   SET access_restricted = true
 WHERE NOT w.access_restricted
   AND NOT w.is_personal
   AND (EXISTS (SELECT 1 FROM public.whatsapp_channel_members m WHERE m.config_id = w.id)
        OR EXISTS (SELECT 1 FROM public.whatsapp_channel_teams t WHERE t.config_id = w.id));

-- 190's body; only the last branch differs.
CREATE OR REPLACE FUNCTION public.can_use_channel(p_account_id uuid, p_channel_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_config w
    WHERE w.id = p_channel_id
      AND w.account_id = p_account_id
  )
  AND is_account_member(p_account_id)
  AND (
    is_account_member(p_account_id, 'admin')
    OR CASE
      WHEN EXISTS (
        SELECT 1 FROM whatsapp_config w
        WHERE w.id = p_channel_id AND w.account_id = p_account_id AND w.is_personal
      ) THEN EXISTS (
        SELECT 1 FROM whatsapp_config w
        WHERE w.id = p_channel_id
          AND w.account_id = p_account_id
          AND (
            -- The owner must still be able to send here: a person
            -- demoted to viewer keeps the number (an admin deletes it)
            -- but may not use it.
            (w.user_id = auth.uid() AND is_account_member(p_account_id, 'agent'))
            OR (is_account_member(p_account_id, 'team_leader')
                AND leads_teammate(p_account_id, w.user_id))
          )
      )
      ELSE (
        (
          NOT EXISTS (
            SELECT 1 FROM whatsapp_channel_members m
            WHERE m.config_id = p_channel_id AND m.account_id = p_account_id
          )
          -- 314: nobody left on a restricted number is not "everyone".
          AND EXISTS (
            SELECT 1 FROM whatsapp_config w
            WHERE w.id = p_channel_id
              AND w.account_id = p_account_id
              AND NOT w.access_restricted
          )
        )
        OR EXISTS (
          SELECT 1 FROM whatsapp_channel_members m
          WHERE m.config_id = p_channel_id
            AND m.account_id = p_account_id
            AND m.user_id = auth.uid()
        )
      )
    END
  );
$function$;

-- 071's body; the last statement is new.
CREATE OR REPLACE FUNCTION public.set_channel_access(p_config_id uuid, p_user_ids uuid[], p_team_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account UUID := current_account_id();
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  PERFORM 1 FROM whatsapp_config
   WHERE id = p_config_id AND account_id = v_account
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_user_ids IS NOT NULL THEN
    PERFORM set_channel_members(p_config_id, p_user_ids);
  END IF;
  IF p_team_ids IS NOT NULL THEN
    PERFORM set_channel_teams(p_config_id, p_team_ids);
  END IF;

  -- 314: the one way back to "everyone". NULL is "leave that list alone",
  -- so one empty list alone does not open the number.
  IF cardinality(p_user_ids) = 0 AND cardinality(p_team_ids) = 0 THEN
    UPDATE whatsapp_config SET access_restricted = false
     WHERE id = p_config_id AND access_restricted;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_channel_access(
  p_config_id uuid, p_user_ids uuid[], p_team_ids uuid[],
  p_expected_user_ids uuid[], p_expected_team_ids uuid[]
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account UUID := current_account_id();
  v_stored  UUID[];
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'WhatsApp number not found' USING ERRCODE = 'P0002';
  END IF;
  IF (p_user_ids IS NOT NULL AND p_expected_user_ids IS NULL)
     OR (p_team_ids IS NOT NULL AND p_expected_team_ids IS NULL) THEN
    RAISE EXCEPTION 'The lists the page showed are required' USING ERRCODE = '22023';
  END IF;

  -- The 3-argument function's lock, held to the end of the transaction.
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));

  IF p_expected_user_ids IS NOT NULL THEN
    -- As the page reads it: hand-ticked people who are staff here. A row
    -- that outlived its person is not shown, so it is not compared.
    SELECT coalesce(array_agg(m.user_id ORDER BY m.user_id), '{}') INTO v_stored
      FROM whatsapp_channel_members m
     WHERE m.config_id = p_config_id AND m.account_id = v_account AND m.direct
       AND EXISTS (SELECT 1 FROM profiles p
                    WHERE p.user_id = m.user_id AND p.account_id = v_account
                      AND p.account_role <> 'bank_guest');
    IF v_stored <> (SELECT coalesce(array_agg(DISTINCT u ORDER BY u), '{}')
                      FROM unnest(p_expected_user_ids) u WHERE u IS NOT NULL) THEN
      RAISE EXCEPTION 'Who may use this number was changed meanwhile'
        USING ERRCODE = '22023', HINT = 'access_changed';
    END IF;
  END IF;

  IF p_expected_team_ids IS NOT NULL THEN
    SELECT coalesce(array_agg(t.team_id ORDER BY t.team_id), '{}') INTO v_stored
      FROM whatsapp_channel_teams t
     WHERE t.config_id = p_config_id AND t.account_id = v_account;
    IF v_stored <> (SELECT coalesce(array_agg(DISTINCT u ORDER BY u), '{}')
                      FROM unnest(p_expected_team_ids) u WHERE u IS NOT NULL) THEN
      RAISE EXCEPTION 'Who may use this number was changed meanwhile'
        USING ERRCODE = '22023', HINT = 'access_changed';
    END IF;
  END IF;

  PERFORM set_channel_access(p_config_id, p_user_ids, p_team_ids);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_channel_access(uuid, uuid[], uuid[], uuid[], uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_channel_access(uuid, uuid[], uuid[], uuid[], uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_channel_access(uuid, uuid[], uuid[], uuid[], uuid[]) IS
  'set_channel_access(uuid, uuid[], uuid[]) that refuses (22023, access_changed) when the stored lists are not the ones the page showed. Migration 314.';

CREATE OR REPLACE FUNCTION public.update_team(
  p_team_id uuid, p_name text, p_set_leader boolean, p_leader_user_id uuid,
  p_member_ids uuid[], p_config_ids uuid[], p_expected_member_ids uuid[]
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account UUID := current_account_id();
  v_stored  UUID[];
BEGIN
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_member_ids IS NULL THEN
    RAISE EXCEPTION 'The members the page showed are required' USING ERRCODE = '22023';
  END IF;

  -- The 6-argument function's lock, held to the end of the transaction.
  PERFORM pg_advisory_xact_lock(channel_access_lock_key(v_account));
  IF NOT EXISTS (SELECT 1 FROM teams WHERE id = p_team_id AND account_id = v_account) THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(array_agg(tm.user_id ORDER BY tm.user_id), '{}') INTO v_stored
    FROM team_members tm
   WHERE tm.team_id = p_team_id AND tm.account_id = v_account;
  IF v_stored <> (SELECT coalesce(array_agg(DISTINCT u ORDER BY u), '{}')
                    FROM unnest(p_expected_member_ids) u WHERE u IS NOT NULL) THEN
    RAISE EXCEPTION 'The members of this team were changed meanwhile'
      USING ERRCODE = '22023', HINT = 'members_changed';
  END IF;

  PERFORM update_team(p_team_id, p_name, p_set_leader, p_leader_user_id, p_member_ids, p_config_ids);
END;
$function$;

REVOKE ALL ON FUNCTION public.update_team(uuid, text, boolean, uuid, uuid[], uuid[], uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_team(uuid, text, boolean, uuid, uuid[], uuid[], uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.update_team(uuid, text, boolean, uuid, uuid[], uuid[], uuid[]) IS
  'update_team that refuses (22023, members_changed) when the stored members are not the ones the page showed. Migration 314.';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
