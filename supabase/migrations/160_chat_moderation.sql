-- 160: team chat moderation (087 family): removing someone else's
-- message needs a reason and is audited, posting timeouts, and an
-- audited channel export.
--
--   A. Moderation. internal_messages.deleted_by records who removed a
--      message; the structural guard (chat_message_before_update, 156)
--      lets it be set only in the update that sets deleted_at from NULL,
--      and never changes it afterwards. chat_delete_message gains
--      p_reason (DEFAULT NULL, so 1-argument calls keep working):
--        * the author's own message: 157's rules (delete_own and the
--          delete window), no reason;
--        * someone else's: a live workspace owner / admin (any channel),
--          or a channel admin (chat_channel_members.role 'admin', never a
--          bank guest) of a team or private channel. It needs a reason of
--          5..500 non-blank characters and writes chat_audit_log
--          'moderate_delete' {message_id, author_id, reason}.
--        * a system post (NULL author): still only a workspace owner /
--          admin, as before 160, now with a reason; a channel admin never.
--      Every delete stamps deleted_by = the caller. Behaviour change: an
--      owner / admin deleting someone else's message without a reason is
--      now refused (22023, 'a reason is required').
--   B. Posting timeouts. chat_channel_members.post_blocked_until; set by
--      chat_restrict_member (team / private channels, behind 091's
--      chat_assert_can_manage_channel, audited 'restrict_member'). A
--      workspace owner / admin is never restricted, a channel admin who
--      is not a workspace owner / admin restricts only plain members, and
--      a timeout is at most 30 days. chat_assert_can_write refuses a
--      caller whose row is blocked (42501, 'restricted from posting'), so
--      posting, replies, edits, reactions, pins, forwards, call cards,
--      typing and uploads (chat_storage_can_write calls it) all stop.
--      Reading and marking read are untouched.
--   C. chat_export_channel: a live workspace owner / admin exports any
--      channel (members or not, every kind), reason required, at most
--      10000 messages. The audit row 'export_channel' is written in the
--      same call that returns the data, before it is built.
--
-- Must be applied by a superuser or BYPASSRLS role, like 087 and 091.
-- Re-runnable; no BEGIN/COMMIT. Nothing is granted to service_role
-- (verify-internal-chat-admin.sql pins that list).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '160 must be applied by a superuser or BYPASSRLS role (the chat functions own RLS-forced tables)';
  END IF;
END $$;

-- ---------- D. Audit actions (the same union as 159) ----------

-- Re-runnable without loss: re-running an older file on a newer
-- database must not narrow the list, so the constraint is replaced only
-- when it does not already name every action below.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.chat_audit_log'::regclass
       AND c.conname = 'chat_audit_log_action_check'
       AND pg_get_constraintdef(c.oid) LIKE '%''admin_read_private''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''erase_person''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''add_members''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''set_member_role''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''update_channel''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''archive_channel''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''unarchive_channel''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''remove_member''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''set_permissions''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''update_settings''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''update_policy''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''update_sensitive_guard''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''set_audience''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''moderate_delete''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''restrict_member''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''export_channel''%') THEN
    ALTER TABLE public.chat_audit_log DROP CONSTRAINT IF EXISTS chat_audit_log_action_check;
    ALTER TABLE public.chat_audit_log ADD CONSTRAINT chat_audit_log_action_check CHECK (action IN (
      'admin_read_private','erase_person','add_members','set_member_role',
      'update_channel','archive_channel','unarchive_channel','remove_member',
      'set_permissions','update_settings','update_policy','update_sensitive_guard',
      'set_audience','moderate_delete','restrict_member','export_channel'));
  END IF;
END $$;

-- ---------- Columns ----------

ALTER TABLE public.internal_messages ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.chat_channel_members ADD COLUMN IF NOT EXISTS post_blocked_until timestamptz;

-- ---------- Reason helper (internal) ----------
-- A moderation reason: 5..500 characters once trimmed, at least 5 of them
-- non-blank. Returns the trimmed reason. The client maps the phrase
-- 'a reason is required'.
CREATE OR REPLACE FUNCTION public.chat_assert_reason(p_fn text, p_reason text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_reason IS NULL OR p_reason ~ '^[[:space:]]*$'
     OR char_length(regexp_replace(p_reason, '[[:space:]]', '', 'g')) < 5
     OR char_length(btrim(p_reason, E' \t\r\n')) > 500 THEN
    RAISE EXCEPTION '%: a reason is required (5 to 500 characters)', p_fn USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p_reason, E' \t\r\n');
