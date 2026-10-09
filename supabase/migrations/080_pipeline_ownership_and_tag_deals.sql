-- ============================================================
-- 080: pipelines for everyone — per-person deals, and deals from
--      chat tags
--
-- Pipelines were an admin's board: a deal was visible to whoever could
-- see its contact (043/059), which in practice hid most of the board
-- from agents and showed them deals they had nothing to do with. This
-- makes the board every member's, scoped by who OWNS each deal:
--
--   admin / owner   every deal in the account
--   team_leader     their own deals and their teammates' (044)
--   agent / viewer  their own deals only
--
-- And it lets an admin link a pipeline stage to a chat tag (in practice
-- "Interested customer"): tagging a chat with that tag — with or
-- without a sub-tag — opens a deal for the customer in that stage.
--
-- Design:
--
--   deal owner          = the assignee if there is one, else the creator
--   deal_owner()        maps that to an auth user id (see below)
--   can_view_deal()     the visibility rule; every deals policy states it
--                       inline, per-caller values hoisted (section 2)
--   pipeline_stages.auto_chat_tag_id   the stage a tag opens deals in
--   resolve_chat_deal_owner()          who owns a deal opened from a
--                                      chat (trigger + automations)
--   create_deals_for_chat_tag()        the AFTER UPDATE trigger on
--                                      conversations that opens them
--
-- deals.assigned_to is a profiles.id (002's FK, and what the deal form
-- stores), not an auth user id, while deals.user_id is an auth user id.
-- So "COALESCE(assigned_to, user_id)" cannot be compared to auth.uid()
-- as it stands: deal_owner() resolves the assignee's profile to its
-- user_id first. The trigger writes both columns in their own terms.
--
-- Invariants:
--
-- * Visibility is the deal's owner, not its contact. The 043/059
--   contact conjunct is gone: an agent no longer sees another agent's
--   deal just because they can see the customer.
-- * Writes check the same rule on the NEW row (deals_insert's and
--   deals_update's WITH CHECK), so an agent cannot create a deal for,
--   or hand their deal to, someone whose deals they could not see. A
--   leader may assign within their team; an admin anywhere in the
--   account — never to another account's profile.
-- * A stage may only be linked to a MAIN tag of its own pipeline's
--   account (pipeline_stages_auto_tag_guard), and a tag opens deals in
--   at most one stage per pipeline (partial unique index). Linking is
--   a stage write, so the existing stage policies already make it
--   admin-only. Deleting the tag unlinks the stage (ON DELETE SET NULL).
--
-- Deliberate choices in the auto deal:
--
-- * It fires on ARRIVAL at the tag only (chat_tag_id changes to a
--   non-NULL value). A sub-tag change alone never fires, and nothing
--   fires on INSERT: chats are created untagged.
-- * It never moves an existing deal. Re-tagging does not touch the
--   stage, owner or status of any deal; people move deals themselves.
-- * It skips a pipeline in which the contact already has an OPEN deal,
--   so tagging away and back does not duplicate. Once that deal is won
--   or lost, the next arrival opens a new one.
-- * Automation and flow tagging (service role, no auth.uid()) open
--   deals too: the rule is about the tag, not who set it. The
--   automation create_deal step owns its deal by the same rule
--   (resolve_chat_deal_owner with no actor).
-- * Owner, first that applies, each an active member of the account:
--   (a) the chat's assigned agent; (b) the chat's creator, when below
--   admin (an agent or leader started it — inbound chats are stamped
--   with the account owner's id, which must not win here); (c) the
--   person tagging; (d) the chat's creator, whoever that is.
-- * It never blocks the tag: the body runs in its own exception block
--   and a failure is a WARNING, not an error. The tag write stands.
-- * Two tag writes for one customer are serialised by a transaction
--   advisory lock on the contact before the open-deal check.
--
-- Re-runnable: every statement is guarded.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Who owns a deal, and who may see it
-- ------------------------------------------------------------

-- The owner as an auth user id: the assignee's user_id (assigned_to is
-- a profiles.id), else the creator. SECURITY DEFINER so the lookup does
-- not depend on the caller's profiles RLS.
CREATE OR REPLACE FUNCTION public.deal_owner(
  p_assigned_to uuid,
  p_user_id     uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p.user_id FROM profiles p WHERE p.id = p_assigned_to),
    p_user_id
  );
