-- 191: personal chats + history import jobs.
--
-- Everything to or from a staff member's own scanned number (190:
-- whatsapp_config.is_personal, user_id = owner) lives in a SEPARATE
-- conversation per (contact, owner): conversations.personal_owner_id.
-- NULL means a company chat, which is what every row was before 191.
--
--   0. Refusal scan: a company chat already on a personal number stops
--      the migration before any DDL (nothing is moved silently).
--   1. personal_owner_id + row CHECKs + index.
--   2. One company chat per contact, one personal chat per (contact,
--      owner): two partial unique indexes replace 036's.
--   3. conversations_personal_guard (every writer, service role too):
--      owner frozen, owner live staff, numbers match the chat's kind.
--      062's set_conversation_send_channel is a plain UPDATE, so it is
--      refused through this trigger as well.
--   4. Visibility: can_view_personal_chat (owner, the owner's team
--      leaders, admins) replaces can_view_conversation for a personal
--      chat in the conversations / messages policies; coordinator shares
--      never reach one.
--   5. Coordinator shares refuse personal chats (RPC + trigger).
--   6. 169 (contact owner follows the chat) skips personal chats.
--   7. 080/138 (deals from chat tags) skip personal chats.
--   8. merge_duplicate_conversations keys on personal_owner_id too.
--   9. History import job tables + claim_personal_history_import +
--      import_history_rows (service role only). Every row is stamped
--      provider 'openwa' and a channel that is NULL or the owner's own
--      personal number in the chat's workspace; anything else refuses
--      the whole batch.
--  10. Customer documents (178): a document filed from a personal chat
--      is seen only by those who see the chat (backstop; the app no
--      longer files them).
--
-- Every personal-chat refusal raised here carries HINT 'PERSONAL_CHAT'
-- and SQLSTATE 23514, except the coordinator-share RPC's (42501): that
-- one refuses an action, not a row shape.
--
-- 190's personal-number grant inside can_view_conversation is kept as
-- is. After 191 no company chat can sit on a personal number, so for
-- conversations it is redundant (it still matters for contacts).
--
-- Apply as postgres (or superuser). Re-runnable.

-- ---------- 0. Refusal scan (before any DDL) ----------

DO $$
DECLARE
  v_n bigint;
  v_has_col boolean := EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversations'
       AND column_name = 'personal_owner_id');
BEGIN
  EXECUTE format($q$
    SELECT count(*) FROM public.conversations c
     WHERE %s
       AND EXISTS (SELECT 1 FROM public.whatsapp_config w
                    WHERE w.is_personal
                      AND w.id IN (c.channel_id, c.send_channel_id))$q$,
    CASE WHEN v_has_col THEN 'c.personal_owner_id IS NULL' ELSE 'TRUE' END)
  INTO v_n;
  PERFORM set_config('wacrm.m191_refused',
    CASE WHEN v_n > 0 THEN format(
      '%s company conversation(s) have channel_id or send_channel_id on a personal number; move them to a company number (or delete them), then re-run 191',
      v_n) ELSE '' END, false);
  IF v_n > 0 THEN
    PERFORM set_config('default_transaction_read_only', 'on', false);
  END IF;
END $$;

DO $$ BEGIN
  IF current_setting('wacrm.m191_refused', true) <> '' THEN
    RAISE EXCEPTION '191 refused, nothing changed (this session is now read-only; reconnect): %',
      current_setting('wacrm.m191_refused')
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'PERSONAL_CHAT';
  END IF;
END $$;