END $$;

-- ---------- A. Structural guard (156_chat_messaging_v2.sql + deleted_by) ----------
CREATE OR REPLACE FUNCTION public.chat_message_before_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.channel_id <> OLD.channel_id OR NEW.account_id <> OLD.account_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.author_kind <> OLD.author_kind
     OR NEW.created_at <> OLD.created_at
     OR NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id
     OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id THEN
    RAISE EXCEPTION 'internal_messages: structural columns are immutable' USING ERRCODE = '42501';
  END IF;
  -- 160: deleted_by is set once, together with deleted_at.
  IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
     AND NOT (OLD.deleted_by IS NULL AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'internal_messages: deleted_by is set only when the message is deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body AND NEW.erased_at IS NULL THEN
    INSERT INTO public.internal_message_edits (message_id, previous_body, edited_at, edited_by)
    VALUES (OLD.id, OLD.body, now(), coalesce(auth.uid(), OLD.author_id));
    IF NEW.deleted_at IS NULL THEN
      NEW.edited_at := now();
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------- A. chat_delete_message (157_chat_permissions.sql + moderation) ----------
DROP FUNCTION IF EXISTS public.chat_delete_message(uuid);
CREATE OR REPLACE FUNCTION public.chat_delete_message(p_message uuid, p_reason text DEFAULT NULL)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_msg    public.internal_messages;
  v_ch     public.chat_channels;
  v_role   text;
  v_own    boolean;
  v_mod    boolean;
  v_reason text;
  v_paths  text[];
BEGIN
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = p_message FOR UPDATE;
  IF NOT FOUND OR NOT public.chat_can_read_channel(v_msg.channel_id) THEN
    RAISE EXCEPTION 'chat_delete_message: message not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = v_msg.channel_id;
  v_role := coalesce(public.chat_ws_role(v_msg.account_id), '');
  v_own := v_uid IS NOT NULL AND v_msg.author_id IS NOT DISTINCT FROM v_uid;
  -- 160: someone else's message: a workspace owner / admin anywhere, or a
  -- channel admin (not a bank guest) of a team or private channel for a
  -- person's post; system posts stay with the workspace owner / admin.
  v_mod := NOT v_own AND v_uid IS NOT NULL AND (
    v_role IN ('owner','admin')
    OR (v_msg.author_kind = 'user' AND v_role NOT IN ('', 'bank_guest')
        AND v_ch.kind IN ('team','private')
        AND EXISTS (SELECT 1 FROM public.chat_channel_members cm
                     WHERE cm.channel_id = v_msg.channel_id AND cm.user_id = v_uid AND cm.role = 'admin')));
  IF NOT v_own AND NOT v_mod THEN
    RAISE EXCEPTION 'chat_delete_message: only the author or a workspace owner/admin can delete (or a channel admin, in a team or private channel)'
      USING ERRCODE = '42501';
  END IF;
  IF v_msg.deleted_at IS NOT NULL THEN
    RETURN '{}';
  END IF;
  IF v_own THEN
    -- 157: an author deleting their own message needs delete_own and the
    -- delete window.
    PERFORM public.chat_assert_permission(v_msg.account_id, 'delete_own');
    PERFORM public.chat_assert_window(v_msg, 'delete');
  ELSE
    v_reason := public.chat_assert_reason('chat_delete_message', p_reason);
    INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
    VALUES (v_msg.account_id, v_uid, 'moderate_delete', v_msg.channel_id,
            jsonb_build_object('message_id', v_msg.id, 'author_id', v_msg.author_id, 'reason', v_reason));
  END IF;
  UPDATE public.internal_messages SET body = '', deleted_at = now(), deleted_by = v_uid WHERE id = p_message;
  WITH d AS (DELETE FROM public.message_attachments WHERE message_id = p_message RETURNING storage_path)
  SELECT coalesce(array_agg(storage_path ORDER BY storage_path), '{}') INTO v_paths FROM d;
  DELETE FROM public.shared_conversations WHERE message_id = p_message;
  DELETE FROM public.message_mentions WHERE message_id = p_message;
  DELETE FROM public.message_mentions_broadcast WHERE message_id = p_message;
  DELETE FROM public.notifications
   WHERE account_id = v_msg.account_id
     AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
     AND meta->>'message_id' = p_message::text;
  RETURN v_paths;
END $$;

-- ---------- B. chat_assert_can_write (143_chat_dm_rules.sql + posting timeouts) ----------
CREATE OR REPLACE FUNCTION public.chat_assert_can_write(p_channel uuid, p_autojoin boolean)
RETURNS public.chat_channels LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_ch    public.chat_channels;
  v_role  text;
  v_until timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat: no authenticated user' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat: channel not found' USING ERRCODE = 'P0002';
  END IF;
  v_role := public.chat_ws_role(v_ch.account_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'chat: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION 'chat: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  IF v_ch.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'chat: channel is archived' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' AND v_ch.kind <> 'private' THEN
    -- guests post in private channels only (never a deal room's Team notes)
    RAISE EXCEPTION 'chat: not a member of this channel' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_channel_members WHERE channel_id = p_channel AND user_id = v_uid) THEN
    IF v_ch.kind = 'team' AND v_role <> 'bank_guest' THEN
      IF p_autojoin THEN
        INSERT INTO public.chat_channel_members (channel_id, user_id, role) VALUES (p_channel, v_uid, 'member')
        ON CONFLICT DO NOTHING;
      END IF;
    ELSE
      RAISE EXCEPTION 'chat: not a member of this channel' USING ERRCODE = '42501';
    END IF;
  END IF;
  -- 143: the src/lib/chat error mapper keys on this phrase
  IF v_ch.kind = 'dm' AND NOT public.chat_dm_user_allowed(p_channel, v_uid) THEN
    RAISE EXCEPTION 'chat: direct messages between these people are turned off' USING ERRCODE = '42501';
  END IF;
  -- 160: a posting timeout (chat_restrict_member); the client keys on
  -- 'restricted from posting'.
  SELECT cm.post_blocked_until INTO v_until FROM public.chat_channel_members cm
   WHERE cm.channel_id = p_channel AND cm.user_id = v_uid;
  IF v_until IS NOT NULL AND v_until > now() THEN
    RAISE EXCEPTION 'chat: you are restricted from posting in this channel until %', v_until USING ERRCODE = '42501';
  END IF;
  RETURN v_ch;
END $$;

-- ---------- B. chat_restrict_member ----------
CREATE OR REPLACE FUNCTION public.chat_restrict_member(p_channel uuid, p_user uuid, p_until timestamptz, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_ch     public.chat_channels;
  v_my     text;
  v_target text;
  v_trole  text;
  v_reason text;
BEGIN
  -- 091's gate: team / private only (22023), live staff, channel admin or
  -- workspace owner / admin, not archived.
  v_ch := public.chat_assert_can_manage_channel('chat_restrict_member', p_channel, false);
  v_my := public.chat_ws_role(v_ch.account_id);
  IF p_user IS NULL OR p_user = v_uid THEN
    RAISE EXCEPTION 'chat_restrict_member: you cannot restrict yourself' USING ERRCODE = '22023';
  END IF;
  v_target := public.chat_user_role(v_ch.account_id, p_user);
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'chat_restrict_member: not a member of this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF v_target IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_restrict_member: a workspace owner or admin cannot be restricted' USING ERRCODE = '42501';
  END IF;
  SELECT cm.role INTO v_trole FROM public.chat_channel_members cm
   WHERE cm.channel_id = p_channel AND cm.user_id = p_user FOR UPDATE;
  IF v_trole IS NULL AND (v_ch.kind <> 'team' OR v_target = 'bank_guest') THEN
    RAISE EXCEPTION 'chat_restrict_member: not a member of this channel' USING ERRCODE = 'P0002';
  END IF;
  IF v_trole = 'admin' AND v_my NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_restrict_member: only a workspace owner or admin can restrict a channel admin' USING ERRCODE = '42501';
  END IF;
  IF p_until IS NOT NULL THEN
    IF p_until <= now() OR p_until > now() + interval '30 days' THEN
      RAISE EXCEPTION 'chat_restrict_member: the end must be in the future and at most 30 days ahead' USING ERRCODE = '22023';
    END IF;
    v_reason := public.chat_assert_reason('chat_restrict_member', p_reason);
  ELSIF p_reason IS NOT NULL AND p_reason !~ '^[[:space:]]*$' THEN
    v_reason := left(btrim(p_reason, E' \t\r\n'), 500);
  END IF;
  IF v_trole IS NULL THEN
    IF p_until IS NULL THEN
      RETURN;  -- nothing to clear: no row means not restricted
    END IF;
    -- a team channel: a row (role member) holds the restriction
    INSERT INTO public.chat_channel_members (channel_id, user_id, role, post_blocked_until)
    VALUES (p_channel, p_user, 'member', p_until)
    ON CONFLICT (channel_id, user_id) DO UPDATE SET post_blocked_until = EXCLUDED.post_blocked_until;
  ELSE
    UPDATE public.chat_channel_members SET post_blocked_until = p_until
     WHERE channel_id = p_channel AND user_id = p_user;
  END IF;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, v_uid, 'restrict_member', p_channel,
          jsonb_build_object('user_id', p_user, 'until', p_until, 'reason', v_reason));
END $$;

-- ---------- C. chat_export_channel ----------
CREATE OR REPLACE FUNCTION public.chat_export_channel(p_channel uuid, p_from timestamptz, p_to timestamptz, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_limit  constant integer := 10000;
  v_uid    uuid := auth.uid();
  v_ch     public.chat_channels;
  v_reason text;
  v_total  bigint;
  v_trunc  boolean;
  v_msgs   jsonb;
BEGIN
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_export_channel: channel not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL OR coalesce(public.chat_ws_role(v_ch.account_id), '') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_export_channel: owner or admin role required' USING ERRCODE = '42501';
  END IF;
  v_reason := public.chat_assert_reason('chat_export_channel', p_reason);
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'chat_export_channel: the start must not be after the end' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_total FROM public.internal_messages m
   WHERE m.channel_id = p_channel
     AND (p_from IS NULL OR m.created_at >= p_from)
     AND (p_to IS NULL OR m.created_at <= p_to);
  v_trunc := v_total > c_limit;
  -- The audit row first: if it cannot be written, nothing is returned.
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, v_uid, 'export_channel', p_channel,
          jsonb_build_object('from', p_from, 'to', p_to, 'reason', v_reason,
                             'count', least(v_total, c_limit), 'truncated', v_trunc));
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'thread_root_id', m.thread_root_id, 'reply_to_id', m.reply_to_id,
           'author_kind', m.author_kind, 'author_id', m.author_id,
           'author_name', (SELECT p.full_name FROM public.profiles p
                            WHERE p.user_id = m.author_id AND p.account_id = m.account_id),
           'body', CASE WHEN m.erased_at IS NOT NULL THEN '[erased]'
                        WHEN m.deleted_at IS NOT NULL THEN ''
                        ELSE public.chat_render_mentions(m.body, m.account_id) END,
           'created_at', m.created_at, 'edited_at', m.edited_at, 'deleted_at', m.deleted_at,
           'deleted_by', m.deleted_by, 'erased_at', m.erased_at,
           'attachments', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                    'name', a.name, 'mime', a.mime, 'bytes', a.bytes,
                                    'kind', a.kind, 'duration_ms', a.duration_ms) ORDER BY a.name, a.id), '[]'::jsonb)
                             FROM public.message_attachments a WHERE a.message_id = m.id))
           ORDER BY m.created_at, m.id), '[]'::jsonb)
    INTO v_msgs
    FROM (SELECT * FROM public.internal_messages im
           WHERE im.channel_id = p_channel
             AND (p_from IS NULL OR im.created_at >= p_from)
             AND (p_to IS NULL OR im.created_at <= p_to)
           ORDER BY im.created_at, im.id
           LIMIT c_limit) m;
  RETURN jsonb_build_object(
    'channel', jsonb_build_object('id', v_ch.id, 'kind', v_ch.kind, 'name', v_ch.name, 'topic', v_ch.topic),
    'messages', v_msgs,
    'truncated', v_trunc);
END $$;

-- ---------- Grants ----------
REVOKE ALL ON FUNCTION public.chat_assert_reason(text, text),
  public.chat_delete_message(uuid, text),
  public.chat_restrict_member(uuid, uuid, timestamptz, text),
  public.chat_export_channel(uuid, timestamptz, timestamptz, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_delete_message(uuid, text),
  public.chat_restrict_member(uuid, uuid, timestamptz, text),
  public.chat_export_channel(uuid, timestamptz, timestamptz, text)
  TO authenticated;
