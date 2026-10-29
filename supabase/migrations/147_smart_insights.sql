-- ============================================================
-- 147_smart_insights.sql — the Smart insights foundation
--
-- Smart insights are CRM features powered by Jev (TypeSafe's System One
-- model): it reads a conversation and returns typed judgments with
-- probabilities, never text. This migration is the shared ground the
-- features stand on; the features themselves live in lib/insights/*.
--
--  * ai_insight_settings: one row per account, every feature off until
--    an admin switches it on (no row = everything off, so an install
--    that never opens Settings → Smart insights never calls Jev).
--    Members read it (the inbox and composer need to know what is on),
--    admins write it; no DELETE policy. reply_interested_tag_id is a
--    composite FK to chat_tags (id, account_id), the 075 pattern, so
--    another account's tag is impossible, and a trigger refuses a
--    sub-tag: replies are tagged with a main tag.
--
--  * conversations.insight_* and suggested_*: what Jev last judged
--    about the chat (intent, urgency, lead temperature, upset, wants a
--    person, a derived priority) and the chat tag it suggests. These
--    are trusted columns: the inbox sorts on the priority and the tag
--    suggestion can be auto-applied, so a client must not be able to
--    forge them. conversations_insight_guard refuses any change to
--    them unless the writer is the service role (062's idiom:
--    auth.uid() IS NULL or role service_role) or the transaction-local
--    flag app.insight_write is 'on' (raised only by
--    dismiss_tag_suggestion for its own UPDATE, the 062
--    app.send_channel_switch idiom). The trigger is column-scoped, so
--    status, tag and assignment updates by agents never reach it.
--    The suggestion FKs are composite (075) with ON DELETE SET NULL
--    (col): the column list keeps account_id. Deleting a tag nulls the
--    column as the deleting admin, so the guard lets a column go to
--    NULL when the tag it named no longer exists.
--
--  * dismiss_tag_suggestion(conversation): an agent's "not this tag".
--    It remembers the dismissed tag (so the same suggestion is not
--    made again) and clears the suggestion. SECURITY DEFINER with
--    explicit checks: agent and up, active account, and the chat
--    visible to the caller (can_view_conversation, as 062's
--    set_conversation_send_channel).
--
--  * chat_tags.ai_hint: a plain-language "when does this tag apply"
--    hint for Jev, written under chat_tags' existing policies (admins).
--
--  * conversation_events.kind also allows 'chat_tag_auto', the note an
--    automatic tagging leaves in the thread (service role only; the
--    table still has no client write policy), and a details jsonb
--    column for that note's ids and probability.
--
-- Re-runnable: CREATE … IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- constraints added inside DO blocks, CREATE OR REPLACE, DROP … IF
-- EXISTS before each trigger and policy.
-- ============================================================

-- ---------- 1. Per-account settings ----------

CREATE TABLE IF NOT EXISTS public.ai_insight_settings (
  account_id               uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  signals_enabled          boolean NOT NULL DEFAULT false,
  tag_suggest_mode         text NOT NULL DEFAULT 'off'
    CONSTRAINT ai_insight_settings_tag_suggest_mode_check
    CHECK (tag_suggest_mode IN ('off', 'suggest', 'auto')),
  tag_auto_min_p           real NOT NULL DEFAULT 0.85
    CONSTRAINT ai_insight_settings_tag_auto_min_p_check
    CHECK (tag_auto_min_p BETWEEN 0.6 AND 0.99),
  reply_class_enabled      boolean NOT NULL DEFAULT false,
  reply_interested_tag_id  uuid NULL,
  compose_check_mode       text NOT NULL DEFAULT 'off'
    CONSTRAINT ai_insight_settings_compose_check_mode_check
    CHECK (compose_check_mode IN ('off', 'warn')),
  meaning_triggers_enabled boolean NOT NULL DEFAULT false,
  kb_gap_judge_enabled     boolean NOT NULL DEFAULT false,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_insight_settings_reply_tag_fkey'
  ) THEN
    ALTER TABLE public.ai_insight_settings
      ADD CONSTRAINT ai_insight_settings_reply_tag_fkey
      FOREIGN KEY (reply_interested_tag_id, account_id)
      REFERENCES public.chat_tags (id, account_id)
      ON DELETE SET NULL (reply_interested_tag_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_ai_insight_settings_reply_tag
  ON public.ai_insight_settings (reply_interested_tag_id)
  WHERE reply_interested_tag_id IS NOT NULL;

COMMENT ON TABLE public.ai_insight_settings IS
  'Smart insights switches, one row per account (migration 147). No row = every feature off. Members read, admins write.';
COMMENT ON COLUMN public.ai_insight_settings.tag_auto_min_p IS
  'Auto-apply a suggested chat tag only when Jev''s probability is at least this (0.6–0.99), and only on a chat with no tag.';
COMMENT ON COLUMN public.ai_insight_settings.kb_gap_judge_enabled IS
  'Jev labels the intent of knowledge-gap topics and checks whether an approved answer covers them; off = topics still form, with no intent and coverage unknown.';
COMMENT ON COLUMN public.ai_insight_settings.reply_interested_tag_id IS
  'Main chat tag given to a campaign reply Jev sorts as interested; NULL = sort without tagging.';

-- Stamps updated_at (the settings PUT is version-checked on it) and
-- refuses a sub-tag as the interested-reply tag.
CREATE OR REPLACE FUNCTION public.ai_insight_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  new.updated_at := now();
  IF new.reply_interested_tag_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM chat_tags t
        WHERE t.id = new.reply_interested_tag_id
          AND t.parent_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Interested replies can only be tagged with a main tag, not a sub-tag'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS ai_insight_settings_guard ON public.ai_insight_settings;
CREATE TRIGGER ai_insight_settings_guard
  BEFORE INSERT OR UPDATE ON public.ai_insight_settings
  FOR EACH ROW EXECUTE FUNCTION public.ai_insight_settings_guard();

REVOKE ALL ON FUNCTION public.ai_insight_settings_guard() FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.ai_insight_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_insight_settings FROM PUBLIC, anon, authenticated, service_role;

-- is_account_member reads the caller's active, live, non-guest row
-- (083), so a bank guest and another workspace's members get nothing.
DROP POLICY IF EXISTS ai_insight_settings_read   ON public.ai_insight_settings;
DROP POLICY IF EXISTS ai_insight_settings_insert ON public.ai_insight_settings;
DROP POLICY IF EXISTS ai_insight_settings_update ON public.ai_insight_settings;
CREATE POLICY ai_insight_settings_read ON public.ai_insight_settings
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'viewer'));
CREATE POLICY ai_insight_settings_insert ON public.ai_insight_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.is_account_member(account_id, 'admin'));
CREATE POLICY ai_insight_settings_update ON public.ai_insight_settings
  FOR UPDATE TO authenticated
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE ON public.ai_insight_settings TO authenticated;
GRANT SELECT ON public.ai_insight_settings TO service_role;

-- ---------- 2. What Jev judged about a chat ----------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS insight_intent             text,
  ADD COLUMN IF NOT EXISTS insight_intent_p           real,
  ADD COLUMN IF NOT EXISTS insight_urgency            real,
  ADD COLUMN IF NOT EXISTS insight_lead_temp          real,
  ADD COLUMN IF NOT EXISTS insight_upset              real,
  ADD COLUMN IF NOT EXISTS insight_wants_human        real,
  ADD COLUMN IF NOT EXISTS insight_priority           smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insight_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS suggested_chat_tag_id      uuid,
  ADD COLUMN IF NOT EXISTS suggested_chat_sub_tag_id  uuid,
  ADD COLUMN IF NOT EXISTS tag_suggestion_dismissed_id uuid,
  ADD COLUMN IF NOT EXISTS suggested_tag_p            real,
  ADD COLUMN IF NOT EXISTS suggested_tag_at           timestamptz,
  ADD COLUMN IF NOT EXISTS suggestion_basis_at        timestamptz NULL;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('conversations_insight_intent_check',
       'CHECK (insight_intent IS NULL OR char_length(insight_intent) BETWEEN 1 AND 40)'),
      ('conversations_insight_intent_p_check',
       'CHECK (insight_intent_p IS NULL OR insight_intent_p BETWEEN 0 AND 1)'),
      ('conversations_insight_urgency_check',
       'CHECK (insight_urgency IS NULL OR insight_urgency BETWEEN 0 AND 2)'),
      ('conversations_insight_lead_temp_check',
       'CHECK (insight_lead_temp IS NULL OR insight_lead_temp BETWEEN 0 AND 3)'),
      ('conversations_insight_upset_check',
       'CHECK (insight_upset IS NULL OR insight_upset BETWEEN 0 AND 1)'),
      ('conversations_insight_wants_human_check',
       'CHECK (insight_wants_human IS NULL OR insight_wants_human BETWEEN 0 AND 1)'),
      ('conversations_insight_priority_check',
       'CHECK (insight_priority BETWEEN 0 AND 2)'),
      ('conversations_suggested_tag_p_check',
       'CHECK (suggested_tag_p IS NULL OR suggested_tag_p BETWEEN 0 AND 1)'),
      -- Same-account composite FKs (062/075); the column list on SET
      -- NULL keeps account_id.
      ('conversations_suggested_chat_tag_fkey',
       'FOREIGN KEY (suggested_chat_tag_id, account_id) REFERENCES public.chat_tags (id, account_id) ON DELETE SET NULL (suggested_chat_tag_id)'),
      ('conversations_suggested_chat_sub_tag_fkey',
       'FOREIGN KEY (suggested_chat_sub_tag_id, account_id) REFERENCES public.chat_tags (id, account_id) ON DELETE SET NULL (suggested_chat_sub_tag_id)'),
      ('conversations_tag_suggestion_dismissed_fkey',
       'FOREIGN KEY (tag_suggestion_dismissed_id, account_id) REFERENCES public.chat_tags (id, account_id) ON DELETE SET NULL (tag_suggestion_dismissed_id)')
    ) AS v(name, def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name) THEN
      EXECUTE format('ALTER TABLE public.conversations ADD CONSTRAINT %I %s', c.name, c.def);
    END IF;
  END LOOP;
END
$$;

-- The inbox's "needs attention first" sort; most chats are 0.
CREATE INDEX IF NOT EXISTS idx_conversations_insight_priority
  ON public.conversations (account_id, insight_priority)
  WHERE insight_priority > 0;
-- Deleting a tag scans these.
CREATE INDEX IF NOT EXISTS idx_conversations_suggested_chat_tag
  ON public.conversations (suggested_chat_tag_id) WHERE suggested_chat_tag_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_suggested_chat_sub_tag
  ON public.conversations (suggested_chat_sub_tag_id) WHERE suggested_chat_sub_tag_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_tag_suggestion_dismissed
  ON public.conversations (tag_suggestion_dismissed_id) WHERE tag_suggestion_dismissed_id IS NOT NULL;

COMMENT ON COLUMN public.conversations.insight_intent IS
  'Jev''s reading of what the customer wants (a short code), migration 147. Service-role writes only.';
COMMENT ON COLUMN public.conversations.insight_priority IS
  '0 normal, 1 attention, 2 urgent: derived from the insight_* signals by the server (migration 147).';
COMMENT ON COLUMN public.conversations.insight_at IS
  'created_at of the inbound message last judged; writers move it forward only, so a late judgment of an older message never overwrites a newer one.';
COMMENT ON COLUMN public.conversations.suggested_chat_tag_id IS
  'Main chat tag Jev suggests for this chat (migration 147); cleared by dismiss_tag_suggestion().';
COMMENT ON COLUMN public.conversations.tag_suggestion_dismissed_id IS
  'The last suggested tag a person dismissed, so the same suggestion is not made again.';
-- The suggestion is decided from the chat's tags read before a Jev call
-- of seconds; every suggestion write is a compare-and-set on those tags,
-- the dismissal and this column, so a dismissal, a manual tag (even one
-- removed again) or another judgment made meanwhile is never undone.
COMMENT ON COLUMN public.conversations.suggestion_basis_at IS
  'Server time (app clock, ms) at which the latest tag decision read the chat: a suggestion store or clear, or an automatic tag; now() when a person changes the tags. A decision writes only while this is NULL or no later than its own read time, then stamps that time, so nothing decided after it looked is undone (migration 147). Service-role writes only.';

-- ---------- 3. The guard ----------

-- SECURITY DEFINER only so the "the tag is gone" check sees chat_tags
-- regardless of the writer's RLS; auth.uid(), auth.role() and the
-- flag read session settings, which definer rights do not change.
CREATE OR REPLACE FUNCTION public.conversations_insight_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF tg_op = 'UPDATE' THEN
    IF  new.insight_intent      IS NOT DISTINCT FROM old.insight_intent
    AND new.insight_intent_p    IS NOT DISTINCT FROM old.insight_intent_p
    AND new.insight_urgency     IS NOT DISTINCT FROM old.insight_urgency
    AND new.insight_lead_temp   IS NOT DISTINCT FROM old.insight_lead_temp
    AND new.insight_upset       IS NOT DISTINCT FROM old.insight_upset
    AND new.insight_wants_human IS NOT DISTINCT FROM old.insight_wants_human
    AND new.insight_priority    IS NOT DISTINCT FROM old.insight_priority
    AND new.insight_at          IS NOT DISTINCT FROM old.insight_at
    AND new.suggested_tag_p     IS NOT DISTINCT FROM old.suggested_tag_p
    AND new.suggested_tag_at    IS NOT DISTINCT FROM old.suggested_tag_at
    AND new.suggestion_basis_at IS NOT DISTINCT FROM old.suggestion_basis_at
    -- A tag column going to NULL because its tag was deleted (the FK's
    -- ON DELETE SET NULL, run as the deleting admin) is not a forgery.
    AND (new.suggested_chat_tag_id IS NOT DISTINCT FROM old.suggested_chat_tag_id
         OR (new.suggested_chat_tag_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM chat_tags WHERE id = old.suggested_chat_tag_id)))
    AND (new.suggested_chat_sub_tag_id IS NOT DISTINCT FROM old.suggested_chat_sub_tag_id
         OR (new.suggested_chat_sub_tag_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM chat_tags WHERE id = old.suggested_chat_sub_tag_id)))
    AND (new.tag_suggestion_dismissed_id IS NOT DISTINCT FROM old.tag_suggestion_dismissed_id
         OR (new.tag_suggestion_dismissed_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM chat_tags WHERE id = old.tag_suggestion_dismissed_id)))
    THEN
      RETURN new;
    END IF;
  ELSIF new.insight_intent IS NULL
    AND new.insight_intent_p IS NULL
    AND new.insight_urgency IS NULL
    AND new.insight_lead_temp IS NULL
    AND new.insight_upset IS NULL
    AND new.insight_wants_human IS NULL
    AND new.insight_priority = 0
    AND new.insight_at IS NULL
    AND new.suggested_chat_tag_id IS NULL
    AND new.suggested_chat_sub_tag_id IS NULL
    AND new.tag_suggestion_dismissed_id IS NULL
    AND new.suggested_tag_p IS NULL
    AND new.suggested_tag_at IS NULL
    AND new.suggestion_basis_at IS NULL THEN
    RETURN new;
  END IF;

  -- The insight writers run on the service role; migrations and the
  -- SQL editor have no signed-in user (062's idiom).
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN new;
  END IF;

  -- dismiss_tag_suggestion() raises this for its own UPDATE only.
  IF COALESCE(current_setting('app.insight_write', TRUE), '') = 'on' THEN
    RETURN new;
  END IF;

  RAISE EXCEPTION 'Smart insights fields are written by the server only'
    USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS conversations_insight_guard ON public.conversations;
CREATE TRIGGER conversations_insight_guard
  BEFORE INSERT OR UPDATE OF
    insight_intent, insight_intent_p, insight_urgency, insight_lead_temp,
    insight_upset, insight_wants_human, insight_priority, insight_at,
    suggested_chat_tag_id, suggested_chat_sub_tag_id,
    tag_suggestion_dismissed_id, suggested_tag_p, suggested_tag_at,
    suggestion_basis_at
  ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_insight_guard();

REVOKE ALL ON FUNCTION public.conversations_insight_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 4. Dismissing a suggestion ----------

CREATE OR REPLACE FUNCTION public.dismiss_tag_suggestion(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_conv FROM conversations
   WHERE id = p_conversation_id
     AND account_id = current_account_id()
   FOR UPDATE;
  IF NOT FOUND
     OR current_role_rank() < 2
     OR NOT (
       current_role_rank() >= 4
       OR can_view_conversation(
            v_conv.account_id, v_conv.user_id, v_conv.assigned_agent_id,
            v_conv.channel_id, v_conv.send_channel_id)
     ) THEN
    RAISE EXCEPTION 'You cannot change this conversation' USING ERRCODE = '42501';
  END IF;

  IF v_conv.suggested_chat_tag_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.insight_write', 'on', TRUE);
  UPDATE conversations
     SET tag_suggestion_dismissed_id = suggested_chat_tag_id,
         suggested_chat_tag_id = NULL,
         suggested_chat_sub_tag_id = NULL,
         suggested_tag_p = NULL,
         suggested_tag_at = NULL
   WHERE id = p_conversation_id;
  PERFORM set_config('app.insight_write', '', TRUE);
END
$$;

REVOKE ALL ON FUNCTION public.dismiss_tag_suggestion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_tag_suggestion(uuid) TO authenticated;

COMMENT ON FUNCTION public.dismiss_tag_suggestion(uuid) IS
  'An agent''s "not this tag": remembers the dismissed tag and clears the suggestion. Agent and up, on a chat they can see (migration 147).';

-- ---------- 5. A hint per tag for Jev ----------

ALTER TABLE public.chat_tags
  ADD COLUMN IF NOT EXISTS ai_hint text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_tags_ai_hint_check') THEN
    ALTER TABLE public.chat_tags
      ADD CONSTRAINT chat_tags_ai_hint_check
      CHECK (ai_hint IS NULL OR char_length(ai_hint) <= 300);
  END IF;
END
$$;

COMMENT ON COLUMN public.chat_tags.ai_hint IS
  'Plain-language "when does this tag apply", read by Jev when it suggests tags (migration 147).';

-- ---------- 6. The automatic tagging note ----------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conversation_events_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%chat_tag_auto%'
  ) THEN
    ALTER TABLE public.conversation_events
      DROP CONSTRAINT IF EXISTS conversation_events_kind_check;
    ALTER TABLE public.conversation_events
      ADD CONSTRAINT conversation_events_kind_check
      CHECK (kind IN ('channel_switched', 'chat_tag_auto'));
  END IF;
END
$$;

-- 061 gave the table no column for a note's own data. A chat_tag_auto
-- note keeps the tag's display name as it was in to_label (so it still
-- reads after a rename or delete) and its ids and Jev's probability
-- here: { chat_tag_id, chat_sub_tag_id, p }. NULL for channel_switched.
ALTER TABLE public.conversation_events
  ADD COLUMN IF NOT EXISTS details jsonb NULL;

COMMENT ON COLUMN public.conversation_events.details IS
  'Kind-specific data (migration 147): chat_tag_auto = {chat_tag_id, chat_sub_tag_id, p}; NULL for channel_switched.';
