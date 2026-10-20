-- ============================================================
-- 130 — Coordinators: bank assignments and chats shared with them
--
-- A coordinator files a customer's application with a bank (through the
-- external submission / Compass app) and contacts the customer when the
-- bank needs something. Each bank has a coordinator; some work several
-- banks. A coordinator otherwise works exactly like an agent.
--
-- A coordinator is NOT a new account_role_enum value: every role CASE /
-- IN list across the migrations and the TS role ladder would have to be
-- re-created. A coordinator is a live staff profile (role agent or
-- team_leader) holding at least one bank assignment:
--
--  * coordinator_banks (account, auth user, case_banks code). Written
--    only by set_coordinator_banks(), a live owner/admin of the caller's
--    active account, which replaces a person's set in one statement
--    pair under the person's profile row lock. An empty array means no
--    longer a coordinator. Removing a bank does NOT delete that bank's
--    shares: the visibility predicate joins the assignment, so the
--    shares simply stop granting anything (and grant again if the bank
--    is given back while they are still open).
--
--  * conversation_coordinator_shares: an agent (or above) who can see a
--    chat shares it with a coordinator of one of the chat's banks. One
--    open share per (conversation, coordinator). It lasts until revoked
--    (revoke_conversation_share: the sharer, the coordinator, the chat's
--    owner / assignee or their team leader, or an admin). No expiry.
--    Sharing rings the coordinator's bell (type conversation_shared).
--
-- What a live share grants (coordinator_share_grants): the caller is
-- the share's coordinator, the share is open, the caller still holds
-- its bank, and the caller is live agent / team_leader staff of the
-- conversation's account, which is their ACTIVE account. Then:
--
--  * the conversation (conversations SELECT, through its own permissive
--    policy; conversation_events and message_reactions follow because
--    their policies sub-select conversations / messages under RLS);
--  * its messages (SELECT), and INSERT of the coordinator's own outbound
--    message (sender_type 'agent', sender_id = the caller) carrying the
--    conversation's own number (channel_id or send_channel_id) — never
--    UPDATE or DELETE;
--  * its contact, SELECT only (coordinator_share_grants_contact);
--  * team chat's conversation cards (chat_can_view_conversation).
--
-- Deliberately NOT granted: conversations UPDATE / DELETE (the agent
-- stays owner: no reassigning, tagging, closing or moving the thread),
-- the number itself (can_use_channel is unchanged, so the coordinator
-- cannot pin the chat, start chats on the number or stamp it on another
-- thread; set_conversation_send_channel still refuses them), and
-- everything else that reads can_view_conversation / can_view_contact:
-- can_view_contact is unchanged on purpose — extending it would also
-- hand a coordinator contact edit and delete, contact notes, tasks,
-- calls and recordings, journeys, deal rooms and CRM memory of the
-- customer, none of which "read and reply in the shared chat" needs.
-- So memory_can_read (129) and pbx_visible_contact_ids (113), its
-- mirrors, need no change. flow_runs, team activity (074), push (109,
-- 112) and tasks' can_link_task (085) keep their rules.
--
-- TS mirror: src/lib/auth/conversation-visibility.ts (sharedWithMe).
-- Asserted by supabase/ci/verify-coordinators.sql.
--
-- Like 122-128, apply as a superuser or a BYPASSRLS role: both tables
-- are RLS-forced and the SECURITY DEFINER functions read and write them
-- as their owner. Re-runnable.
-- ============================================================

-- ---------- 1. Bank assignments ----------

