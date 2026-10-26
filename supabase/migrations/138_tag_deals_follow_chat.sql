-- ============================================================
-- 138_tag_deals_follow_chat.sql — a deal opened from a chat tag
-- follows the chat's tags.
--
-- 080's create_deals_for_chat_tag opened a deal when a chat arrived at
-- a main tag linked to a pipeline stage, titled with the customer's
-- name (else phone), and never touched it again. The business wants the
-- board to follow the inbox:
--
--  * The title carries the sub-tag: "Jane Doe · ADCB" when the chat is
--    tagged Interested -> ADCB; just the name with no sub-tag.
--  * Re-tag moves the deal: when a chat arrives at a linked main tag
--    and the customer already has an open deal in that pipeline, that
--    deal moves to the linked stage (080 skipped it). The deal of this
--    chat goes first, else the newest open one; only one moves. With no
--    open deal one is opened, as in 080. Moving to an unlinked tag, or
--    clearing the tag, moves nothing.
--  * A sub-tag change re-titles that same deal (the trigger now also
--    fires on chat_sub_tag_id). A sub-tag change alone never opens a
--    deal.
--  * A title is rewritten only while it still has the generated shape
--    ("<name>" or "<name> · <anything>"), so a deal someone renamed by
--    hand keeps its name.
--  * Unchanged from 080: the owner (resolve_chat_deal_owner), one
--    advisory lock per customer, and a failure is a WARNING that never
--    blocks the tag write. Only open deals are moved or re-titled.
--
-- Re-runnable: CREATE OR REPLACE, DROP TRIGGER IF EXISTS.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_deals_for_chat_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_moved    boolean := new.chat_tag_id IS DISTINCT FROM old.chat_tag_id;
  v_owner    uuid;
  v_profile  uuid;
  v_base     text;
  v_sub      text;
  v_title    text;
  v_currency text;
  v_stage    record;
  v_deal     record;
BEGIN
  BEGIN
    IF new.chat_tag_id IS NULL THEN
      RETURN NULL;
    END IF;
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

    SELECT COALESCE(NULLIF(btrim(c.name), ''), c.phone) INTO v_base
      FROM public.contacts c
     WHERE c.id = new.contact_id;
    v_base := COALESCE(v_base, 'Deal');
    SELECT NULLIF(btrim(t.name), '') INTO v_sub
      FROM public.chat_tags t
     WHERE t.id = new.chat_sub_tag_id;
    v_title := v_base || COALESCE(' · ' || v_sub, '');

    FOR v_stage IN
      SELECT s.id, s.pipeline_id
        FROM public.pipeline_stages s
        JOIN public.pipelines p ON p.id = s.pipeline_id
       WHERE s.auto_chat_tag_id = new.chat_tag_id
         AND p.account_id = new.account_id
       ORDER BY s.pipeline_id
    LOOP
      -- The customer's open deal here: this chat's first, else the newest.
      SELECT d.id, d.stage_id, d.title INTO v_deal
        FROM public.deals d
       WHERE d.contact_id = new.contact_id
         AND d.pipeline_id = v_stage.pipeline_id
         AND d.status = 'open'
       ORDER BY (d.conversation_id IS NOT DISTINCT FROM new.id) DESC, d.created_at DESC, d.id
       LIMIT 1;

      IF FOUND THEN
        UPDATE public.deals d
           SET stage_id = CASE WHEN v_moved THEN v_stage.id ELSE d.stage_id END,
               -- only a title still in the generated shape
               title = CASE WHEN d.title = v_base OR left(d.title, length(v_base) + 3) = v_base || ' · '
                            THEN v_title ELSE d.title END
         WHERE d.id = v_deal.id
           AND ((v_moved AND d.stage_id IS DISTINCT FROM v_stage.id)
                OR ((d.title = v_base OR left(d.title, length(v_base) + 3) = v_base || ' · ')
                    AND d.title IS DISTINCT FROM v_title));
      ELSIF v_moved THEN
        IF v_owner IS NULL THEN
          -- The owner (header, "Owner"), the tagger acting.
          v_owner := public.resolve_chat_deal_owner(new.id, v_caller);
          -- deals.assigned_to is a profiles.id, and only one of this
          -- account: the creator fallback (d) may have left, taking their
          -- profile to another account. Then the deal is theirs by
          -- user_id, unassigned.
          SELECT pr.id INTO v_profile
            FROM public.profiles pr
           WHERE pr.user_id = v_owner
             AND pr.account_id = new.account_id;
          SELECT a.default_currency INTO v_currency
            FROM public.accounts a
           WHERE a.id = new.account_id;
        END IF;
        INSERT INTO public.deals (
          account_id, pipeline_id, stage_id, contact_id, conversation_id,
          title, value, currency, status, user_id, assigned_to
        ) VALUES (
          new.account_id, v_stage.pipeline_id, v_stage.id, new.contact_id, new.id,
          v_title, 0, COALESCE(v_currency, 'USD'), 'open',
          v_owner, v_profile
        );
      END IF;
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
  AFTER UPDATE OF chat_tag_id, chat_sub_tag_id ON public.conversations
  FOR EACH ROW
  WHEN (new.chat_tag_id IS NOT NULL
        AND (new.chat_tag_id IS DISTINCT FROM old.chat_tag_id
             OR new.chat_sub_tag_id IS DISTINCT FROM old.chat_sub_tag_id))
  EXECUTE FUNCTION public.create_deals_for_chat_tag();

REVOKE ALL ON FUNCTION public.create_deals_for_chat_tag() FROM PUBLIC, anon, authenticated, service_role;
