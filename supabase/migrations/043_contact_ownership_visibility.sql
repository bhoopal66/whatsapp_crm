-- ============================================================
-- 043: contact visibility follows the chat
--
-- Migration 042 made conversations private to the person handling
-- them, but left `contacts` readable by every member — so an agent
-- could still browse the whole customer list, just not the chats. This
-- closes that.
--
--   agent / viewer : contacts they created, plus any contact whose
--                    conversation they own or are assigned
--   admin / owner  : everything
--
-- The "or handles the chat" half is what makes admin triage work: when
-- an admin assigns an inbound conversation to an agent, the agent must
-- be able to see who they are talking to. Assignment therefore grants
-- the contact along with the chat, with no second step.
--
-- Note the direction of the rule. A contact is visible if you created
-- it OR you handle its conversation — not AND. Someone who adds a
-- contact keeps sight of it even before any chat exists, which is what
-- makes "add a contact, then message them" work at all.
-- ============================================================

-- ---------- the predicate ----------

-- SECURITY DEFINER quite deliberately. The body reads `conversations`,
-- which since 042 carries its own RLS; a plain function would have
-- that policy applied inside this one, so a contact would only be
-- visible through a conversation the caller could ALREADY see — which
-- is the question we are trying to answer, and in the assigned case
-- gives the wrong answer. Running as the definer asks the plain
-- question "does a conversation exist that this user handles?".
--
-- Safe because the function takes no free-form input: it is handed the
-- row's own columns by the policies below and returns only a boolean.
CREATE OR REPLACE FUNCTION public.can_view_contact(
  p_account_id UUID,
  p_contact_id UUID,
  p_creator_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN is_account_member(p_account_id, 'admin') THEN TRUE
    WHEN is_account_member(p_account_id) THEN
      COALESCE(p_creator_id = auth.uid(), FALSE)
      OR EXISTS (
        SELECT 1
        FROM conversations c
        WHERE c.contact_id = p_contact_id
          AND (
            c.user_id = auth.uid()
            OR c.assigned_agent_id = auth.uid()
          )
      )
    ELSE FALSE
  END;
$$;

COMMENT ON FUNCTION public.can_view_contact(UUID, UUID, UUID) IS
  'Row-visibility rule for contacts and their notes, deals, tags and custom values. Admin+ sees the account; everyone else sees contacts they created or whose chat they handle. See migration 043.';

-- ---------- contacts ----------

DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts
  FOR SELECT
  USING (can_view_contact(account_id, id, user_id));

DROP POLICY IF EXISTS contacts_update ON public.contacts;
CREATE POLICY contacts_update ON public.contacts
  FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_view_contact(account_id, id, user_id)
  );

DROP POLICY IF EXISTS contacts_delete ON public.contacts;
CREATE POLICY contacts_delete ON public.contacts
  FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_view_contact(account_id, id, user_id)
  );

-- ---------- everything hanging off a contact ----------
--
-- These four are rewritten to call the predicate directly rather than
-- leaning on `contacts` RLS filtering the sub-select for them. Nested
-- policy evaluation is subtle enough that "it happens to work" is a
-- poor foundation for an access rule; stating it outright also means
-- one place to read when asking who can see a customer's notes.

DROP POLICY IF EXISTS contact_notes_select ON public.contact_notes;
CREATE POLICY contact_notes_select ON public.contact_notes
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS contact_notes_update ON public.contact_notes;
CREATE POLICY contact_notes_update ON public.contact_notes
  FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS contact_notes_delete ON public.contact_notes;
CREATE POLICY contact_notes_delete ON public.contact_notes
  FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS deals_select ON public.deals;
CREATE POLICY deals_select ON public.deals
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = deals.contact_id
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals
  FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = deals.contact_id
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_delete ON public.deals
  FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = deals.contact_id
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS contact_tags_select ON public.contact_tags;
CREATE POLICY contact_tags_select ON public.contact_tags
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_tags.contact_id
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS contact_tags_modify ON public.contact_tags;
CREATE POLICY contact_tags_modify ON public.contact_tags
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_tags.contact_id
        AND is_account_member(c.account_id, 'agent')
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS contact_custom_values_select ON public.contact_custom_values;
CREATE POLICY contact_custom_values_select ON public.contact_custom_values
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_custom_values.contact_id
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );

DROP POLICY IF EXISTS contact_custom_values_modify ON public.contact_custom_values;
CREATE POLICY contact_custom_values_modify ON public.contact_custom_values
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_custom_values.contact_id
        AND is_account_member(c.account_id, 'agent')
        AND can_view_contact(c.account_id, c.id, c.user_id)
    )
  );