-- ---------- 1. Column, CHECKs, index ----------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS personal_owner_id uuid NULL
    REFERENCES auth.users(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.conversations.personal_owner_id IS
  'NULL = company chat. Otherwise a personal chat: everything to/from that staff member''s own number (whatsapp_config.is_personal) with this contact. Seen by the owner, the owner''s team leaders and admins only; frozen after insert. Migration 191.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'conversations_personal_owner_is_user') THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_personal_owner_is_user
      CHECK (personal_owner_id IS NULL OR user_id = personal_owner_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'conversations_personal_owner_assignee') THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_personal_owner_assignee
      CHECK (personal_owner_id IS NULL OR assigned_agent_id IS NULL
             OR assigned_agent_id = personal_owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversations_personal_owner_idx
  ON public.conversations (personal_owner_id)
  WHERE personal_owner_id IS NOT NULL;

-- ---------- 2. Uniqueness: company vs personal ----------
-- Created before 036's index is dropped: autocommit, so there is never
-- a moment without a uniqueness guarantee.

CREATE UNIQUE INDEX IF NOT EXISTS conversations_company_chat
  ON public.conversations (account_id, contact_id)
  WHERE personal_owner_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_personal_chat
  ON public.conversations (account_id, contact_id, personal_owner_id)
  WHERE personal_owner_id IS NOT NULL;

DROP INDEX IF EXISTS public.idx_conversations_account_contact;

-- ---------- 3. Guard trigger ----------

CREATE OR REPLACE FUNCTION public.conversations_personal_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_col text;
  v_id  uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.personal_owner_id IS DISTINCT FROM OLD.personal_owner_id THEN
    RAISE EXCEPTION 'A chat cannot change between company and personal'
      USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
  END IF;

  IF NEW.personal_owner_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = NEW.personal_owner_id
         AND p.account_id = NEW.account_id
         AND p.deactivated_at IS NULL
         AND p.account_role::text IN ('owner', 'admin', 'team_leader', 'agent')
    ) THEN
      RAISE EXCEPTION 'A personal chat''s owner must be live staff of the workspace'
        USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
    END IF;
    IF NEW.user_id IS DISTINCT FROM NEW.personal_owner_id THEN
      RAISE EXCEPTION 'A personal chat belongs to its owner'
        USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
    END IF;
    IF NEW.assigned_agent_id IS NOT NULL
       AND NEW.assigned_agent_id <> NEW.personal_owner_id THEN
      RAISE EXCEPTION 'A personal chat cannot be assigned to someone else'
        USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
    END IF;
  END IF;

  FOREACH v_col IN ARRAY ARRAY['channel_id', 'send_channel_id'] LOOP
    v_id := CASE v_col WHEN 'channel_id' THEN NEW.channel_id ELSE NEW.send_channel_id END;
    CONTINUE WHEN v_id IS NULL;
    IF NEW.personal_owner_id IS NULL THEN
      IF EXISTS (SELECT 1 FROM whatsapp_config w WHERE w.id = v_id AND w.is_personal) THEN
        RAISE EXCEPTION 'A company chat cannot use a personal number (%)', v_col
          USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM whatsapp_config w
       WHERE w.id = v_id AND w.is_personal
         AND w.account_id = NEW.account_id
         AND w.user_id = NEW.personal_owner_id
    ) THEN
      RAISE EXCEPTION 'A personal chat can only use its owner''s personal number (%)', v_col
        USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.conversations_personal_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS conversations_personal_guard ON public.conversations;
CREATE TRIGGER conversations_personal_guard
  BEFORE INSERT OR UPDATE OF personal_owner_id, user_id, assigned_agent_id,
                             channel_id, send_channel_id
  ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.conversations_personal_guard();

-- ---------- 4. Visibility ----------

CREATE OR REPLACE FUNCTION public.can_view_personal_chat(p_account_id uuid, p_owner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_owner IS NOT NULL AND (
    is_account_member(p_account_id, 'admin')
    OR (p_owner = auth.uid() AND is_account_member(p_account_id))
    OR (is_account_member(p_account_id, 'team_leader')
        AND leads_teammate(p_account_id, p_owner))
  );
$$;

REVOKE ALL ON FUNCTION public.can_view_personal_chat(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_personal_chat(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.can_view_personal_chat(uuid, uuid) IS
  'Who sees a personal chat (conversations.personal_owner_id): admins and owners, the owner, and team leaders of the owner. Replaces can_view_conversation for personal chats in the conversations/messages policies. Migration 191.';

-- 061's policies, with the personal branch.
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR CASE WHEN personal_owner_id IS NULL
           THEN can_view_conversation(account_id, user_id, assigned_agent_id, channel_id, send_channel_id)
           ELSE can_view_personal_chat(account_id, personal_owner_id)
         END
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
      OR CASE WHEN personal_owner_id IS NULL
           THEN can_view_conversation(account_id, user_id, assigned_agent_id, channel_id, send_channel_id)
           ELSE can_view_personal_chat(account_id, personal_owner_id)
         END
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
      OR CASE WHEN personal_owner_id IS NULL
           THEN can_view_conversation(account_id, user_id, assigned_agent_id, channel_id, send_channel_id)
           ELSE can_view_personal_chat(account_id, personal_owner_id)
         END
    )
  );

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
          OR CASE WHEN c.personal_owner_id IS NULL
               THEN can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id)
               ELSE can_view_personal_chat(c.account_id, c.personal_owner_id)
             END
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
          OR CASE WHEN c.personal_owner_id IS NULL
               THEN can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id)
               ELSE can_view_personal_chat(c.account_id, c.personal_owner_id)
             END
        )
    )
  );

