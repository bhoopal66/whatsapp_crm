-- ============================================================
-- 307_chat_forward_once.sql — team chat: a forward goes once and whole,
-- bells end with the read access, file names are guarded
--
-- 1. A forward whose answer was lost was made again by the retry: the
--    message and its files twice, two bells. chat_forward_message takes
--    276's client id (the same unique key and race handling) and answers
--    a repeat with the copy it made first. chat_share_call likewise: its
--    post and card doubled the same way, and the call panel retries it by
--    itself.
--
--    The id is a fourth, REQUIRED argument of a function of its own, and
--    the old three-argument signature stays beside it (it calls the new
--    one without an id). So a call naming three arguments fits only the
--    old one, a call naming four only the new one, and PostgREST and
--    every positional call see one candidate each. Re-applying an earlier
--    file gives the old signature its old body back, never an ambiguity.
-- 2. A forward that carried fewer files than its source was accepted.
-- 3. chat_edit_message rewrote the bell of somebody who had left the
--    channel since; chat_leave_channel left the leaver's unread bells.
-- 4. chat_sensitive_guard (158) reads the body, which lists the file names
--    only when the message has no text. chat_insert_attachments scans each
--    name; both ask chat_assert_not_sensitive.
-- 5. chat_mark_read (087) moved a read mark back.
--
-- The functions are the catalog's bodies with the marked lines changed;
-- search_path and grants are unchanged. Nothing here refuses itself on
-- existing data. Needs 276. Re-applying 087-165, 273, 277 or 289 undoes
-- parts of it: apply in order. Safe to run twice, as a superuser or
-- BYPASSRLS role. supabase/ci/verify-chat-forward-once.sql asserts it.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '307 must be applied by a superuser or BYPASSRLS role (the chat functions own RLS-forced tables)';
  END IF;
  IF to_regclass('public.internal_messages_client_id_key') IS NULL THEN
    RAISE EXCEPTION '307: apply 276 first (internal_messages.client_id)';
  END IF;
END $$;

-- ---------- 1 and 2. A forward, and a shared call, once ----------

