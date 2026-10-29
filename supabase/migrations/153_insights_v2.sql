-- ============================================================
-- 153_insights_v2.sql — Customer insights 2.0
--
-- 147 gave a chat Jev's judgments of intent, urgency, temperature,
-- upset and wants-a-person. 2.0 adds what the inbox needs to act on
-- them: a mood, the objections the customer raised, whether the last
-- message wants a reply or a call back, an "attention" pin the server
-- raises with a reason, and a per-message history of the figures.
--
--  * conversations.insight_sentiment (0 very negative … 4 very
--    positive), insight_objections (a subset of six codes),
--    insight_needs_reply / insight_callback (probabilities) and the pin
--    insight_attention_at + insight_attention_reason (urgent,
--    wants_person, upset, callback; the reason is NULL exactly when the
--    pin is). Like 147's columns they are trusted: the inbox pins and
--    notifies on them, so conversations_insight_guard is extended to
--    them (service role, or the transaction-local app.insight_write
--    flag a SECURITY DEFINER function raises around its own UPDATE).
--
--  * A pin is cleared by a person, never by the bot or the customer,
--    in three ways, each leaving an insight_attention_cleared note in
--    conversation_events with details {how, reason}:
--      - closing the chat (how 'closed'): a BEFORE UPDATE OF status
--        trigger nulls the pin, and the guard lets the pin go to NULL
--        in the same UPDATE that moves status to closed;
--      - a person's reply (how 'reply'): an AFTER INSERT trigger on
--        messages, sender_type 'agent' with a sender_id (077's and
--        078's test for "a person wrote"), inside its own EXCEPTION
--        block so it can never fail the message insert (078's shape);
--      - acknowledge_insight_attention() (how 'handled'): an agent's
--        "dealt with", with dismiss_tag_suggestion's access rule.
--    The service-role writer that raises a pin records
--    insight_attention_set itself.
--
--  * conversation_insight_events: one row per judged message (the
--    figures as jsonb), for the chat's mood/priority history. Readers
--    are whoever can see the chat (conversations' own RLS inside the
--    policy's EXISTS); only the service role writes.
--
--  * ai_insight_settings gains which reasons pin a chat and whether a
--    pin notifies; all default on, so turning attention on in 2.0 does
--    what it says. 147's policies (members read, admins write) cover
--    the new columns.
--
-- Additive and re-runnable on a database already on 152: ADD COLUMN IF
-- NOT EXISTS, constraints added inside DO blocks, CREATE OR REPLACE,
-- DROP … IF EXISTS before every trigger and policy.
-- ============================================================

-- ---------- 1. The new judgment columns ----------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS insight_sentiment        real,
  ADD COLUMN IF NOT EXISTS insight_objections       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS insight_needs_reply      real,
  ADD COLUMN IF NOT EXISTS insight_callback         real,
  ADD COLUMN IF NOT EXISTS insight_attention_at     timestamptz,
  ADD COLUMN IF NOT EXISTS insight_attention_reason text;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('conversations_insight_sentiment_check',
       'CHECK (insight_sentiment IS NULL OR insight_sentiment BETWEEN 0 AND 4)'),
      ('conversations_insight_objections_check',
       'CHECK (insight_objections <@ ARRAY[''price'', ''documents'', ''eligibility'', ''trust'', ''timing'', ''comparing'']::text[])'),
      ('conversations_insight_needs_reply_check',
       'CHECK (insight_needs_reply IS NULL OR insight_needs_reply BETWEEN 0 AND 1)'),
      ('conversations_insight_callback_check',
       'CHECK (insight_callback IS NULL OR insight_callback BETWEEN 0 AND 1)'),
      ('conversations_insight_attention_reason_check',
       'CHECK (insight_attention_reason IS NULL OR insight_attention_reason IN (''urgent'', ''wants_person'', ''upset'', ''callback''))'),
      ('conversations_insight_attention_pair_check',
       'CHECK ((insight_attention_at IS NULL) = (insight_attention_reason IS NULL))')
    ) AS v(name, def)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name) THEN
      EXECUTE format('ALTER TABLE public.conversations ADD CONSTRAINT %I %s', c.name, c.def);
    END IF;
  END LOOP;
END
$$;

-- The inbox's pinned chats; most chats are not pinned.
CREATE INDEX IF NOT EXISTS idx_conversations_insight_attention
  ON public.conversations (account_id, insight_attention_at)
  WHERE insight_attention_at IS NOT NULL;

COMMENT ON COLUMN public.conversations.insight_sentiment IS
  'Jev''s reading of the customer''s mood, 0 very negative … 4 very positive (migration 153). Service-role writes only.';
COMMENT ON COLUMN public.conversations.insight_objections IS
  'Objections the customer raised, a subset of price, documents, eligibility, trust, timing, comparing (migration 153). Service-role writes only.';
COMMENT ON COLUMN public.conversations.insight_needs_reply IS
  'Probability the customer''s last message wants a reply (migration 153). Service-role writes only.';
COMMENT ON COLUMN public.conversations.insight_callback IS
  'Probability the customer asked to be called back (migration 153). Service-role writes only.';
COMMENT ON COLUMN public.conversations.insight_attention_at IS
  'When the server pinned the chat for a person''s attention (migration 153). Set by the service role; cleared by closing the chat, a person''s reply or acknowledge_insight_attention().';
COMMENT ON COLUMN public.conversations.insight_attention_reason IS
  'Why the chat is pinned: urgent, wants_person, upset or callback; NULL exactly when insight_attention_at is (migration 153).';

-- ---------- 2. The guard, extended to the new columns ----------

-- 147's function with the six columns added. The one new exception:
-- the pin may go to NULL in the UPDATE that moves status to closed
-- (conversations_attention_close_clear has already nulled it by then,
-- and an agent may close a chat).
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
    AND new.insight_sentiment   IS NOT DISTINCT FROM old.insight_sentiment
    AND new.insight_objections  IS NOT DISTINCT FROM old.insight_objections
    AND new.insight_needs_reply IS NOT DISTINCT FROM old.insight_needs_reply
    AND new.insight_callback    IS NOT DISTINCT FROM old.insight_callback
    -- Closing a chat clears its pin (153).
    AND ((new.insight_attention_at IS NOT DISTINCT FROM old.insight_attention_at
          AND new.insight_attention_reason IS NOT DISTINCT FROM old.insight_attention_reason)
         OR (new.insight_attention_at IS NULL
             AND new.insight_attention_reason IS NULL
             AND new.status = 'closed'
             AND old.status IS DISTINCT FROM 'closed'))
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
    AND new.suggestion_basis_at IS NULL
    AND new.insight_sentiment IS NULL
    AND cardinality(new.insight_objections) = 0
    AND new.insight_needs_reply IS NULL
    AND new.insight_callback IS NULL
    AND new.insight_attention_at IS NULL
    AND new.insight_attention_reason IS NULL THEN
    RETURN new;
  END IF;

  -- The insight writers run on the service role; migrations and the
  -- SQL editor have no signed-in user (062's idiom).
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN new;
  END IF;

  -- dismiss_tag_suggestion(), acknowledge_insight_attention() and the
  -- reply trigger raise this for their own UPDATE only.
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
    suggestion_basis_at,
    insight_sentiment, insight_objections, insight_needs_reply,
    insight_callback, insight_attention_at, insight_attention_reason
  ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_insight_guard();

REVOKE ALL ON FUNCTION public.conversations_insight_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 3. The attention notes ----------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conversation_events_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%insight_attention_cleared%'
  ) THEN
    ALTER TABLE public.conversation_events
      DROP CONSTRAINT IF EXISTS conversation_events_kind_check;
    ALTER TABLE public.conversation_events
      ADD CONSTRAINT conversation_events_kind_check
      CHECK (kind IN ('channel_switched', 'chat_tag_auto',
                      'insight_attention_set', 'insight_attention_cleared'));
  END IF;
END
$$;

COMMENT ON COLUMN public.conversation_events.details IS
  'Kind-specific data: chat_tag_auto = {chat_tag_id, chat_sub_tag_id, p} (147); insight_attention_set = {reason, …} written by the server; insight_attention_cleared = {how: closed | reply | handled, reason} (153); NULL for channel_switched.';

-- ---------- 4. Closing a chat clears its pin ----------

-- Named to sort before conversations_insight_guard: BEFORE triggers
-- fire in name order. Column-scoped on status, so the guard (scoped on
-- the insight columns) does not fire at all for a plain close.
CREATE OR REPLACE FUNCTION public.conversations_attention_close_clear()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  new.insight_attention_at := NULL;
  new.insight_attention_reason := NULL;
  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS conversations_attention_close_clear ON public.conversations;
CREATE TRIGGER conversations_attention_close_clear
  BEFORE UPDATE OF status ON public.conversations
  FOR EACH ROW
  WHEN (new.status = 'closed'
        AND old.status IS DISTINCT FROM 'closed'
        AND old.insight_attention_at IS NOT NULL)
  EXECUTE FUNCTION public.conversations_attention_close_clear();

REVOKE ALL ON FUNCTION public.conversations_attention_close_clear() FROM PUBLIC, anon, authenticated, service_role;

-- The note, after the row is written. SECURITY DEFINER because
-- conversation_events has no client write policy; a failure is a
-- WARNING so a note can never stop a chat from closing.
CREATE OR REPLACE FUNCTION public.conversations_attention_close_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    INSERT INTO conversation_events (account_id, conversation_id, kind, actor_user_id, details)
    VALUES (new.account_id, new.id, 'insight_attention_cleared',
            (SELECT u.id FROM auth.users u WHERE u.id = auth.uid()),
            jsonb_build_object('how', 'closed', 'reason', old.insight_attention_reason));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Could not record the cleared attention pin on conversation %: %',
      new.id, SQLERRM;
  END;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS conversations_attention_close_note ON public.conversations;
CREATE TRIGGER conversations_attention_close_note
  AFTER UPDATE OF status ON public.conversations
  FOR EACH ROW
  WHEN (new.status = 'closed'
        AND old.status IS DISTINCT FROM 'closed'
        AND old.insight_attention_at IS NOT NULL
        AND new.insight_attention_at IS NULL)
  EXECUTE FUNCTION public.conversations_attention_close_note();

REVOKE ALL ON FUNCTION public.conversations_attention_close_note() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 5. A person's reply clears the pin ----------

-- 078's shape: everything inside an EXCEPTION block, so a failure is a
-- WARNING and the message insert always succeeds (a lost message costs
-- the conversation). The flag is raised around this UPDATE only.
CREATE OR REPLACE FUNCTION public.messages_clear_insight_attention()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_reason  text;
BEGIN
  BEGIN
    SELECT account_id, insight_attention_reason INTO v_account, v_reason
      FROM conversations
     WHERE id = new.conversation_id
       AND insight_attention_at IS NOT NULL
     FOR UPDATE;
    IF FOUND THEN
      PERFORM set_config('app.insight_write', 'on', TRUE);
      UPDATE conversations
         SET insight_attention_at = NULL,
             insight_attention_reason = NULL
       WHERE id = new.conversation_id;
      PERFORM set_config('app.insight_write', '', TRUE);

      INSERT INTO conversation_events (account_id, conversation_id, kind, actor_user_id, details)
      VALUES (v_account, new.conversation_id, 'insight_attention_cleared',
              (SELECT u.id FROM auth.users u WHERE u.id = new.sender_id),
              jsonb_build_object('how', 'reply', 'reason', v_reason));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.insight_write', '', TRUE);
    RAISE WARNING 'Could not clear the attention pin on conversation %: %',
      new.conversation_id, SQLERRM;
  END;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS messages_clear_insight_attention ON public.messages;
CREATE TRIGGER messages_clear_insight_attention
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (new.sender_type = 'agent' AND new.sender_id IS NOT NULL)
  EXECUTE FUNCTION public.messages_clear_insight_attention();

REVOKE ALL ON FUNCTION public.messages_clear_insight_attention() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 6. "Dealt with" ----------

CREATE OR REPLACE FUNCTION public.acknowledge_insight_attention(p_conversation_id uuid)
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

  IF v_conv.insight_attention_at IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.insight_write', 'on', TRUE);
  UPDATE conversations
     SET insight_attention_at = NULL,
         insight_attention_reason = NULL
   WHERE id = p_conversation_id;
  PERFORM set_config('app.insight_write', '', TRUE);

  INSERT INTO conversation_events (account_id, conversation_id, kind, actor_user_id, details)
  VALUES (v_conv.account_id, p_conversation_id, 'insight_attention_cleared', auth.uid(),
          jsonb_build_object('how', 'handled', 'reason', v_conv.insight_attention_reason));
END
$$;

REVOKE ALL ON FUNCTION public.acknowledge_insight_attention(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_insight_attention(uuid) TO authenticated;

COMMENT ON FUNCTION public.acknowledge_insight_attention(uuid) IS
  'An agent''s "dealt with": clears the chat''s attention pin and notes it (how = handled). Agent and up, on a chat they can see (migration 153).';

-- ---------- 7. Per-message history ----------

CREATE TABLE IF NOT EXISTS public.conversation_insight_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL,
  conversation_id uuid        NOT NULL,
  message_at      timestamptz NOT NULL,
  figures         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_insight_events_conversation_fkey
    FOREIGN KEY (conversation_id, account_id)
    REFERENCES public.conversations (id, account_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS conversation_insight_events_conversation_idx
  ON public.conversation_insight_events (conversation_id, message_at DESC);

COMMENT ON TABLE public.conversation_insight_events IS
  'What Jev judged about each customer message (migration 153): the chat''s mood and priority history. Readable by whoever can see the chat; the service role writes.';
COMMENT ON COLUMN public.conversation_insight_events.message_at IS
  'created_at of the inbound message judged.';
COMMENT ON COLUMN public.conversation_insight_events.figures IS
  'The judged figures for that message (sentiment, objections, needs_reply, callback, urgency, …), numbers and codes only, never message text.';

ALTER TABLE public.conversation_insight_events ENABLE ROW LEVEL SECURITY;

-- conversations' own RLS applies inside the EXISTS, so this is "the
-- caller can see the chat" (061's conversation_events_select shape).
DROP POLICY IF EXISTS conversation_insight_events_select ON public.conversation_insight_events;
CREATE POLICY conversation_insight_events_select ON public.conversation_insight_events
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT current_account_id())
    AND EXISTS (
      SELECT 1 FROM public.conversations c
       WHERE c.id = conversation_insight_events.conversation_id
         AND c.account_id = conversation_insight_events.account_id
    )
  );

REVOKE ALL ON public.conversation_insight_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversation_insight_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_insight_events TO service_role;

-- ---------- 8. Attention switches ----------

ALTER TABLE public.ai_insight_settings
  ADD COLUMN IF NOT EXISTS attention_pin_urgent       boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS attention_pin_upset        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS attention_pin_wants_person boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS attention_pin_callback     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS attention_notify           boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.ai_insight_settings.attention_pin_urgent IS
  'Pin a chat for attention when Jev judges it urgent (migration 153).';
COMMENT ON COLUMN public.ai_insight_settings.attention_pin_upset IS
  'Pin a chat for attention when the customer is upset (migration 153).';
COMMENT ON COLUMN public.ai_insight_settings.attention_pin_wants_person IS
  'Pin a chat for attention when the customer asks for a person (migration 153).';
COMMENT ON COLUMN public.ai_insight_settings.attention_pin_callback IS
  'Pin a chat for attention when the customer asks to be called back (migration 153).';
COMMENT ON COLUMN public.ai_insight_settings.attention_notify IS
  'Ring the bell when a chat is pinned (migration 153).';

-- ---------- 9. The attention bell ----------
-- A pin rings once, for the chat's assigned agent (else its owner):
-- type insight_attention, written by the service role
-- (notifyInsightAttention in src/lib/notifications/insight-attention.ts)
-- with conversation_id set, so it opens the chat. 133's list plus
-- insight_attention; a later type edits the list from here. The bell
-- trigger (109) pushes it like any non-chat_* type, under the push kind
-- insight_attention (src/lib/push/kinds.ts); quiet hours hold it like a
-- WhatsApp message, since only the calendar's reminders are exempt.
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected',
    'team_activity_alert',
    'ai_handoff',
    'task_assigned',
    'task_due',
    'chat_mention',
    'chat_dm',
    'chat_thread_reply',
    'chat_broadcast',
    'call_missed',
    'callback_requested',
    'deal_room_join_request',
    'deal_room_update',
    'call_outcome_due',
    'pbx_connection_silent',
    'pbx_connection_restored',
    'meeting_invite',
    'calendar_invite',
    'calendar_update',
    'calendar_cancelled',
    'calendar_response',
    'event_reminder',
    'meeting_reminder',
    'group_join_request',
    'conversation_shared',
    'insight_attention'
  ));