-- 057's insert policy; a personal chat is opened only by its owner.
DROP POLICY IF EXISTS conversations_insert ON public.conversations;
CREATE POLICY conversations_insert ON public.conversations FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM public.contacts ct
      WHERE ct.id = conversations.contact_id
        AND ct.account_id = conversations.account_id
        AND can_view_contact(ct.account_id, ct.id, ct.user_id)
    )
    AND (
      assigned_agent_id IS NULL
      OR assigned_agent_id = auth.uid()
      OR is_account_member(account_id, 'admin')
      OR (
        is_account_member(account_id, 'team_leader')
        AND leads_teammate(account_id, assigned_agent_id)
      )
    )
    AND (personal_owner_id IS NULL OR personal_owner_id = auth.uid())
  );

-- 133's coordinator policies: never a personal chat. The messages
-- policies read my_coordinator_shares(), which drops them below.
DROP POLICY IF EXISTS conversations_coordinator_select ON public.conversations;
CREATE POLICY conversations_coordinator_select ON public.conversations
  FOR SELECT
  USING (
    account_id = (SELECT public.current_account_id())
    AND personal_owner_id IS NULL
    AND (SELECT public.i_hold_open_coordinator_shares())
    AND id IN (SELECT g.conversation_id FROM public.my_coordinator_shares() g)
  );

-- ---------- 5. Coordinator shares ----------