CREATE OR REPLACE FUNCTION public.chat_forward_message(p_message uuid, p_channel uuid, p_attachments jsonb, p_client_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_src public.internal_messages;
  v_ch  public.chat_channels;
  v_id  uuid;
  v_channel uuid;
  v_of      text;
  v_gone    boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat: no authenticated user' USING ERRCODE = '42501';
  END IF;
  -- 307: a repeat of a forward that went through answers the copy made
  -- first, before any rule (as 276 does for a post); one deleted or
  -- erased since gives its id up and the repeat is a new forward.
  SELECT m.id, m.channel_id, m.meta->'forwarded'->>'message_id', m.deleted_at IS NOT NULL OR m.erased_at IS NOT NULL
    INTO v_id, v_channel, v_of, v_gone FROM public.internal_messages m
   WHERE m.author_id = v_uid AND m.client_id = p_client_id;
  IF FOUND THEN
    IF v_channel <> p_channel OR (NOT v_gone AND v_of IS DISTINCT FROM p_message::text) THEN
      RAISE EXCEPTION 'chat_forward_message: this client id was used for another message or channel' USING ERRCODE = '22023';
    END IF;
    IF NOT v_gone THEN
      RETURN v_id;
    END IF;
    UPDATE public.internal_messages SET client_id = NULL WHERE id = v_id AND client_id = p_client_id;
  END IF;

  SELECT * INTO v_src FROM public.internal_messages WHERE id = p_message;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_src.channel_id) THEN
    RAISE EXCEPTION 'chat_forward_message: message not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_src.deleted_at IS NOT NULL OR v_src.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_forward_message: a deleted message cannot be forwarded' USING ERRCODE = '22023';
  END IF;

  v_ch := public.chat_assert_can_write(p_channel, true);
  IF v_ch.account_id <> v_src.account_id THEN
    RAISE EXCEPTION 'chat_forward_message: a message can only be forwarded within its workspace'
      USING ERRCODE = '42501';
  END IF;
  -- 157: a forward is a top-level post; its copied attachments need no upload_files.
  PERFORM public.chat_assert_permission(v_ch.account_id, 'forward_messages');
  PERFORM public.chat_assert_post_rules(v_ch, NULL);

  LOOP
    INSERT INTO public.internal_messages (channel_id, account_id, author_kind, author_id, body, meta, client_id)
    VALUES (p_channel, v_ch.account_id, 'user', v_uid,
            left(public.chat_render_mentions(v_src.body, v_src.account_id), 8000),
            jsonb_build_object('forwarded', jsonb_build_object(
              'message_id', v_src.id, 'author_id', v_src.author_id,
              'author_kind', v_src.author_kind, 'created_at', v_src.created_at)), p_client_id)
    ON CONFLICT (author_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_id;
    EXIT WHEN v_id IS NOT NULL;
    -- 307: the first attempt was still under way at the look-up above
    -- (the insert waited for it). Not found: another repeat has just
    -- freed the id.
    SELECT m.id, m.channel_id, m.meta->'forwarded'->>'message_id', m.deleted_at IS NOT NULL OR m.erased_at IS NOT NULL
      INTO v_id, v_channel, v_of, v_gone FROM public.internal_messages m
     WHERE m.author_id = v_uid AND m.client_id = p_client_id;
    CONTINUE WHEN NOT FOUND;
    IF v_channel <> p_channel OR (NOT v_gone AND v_of IS DISTINCT FROM p_message::text) THEN
      RAISE EXCEPTION 'chat_forward_message: this client id was used for another message or channel' USING ERRCODE = '22023';
    END IF;
    IF NOT v_gone THEN
      RETURN v_id;
    END IF;
    UPDATE public.internal_messages SET client_id = NULL WHERE id = v_id AND client_id = p_client_id;
  END LOOP;

  PERFORM public.chat_insert_attachments(v_ch, v_id, p_attachments);
  -- The copies must be the source's own files, every one of them (307:
  -- a missing one was let through): the same multiset of (name, mime,
  -- bytes, kind, duration_ms; EXCEPT ALL counts NULLs as equal).
  -- Otherwise a forward would post any uploaded file without upload_files
  -- (157), or part of a message as the whole. Who may read the message
  -- may read all its attachments, so nothing is left out here.
  IF EXISTS (
    (SELECT a.name, a.mime, a.bytes, a.kind, a.duration_ms FROM public.message_attachments a WHERE a.message_id = v_id
     EXCEPT ALL
     SELECT a.name, a.mime, a.bytes, a.kind, a.duration_ms FROM public.message_attachments a WHERE a.message_id = v_src.id)
    UNION ALL
    (SELECT a.name, a.mime, a.bytes, a.kind, a.duration_ms FROM public.message_attachments a WHERE a.message_id = v_src.id
     EXCEPT ALL
     SELECT a.name, a.mime, a.bytes, a.kind, a.duration_ms FROM public.message_attachments a WHERE a.message_id = v_id)) THEN
    RAISE EXCEPTION 'chat_forward_message: attachments must be copies of the source message''s attachments'
      USING ERRCODE = '22023';
  END IF;
  -- 165: the caller's attachment fields prove nothing on their own, and
  -- chat_storage_can_write lets send_voice alone upload any object. So
  -- each copy's stored object must have the size of the source file it
  -- copies and the same stored mimetype as that file's object (object to
  -- object, so a legacy row with an un-normalised mime still forwards).
  -- An object with no metadata is refused.
  IF EXISTS (
    SELECT 1
      FROM public.message_attachments f
      LEFT JOIN storage.objects fo ON fo.bucket_id = 'chat-files' AND fo.name = f.storage_path
     WHERE f.message_id = v_id
       AND NOT EXISTS (
         SELECT 1
           FROM public.message_attachments s
           JOIN storage.objects so ON so.bucket_id = 'chat-files' AND so.name = s.storage_path
          WHERE s.message_id = v_src.id
            AND s.name = f.name AND s.mime = f.mime AND s.bytes = f.bytes AND s.kind = f.kind
            AND s.duration_ms IS NOT DISTINCT FROM f.duration_ms
            AND fo.metadata IS NOT NULL
            AND CASE WHEN fo.metadata->>'size' ~ '^[0-9]{1,18}$'
                     THEN (fo.metadata->>'size')::bigint END = s.bytes
            AND fo.metadata->>'mimetype' = so.metadata->>'mimetype')) THEN
    RAISE EXCEPTION 'chat_forward_message: a forwarded file''s stored object does not match the source file it copies'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.chat_notifications (user_id, account_id, message_id, kind)
  SELECT cm.user_id, v_ch.account_id, v_id, 'dm'
    FROM public.chat_channel_members cm
   WHERE v_ch.kind = 'dm' AND cm.channel_id = p_channel AND cm.user_id <> v_uid
     AND public.chat_user_can_read_channel(p_channel, cm.user_id, true);
  RETURN v_id;