$$;

COMMENT ON FUNCTION public.deal_owner(uuid, uuid) IS
  'A deal''s owner as an auth user id: the assignee (deals.assigned_to is a '
  'profiles.id) else the creator (deals.user_id). See migration 080.';

REVOKE ALL ON FUNCTION public.deal_owner(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deal_owner(uuid, uuid) TO authenticated, service_role;

-- The visibility rule. p_owner is an auth user id (deal_owner()).
CREATE OR REPLACE FUNCTION public.can_view_deal(
  p_account_id uuid,
  p_owner      uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    WHEN p_owner IS NULL THEN FALSE
    WHEN p_owner = auth.uid() THEN is_account_member(p_account_id)
    WHEN is_account_member(p_account_id, 'team_leader')
      THEN leads_teammate(p_account_id, p_owner)
    ELSE FALSE
  END;
$$;

COMMENT ON FUNCTION public.can_view_deal(uuid, uuid) IS
  'Row-visibility rule for deals: admin+ sees the account, a team leader '
  'their own and their teammates'' deals, everyone else their own. '
  'p_owner is deal_owner(assigned_to, user_id). See migration 080.';

REVOKE ALL ON FUNCTION public.can_view_deal(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_deal(uuid, uuid) TO authenticated, service_role;

-- An assignee must be a member of the deal's own account. SECURITY
-- DEFINER so the answer does not depend on the writer's profiles RLS.
-- Not "active": a deal assigned to someone later deactivated stays
-- editable.
CREATE OR REPLACE FUNCTION public.deal_assignee_in_account(
  p_assigned_to uuid,
  p_account_id  uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_assigned_to IS NULL OR EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.id = p_assigned_to
       AND p.account_id = p_account_id
  );
$$;

COMMENT ON FUNCTION public.deal_assignee_in_account(uuid, uuid) IS
  'Write check for deals: assigned_to (a profiles.id) is NULL or a profile '
  'of the deal''s account. See migration 080.';

REVOKE ALL ON FUNCTION public.deal_assignee_in_account(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deal_assignee_in_account(uuid, uuid) TO authenticated, service_role;

-- The caller's teammates — members of a team in the caller's account
-- that the caller leads — as auth user ids and as profile ids: the set
-- leads_teammate() tests one person against, computed once per query
-- for the deals policies. SECURITY DEFINER for leads_teammate()'s reason.
CREATE OR REPLACE FUNCTION public.led_teammate_user_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT tm.user_id), '{}')
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
   WHERE t.account_id = current_account_id()
     AND t.leader_user_id = auth.uid()
     AND tm.user_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.led_teammate_profile_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(p.id), '{}')
    FROM profiles p
   WHERE p.user_id = ANY (led_teammate_user_ids());
$$;

REVOKE ALL ON FUNCTION public.led_teammate_user_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.led_teammate_profile_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.led_teammate_user_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.led_teammate_profile_ids() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. deals policies: the owner rule, on reads and on writes
-- ------------------------------------------------------------
-- can_view_deal() and deal_owner() carry SET search_path, so the planner
-- cannot inline them: in a policy they run once per ROW, and called bare
-- an owner's count over 20k deals took ~2.7 s. So every policy states the
-- rule in the 059 shape, cheapest first, each per-caller value an
-- InitPlan evaluated once per query:
--
--   rank >= 4                        admin / owner: the whole account
--   assigned_to IS NULL
--     AND user_id = auth.uid()       the caller's own unassigned deal
--   assigned_to = caller's profile   a deal assigned to the caller
--   rank = 3 AND the owner is one   a leader: their teammates' deals,
--     of led_teammate_*_ids()        the same two forms
--
-- That is can_view_deal() exactly, with nothing evaluated per row.
-- Below admin it means "the owner is me" — the two own-deal lines,
-- since assigned_to is an FK to profiles and profiles.user_id is NOT
-- NULL UNIQUE — plus, for a leader, leads_teammate() of the owner,
-- which is the owner being in the set led_teammate_user_ids() lists.
-- (The caller's own profile row is always visible to them, 017.)
-- can_view_deal() stays the rule's single-row statement; a change to
-- it is a change to these policies.
--
-- Writes add deal_assignee_in_account(): an admin passes every other
-- conjunct, so without it they could hand a deal to another account's
-- member.
DROP POLICY IF EXISTS deals_select ON public.deals;
CREATE POLICY deals_select ON public.deals
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p WHERE p.user_id = (SELECT auth.uid()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_insert ON public.deals;
CREATE POLICY deals_insert ON public.deals
  FOR INSERT
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND deal_assignee_in_account(assigned_to, account_id)
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p WHERE p.user_id = (SELECT auth.uid()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p WHERE p.user_id = (SELECT auth.uid()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  )
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND deal_assignee_in_account(assigned_to, account_id)
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p WHERE p.user_id = (SELECT auth.uid()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_delete ON public.deals
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p WHERE p.user_id = (SELECT auth.uid()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

-- ------------------------------------------------------------
-- 3. Linking a stage to a chat tag
-- ------------------------------------------------------------
ALTER TABLE public.pipeline_stages
  ADD COLUMN IF NOT EXISTS auto_chat_tag_id uuid NULL
    REFERENCES public.chat_tags(id) ON DELETE SET NULL;

-- A tag opens deals in at most one stage of a pipeline.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_auto_chat_tag_key
  ON public.pipeline_stages (pipeline_id, auto_chat_tag_id)
  WHERE auto_chat_tag_id IS NOT NULL;

-- The auto-deal trigger looks stages up by tag; deleting a tag scans it.
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_auto_chat_tag
  ON public.pipeline_stages (auto_chat_tag_id)
  WHERE auto_chat_tag_id IS NOT NULL;

COMMENT ON COLUMN public.pipeline_stages.auto_chat_tag_id IS
  'Migration 080: a main chat tag of the same account. Tagging a chat with '
  'it opens a deal in this stage unless the contact already has an open '
  'deal in the pipeline. Never moves an existing deal.';

-- Main tag, same account. SECURITY DEFINER so another account's tag is
-- seen (and refused) rather than invisible to the writer's RLS.
CREATE OR REPLACE FUNCTION public.pipeline_stages_auto_tag_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tag_account      uuid;
  v_tag_parent       uuid;
  v_pipeline_account uuid;
BEGIN
  IF new.auto_chat_tag_id IS NULL THEN
    RETURN new;
  END IF;

  SELECT t.account_id, t.parent_id INTO v_tag_account, v_tag_parent
    FROM public.chat_tags t
   WHERE t.id = new.auto_chat_tag_id;
  IF NOT FOUND THEN
    -- A missing tag is the FK's to report.
    RETURN new;
  END IF;

  IF v_tag_parent IS NOT NULL THEN
    RAISE EXCEPTION 'A pipeline stage can only be linked to a main tag, not a sub-tag'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.account_id INTO v_pipeline_account
    FROM public.pipelines p
   WHERE p.id = new.pipeline_id;
  IF v_pipeline_account IS DISTINCT FROM v_tag_account THEN
    RAISE EXCEPTION 'A pipeline stage can only be linked to a tag of its own account'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS pipeline_stages_auto_tag_guard ON public.pipeline_stages;
CREATE TRIGGER pipeline_stages_auto_tag_guard
  BEFORE INSERT OR UPDATE OF auto_chat_tag_id, pipeline_id ON public.pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.pipeline_stages_auto_tag_guard();

REVOKE ALL ON FUNCTION public.pipeline_stages_auto_tag_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Tagging a chat opens a deal
-- ------------------------------------------------------------

-- Who owns a deal opened from a chat (header, "Owner"), as an auth user
-- id. Each candidate must be an active member of the chat's account; (d)
-- is the unconditional fallback. p_actor is the person acting — the
-- tagger — and NULL for a bot. Shared by the tag trigger below and the
-- automation create_deal step (service role), so both own a chat's deal
-- the same way. NULL only when the conversation does not exist.
CREATE OR REPLACE FUNCTION public.resolve_chat_deal_owner(
  p_conversation_id uuid,
  p_actor           uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account  uuid;
  v_creator  uuid;
  v_assignee uuid;
  v_owner    uuid;
BEGIN
  SELECT c.account_id, c.user_id, c.assigned_agent_id
    INTO v_account, v_creator, v_assignee
    FROM public.conversations c
   WHERE c.id = p_conversation_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- (a) the chat's assigned agent
  SELECT pr.user_id INTO v_owner
    FROM public.profiles pr
   WHERE pr.user_id = v_assignee
     AND pr.account_id = v_account
     AND pr.deactivated_at IS NULL;
  -- (b) the chat's creator, when below admin
  IF v_owner IS NULL THEN
    SELECT pr.user_id INTO v_owner
      FROM public.profiles pr
     WHERE pr.user_id = v_creator
       AND pr.account_id = v_account
       AND pr.deactivated_at IS NULL
       AND pr.account_role NOT IN ('owner', 'admin');
  END IF;
  -- (c) the person acting
  IF v_owner IS NULL AND p_actor IS NOT NULL THEN
    SELECT pr.user_id INTO v_owner
      FROM public.profiles pr
     WHERE pr.user_id = p_actor
       AND pr.account_id = v_account
       AND pr.deactivated_at IS NULL;
  END IF;
  -- (d) the chat's creator, whoever that is
  RETURN COALESCE(v_owner, v_creator);
END
$$;

COMMENT ON FUNCTION public.resolve_chat_deal_owner(uuid, uuid) IS
  'Owner (auth user id) of a deal opened from a chat: assigned agent, else '
  'a below-admin creator, else p_actor, else the creator; each an active '
  'member. Service role only. See migration 080.';

REVOKE ALL ON FUNCTION public.resolve_chat_deal_owner(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_chat_deal_owner(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.create_deals_for_chat_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_owner    uuid;
  v_profile  uuid;
  v_title    text;
  v_currency text;
  v_stage    record;
BEGIN
  BEGIN
    -- Most tags are linked to nothing: leave before taking the lock.
    IF NOT EXISTS (
      SELECT 1
        FROM public.pipeline_stages s
        JOIN public.pipelines p ON p.id = s.pipeline_id
       WHERE s.auto_chat_tag_id = new.chat_tag_id
         AND p.account_id = new.account_id
    ) THEN
      RETURN NULL;
    END IF;

    -- One customer, one decision at a time: two concurrent tag writes
    -- must not both find "no open deal" and both insert.
    PERFORM pg_advisory_xact_lock(hashtext('deal-from-tag:' || new.contact_id::text));

    -- The owner (header, "Owner"), the tagger acting.
    v_owner := public.resolve_chat_deal_owner(new.id, v_caller);

    -- deals.assigned_to is a profiles.id.
    SELECT pr.id INTO v_profile
      FROM public.profiles pr
     WHERE pr.user_id = v_owner;

    SELECT COALESCE(NULLIF(btrim(c.name), ''), c.phone) INTO v_title
      FROM public.contacts c
     WHERE c.id = new.contact_id;

    SELECT a.default_currency INTO v_currency
      FROM public.accounts a
     WHERE a.id = new.account_id;

    FOR v_stage IN
      SELECT s.id, s.pipeline_id
        FROM public.pipeline_stages s
        JOIN public.pipelines p ON p.id = s.pipeline_id
       WHERE s.auto_chat_tag_id = new.chat_tag_id
         AND p.account_id = new.account_id
       ORDER BY s.pipeline_id
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.deals d
         WHERE d.contact_id = new.contact_id
           AND d.pipeline_id = v_stage.pipeline_id
           AND d.status = 'open'
      );

      INSERT INTO public.deals (
        account_id, pipeline_id, stage_id, contact_id, conversation_id,
        title, value, currency, status, user_id, assigned_to
      ) VALUES (
        new.account_id, v_stage.pipeline_id, v_stage.id, new.contact_id, new.id,
        COALESCE(v_title, 'Deal'), 0, COALESCE(v_currency, 'USD'), 'open',
        v_owner, v_profile
      );
    END LOOP;
  EXCEPTION WHEN others THEN
    -- Tagging the chat must never fail because a deal could not be made.
    RAISE WARNING 'create_deals_for_chat_tag: conversation %: % (%)',
      new.id, SQLERRM, SQLSTATE;
  END;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS create_deals_for_chat_tag ON public.conversations;
CREATE TRIGGER create_deals_for_chat_tag
  AFTER UPDATE OF chat_tag_id ON public.conversations
  FOR EACH ROW
  WHEN (new.chat_tag_id IS NOT NULL AND new.chat_tag_id IS DISTINCT FROM old.chat_tag_id)
  EXECUTE FUNCTION public.create_deals_for_chat_tag();

REVOKE ALL ON FUNCTION public.create_deals_for_chat_tag() FROM PUBLIC, anon, authenticated, service_role;
