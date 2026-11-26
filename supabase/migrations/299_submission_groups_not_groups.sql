-- ============================================================
-- 299_submission_groups_not_groups.sql — a submission group's WhatsApp
-- mirror is no ordinary group.
--
-- The problem. A submission group (115) is created by our own number, so
-- Whapi's `groups.post` event made it a row of whatsapp_groups too: its
-- customer messages were copied into whatsapp_group_messages, and 219's
-- triggers made every participant whose number is a saved staff number
-- a manager. The id functions had no submission exclusion, so those
-- people read, sent into and managed the group through
-- /api/whatsapp/groups/<id>/** or PostgREST, also after their access
-- was removed, the bank was taken away or the case had ENDED. Only the
-- list, Sync and the unread count (173) left such rows out.
--
-- The rule now. A whatsapp_groups row whose (account_id, wa_group_id)
-- is a submission_groups row, ACTIVE or ENDED, is nobody's: visible and
-- manageable to no one, owners and admins included (they use the
-- submission screens). Every policy and whatsapp_group_can_view /
-- _can_manage / _mark_read / _unread_count read through these two
-- functions. The service role, which bypasses RLS, is unchanged.
--
--   * whatsapp_group_managers takes no row for such a group: a BEFORE
--     INSERT trigger skips it (skip, not raise: 219's triggers insert
--     many groups in one statement, and the others must be granted).
--     It also holds for a re-run of 219's backfill.
--   * A submission group that gets its WhatsApp id after the mirror was
--     made (the webhook beat sg_attach_wa_group) drops the mirror's
--     managers then; this file drops those of existing mirrors.
--   * Mirror rows, participants and messages are NOT deleted: hiding is
--     enough, and a clean-up is the owner's decision.
--
-- And: staff_removal_phone. staff_saved_phone (219) answers NULL for a
-- person deactivated or demoted since, so taking such a person off a
-- group left their phone in it. Removals use this one; it never names a
-- number somebody else in the team uses too, nor an owner's or admin's.
--
-- Both id functions are restated: 114's visible ids with 286's
-- team_members pairing, 218's manageable ids. Apply in order: re-running
-- 114, 218 or 286 after this file calls for re-running this file.
-- Re-runnable. Apply as a superuser or BYPASSRLS role, like 114/115.
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
    RAISE EXCEPTION '299 must be applied by a superuser or a BYPASSRLS owner of public.submission_groups';
  END IF;
END $$;

-- 115's index on the WhatsApp id leads with channel_id, which a mirror
-- on a replaced number does not share.
CREATE INDEX IF NOT EXISTS submission_groups_account_wa_group_idx
  ON public.submission_groups (account_id, wa_group_id) WHERE wa_group_id IS NOT NULL;

-- ---------- 1. Who sees and manages a group ----------

CREATE OR REPLACE FUNCTION public.whatsapp_group_visible_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ctx AS (
    SELECT current_account_id() AS acct, current_role_rank() AS rnk
  ), ppl AS (
    SELECT auth.uid() AS user_id
    UNION
    SELECT tm.user_id
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.id AND tm.account_id = t.account_id, ctx
     WHERE ctx.rnk = 3
       AND t.account_id = ctx.acct
       AND t.leader_user_id = auth.uid()
  ), ids AS (
    SELECT g.id FROM whatsapp_groups g, ctx
     WHERE g.account_id = ctx.acct AND ctx.rnk >= 4
    UNION
    SELECT g.id FROM whatsapp_groups g, ctx
     WHERE g.account_id = ctx.acct AND ctx.rnk BETWEEN 1 AND 3
       AND g.created_by IN (SELECT user_id FROM ppl)
    UNION
    SELECT m.group_id FROM whatsapp_group_managers m, ctx
     WHERE m.account_id = ctx.acct AND ctx.rnk BETWEEN 1 AND 3
       AND m.user_id IN (SELECT user_id FROM ppl)
  )
  SELECT g.id FROM ids JOIN whatsapp_groups g ON g.id = ids.id
   WHERE NOT EXISTS (
     SELECT 1 FROM submission_groups s
      WHERE s.account_id = g.account_id AND s.wa_group_id = g.wa_group_id)
$$;
COMMENT ON FUNCTION public.whatsapp_group_visible_ids() IS
  'The groups of the active workspace the caller sees: owner/admin all; else created or managed by the caller or, for a team leader, by a person in a team they lead. Never the mirror of a submission group, ACTIVE or ENDED. Read once per query by the policies. Migrations 114, 286, 299.';

CREATE OR REPLACE FUNCTION public.whatsapp_group_manageable_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ctx AS (
    SELECT current_account_id() AS acct, current_role_rank() AS rnk
  ), ids AS (
    SELECT g.id FROM whatsapp_groups g, ctx
     WHERE g.account_id = ctx.acct AND ctx.rnk >= 4
    UNION
    SELECT g.id FROM whatsapp_groups g, ctx
     WHERE g.account_id = ctx.acct AND ctx.rnk IN (2, 3)
       AND g.channel_id IS NOT NULL
       AND (g.created_by = auth.uid()
            OR EXISTS (SELECT 1 FROM whatsapp_group_managers m
                        WHERE m.group_id = g.id AND m.user_id = auth.uid()))
  )
  SELECT g.id FROM ids JOIN whatsapp_groups g ON g.id = ids.id
   WHERE NOT EXISTS (
     SELECT 1 FROM submission_groups s
      WHERE s.account_id = g.account_id AND s.wa_group_id = g.wa_group_id)
$$;
COMMENT ON FUNCTION public.whatsapp_group_manageable_ids() IS
  'The groups of the active workspace the caller manages (edit, members, invite link, send): owner/admin all; an agent or team leader the ones they created or manage, while the group has a number, whoever the number is allocated to. Never the mirror of a submission group, ACTIVE or ENDED. Migrations 114, 218, 299.';

REVOKE ALL ON FUNCTION public.whatsapp_group_visible_ids(),
  public.whatsapp_group_manageable_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_group_visible_ids(),
  public.whatsapp_group_manageable_ids()
  TO authenticated, service_role;

-- ---------- 2. Nobody is made a manager of a mirror ----------

CREATE OR REPLACE FUNCTION public.whatsapp_group_managers_not_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1
               FROM whatsapp_groups g
               JOIN submission_groups s
                 ON s.account_id = g.account_id AND s.wa_group_id = g.wa_group_id
              WHERE g.id = NEW.group_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.whatsapp_group_managers_not_submission() IS
  'Skips a manager row for the mirror of a submission group, whoever writes it (219''s triggers and backfill included). Migration 299.';
REVOKE ALL ON FUNCTION public.whatsapp_group_managers_not_submission() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_group_managers_not_submission ON public.whatsapp_group_managers;
CREATE TRIGGER whatsapp_group_managers_not_submission
  BEFORE INSERT ON public.whatsapp_group_managers
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_group_managers_not_submission();

-- ---------- 3. A submission group takes its WhatsApp id ----------

-- Never fails the write it rides on: the id functions hide the mirror
-- whether or not its managers could be dropped.
CREATE OR REPLACE FUNCTION public.submission_groups_drop_mirror_managers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '1s'
AS $$
BEGIN
  BEGIN
    DELETE FROM whatsapp_group_managers m
     USING whatsapp_groups g
     WHERE g.account_id = NEW.account_id
       AND g.wa_group_id = NEW.wa_group_id
       AND m.group_id = g.id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'submission_groups_drop_mirror_managers: group %: % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION public.submission_groups_drop_mirror_managers() IS
  'A submission group got its WhatsApp id: the managers of a whatsapp_groups row with that id are dropped. Migration 299.';
REVOKE ALL ON FUNCTION public.submission_groups_drop_mirror_managers() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS submission_groups_drop_mirror_managers ON public.submission_groups;
CREATE TRIGGER submission_groups_drop_mirror_managers
  AFTER INSERT OR UPDATE OF wa_group_id ON public.submission_groups
  FOR EACH ROW WHEN (NEW.wa_group_id IS NOT NULL)
  EXECUTE FUNCTION public.submission_groups_drop_mirror_managers();

-- Existing mirrors (both triggers above are already in place).
DELETE FROM public.whatsapp_group_managers m
 USING public.whatsapp_groups g, public.submission_groups s
 WHERE m.group_id = g.id
   AND s.account_id = g.account_id
   AND s.wa_group_id = g.wa_group_id;

-- ---------- 4. Whose phone leaves a group ----------

-- staff_saved_phone without its live filter. Nothing is taken out for an
-- owner or admin (they keep every group, as before), nor a number another
-- live member saved too: a company SIM handed on is theirs now, and which
-- of the two is in the group cannot be told.
CREATE OR REPLACE FUNCTION public.staff_removal_phone(p_account uuid, p_user uuid)
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
     AND NOT EXISTS (
       SELECT 1 FROM profiles me
        WHERE me.user_id = cp.user_id
          AND me.account_id = cp.account_id
          AND me.deactivated_at IS NULL
          AND me.account_role::text IN ('owner', 'admin'))
     AND NOT EXISTS (
       SELECT 1 FROM coordinator_phones o
         JOIN profiles p ON p.user_id = o.user_id AND p.account_id = o.account_id
        WHERE o.account_id = cp.account_id
          AND o.phone = cp.phone
          AND o.user_id <> cp.user_id
          AND p.deactivated_at IS NULL
          AND p.account_role::text <> 'bank_guest');
$$;
COMMENT ON FUNCTION public.staff_removal_phone(uuid, uuid) IS
  'The saved WhatsApp number (digits) to take out of a group when this person is taken off it, also after they were deactivated or demoted; NULL when nothing is saved, for a live owner or admin, and when another live member saved the same number. For removals only: additions use staff_saved_phone. Service role only. Migration 299.';
REVOKE ALL ON FUNCTION public.staff_removal_phone(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_removal_phone(uuid, uuid) TO service_role;

RESET lock_timeout;