CREATE OR REPLACE FUNCTION public.my_coordinator_shares()
RETURNS TABLE (share_id uuid, conversation_id uuid, bank_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
ROWS 10
AS $$
  SELECT s.id, s.conversation_id, s.bank_code
    FROM public.conversation_coordinator_shares s
    JOIN public.coordinator_banks b
      ON b.account_id = s.account_id
     AND b.user_id = s.coordinator_user_id
     AND b.bank_code = s.bank_code
    JOIN public.profiles p
      ON p.user_id = s.coordinator_user_id
     AND p.account_id = s.account_id
    JOIN public.conversations c
      ON c.id = s.conversation_id
     AND c.personal_owner_id IS NULL
   WHERE auth.uid() IS NOT NULL
     AND s.coordinator_user_id = auth.uid()
     AND s.revoked_at IS NULL
     AND s.account_id = public.current_account_id()
     AND p.deactivated_at IS NULL
     AND p.account_role::text IN ('agent', 'team_leader');
$$;

CREATE OR REPLACE FUNCTION public.share_conversation_with_coordinator(
  p_conversation_id     uuid,
  p_coordinator_user_id uuid,
  p_bank_code           text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
  v_conv public.conversations%ROWTYPE;
  v_open public.conversation_coordinator_shares%ROWTYPE;
  v_id   uuid;
  v_name text;
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 2 THEN
    RAISE EXCEPTION 'You cannot share conversations' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.conversations
   WHERE id = p_conversation_id AND account_id = v_acct
   FOR UPDATE;
  IF NOT FOUND OR NOT (
       public.current_role_rank() >= 4
       OR CASE WHEN v_conv.personal_owner_id IS NULL
            THEN public.can_view_conversation(v_conv.account_id, v_conv.user_id, v_conv.assigned_agent_id,
                                              v_conv.channel_id, v_conv.send_channel_id)
            ELSE public.can_view_personal_chat(v_conv.account_id, v_conv.personal_owner_id)
          END) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
  END IF;

  -- 191: a personal chat is never shared.
  IF v_conv.personal_owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'A personal chat cannot be shared'
      USING ERRCODE = '42501', HINT = 'PERSONAL_CHAT';
  END IF;

  IF p_coordinator_user_id IS NULL OR p_coordinator_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Share with another person' USING ERRCODE = '22023', HINT = 'self_share';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.coordinator_banks b
      JOIN public.profiles p ON p.user_id = b.user_id AND p.account_id = b.account_id
     WHERE b.account_id = v_acct
       AND b.user_id = p_coordinator_user_id
       AND b.bank_code = p_bank_code
       AND p.deactivated_at IS NULL
       AND p.account_role::text IN ('agent', 'team_leader')
  ) THEN
    RAISE EXCEPTION 'That person is not a coordinator for this bank'
      USING ERRCODE = '22023', HINT = 'not_coordinator';
  END IF;

  SELECT * INTO v_open FROM public.conversation_coordinator_shares
   WHERE conversation_id = p_conversation_id
     AND coordinator_user_id = p_coordinator_user_id
     AND revoked_at IS NULL;
  IF FOUND THEN
    IF v_open.bank_code = p_bank_code THEN
      RETURN v_open.id;  -- already shared: idempotent, no second bell
    END IF;
    -- Shared before under another bank: that share is replaced.
    UPDATE public.conversation_coordinator_shares
       SET revoked_at = now(), revoked_by = auth.uid()
     WHERE id = v_open.id;
  END IF;

  INSERT INTO public.conversation_coordinator_shares
    (account_id, conversation_id, coordinator_user_id, bank_code, shared_by)
  VALUES (v_acct, p_conversation_id, p_coordinator_user_id, p_bank_code, auth.uid())
  RETURNING id INTO v_id;

  SELECT coalesce(nullif(btrim(ct.name), ''), ct.phone) INTO v_name
    FROM public.contacts ct WHERE ct.id = v_conv.contact_id;

  INSERT INTO public.notifications
    (account_id, user_id, type, conversation_id, contact_id, actor_user_id, title, body, meta)
  VALUES (v_acct, p_coordinator_user_id, 'conversation_shared', p_conversation_id,
          v_conv.contact_id, auth.uid(),
          left('Chat shared with you' || coalesce(': ' || v_name, ''), 200),
          'Bank: ' || p_bank_code,
          jsonb_build_object('share_id', v_id, 'bank_code', p_bank_code));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.share_conversation_with_coordinator(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_conversation_with_coordinator(uuid, uuid, text) TO authenticated;

-- Backstop for any other writer.
CREATE OR REPLACE FUNCTION public.coordinator_shares_refuse_personal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM conversations c
              WHERE c.id = NEW.conversation_id AND c.personal_owner_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A personal chat cannot be shared'
      USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.coordinator_shares_refuse_personal() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS coordinator_shares_refuse_personal ON public.conversation_coordinator_shares;
CREATE TRIGGER coordinator_shares_refuse_personal
  BEFORE INSERT OR UPDATE OF conversation_id ON public.conversation_coordinator_shares
  FOR EACH ROW
  EXECUTE FUNCTION public.coordinator_shares_refuse_personal();

-- ---------- 6. 169: a personal chat never moves the contact's owner ----------

DROP TRIGGER IF EXISTS conversations_move_contact_owner ON public.conversations;
CREATE TRIGGER conversations_move_contact_owner
  AFTER UPDATE OF assigned_agent_id ON public.conversations
  FOR EACH ROW
  WHEN (NEW.assigned_agent_id IS NOT NULL
        AND NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
        AND NEW.personal_owner_id IS NULL)
  EXECUTE FUNCTION public.conversations_move_contact_owner();

DROP TRIGGER IF EXISTS conversations_move_contact_owner_ins ON public.conversations;
CREATE TRIGGER conversations_move_contact_owner_ins
  AFTER INSERT ON public.conversations
  FOR EACH ROW
  WHEN (NEW.assigned_agent_id IS NOT NULL AND NEW.personal_owner_id IS NULL)
  EXECUTE FUNCTION public.conversations_move_contact_owner();

-- ---------- 7. 138: no deals from personal chats ----------

DROP TRIGGER IF EXISTS create_deals_for_chat_tag ON public.conversations;
CREATE TRIGGER create_deals_for_chat_tag
  AFTER UPDATE OF chat_tag_id, chat_sub_tag_id ON public.conversations
  FOR EACH ROW
  WHEN (new.chat_tag_id IS NOT NULL
        AND new.personal_owner_id IS NULL
        AND (new.chat_tag_id IS DISTINCT FROM old.chat_tag_id
             OR new.chat_sub_tag_id IS DISTINCT FROM old.chat_sub_tag_id))
  EXECUTE FUNCTION public.create_deals_for_chat_tag();

-- ---------- 8. 036's merge, keyed on the owner too ----------

CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           contact_id,
           personal_owner_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0)                AS total_unread
    FROM conversations
    GROUP BY account_id, contact_id, personal_owner_id
    HAVING count(*) > 1
  LOOP
    v_all      := v_group.ids;
    v_survivor := v_all[1];
    v_losers   := v_all[2:array_length(v_all, 1)];

    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);

    UPDATE conversations c
    SET unread_count      = v_group.total_unread,
        last_message_text = lm.content_text,
        last_message_at   = lm.created_at,
        updated_at        = NOW()
    FROM (
      SELECT content_text, created_at
      FROM messages
      WHERE conversation_id = v_survivor
      ORDER BY created_at DESC
      LIMIT 1
    ) lm
    WHERE c.id = v_survivor;

    UPDATE conversations
    SET unread_count = v_group.total_unread,
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;