CREATE TABLE IF NOT EXISTS public.coordinator_banks (
  account_id uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bank_code  text        NOT NULL,
  created_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coordinator_banks_pkey PRIMARY KEY (account_id, user_id, bank_code),
  CONSTRAINT coordinator_banks_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_coordinator_banks_bank
  ON public.coordinator_banks (account_id, bank_code);

ALTER TABLE public.coordinator_banks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coordinator_banks FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.coordinator_banks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.coordinator_banks TO authenticated, service_role;

-- Members of the active account read; a bank guest has no active
-- account (current_account_id() is NULL) and reads nothing.
DROP POLICY IF EXISTS coordinator_banks_select ON public.coordinator_banks;
CREATE POLICY coordinator_banks_select ON public.coordinator_banks
  FOR SELECT
  USING (account_id = (SELECT public.current_account_id()));

COMMENT ON TABLE public.coordinator_banks IS
  'Which banks (case_banks) a coordinator works. A coordinator is a live agent / team_leader holding at least one row. Written only by set_coordinator_banks(). Migration 130.';

-- ---------- 2. Shares ----------

CREATE TABLE IF NOT EXISTS public.conversation_coordinator_shares (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id          uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id     uuid        NOT NULL,
  coordinator_user_id uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bank_code           text        NOT NULL,
  shared_by           uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  revoked_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT conversation_coordinator_shares_pkey PRIMARY KEY (id),
  CONSTRAINT conversation_coordinator_shares_conversation_fkey FOREIGN KEY (conversation_id, account_id)
    REFERENCES public.conversations (id, account_id) ON DELETE CASCADE,
  CONSTRAINT conversation_coordinator_shares_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code) ON DELETE CASCADE,
  CONSTRAINT conversation_coordinator_shares_revoked_check
    CHECK (revoked_at IS NOT NULL OR revoked_by IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_coordinator_shares_one_open
  ON public.conversation_coordinator_shares (conversation_id, coordinator_user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_coordinator_shares_coordinator
  ON public.conversation_coordinator_shares (coordinator_user_id, account_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.conversation_coordinator_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_coordinator_shares FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_coordinator_shares FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.conversation_coordinator_shares TO authenticated, service_role;

-- Readable by whoever can see the conversation: the sub-select runs
-- under conversations' own RLS, so this follows every rule there,
-- the coordinator's own share included.
DROP POLICY IF EXISTS conversation_coordinator_shares_select ON public.conversation_coordinator_shares;
CREATE POLICY conversation_coordinator_shares_select ON public.conversation_coordinator_shares
  FOR SELECT
  USING (
    account_id = (SELECT public.current_account_id())
    AND EXISTS (
      SELECT 1 FROM public.conversations c
       WHERE c.id = conversation_coordinator_shares.conversation_id
    )
  );

COMMENT ON TABLE public.conversation_coordinator_shares IS
  'A chat shared with a coordinator of one of its banks. Open until revoked; grants only while the coordinator still holds the bank and is live agent / team_leader staff (coordinator_share_grants). Written only by share_conversation_with_coordinator() / revoke_conversation_share(). Migration 130.';

-- ---------- 3. The grant predicate ----------

CREATE OR REPLACE FUNCTION public.coordinator_share_grants(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.conversation_coordinator_shares s
      JOIN public.coordinator_banks b
        ON b.account_id = s.account_id
       AND b.user_id = s.coordinator_user_id
       AND b.bank_code = s.bank_code
      JOIN public.profiles p
        ON p.user_id = s.coordinator_user_id
       AND p.account_id = s.account_id
     WHERE s.conversation_id = p_conversation_id
       AND s.coordinator_user_id = auth.uid()
       AND s.revoked_at IS NULL
       AND s.account_id = public.current_account_id()
       AND p.deactivated_at IS NULL
       AND p.account_role::text IN ('agent', 'team_leader')
  );
$$;

REVOKE ALL ON FUNCTION public.coordinator_share_grants(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coordinator_share_grants(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.coordinator_share_grants(uuid) IS
  'Does a live share give the caller this conversation? Open share to auth.uid(), bank still held (coordinator_banks), live agent / team_leader in the conversation''s account, which is the caller''s active account. OR''d into conversations / messages SELECT, messages INSERT and chat_can_view_conversation. TS mirror: conversation-visibility.ts sharedWithMe. Migration 130.';

CREATE OR REPLACE FUNCTION public.coordinator_share_grants_contact(p_contact_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
     WHERE c.contact_id = p_contact_id
       AND public.coordinator_share_grants(c.id)
  );
$$;

REVOKE ALL ON FUNCTION public.coordinator_share_grants_contact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coordinator_share_grants_contact(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.coordinator_share_grants_contact(uuid) IS
  'A contact one of whose conversations is shared with the caller (coordinator_share_grants). Read-only grant: contacts SELECT only, not can_view_contact. Migration 130.';

-- ---------- 4. Policies (permissive, added beside the existing ones) ----------

DROP POLICY IF EXISTS conversations_coordinator_select ON public.conversations;
CREATE POLICY conversations_coordinator_select ON public.conversations
  FOR SELECT
  USING (public.coordinator_share_grants(id));

DROP POLICY IF EXISTS messages_coordinator_select ON public.messages;
CREATE POLICY messages_coordinator_select ON public.messages
  FOR SELECT
  USING (public.coordinator_share_grants(conversation_id));

-- The coordinator's own reply, on the conversation's own number. The
-- send core inserts after the gateway call with the number it resolved
-- (the customer's last number, or the chat's pin), which is one of the
-- two columns; another number is refused.
DROP POLICY IF EXISTS messages_coordinator_insert ON public.messages;
CREATE POLICY messages_coordinator_insert ON public.messages
  FOR INSERT
  WITH CHECK (
    sender_type = 'agent'
    AND sender_id = auth.uid()
    AND public.coordinator_share_grants(conversation_id)
    AND EXISTS (
      SELECT 1 FROM public.conversations c
       WHERE c.id = messages.conversation_id
         AND messages.channel_id IS NOT NULL
         AND messages.channel_id IN (c.channel_id, c.send_channel_id)
    )
  );

DROP POLICY IF EXISTS contacts_coordinator_select ON public.contacts;
CREATE POLICY contacts_coordinator_select ON public.contacts
  FOR SELECT
  USING (public.coordinator_share_grants_contact(id));

-- 087's predicate for team chat's conversation cards, plus a share.
CREATE OR REPLACE FUNCTION public.chat_can_view_conversation(p_conversation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.conversations cv
     WHERE cv.id = p_conversation_id
       AND cv.account_id = public.current_account_id()
       AND (public.current_role_rank() >= 4
            OR public.can_view_conversation(cv.account_id, cv.user_id, cv.assigned_agent_id,
                                            cv.channel_id, cv.send_channel_id)
            OR public.coordinator_share_grants(cv.id)))
$$;

-- ---------- 5. The bell ----------
-- 114's list plus conversation_shared. A later type edits the list from here.
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
    'conversation_shared'
  ));

-- ---------- 6. Write RPCs ----------

CREATE OR REPLACE FUNCTION public.set_coordinator_banks(p_user_id uuid, p_bank_codes text[])
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct  uuid := public.current_account_id();
  v_codes text[];
  v_bad   text;
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can assign coordinator banks'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_bank_codes IS NULL THEN
    RAISE EXCEPTION 'A person and a list of banks are required' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_agg(DISTINCT c ORDER BY c), '{}')
    INTO v_codes
    FROM unnest(p_bank_codes) AS c
   WHERE c IS NOT NULL;

  -- One writer per person at a time (the row lock switch_account takes).
  PERFORM 1 FROM public.profiles p
    WHERE p.user_id = p_user_id AND p.account_id = v_acct
    FOR UPDATE;

  IF cardinality(v_codes) > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = p_user_id
         AND p.account_id = v_acct
         AND p.deactivated_at IS NULL
         AND p.account_role::text IN ('agent', 'team_leader')
    ) THEN
      RAISE EXCEPTION 'Only a live agent or team leader can be a coordinator'
        USING ERRCODE = '22023', HINT = 'not_eligible';
    END IF;

    SELECT c INTO v_bad
      FROM unnest(v_codes) AS c
     WHERE NOT EXISTS (SELECT 1 FROM public.case_banks b
                        WHERE b.account_id = v_acct AND b.code = c)
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'Unknown bank %', v_bad USING ERRCODE = '22023', HINT = 'unknown_bank';
    END IF;
  END IF;

  DELETE FROM public.coordinator_banks b
   WHERE b.account_id = v_acct
     AND b.user_id = p_user_id
     AND NOT (b.bank_code = ANY (v_codes));

  INSERT INTO public.coordinator_banks (account_id, user_id, bank_code, created_by)
  SELECT v_acct, p_user_id, c, auth.uid() FROM unnest(v_codes) AS c
  ON CONFLICT (account_id, user_id, bank_code) DO NOTHING;

  RETURN v_codes;
END;
$$;

REVOKE ALL ON FUNCTION public.set_coordinator_banks(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_coordinator_banks(uuid, text[]) TO authenticated;

COMMENT ON FUNCTION public.set_coordinator_banks(uuid, text[]) IS
  'Replace a person''s coordinator banks in the caller''s active account (owner/admin only). The person must be a live agent / team_leader unless the list is empty, which makes them no longer a coordinator. Returns the stored set. Migration 130.';

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
       OR public.can_view_conversation(v_conv.account_id, v_conv.user_id, v_conv.assigned_agent_id,
                                       v_conv.channel_id, v_conv.send_channel_id)) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
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

COMMENT ON FUNCTION public.share_conversation_with_coordinator(uuid, uuid, text) IS
  'Share a chat the caller can see (agent and up, by the normal rules, not by a share) with a live coordinator of that bank. Idempotent for an open share of the same bank; rings conversation_shared. Returns the share id. Migration 130.';

CREATE OR REPLACE FUNCTION public.revoke_conversation_share(p_share_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct  uuid := public.current_account_id();
  v_rank  int := public.current_role_rank();
  v_uid   uuid := auth.uid();
  v_share public.conversation_coordinator_shares%ROWTYPE;
  v_conv  public.conversations%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_acct IS NULL THEN
    RAISE EXCEPTION 'Share not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_share FROM public.conversation_coordinator_shares
   WHERE id = p_share_id AND account_id = v_acct
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Share not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_conv FROM public.conversations WHERE id = v_share.conversation_id;

  IF NOT (
       v_rank >= 4
       OR v_share.shared_by = v_uid
       OR v_share.coordinator_user_id = v_uid
       OR (v_rank >= 2
           AND public.can_view_conversation(v_conv.account_id, v_conv.user_id, v_conv.assigned_agent_id,
                                            v_conv.channel_id, v_conv.send_channel_id)
           AND (v_conv.user_id = v_uid
                OR v_conv.assigned_agent_id = v_uid
                OR (v_rank >= 3
                    AND (public.leads_teammate(v_acct, v_conv.user_id)
                         OR public.leads_teammate(v_acct, v_conv.assigned_agent_id)))))) THEN
    RAISE EXCEPTION 'You cannot revoke this share' USING ERRCODE = '42501';
  END IF;

  IF v_share.revoked_at IS NOT NULL THEN
    RETURN false;  -- already revoked
  END IF;

  UPDATE public.conversation_coordinator_shares
     SET revoked_at = now(), revoked_by = v_uid
   WHERE id = p_share_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_conversation_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_conversation_share(uuid) TO authenticated;

COMMENT ON FUNCTION public.revoke_conversation_share(uuid) IS
  'Revoke a share: its sharer, its coordinator, an admin/owner, or an agent+ who can see the chat and owns it, is assigned it, or leads its owner / assignee. True when it was open, false when already revoked. Migration 130.';

-- A conversation_shared push opens the shared chat, like conversation_assigned.
-- Restates 109's push_bell_url with that one type added; change it together
-- with hrefFor in src/lib/notifications/target.ts.
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
    WHEN n.type IN ('conversation_assigned', 'ai_handoff', 'conversation_shared') THEN
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
