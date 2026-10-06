-- ============================================================
-- 059_rls_performance.sql — make the hot RLS policies index-friendly,
-- and add the indexes the app's hot paths were missing.
--
-- The problem. Since 042/043 the conversations and contacts policies
-- are a bare function call:
--
--   USING (can_view_conversation(account_id, user_id, assigned_agent_id))
--
-- Those functions can't be inlined (SECURITY DEFINER / SET search_path),
-- so Postgres has no predicate to push into an index: every read of
-- conversations, contacts, messages, contact_tags, deals, notes and
-- custom values was a scan of the WHOLE table — every tenant's rows —
-- calling the function once per row, and each call ran one to five
-- profile/team lookups of its own. The inbox list embeds contacts and
-- tags, so it paid that several times over. It is invisible on a small
-- install and grows linearly with total rows across all accounts.
--
-- The fix, without changing who sees what. Two STABLE helpers read the
-- caller's profile once per statement (as an initPlan, because they are
-- wrapped in a scalar sub-SELECT), and each policy gains a leading
--
--   account_id = (SELECT current_account_id())
--
-- which `can_view_*` already implies — both return FALSE for any other
-- account — so it removes no row the old policy allowed and admits none
-- it denied. It hands the planner an index predicate. The admin/owner
-- case, which `can_view_*` answers TRUE for unconditionally inside the
-- caller's account, short-circuits on `(SELECT current_role_rank()) >= 4`
-- before the per-row function is reached. Agents, team leaders and
-- viewers still go through `can_view_*` exactly as before, now only over
-- their own account's rows.
--
-- The TS mirror (lib/auth/conversation-visibility.ts) is unaffected: the
-- rule itself did not change.
--
-- Re-runnable: CREATE OR REPLACE / DROP POLICY IF EXISTS / IF NOT EXISTS.
-- ============================================================


-- ---------- helpers ----------

-- profiles.user_id is UNIQUE (001), so these are single-row lookups.
-- SECURITY DEFINER so they read the caller's own profile without
-- recursing through profiles RLS. NULL for a caller with no profile, in
-- which case every policy below matches nothing — as before.
CREATE OR REPLACE FUNCTION public.current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT account_id FROM profiles WHERE user_id = auth.uid()
$$;

-- Same ladder as is_account_member (044). 0 when there is no profile.
CREATE OR REPLACE FUNCTION public.current_role_rank()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((
    SELECT CASE account_role
             WHEN 'owner'       THEN 5
             WHEN 'admin'       THEN 4
             WHEN 'team_leader' THEN 3
             WHEN 'agent'       THEN 2
             WHEN 'viewer'      THEN 1
             ELSE 0
           END
    FROM profiles WHERE user_id = auth.uid()
  ), 0)
$$;

REVOKE ALL ON FUNCTION public.current_account_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_role_rank() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_account_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_role_rank() TO authenticated, service_role;


-- ---------- conversations ----------

DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_conversation(account_id, user_id, assigned_agent_id)
    )
  );

DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_conversation(account_id, user_id, assigned_agent_id)
    )
  );

DROP POLICY IF EXISTS conversations_delete ON public.conversations;
CREATE POLICY conversations_delete ON public.conversations
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_conversation(account_id, user_id, assigned_agent_id)
    )
  );


-- ---------- messages ----------

DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id)
        )
    )
  );

DROP POLICY IF EXISTS messages_modify ON public.messages;
CREATE POLICY messages_modify ON public.messages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND c.account_id = (SELECT current_account_id())
        AND (SELECT current_role_rank()) >= 2
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id)
        )
    )
  );


-- ---------- contacts ----------

DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_contact(account_id, id, user_id)
    )
  );

DROP POLICY IF EXISTS contacts_update ON public.contacts;
CREATE POLICY contacts_update ON public.contacts
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_contact(account_id, id, user_id)
    )
  );

DROP POLICY IF EXISTS contacts_delete ON public.contacts;
CREATE POLICY contacts_delete ON public.contacts
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR can_view_contact(account_id, id, user_id)
    )
  );


-- ---------- contact children ----------
-- Each keeps 043's shape: visibility follows the parent contact.

