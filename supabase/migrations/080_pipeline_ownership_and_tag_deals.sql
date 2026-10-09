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
--   can_view_deal()     the visibility rule, used by every deals policy
--   pipeline_stages.auto_chat_tag_id   the stage a tag opens deals in
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
--   leader may assign within their team; an admin anywhere.
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
--   deals too: the rule is about the tag, not who set it.
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

-- ------------------------------------------------------------
-- 2. deals policies: the owner rule, on reads and on writes
-- ------------------------------------------------------------
DROP POLICY IF EXISTS deals_select ON public.deals;
CREATE POLICY deals_select ON public.deals
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND can_view_deal(account_id, deal_owner(assigned_to, user_id))
  );

DROP POLICY IF EXISTS deals_insert ON public.deals;
CREATE POLICY deals_insert ON public.deals
  FOR INSERT
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND can_view_deal(account_id, deal_owner(assigned_to, user_id))
  );

DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND can_view_deal(account_id, deal_owner(assigned_to, user_id))
  )
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND can_view_deal(account_id, deal_owner(assigned_to, user_id))
  );

DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_delete ON public.deals
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND can_view_deal(account_id, deal_owner(assigned_to, user_id))
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

    -- The owner (header, "Owner"). Each candidate must be an active
    -- member of the account; (d) is the unconditional fallback.
    SELECT pr.user_id INTO v_owner
      FROM public.profiles pr
     WHERE pr.user_id = new.assigned_agent_id
       AND pr.account_id = new.account_id
       AND pr.deactivated_at IS NULL;
    IF v_owner IS NULL THEN
      SELECT pr.user_id INTO v_owner
        FROM public.profiles pr
       WHERE pr.user_id = new.user_id
         AND pr.account_id = new.account_id
         AND pr.deactivated_at IS NULL
         AND pr.account_role NOT IN ('owner', 'admin');
    END IF;
    IF v_owner IS NULL AND v_caller IS NOT NULL THEN
      SELECT pr.user_id INTO v_owner
        FROM public.profiles pr
       WHERE pr.user_id = v_caller
         AND pr.account_id = new.account_id
         AND pr.deactivated_at IS NULL;
    END IF;
    IF v_owner IS NULL THEN
      v_owner := new.user_id;
    END IF;

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
