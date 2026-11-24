-- ============================================================
-- 276_chat_post_once.sql — a team chat post whose answer was lost is
-- posted once
--
-- A post reached the database and its answer did not reach the browser (a
-- tunnel drop, a laptop gone to sleep): the composer showed an error and
-- kept the draft, and Send posted it again with a second bell for
-- everyone, or, with files, was refused ("already belongs to a message").
-- The client now names each post (internal_messages.client_id, p_client_id)
-- and chat_post_message answers a repeat with the message it made first.
-- Every repeat is a person pressing Send: when that message has been
-- deleted or erased meanwhile, the repeat is an ordinary post.
--
-- The argument is last and optional: chat_share_call's positional call,
-- and a browser still on the previous build, work as before. Exactly one
-- chat_post_message may exist (PostgREST, and every positional call), so
-- every other one is dropped in the statement that creates this one. That
-- statement refuses when the column or its index is missing, so a plain
-- `psql -f` that went on after an error leaves the function as it was.
--
-- Nothing here refuses itself on existing data. Safe to run twice. Apply
-- after 157. Re-applying 087, 156 or 157 brings their chat_post_message
-- back beside this one (posts then fail as ambiguous): re-apply this file
-- after them.
-- ============================================================

ALTER TABLE public.internal_messages ADD COLUMN IF NOT EXISTS client_id uuid;
COMMENT ON COLUMN public.internal_messages.client_id IS
  '276: the id the author''s browser gave this post, so that a repeat of it is answered with this message';
CREATE UNIQUE INDEX IF NOT EXISTS internal_messages_client_id_key
  ON public.internal_messages (author_id, client_id) WHERE client_id IS NOT NULL;

-- chat_post_message (157_chat_permissions.sql): p_client_id.
DO $do$
DECLARE
  v_old regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.internal_messages'::regclass
                    AND attname = 'client_id' AND NOT attisdropped)
     OR to_regclass('public.internal_messages_client_id_key') IS NULL THEN
    RAISE EXCEPTION '276: internal_messages.client_id or its index is missing; chat_post_message is left as it was';
  END IF;
  FOR v_old IN SELECT p.oid FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'chat_post_message' LOOP
    EXECUTE format('DROP FUNCTION %s', v_old);
  END LOOP;
  EXECUTE $fn$