-- An insight_attention push opens the chat, like conversation_shared.
-- Restates 133's push_bell_url with that one type added; change it
-- together with hrefFor in src/lib/notifications/target.ts.
CREATE OR REPLACE FUNCTION public.push_bell_url(n public.notifications)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role    text;
  v_chat    text := CASE WHEN n.conversation_id IS NOT NULL THEN '/inbox?c=' || n.conversation_id END;
  v_contact text;
BEGIN
  SELECT p.account_role::text INTO v_role FROM public.profiles p
   WHERE p.user_id = n.user_id AND p.account_id = n.account_id AND p.deactivated_at IS NULL;
  CASE
    WHEN n.type IN ('conversation_assigned', 'ai_handoff', 'conversation_shared',
                    'insight_attention') THEN
      RETURN coalesce(v_chat, '/notifications');
    WHEN n.type IN ('task_assigned', 'task_due') THEN
      RETURN coalesce('/contacts/' || n.contact_id, v_chat, '/calls');
    WHEN n.type IN ('call_missed', 'callback_requested', 'call_outcome_due') THEN
      v_contact := coalesce(n.contact_id::text, n.meta ->> 'contact_id');
      RETURN CASE WHEN public.push_is_uuid(v_contact) THEN '/contacts/' || v_contact ELSE '/calls' END;
    WHEN n.type IN ('deal_room_join_request', 'deal_room_update') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'room_id')
                  THEN '/chat/rooms/' || (n.meta ->> 'room_id') ELSE '/notifications' END;
    WHEN n.type IN ('channel_disconnected', 'channel_reconnected') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=whatsapp' ELSE '/notifications' END;
    WHEN n.type IN ('pbx_connection_silent', 'pbx_connection_restored') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=phone-system' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_alert' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin', 'team_leader') THEN '/team-activity' ELSE '/notifications' END;
    WHEN n.type = 'meeting_invite' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'meeting_id')
                  THEN '/meetings/' || (n.meta ->> 'meeting_id') ELSE '/notifications' END;
    ELSE
      RETURN '/notifications';
  END CASE;
END $$;

REVOKE ALL ON FUNCTION public.push_bell_url(public.notifications) FROM PUBLIC, anon, authenticated;
