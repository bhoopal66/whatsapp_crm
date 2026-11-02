-- 165_security_lows.sql
--
-- Three low-severity authorisation gaps from the 2026-10-31 audit. No
-- table or constraint changes, so no refusal scan; every statement is
-- re-runnable. Apply after 160, as a superuser or BYPASSRLS role like
-- 156-160 (the chat functions below are 091's, 157's and 159's latest
-- bodies with the 165 lines added).
--
-- 1. chat_forward_message: a forwarded copy's storage object must have
--    the source file's size and the source object's stored mimetype.
--    Before, a person denied upload_files (but allowed send_voice, which
--    chat_storage_can_write also accepts) could upload any file and
--    "forward" it as a copy of a readable file by repeating its name,
--    mime and size fields.
-- 2. ai_insight_settings_guard: the interested-reply tag must be a tag
--    of the row's own workspace (147's composite FK already refuses
--    another workspace's tag; the guard now says so itself), and a
--    signed-in writer is stamped as updated_by.
-- 3. chat_set_member_role: changing a channel admin's role needs a
--    workspace owner or admin (unless it is your own), and a bank guest
--    is never promoted to channel admin. chat_remove_member (091) gets
--    the same rule, or removing a co-admin would sidestep it.
--
-- supabase/ci/verify-security-lows.sql asserts all three.

-- ---------- 1. chat_forward_message (157_chat_permissions.sql) ----------

CREATE OR REPLACE FUNCTION public.chat_forward_message(p_message uuid, p_channel uuid,
  p_attachments jsonb DEFAULT '[]'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_src public.internal_messages;
  v_ch  public.chat_channels;
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat: no authenticated user' USING ERRCODE = '42501';
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

  INSERT INTO public.internal_messages (channel_id, account_id, author_kind, author_id, body, meta)
  VALUES (p_channel, v_ch.account_id, 'user', v_uid,
          left(public.chat_render_mentions(v_src.body, v_src.account_id), 8000),
          jsonb_build_object('forwarded', jsonb_build_object(
            'message_id', v_src.id, 'author_id', v_src.author_id,
            'author_kind', v_src.author_kind, 'created_at', v_src.created_at)))
  RETURNING id INTO v_id;

  PERFORM public.chat_insert_attachments(v_ch, v_id, p_attachments);
  -- The copies must be the source's own files: each one matches a
  -- distinct attachment of the source on (name, mime, bytes, kind,
  -- duration_ms), so no more of them than the source has. Otherwise a
  -- forward would post any uploaded file without upload_files (157).
  IF EXISTS (
    SELECT 1
      FROM (SELECT a.name, a.mime, a.bytes, a.kind, a.duration_ms, count(*) AS n
              FROM public.message_attachments a WHERE a.message_id = v_id
             GROUP BY 1, 2, 3, 4, 5) f
      LEFT JOIN (SELECT a.name, a.mime, a.bytes, a.kind, a.duration_ms, count(*) AS n
                   FROM public.message_attachments a WHERE a.message_id = v_src.id
                  GROUP BY 1, 2, 3, 4, 5) s
        ON s.name = f.name AND s.mime = f.mime AND s.bytes = f.bytes AND s.kind = f.kind
       AND s.duration_ms IS NOT DISTINCT FROM f.duration_ms
     WHERE s.n IS NULL OR f.n > s.n) THEN
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
END $$;

REVOKE ALL ON FUNCTION public.chat_forward_message(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_forward_message(uuid, uuid, jsonb) TO authenticated;

-- ---------- 2. ai_insight_settings_guard (147_smart_insights.sql) ----------

-- Stamps updated_at (the settings PUT is version-checked on it) and
-- updated_by (a signed-in writer; a service-role write keeps what it
-- set), and refuses an interested-reply tag that is not a tag of this
-- workspace or is a sub-tag.
CREATE OR REPLACE FUNCTION public.ai_insight_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  new.updated_at := now();
  IF auth.uid() IS NOT NULL THEN
    new.updated_by := auth.uid();
  END IF;
  IF new.reply_interested_tag_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM chat_tags t
        WHERE t.id = new.reply_interested_tag_id
          AND t.account_id = new.account_id
     ) THEN
    RAISE EXCEPTION 'Interested replies can only be tagged with a chat tag of this workspace'
      USING ERRCODE = 'check_violation';
  END IF;
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

REVOKE ALL ON FUNCTION public.ai_insight_settings_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 3. chat_set_member_role (159_chat_restricted_channels.sql) ----------

CREATE OR REPLACE FUNCTION public.chat_set_member_role(p_channel uuid, p_user_id uuid, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_ch     public.chat_channels;
  v_role   text;
  v_target public.chat_channel_members;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat_set_member_role: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel FOR UPDATE;  -- serialise the last-admin check
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_set_member_role: channel not found' USING ERRCODE = 'P0002';
  END IF;
  v_role := public.chat_ws_role(v_ch.account_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'chat_set_member_role: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin','member') THEN
    RAISE EXCEPTION 'chat_set_member_role: role must be admin or member' USING ERRCODE = '22023';
  END IF;
  IF v_ch.kind IN ('dm','deal_room') THEN
    RAISE EXCEPTION 'chat_set_member_role: DM and deal room members have no settable roles' USING ERRCODE = '22023';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION 'chat_set_member_role: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  IF v_ch.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat_set_member_role: channel is archived' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' THEN
    RAISE EXCEPTION 'chat_set_member_role: bank guests cannot change roles' USING ERRCODE = '42501';
  END IF;
  IF v_ch.kind = 'private'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm
                      WHERE cm.channel_id = p_channel AND cm.user_id = v_uid AND cm.role = 'admin') THEN
    RAISE EXCEPTION 'chat_set_member_role: only channel admins can change roles in a private channel' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('owner','admin')
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm
                      WHERE cm.channel_id = p_channel AND cm.user_id = v_uid AND cm.role = 'admin') THEN
    RAISE EXCEPTION 'chat_set_member_role: only channel admins or workspace owner/admin can change roles' USING ERRCODE = '42501';
  END IF;
  -- 159: as chat_assert_can_manage_channel, a team channel's audience
  IF v_ch.kind = 'team' AND v_role NOT IN ('owner','admin')
     AND NOT public.chat_user_in_channel_audience(p_channel, v_uid) THEN
    RAISE EXCEPTION 'chat_set_member_role: outside this channel''s audience' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_target FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_set_member_role: user is not a member of this channel' USING ERRCODE = 'P0002';
  END IF;
  IF v_target.role = 'guest' THEN
    RAISE EXCEPTION 'chat_set_member_role: a guest''s role cannot be changed (guests are never admins)' USING ERRCODE = '22023';
  END IF;
  -- 165: a channel admin's role is changed only by a workspace owner or
  -- admin (or by that person themselves): otherwise one agent channel
  -- admin of a team channel could demote every other one and keep the
  -- channel. Mirrors chat_restrict_member (160).
  IF v_target.role = 'admin' AND p_user_id IS DISTINCT FROM v_uid
     AND v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_set_member_role: only a workspace owner or admin can change a channel admin''s role' USING ERRCODE = '42501';
  END IF;
  -- 165: a bank guest is never made a channel admin.
  IF p_role = 'admin' AND public.chat_user_role(v_ch.account_id, p_user_id) = 'bank_guest' THEN
    RAISE EXCEPTION 'chat_set_member_role: a bank guest cannot be a channel admin' USING ERRCODE = '22023';
  END IF;
  IF v_ch.kind = 'private' AND v_target.role = 'admin' AND p_role = 'member'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm2
                      WHERE cm2.channel_id = p_channel AND cm2.user_id <> p_user_id AND cm2.role = 'admin'
                        AND coalesce(public.chat_user_role(v_ch.account_id, cm2.user_id), 'bank_guest') <> 'bank_guest') THEN
    RAISE EXCEPTION 'chat_set_member_role: the last admin of a private channel cannot be demoted' USING ERRCODE = '22023';
  END IF;

  UPDATE public.chat_channel_members SET role = p_role WHERE channel_id = p_channel AND user_id = p_user_id;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, v_uid, 'set_member_role', p_channel,
          jsonb_build_object('user_id', p_user_id, 'from', v_target.role, 'to', p_role));