END $function$;
REVOKE ALL ON FUNCTION public.chat_forward_message(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_forward_message(uuid, uuid, jsonb, uuid) TO authenticated;

-- The signature without an id, for a browser still on the previous build.
CREATE OR REPLACE FUNCTION public.chat_forward_message(p_message uuid, p_channel uuid, p_attachments jsonb DEFAULT '[]'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN public.chat_forward_message(p_message, p_channel, p_attachments, NULL::uuid);
END $function$;
REVOKE ALL ON FUNCTION public.chat_forward_message(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_forward_message(uuid, uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_share_call(p_channel uuid, p_call uuid, p_body text, p_client_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ch   public.chat_channels;
  v_call public.calls;
  v_id   uuid;
  v_channel uuid;
  v_of      uuid;
BEGIN
  -- 307: a repeat of a share that went through answers the card posted
  -- first, before any rule. One deleted or erased since is posted again
  -- (chat_post_message takes its id back).
  SELECT m.id, m.channel_id, sc.call_id INTO v_id, v_channel, v_of
    FROM public.internal_messages m LEFT JOIN public.shared_calls sc ON sc.message_id = m.id
   WHERE m.author_id = auth.uid() AND m.client_id = p_client_id
     AND m.deleted_at IS NULL AND m.erased_at IS NULL;
  IF FOUND THEN
    IF v_channel <> p_channel OR v_of IS DISTINCT FROM p_call THEN
      RAISE EXCEPTION 'chat_share_call: this client id was used for another message' USING ERRCODE = '22023';
    END IF;
    RETURN v_id;
  END IF;

  -- 087's write gate, without the team autojoin (chat_post_message
  -- joins below, once every check here has passed).
  v_ch := public.chat_assert_can_write(p_channel, false);

  SELECT * INTO v_call FROM public.calls WHERE id = p_call;
  IF NOT FOUND
     OR v_call.account_id IS DISTINCT FROM v_ch.account_id
     OR NOT public.pbx_can_view_call(v_call)
     OR v_call.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_share_call: you cannot share this call' USING ERRCODE = '42501';
  END IF;
  IF v_ch.kind <> 'deal_room'
     AND EXISTS (SELECT 1 FROM public.chat_channel_members cm
                  WHERE cm.channel_id = p_channel
                    AND (cm.role = 'guest'
                         OR public.chat_user_role(v_ch.account_id, cm.user_id) = 'bank_guest')) THEN
    RAISE EXCEPTION 'chat_share_call: a call cannot be shared into a channel with a bank guest'
      USING ERRCODE = '42501';
  END IF;
  -- 157: share_cards and the posting rule (chat_post_message below
  -- checks the rule again, and @channel in p_body).
  PERFORM public.chat_assert_permission(v_ch.account_id, 'share_cards');
  PERFORM public.chat_assert_post_rules(v_ch, NULL);

  v_id := public.chat_post_message(p_channel, p_body, NULL, NULL, '[]'::jsonb, NULL, p_client_id);
  INSERT INTO public.shared_calls (message_id, call_id, account_id, shared_by)
  VALUES (v_id, p_call, v_ch.account_id, auth.uid())
  -- 307: there already when a concurrent first attempt won.
  ON CONFLICT (message_id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.shared_calls sc WHERE sc.message_id = v_id AND sc.call_id = p_call) THEN
    RAISE EXCEPTION 'chat_share_call: this client id was used for another message' USING ERRCODE = '22023';
  END IF;
  RETURN v_id;
END $function$;
REVOKE ALL ON FUNCTION public.chat_share_call(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_share_call(uuid, uuid, text, uuid) TO authenticated;

-- The signature without an id, for a browser still on the previous build.
CREATE OR REPLACE FUNCTION public.chat_share_call(p_channel uuid, p_call uuid, p_body text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN public.chat_share_call(p_channel, p_call, p_body, NULL::uuid);
END $function$;
REVOKE ALL ON FUNCTION public.chat_share_call(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_share_call(uuid, uuid, text) TO authenticated;

-- ---------- 3. A bell ends with the read access ----------

CREATE OR REPLACE FUNCTION public.chat_edit_message(p_message uuid, p_body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_msg      public.internal_messages;
  v_mentions uuid[];
BEGIN
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = p_message FOR UPDATE;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_msg.channel_id) THEN
    RAISE EXCEPTION 'chat_edit_message: message not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_msg.author_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'chat_edit_message: only the author can edit' USING ERRCODE = '42501';
  END IF;
  IF v_msg.deleted_at IS NOT NULL OR v_msg.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_edit_message: message was deleted' USING ERRCODE = '42501';
  END IF;
  PERFORM public.chat_assert_can_write(v_msg.channel_id, false);
  -- 157: only the author edits, so edit_own and the edit window always apply.
  PERFORM public.chat_assert_permission(v_msg.account_id, 'edit_own');
  PERFORM public.chat_assert_window(v_msg, 'edit');
  UPDATE public.internal_messages SET body = p_body WHERE id = p_message;
  -- The bell rows keep a copy of the body: rebuild it from the new text,
  -- or a recipient keeps reading what was edited away (the edit history
  -- is owner/admin only).
  UPDATE public.notifications
     SET body = public.chat_bell_body(p_body, v_msg.account_id)
   WHERE account_id = v_msg.account_id
     AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
     AND meta->>'message_id' = p_message::text
     -- 307: not the bell of somebody who may no longer read the channel
     AND public.chat_user_can_read_channel(v_msg.channel_id, user_id, true);

  -- 277: the mentions are those of the new text, by chat_post_message's
  -- rules. @channel / @here are not recalculated: an edit notifies nobody
  -- but the people it names.
  SELECT coalesce(array_agg(DISTINCT (t[1])::uuid), '{}') INTO v_mentions
    FROM regexp_matches(p_body, '<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>', 'g') t;
  DELETE FROM public.message_mentions
   WHERE message_id = p_message AND user_id <> ALL (v_mentions);
  -- Only a mention this edit added rings, and nobody this message has
  -- already rung (as a mention, a DM, a thread reply or a broadcast).
  WITH added AS (
    INSERT INTO public.message_mentions (message_id, user_id)
    SELECT p_message, u FROM unnest(v_mentions) u
     WHERE public.chat_user_can_read_channel(v_msg.channel_id, u, true)
    ON CONFLICT DO NOTHING
    RETURNING user_id)
  INSERT INTO public.chat_notifications (user_id, account_id, message_id, kind)
  SELECT a.user_id, v_msg.account_id, p_message, 'mention'
    FROM added a WHERE a.user_id <> v_msg.author_id
  ON CONFLICT (user_id, message_id) DO NOTHING;
END $function$;

CREATE OR REPLACE FUNCTION public.chat_leave_channel(p_channel uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ch  public.chat_channels;
  v_me  public.chat_channel_members;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat_leave_channel: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel FOR UPDATE;  -- serialise the last-member checks
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_leave_channel: channel not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.chat_ws_role(v_ch.account_id) IS NULL THEN
    RAISE EXCEPTION 'chat_leave_channel: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_me FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_leave_channel: not a member of this channel' USING ERRCODE = '42501';
  END IF;
  -- 273: two people's DM stays with both. A leaver got no bell for what
  -- the other side wrote next, and could not see it.
  IF v_ch.kind = 'dm' AND cardinality(string_to_array(v_ch.dm_key, ',')) = 2 THEN
    RAISE EXCEPTION 'chat_leave_channel: a DM between two people cannot be left' USING ERRCODE = '22023';
  END IF;
  IF v_ch.kind = 'dm'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id <> v_uid) THEN
    RAISE EXCEPTION 'chat_leave_channel: the last member cannot leave a DM' USING ERRCODE = '22023';
  END IF;
  IF v_ch.kind IN ('private','deal_room') AND v_me.role = 'admin'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm2
                      WHERE cm2.channel_id = p_channel AND cm2.user_id <> v_uid AND cm2.role = 'admin'
                        AND coalesce(public.chat_user_role(v_ch.account_id, cm2.user_id), 'bank_guest') <> 'bank_guest') THEN
    RAISE EXCEPTION 'chat_leave_channel: the last admin of a private channel cannot leave' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = v_uid;
  -- 307: as chat_remove_member, read access ends with the row in a private
  -- channel or a group DM, so the leaver's unread bells for it go: they
  -- quote what the leaver may no longer read. A team channel stays readable.
  IF NOT public.chat_user_can_read_channel(p_channel, v_uid, true) THEN
    DELETE FROM public.chat_notifications n USING public.internal_messages m
     WHERE n.message_id = m.id AND m.channel_id = p_channel AND n.user_id = v_uid AND n.read_at IS NULL;
    DELETE FROM public.notifications
     WHERE account_id = v_ch.account_id AND user_id = v_uid AND read_at IS NULL
       AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
       AND meta->>'channel_id' = p_channel::text;
  END IF;
END $function$;

-- ---------- 4. The sensitive-data guard and file names ----------

-- chat_sensitive_guard's test (158), on any text of a message.
CREATE OR REPLACE FUNCTION public.chat_assert_not_sensitive(p_channel uuid, p_account uuid, p_text text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_mode  text;
  v_scope text;
  v_kinds text[];
BEGIN
  SELECT s.sensitive_mode, s.sensitive_scope INTO v_mode, v_scope
    FROM public.chat_workspace_settings s WHERE s.account_id = p_account;
  IF v_mode IS DISTINCT FROM 'block' THEN
    RETURN;
  END IF;
  -- 'guests': a channel with a bank guest member (102's test), never a
  -- deal room's Team notes, which guests cannot read.
  IF v_scope = 'guests' AND NOT EXISTS (
       SELECT 1 FROM public.chat_channels c
         JOIN public.chat_channel_members cm ON cm.channel_id = c.id
        WHERE c.id = p_channel AND c.kind <> 'deal_room'
          AND (cm.role = 'guest' OR public.chat_user_role(c.account_id, cm.user_id) = 'bank_guest')) THEN
    RETURN;
  END IF;
  -- A phone names its photos and recordings with the date and time, or the
  -- milliseconds since 1970: 13 to 17 digits that read as a card one time
  -- in ten. STAMP in src/lib/chat/composer-gating.ts is the same pattern.
  v_kinds := public.chat_sensitive_kinds(regexp_replace(p_text,
    '(?<![0-9])(?:20[0-9]{2}[-_. ]?(?:0[1-9]|1[0-2])[-_. ]?(?:0[1-9]|[12][0-9]|3[01])(?:[-_. T]|at)*(?:[01][0-9]|2[0-3])[-_.:h]?[0-5][0-9][-_.:m]?[0-5][0-9](?:[-_.]?[0-9]{1,3})?|1[5-9][0-9]{11})(?![0-9])',
    ';', 'g'));
  IF v_kinds <> '{}' THEN
    RAISE EXCEPTION 'chat: this message contains sensitive data (%) and this workspace blocks it %',
      array_to_string(v_kinds, ', '),
      CASE WHEN v_scope = 'all' THEN 'in team chat' ELSE 'in channels with bank guests' END
      USING ERRCODE = '42501';
  END IF;
END $function$;
REVOKE ALL ON FUNCTION public.chat_assert_not_sensitive(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.chat_sensitive_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.author_kind <> 'user' OR NEW.deleted_at IS NOT NULL OR NEW.erased_at IS NOT NULL
     OR (TG_OP = 'UPDATE' AND NEW.body IS NOT DISTINCT FROM OLD.body) THEN
    RETURN NEW;
  END IF;
  -- A mention is stored as <@uuid>; a uuid's digit groups can read as a
  -- Luhn-valid card, so mention tokens are taken out before the scan.
  PERFORM public.chat_assert_not_sensitive(NEW.channel_id, NEW.account_id, regexp_replace(NEW.body,
    '<@[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}>', ' ', 'g'));
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.chat_insert_attachments(p_ch chat_channels, p_message uuid, p_atts jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_atts   jsonb := coalesce(p_atts, '[]'::jsonb);
  v_att    jsonb;
  v_prefix text;
  v_kind   text;
  v_voice  integer := 0;
BEGIN
  IF jsonb_typeof(v_atts) <> 'array' OR jsonb_array_length(v_atts) > 10 THEN
    RAISE EXCEPTION 'chat: attachments must be an array of at most 10 items' USING ERRCODE = '22023';
  END IF;
  v_prefix := 'account-' || p_ch.account_id || '/channel-' || p_ch.id || '/';
  FOR v_att IN SELECT * FROM jsonb_array_elements(v_atts) LOOP
    IF jsonb_typeof(v_att) <> 'object'
       OR jsonb_typeof(v_att->'storage_path') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'mime') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_att->'bytes') IS DISTINCT FROM 'number'
       OR char_length(btrim(v_att->>'name')) NOT BETWEEN 1 AND 255
       OR (v_att->>'mime') ~ '^[[:space:]]*$'
       OR (v_att->>'bytes')::numeric NOT BETWEEN 0 AND 26214400
       OR (v_att->>'bytes')::numeric <> trunc((v_att->>'bytes')::numeric) THEN
      RAISE EXCEPTION 'chat: each attachment needs storage_path, name, mime and bytes (at most 25 MB)'
        USING ERRCODE = '22023';
    END IF;
    IF coalesce(jsonb_typeof(v_att->'kind'), 'null') NOT IN ('null','string')
       OR coalesce(v_att->>'kind', 'file') NOT IN ('file','voice') THEN
      RAISE EXCEPTION 'chat: attachment kind must be file or voice' USING ERRCODE = '22023';
    END IF;
    v_kind := coalesce(v_att->>'kind', 'file');
    IF coalesce(jsonb_typeof(v_att->'duration_ms'), 'null') NOT IN ('null','number')
       OR (jsonb_typeof(v_att->'duration_ms') = 'number'
           AND ((v_att->>'duration_ms')::numeric NOT BETWEEN 1 AND 1200000
                OR (v_att->>'duration_ms')::numeric <> trunc((v_att->>'duration_ms')::numeric))) THEN
      RAISE EXCEPTION 'chat: attachment duration_ms must be an integer of 1 to 1200000' USING ERRCODE = '22023';
    END IF;
    IF v_kind = 'voice' THEN
      IF jsonb_typeof(v_att->'duration_ms') IS DISTINCT FROM 'number'
         OR btrim(v_att->>'mime') NOT ILIKE 'audio/%' THEN
        RAISE EXCEPTION 'chat: a voice attachment needs an audio/* mime and duration_ms' USING ERRCODE = '22023';
      END IF;
      v_voice := v_voice + 1;
    END IF;
    IF left(v_att->>'storage_path', length(v_prefix)) <> v_prefix
       OR substr(v_att->>'storage_path', length(v_prefix) + 1)
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/]+$' THEN
      RAISE EXCEPTION 'chat: attachment path must be %<uuid>-<name>', v_prefix USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o
                    WHERE o.bucket_id = 'chat-files' AND o.name = v_att->>'storage_path') THEN
      RAISE EXCEPTION 'chat: attachment % was not uploaded', v_att->>'storage_path' USING ERRCODE = 'P0002';
    END IF;
    -- 289: the poster's own upload; an object with no owner is the server's.
    IF EXISTS (SELECT 1 FROM storage.objects o
                WHERE o.bucket_id = 'chat-files' AND o.name = v_att->>'storage_path'
                  AND coalesce(nullif(o.owner_id, ''), o.owner::text) IS NOT NULL
                  AND coalesce(nullif(o.owner_id, ''), o.owner::text) IS DISTINCT FROM auth.uid()::text) THEN
      RAISE EXCEPTION 'chat: attachment % was uploaded by someone else', v_att->>'storage_path' USING ERRCODE = '42501';
    END IF;
    -- One object, one attachment row: a path already attached (or named
    -- twice in this call) would let a post or forward re-publish a file
    -- the caller never uploaded, and a delete of one row would free an
    -- object another message still shows.
    IF EXISTS (SELECT 1 FROM public.message_attachments a WHERE a.storage_path = v_att->>'storage_path')
       OR (SELECT count(*) FROM jsonb_array_elements(v_atts) x
            WHERE x->>'storage_path' = v_att->>'storage_path') > 1 THEN
      RAISE EXCEPTION 'chat: attachment % already belongs to a message', v_att->>'storage_path'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF v_voice > 0 AND jsonb_array_length(v_atts) <> 1 THEN
    RAISE EXCEPTION 'chat: a voice attachment must be the message''s only attachment' USING ERRCODE = '22023';
  END IF;

  -- 307: the sensitive-data guard reads each file's name too (the body of
  -- a message without text already lists them).
  FOR v_att IN SELECT * FROM jsonb_array_elements(v_atts) LOOP
    PERFORM public.chat_assert_not_sensitive(p_ch.id, p_ch.account_id, v_att->>'name');
  END LOOP;

  INSERT INTO public.message_attachments (message_id, storage_path, name, mime, bytes, kind, duration_ms)
  SELECT p_message, a->>'storage_path', btrim(a->>'name'), btrim(a->>'mime'), (a->>'bytes')::bigint,
         coalesce(a->>'kind', 'file'), (a->>'duration_ms')::numeric::integer
    FROM jsonb_array_elements(v_atts) a;
END $function$;

-- ---------- 5. A read mark only moves forward ----------

-- 087's body: it stored the time it was given, so a slow tab's older mark
-- brought back what a newer one had cleared.
CREATE OR REPLACE FUNCTION public.chat_mark_read(p_channel uuid, p_at timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_at timestamptz := least(coalesce(p_at, now()), now());
BEGIN
  UPDATE public.chat_channel_members SET last_read_at = greatest(last_read_at, v_at)
   WHERE channel_id = p_channel AND user_id = auth.uid() AND public.chat_can_read_channel(p_channel);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_mark_read: not a member of this channel' USING ERRCODE = '42501';
  END IF;
  UPDATE public.chat_notifications n SET read_at = now()
    FROM public.internal_messages m
   WHERE n.message_id = m.id AND m.channel_id = p_channel
     AND n.user_id = auth.uid() AND n.read_at IS NULL AND m.created_at <= v_at;
END $$;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