-- ---------- 9. History import jobs ----------

CREATE TABLE IF NOT EXISTS public.personal_history_imports (
  config_id         uuid PRIMARY KEY REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL,
  user_id           uuid NOT NULL,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'listing', 'running', 'paused', 'done', 'failed')),
  chats_total       int NOT NULL DEFAULT 0,
  chats_done        int NOT NULL DEFAULT 0,
  messages_imported int NOT NULL DEFAULT 0,
  last_error        text,
  lease_until       timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.personal_history_import_chats (
  config_id         uuid REFERENCES public.personal_history_imports(config_id) ON DELETE CASCADE,
  chat_id           text,
  name              text,
  chat_ts           timestamptz,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  attempts          int NOT NULL DEFAULT 0,
  next_limit        int NOT NULL DEFAULT 2000,
  messages_imported int NOT NULL DEFAULT 0,
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (config_id, chat_id)
);

COMMENT ON TABLE public.personal_history_imports IS
  'One-time import of a personal number''s phone history into personal chats, one job per whatsapp_config row; driven by a cron through claim_personal_history_import. Service role only. Migration 191.';
COMMENT ON TABLE public.personal_history_import_chats IS
  'The phone chats of a personal_history_imports job and their progress. Service role only. Migration 191.';

ALTER TABLE public.personal_history_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_history_import_chats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.personal_history_imports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.personal_history_import_chats FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.personal_history_imports TO service_role;
GRANT ALL ON public.personal_history_import_chats TO service_role;