END $$;

REVOKE ALL ON FUNCTION public.chat_set_member_role(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_member_role(uuid, uuid, text) TO authenticated;

-- ---------- 3b. chat_remove_member (091_chat_channel_admin.sql) ----------

-- Remove another member (leaving is chat_leave_channel).
CREATE OR REPLACE FUNCTION public.chat_remove_member(p_channel uuid, p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ch     public.chat_channels;
  v_target public.chat_channel_members;
BEGIN
  v_ch := public.chat_assert_can_manage_channel('chat_remove_member', p_channel, false);
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'chat_remove_member: a user is required' USING ERRCODE = '22023';
  END IF;
  IF p_user = auth.uid() THEN
    RAISE EXCEPTION 'chat_remove_member: to leave a channel yourself use chat_leave_channel' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_target FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = p_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_remove_member: user is not a member of this channel' USING ERRCODE = 'P0002';
  END IF;
  -- 165: as chat_set_member_role, another channel admin is removed only
  -- by a workspace owner or admin; otherwise an agent channel admin
  -- could remove every co-admin and keep the channel.
  IF v_target.role = 'admin' AND p_user IS DISTINCT FROM auth.uid()
     AND public.chat_ws_role(v_ch.account_id) NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_remove_member: only a workspace owner or admin can remove a channel admin' USING ERRCODE = '42501';
  END IF;
  -- As chat_leave_channel: only a live non-guest admin counts as another.
  IF v_target.role = 'admin'
     AND NOT EXISTS (SELECT 1 FROM public.chat_channel_members cm2
                      WHERE cm2.channel_id = p_channel AND cm2.user_id <> p_user AND cm2.role = 'admin'
                        AND coalesce(public.chat_user_role(v_ch.account_id, cm2.user_id), 'bank_guest') <> 'bank_guest') THEN
    RAISE EXCEPTION 'chat_remove_member: the last admin of a channel cannot be removed' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = p_user;
  -- Read access ends with the row (chat_user_can_read_channel). Out of a
  -- private channel the person's bell rows for it go too: they quote
  -- messages the person may no longer read. A team channel stays
  -- readable to every staff member (and is rejoined by posting), so its
  -- bells stay.
  IF v_ch.kind = 'private' THEN
    DELETE FROM public.chat_notifications n USING public.internal_messages m
     WHERE n.message_id = m.id AND m.channel_id = p_channel AND n.user_id = p_user;
    DELETE FROM public.notifications
     WHERE account_id = v_ch.account_id AND user_id = p_user
       AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
       AND meta->>'channel_id' = p_channel::text;
  END IF;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, auth.uid(), 'remove_member', p_channel,
          jsonb_build_object('user_id', p_user, 'role', v_target.role));
END $$;

REVOKE ALL ON FUNCTION public.chat_remove_member(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_remove_member(uuid, uuid) TO authenticated;