CREATE FUNCTION public.chat_post_message(
  p_channel uuid, p_body text, p_thread_root uuid DEFAULT NULL, p_share_conversation uuid DEFAULT NULL,
  p_attachments jsonb DEFAULT '[]'::jsonb, p_reply_to uuid DEFAULT NULL,
  p_client_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$
DECLARE
  v_uid       uuid := auth.uid();
  v_ch        public.chat_channels;
  v_id        uuid;
  v_broadcast boolean := false;
  v_channel   uuid;
  v_gone      boolean;
BEGIN
  -- 276: a repeat of a post that went through answers the same message,
  -- before any rule: they were judged when it was posted, and what they
  -- say by now must not tell the author their posted message failed.
  -- One deleted or erased since gives its id up, and the repeat is posted,
  -- by the rules as they are. A concurrent repeat waits for this UPDATE,
  -- then finds the new message at the insert below.
  SELECT m.id, m.channel_id, m.deleted_at IS NOT NULL OR m.erased_at IS NOT NULL
    INTO v_id, v_channel, v_gone FROM public.internal_messages m
   WHERE m.author_id = v_uid AND m.client_id = p_client_id;
  IF FOUND THEN
    IF v_channel <> p_channel THEN
      RAISE EXCEPTION 'chat_post_message: this client id was used in another channel' USING ERRCODE = '22023';
    END IF;
    IF NOT v_gone THEN
      RETURN v_id;
    END IF;
    UPDATE public.internal_messages SET client_id = NULL WHERE id = v_id AND client_id = p_client_id;
  END IF;

  v_ch := public.chat_assert_can_write(p_channel, true);

  IF p_share_conversation IS NOT NULL
     AND (NOT public.chat_can_view_conversation(p_share_conversation)
          OR NOT EXISTS (SELECT 1 FROM public.conversations cv
                          WHERE cv.id = p_share_conversation AND cv.account_id = v_ch.account_id)) THEN
    RAISE EXCEPTION 'chat_post_message: you cannot share this conversation' USING ERRCODE = '42501';
  END IF;
  -- A card is customer data and bank guests never see the inbox: no
  -- share into a channel with a guest member (role guest, or a current
  -- account role of bank_guest). Reads re-check access anyway.
  IF p_share_conversation IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.chat_channel_members cm
                  WHERE cm.channel_id = p_channel
                    AND (cm.role = 'guest'
                         OR public.chat_user_role(v_ch.account_id, cm.user_id) = 'bank_guest')) THEN
    RAISE EXCEPTION 'chat_post_message: a conversation cannot be shared into a channel with a bank guest'
      USING ERRCODE = '42501';
  END IF;

  -- 157: the channel's posting / thread rule, then the role matrix.
  -- @channel / @here is the regex message_mentions_broadcast uses below.
  PERFORM public.chat_assert_post_rules(v_ch, p_thread_root);
  IF p_body ~* '(?:^|[^[:alnum:]_])@(channel|here)(?![[:alnum:]_])' THEN
    PERFORM public.chat_assert_permission(v_ch.account_id, 'mention_everyone');
    IF v_ch.mention_everyone = 'admins' AND NOT public.chat_is_channel_admin(v_ch.id, v_ch.account_id, v_uid) THEN
      RAISE EXCEPTION 'chat: you may not notify everyone in this channel (only channel admins can)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF jsonb_typeof(p_attachments) = 'array' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_attachments) a
                WHERE jsonb_typeof(a) = 'object' AND coalesce(a->>'kind', 'file') = 'file') THEN
      PERFORM public.chat_assert_permission(v_ch.account_id, 'upload_files');
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_attachments) a
                WHERE jsonb_typeof(a) = 'object' AND a->>'kind' = 'voice') THEN
      PERFORM public.chat_assert_permission(v_ch.account_id, 'send_voice');
    END IF;
  END IF;
  IF p_share_conversation IS NOT NULL THEN
    PERFORM public.chat_assert_permission(v_ch.account_id, 'share_cards');
  END IF;

  LOOP
    INSERT INTO public.internal_messages (channel_id, account_id, thread_root_id, author_kind, author_id, body, reply_to_id, client_id)
    VALUES (p_channel, v_ch.account_id, p_thread_root, 'user', v_uid, p_body, p_reply_to, p_client_id)
    ON CONFLICT (author_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_id;
    EXIT WHEN v_id IS NOT NULL;
    -- 276: the first attempt was still under way at the look-up above (the
    -- insert waited for it): its message, its files and its bells stand,
    -- unless it is deleted or erased by now. Not found: another repeat
    -- has just freed the id.
    SELECT m.id, m.channel_id, m.deleted_at IS NOT NULL OR m.erased_at IS NOT NULL
      INTO v_id, v_channel, v_gone FROM public.internal_messages m
     WHERE m.author_id = v_uid AND m.client_id = p_client_id;
    CONTINUE WHEN NOT FOUND;
    IF v_channel <> p_channel THEN
      RAISE EXCEPTION 'chat_post_message: this client id was used in another channel' USING ERRCODE = '22023';
    END IF;
    IF NOT v_gone THEN
      RETURN v_id;
    END IF;
    UPDATE public.internal_messages SET client_id = NULL WHERE id = v_id AND client_id = p_client_id;
  END LOOP;

  -- validates every attachment; a refusal rolls the message back with it
  PERFORM public.chat_insert_attachments(v_ch, v_id, p_attachments);

  -- <@uuid> mentions; anyone who cannot read the channel's messages is dropped
  INSERT INTO public.message_mentions (message_id, user_id)
  SELECT DISTINCT v_id, (t[1])::uuid
    FROM regexp_matches(p_body, '<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>', 'g') t
   WHERE public.chat_user_can_read_channel(p_channel, (t[1])::uuid, true)
  ON CONFLICT DO NOTHING;

  -- @channel / @here (no presence check: both notify every channel member)
  INSERT INTO public.message_mentions_broadcast (message_id, kind)
  SELECT DISTINCT v_id, lower(t[1])
    FROM regexp_matches(p_body, '(?:^|[^[:alnum:]_])@(channel|here)(?![[:alnum:]_])', 'gi') t
  ON CONFLICT DO NOTHING;
  v_broadcast := FOUND;

  -- one notification per recipient; precedence mention > dm > thread_reply > broadcast
  INSERT INTO public.chat_notifications (user_id, account_id, message_id, kind)
  SELECT DISTINCT ON (r.uid) r.uid, v_ch.account_id, v_id, r.kind
    FROM (
      SELECT mm.user_id AS uid, 'mention'::text AS kind, 1 AS prio
        FROM public.message_mentions mm WHERE mm.message_id = v_id
      UNION ALL
      SELECT cm.user_id, 'dm', 2
        FROM public.chat_channel_members cm WHERE v_ch.kind = 'dm' AND cm.channel_id = p_channel
      UNION ALL
      SELECT x.author_id, 'thread_reply', 3
        FROM public.internal_messages x
       WHERE p_thread_root IS NOT NULL AND x.author_id IS NOT NULL
         AND (x.id = p_thread_root OR (x.thread_root_id = p_thread_root AND x.id <> v_id))
      UNION ALL
      SELECT cm.user_id, 'broadcast', 4
        FROM public.chat_channel_members cm WHERE v_broadcast AND cm.channel_id = p_channel
    ) r
   WHERE r.uid <> v_uid AND public.chat_user_can_read_channel(p_channel, r.uid, true)
   ORDER BY r.uid, r.prio;

  IF p_share_conversation IS NOT NULL THEN
    INSERT INTO public.shared_conversations (message_id, conversation_id, shared_by, snapshot)
    VALUES (v_id, p_share_conversation, v_uid, public.chat_conversation_snapshot(p_share_conversation));
  END IF;
  RETURN v_id;
END $body$
  $fn$;
  -- 156's grants: the browser's signed-in user only.
  REVOKE ALL ON FUNCTION public.chat_post_message(uuid, text, uuid, uuid, jsonb, uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.chat_post_message(uuid, text, uuid, uuid, jsonb, uuid, uuid) TO authenticated;
END $do$;

NOTIFY pgrst, 'reload schema';