CREATE OR REPLACE FUNCTION public.claim_personal_history_import(p_lease_seconds int)
RETURNS SETOF public.personal_history_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 1 THEN
    RAISE EXCEPTION 'lease must be at least one second' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  UPDATE personal_history_imports i
     SET lease_until = now() + make_interval(secs => p_lease_seconds),
         started_at  = coalesce(i.started_at, now()),
         updated_at  = now()
   WHERE i.config_id = (
     SELECT j.config_id FROM personal_history_imports j
      WHERE j.status IN ('queued', 'listing', 'running', 'paused')
        AND (j.lease_until IS NULL OR j.lease_until < now())
      ORDER BY j.created_at, j.config_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
  RETURNING i.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_personal_history_import(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_personal_history_import(int) TO service_role;

-- Rows: a jsonb array of {sender_type, sender_id, content_type,
-- content_text, message_id, status, provider, channel_id, created_at}.
-- A row with no message_id is skipped (nothing to dedupe on). Replays
-- insert nothing (037's unique (conversation_id, message_id)). Never
-- touches unread_count or status; moves the last-message summary only
-- forward.
CREATE OR REPLACE FUNCTION public.import_history_rows(p_conversation_id uuid, p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n     int;
  v_text  text;
  v_at    timestamptz;
  v_acct  uuid;
  v_owner uuid;
BEGIN
  SELECT c.account_id, c.personal_owner_id INTO v_acct, v_owner
    FROM conversations c WHERE c.id = p_conversation_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'History is imported into personal chats only'
      USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  -- The rows come from the caller, not from the chat: a channel_id must
  -- be the owner's own personal number in this workspace (or NULL), and
  -- the provider OpenWA, the only one a personal number runs on (190).
  -- Every row is checked, skipped ones too; one bad row refuses the batch.
  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_rows) AS r(provider text, channel_id uuid)
     WHERE coalesce(r.provider, 'openwa') <> 'openwa'
        OR (r.channel_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM whatsapp_config w
               WHERE w.id = r.channel_id
                 AND w.account_id = v_acct
                 AND w.is_personal
                 AND w.user_id = v_owner))) THEN
    RAISE EXCEPTION 'History rows must be on the chat owner''s personal OpenWA number'
      USING ERRCODE = '23514', HINT = 'PERSONAL_CHAT';
  END IF;

  WITH ins AS (
    INSERT INTO messages (conversation_id, sender_type, sender_id, content_type,
                          content_text, message_id, status, provider, channel_id, created_at)
    SELECT p_conversation_id, r.sender_type, r.sender_id,
           coalesce(r.content_type, 'text'), r.content_text, r.message_id,
           coalesce(r.status, 'delivered'), 'openwa', r.channel_id,
           coalesce(r.created_at, now())
      FROM jsonb_to_recordset(p_rows) AS r(
             sender_type text, sender_id uuid, content_type text, content_text text,
             message_id text, status text, provider text, channel_id uuid,
             created_at timestamptz)
     WHERE nullif(btrim(r.message_id), '') IS NOT NULL
    ON CONFLICT (conversation_id, message_id) DO NOTHING
    RETURNING content_text, created_at
  ), newest AS (
    SELECT content_text, created_at FROM ins ORDER BY created_at DESC LIMIT 1
  )
  SELECT (SELECT count(*) FROM ins)::int, n.content_text, n.created_at
    INTO v_n, v_text, v_at
    FROM (SELECT 1) one LEFT JOIN newest n ON true;

  IF v_n > 0 THEN
    UPDATE conversations c
       SET last_message_text = v_text,
           last_message_at   = v_at
     WHERE c.id = p_conversation_id
       AND (c.last_message_at IS NULL OR c.last_message_at < v_at);
  END IF;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.import_history_rows(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_history_rows(uuid, jsonb) TO service_role;

-- ---------- 10. Customer documents (178) ----------
-- 178's customer_documents_select lets anyone who can see the customer
-- read every document filed for them. A document from a personal chat
-- must stay with that chat, and the policy cannot look the chat up
-- itself: the conversations policy hides it from exactly the people it
-- must refuse, so a NOT EXISTS would pass them. This definer helper
-- reads the chat's owner unfiltered and answers only "may the caller
-- see a document from this chat": true for no chat or a company chat.
CREATE OR REPLACE FUNCTION public.customer_document_chat_visible(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT CASE WHEN c.personal_owner_id IS NULL THEN true
                 ELSE public.can_view_personal_chat(c.account_id, c.personal_owner_id)
            END
       FROM public.conversations c
      WHERE c.id = p_conversation_id),
    true);
$$;

REVOKE ALL ON FUNCTION public.customer_document_chat_visible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_document_chat_visible(uuid) TO authenticated, service_role;

-- 178's body, unchanged, plus the personal-chat condition on the
-- non-admin branches (admins see every personal chat anyway). The
-- folders policy is left alone: a folder row is the customer's
-- reference number and NAS timestamps, no message content.
DROP POLICY IF EXISTS customer_documents_select ON public.customer_documents;
CREATE POLICY customer_documents_select ON public.customer_documents
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND ((SELECT public.current_role_rank()) >= 4
              OR ((EXISTS (SELECT 1 FROM public.contacts c
                            WHERE c.id = customer_documents.contact_id
                              AND public.can_view_contact(c.account_id, c.id, c.user_id))
                   OR (customer_documents.conversation_id IS NOT NULL
                       AND public.coordinator_share_grants(customer_documents.conversation_id)))
                  AND (customer_documents.conversation_id IS NULL
                       OR public.customer_document_chat_visible(customer_documents.conversation_id)))));