DROP POLICY IF EXISTS contact_notes_select ON public.contact_notes;
CREATE POLICY contact_notes_select ON public.contact_notes
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS contact_notes_update ON public.contact_notes;
CREATE POLICY contact_notes_update ON public.contact_notes
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS contact_notes_delete ON public.contact_notes;
CREATE POLICY contact_notes_delete ON public.contact_notes
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_notes.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS deals_select ON public.deals;
CREATE POLICY deals_select ON public.deals
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = deals.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = deals.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_delete ON public.deals
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = deals.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS contact_tags_select ON public.contact_tags;
CREATE POLICY contact_tags_select ON public.contact_tags
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_tags.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS contact_tags_modify ON public.contact_tags;
CREATE POLICY contact_tags_modify ON public.contact_tags
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_tags.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (SELECT current_role_rank()) >= 2
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS contact_custom_values_select ON public.contact_custom_values;
CREATE POLICY contact_custom_values_select ON public.contact_custom_values
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_custom_values.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );

DROP POLICY IF EXISTS contact_custom_values_modify ON public.contact_custom_values;
CREATE POLICY contact_custom_values_modify ON public.contact_custom_values
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_custom_values.contact_id
        AND c.account_id = (SELECT current_account_id())
        AND (SELECT current_role_rank()) >= 2
        AND (
          (SELECT current_role_rank()) >= 4
          OR can_view_contact(c.account_id, c.id, c.user_id)
        )
    )
  );


-- ---------- indexes ----------

-- Inbox list: newest activity first, per account, keyset-paged on
-- (last_message_at, id). Must match the query's order exactly —
-- `last_message_at DESC NULLS FIRST, id DESC` (lib/inbox/pagination.ts;
-- DESC defaults to NULLS FIRST) — or the planner sorts instead.
CREATE INDEX IF NOT EXISTS idx_conversations_account_last_msg
  ON public.conversations (account_id, last_message_at DESC, id DESC);
-- "Assigned to me" and the RLS visibility rule.
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_agent
  ON public.conversations (assigned_agent_id)
  WHERE assigned_agent_id IS NOT NULL;
-- v1 keyset pagination.
CREATE INDEX IF NOT EXISTS idx_conversations_account_created
  ON public.conversations (account_id, created_at DESC, id DESC);

-- Thread load (latest N) and v1 message pagination. The existing
-- (conversation_id, created_at) index is partial on sender_type.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at DESC, id DESC);

-- Contacts page order and v1 keyset.
CREATE INDEX IF NOT EXISTS idx_contacts_account_created
  ON public.contacts (account_id, created_at DESC, id DESC);

-- Inbound contact matching (`lib/contacts/dedupe.ts`) is a suffix match
-- — `phone_normalized LIKE '%<last 8 digits>'` — on every inbound
-- message and every API broadcast recipient. A btree can't serve a
-- leading wildcard; a trigram index can.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'idx_contacts_phone_norm_trgm'
  ) THEN
    EXECUTE format(
      'CREATE INDEX idx_contacts_phone_norm_trgm ON public.contacts USING gin (phone_normalized %I.gin_trgm_ops)',
      (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm')
    );
  END IF;
END $$;

-- Campaign-reply detection on every inbound message, and the
-- broadcast wizard's frequency cap.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact
  ON public.broadcast_recipients (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_sent_at
  ON public.broadcast_recipients (sent_at)
  WHERE sent_at IS NOT NULL;

-- Flow inbound dedup on every message (the one-active-run index is
-- partial on status='active').
CREATE INDEX IF NOT EXISTS idx_flow_runs_account_contact
  ON public.flow_runs (account_id, contact_id);

-- Unindexed foreign keys: contact-detail reads, and cascade /
-- SET NULL work when a contact, conversation or message is deleted
-- (without these each deleted parent row scans the child table).
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact
  ON public.contact_notes (contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact
  ON public.deals (contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_conversation
  ON public.deals (conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flow_runs_last_prompt_msg
  ON public.flow_runs (last_prompt_message_id)
  WHERE last_prompt_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flow_runs_conversation
  ON public.flow_runs (conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_conversation
  ON public.notifications (conversation_id);
