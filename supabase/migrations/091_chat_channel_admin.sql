-- 091_chat_channel_admin.sql — team chat (module 014b): channel administration
--
-- 087 created the columns but nothing wrote them: chat_channels.topic
-- was set only at creation, archived_at was only read (every write
-- refuses an archived channel), and chat_channel_members.muted was
-- never read or written. This adds the four functions the plan's
-- channel settings need, called by the browser like the rest of 087:
--
--  * chat_update_channel(p_channel, p_name, p_topic): rename and/or
--    re-topic a team or private channel. NULL keeps a field, a blank
--    topic clears it. The name is trimmed, and the table enforces the
--    rest exactly as at creation: 1-80 characters and a topic of at
--    most 250 (23514), unique per workspace among live team and private
--    channels, ignoring case (23505, chat_channels_name_uq).
--  * chat_archive_channel(p_channel, p_archived): archive (087's guards
--    then refuse posts, edits, reactions, pins, uploads, system posts,
--    adds and role changes) or unarchive. An unarchive whose name a live
--    channel took meanwhile is 23505 from the same unique index.
--  * chat_remove_member(p_channel, p_user): remove someone else (leaving
--    is chat_leave_channel), never the last channel admin. Out of a
--    private channel, read access ends at once and the person's bell
--    rows for it go too.
--  * chat_set_muted(p_channel, p_muted): the caller's own membership, on
--    any kind of channel (DMs and deal rooms included), bank guests too.
--    Not audited.
--
-- Who manages (the first three, chat_assert_can_manage_channel): team
-- and private channels only (DMs are fixed sets, deal rooms belong to
-- 088's functions); a channel admin, or a workspace owner/admin who, in
-- a private channel, must be a member (D-B1: nobody acts on a private
-- channel from outside it; a non-member owner/admin reads it only
-- through the audited chat_admin_read_private). A current role of
-- bank_guest is a guest everywhere, whatever the membership row says.
-- All three are audited (update_channel, archive_channel,
-- unarchive_channel, remove_member) and refuse an archived channel,
-- except to unarchive it.
--
-- Mute: a muted member's channel rings only for a direct @mention. No
-- chat_notifications row, so no bell, for @channel / @here (broadcast),
-- a thread reply, or a message in a muted DM. That is a BEFORE INSERT
-- filter on chat_notifications rather than a copy of chat_post_message:
-- the post writes one row per recipient, mention first, so the filter
-- sees exactly the kind that would ring. chat_unread_counts gains a
-- `muted` column and still counts a muted channel's unread;
-- chat_workspace_badges leaves a muted channel's plain unread out of the
-- rail total and keeps its mentions.
--
-- Like 087, this must be applied by a superuser or BYPASSRLS role: the
-- new SECURITY DEFINER functions write RLS-forced tables that have no
-- write policy, so owned by any other role every write would be refused.
--
-- Re-runnable: every statement is guarded or replaces in place.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '091 must be applied by a superuser or BYPASSRLS role (the chat functions own RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Audit actions ----------

ALTER TABLE public.chat_audit_log DROP CONSTRAINT IF EXISTS chat_audit_log_action_check;
ALTER TABLE public.chat_audit_log ADD CONSTRAINT chat_audit_log_action_check CHECK (action IN (
  'admin_read_private','erase_person','add_members','set_member_role',
  'update_channel','archive_channel','unarchive_channel','remove_member'));

-- ---------- 2. Who manages a channel ----------

-- Gate of chat_update_channel, chat_archive_channel and
-- chat_remove_member. Returns the channel, locked (serialises the
-- last-admin check). p_fn prefixes the errors; p_archived_ok lets
-- through the one write an archived channel takes, its unarchive.
CREATE OR REPLACE FUNCTION public.chat_assert_can_manage_channel(p_fn text, p_channel uuid, p_archived_ok boolean)
RETURNS public.chat_channels LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_ch   public.chat_channels;
  v_role text;
  v_my   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '%: no authenticated user', p_fn USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%: channel not found', p_fn USING ERRCODE = 'P0002';
  END IF;
  v_role := public.chat_ws_role(v_ch.account_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION '%: not a member of this workspace', p_fn USING ERRCODE = '42501';
  END IF;
  IF v_ch.kind NOT IN ('team','private') THEN
    RAISE EXCEPTION '%: only team and private channels (DMs are fixed sets; deal rooms are managed from the deal)', p_fn
      USING ERRCODE = '22023';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION '%: internal chat is disabled for this workspace', p_fn USING ERRCODE = 'CH001';
  END IF;
  IF v_ch.archived_at IS NOT NULL AND NOT p_archived_ok THEN
    RAISE EXCEPTION '%: channel is archived', p_fn USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' THEN
    RAISE EXCEPTION '%: bank guests cannot manage channels', p_fn USING ERRCODE = '42501';
  END IF;
  SELECT cm.role INTO v_my FROM public.chat_channel_members cm WHERE cm.channel_id = p_channel AND cm.user_id = v_uid;
  IF v_ch.kind = 'private' AND v_my IS NULL THEN
    RAISE EXCEPTION '%: not a member of this channel (owner/admin: use chat_admin_read_private to read a private channel)', p_fn
      USING ERRCODE = '42501';
  END IF;
  IF v_my IS DISTINCT FROM 'admin' AND v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION '%: only channel admins or workspace owner/admin can manage a channel', p_fn USING ERRCODE = '42501';
  END IF;
  RETURN v_ch;
END $$;

-- ---------- 3. API functions ----------

-- NULL keeps a field; a blank topic clears it. No change, no audit row.
CREATE OR REPLACE FUNCTION public.chat_update_channel(p_channel uuid, p_name text, p_topic text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ch    public.chat_channels;
  v_name  text;
  v_topic text;
BEGIN
  v_ch := public.chat_assert_can_manage_channel('chat_update_channel', p_channel, false);
  v_name := coalesce(btrim(p_name), v_ch.name);
  v_topic := CASE WHEN p_topic IS NULL THEN v_ch.topic WHEN btrim(p_topic) = '' THEN NULL ELSE p_topic END;
  IF v_name = v_ch.name AND v_topic IS NOT DISTINCT FROM v_ch.topic THEN
    RETURN;
  END IF;
  -- Length and uniqueness are the table's, as at creation: a bad name
  -- or topic is 23514 (chat_channels_name_check / _topic_check), a name
  -- another live team or private channel has is 23505
  -- (chat_channels_name_uq), which the client maps to duplicateName.
  UPDATE public.chat_channels SET name = v_name, topic = v_topic WHERE id = p_channel;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, auth.uid(), 'update_channel', p_channel,
          jsonb_build_object('from', v_ch.name, 'to', v_name, 'topic_from', v_ch.topic, 'topic_to', v_topic));
END $$;

-- Archive (p_archived = true) or unarchive. Already there: no change,
-- no audit row.
CREATE OR REPLACE FUNCTION public.chat_archive_channel(p_channel uuid, p_archived boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ch public.chat_channels;
BEGIN
  v_ch := public.chat_assert_can_manage_channel('chat_archive_channel', p_channel, true);
  IF p_archived IS NULL THEN
    RAISE EXCEPTION 'chat_archive_channel: archived must be true or false' USING ERRCODE = '22023';
  END IF;
  IF p_archived = (v_ch.archived_at IS NOT NULL) THEN
    RETURN;
  END IF;
  -- An unarchive puts the name back under chat_channels_name_uq: if a
  -- live channel took it meanwhile this is 23505 and nothing changes.
  -- The archived channel cannot be renamed, so the other one must be.
  UPDATE public.chat_channels SET archived_at = CASE WHEN p_archived THEN now() END WHERE id = p_channel;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, auth.uid(), CASE WHEN p_archived THEN 'archive_channel' ELSE 'unarchive_channel' END,
          p_channel, jsonb_build_object('name', v_ch.name));
END $$;

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

-- The caller's own mute switch, on any channel they belong to and can
-- see (a deal room's guest member included). Personal state, like
-- chat_mark_read: not audited, and allowed on an archived channel.
CREATE OR REPLACE FUNCTION public.chat_set_muted(p_channel uuid, p_muted boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ch public.chat_channels;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'chat_set_muted: no authenticated user' USING ERRCODE = '42501';
  END IF;
  IF p_muted IS NULL THEN
    RAISE EXCEPTION 'chat_set_muted: muted must be true or false' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_set_muted: channel not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.chat_ws_role(v_ch.account_id) IS NULL THEN
    RAISE EXCEPTION 'chat_set_muted: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION 'chat_set_muted: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  UPDATE public.chat_channel_members SET muted = p_muted
   WHERE channel_id = p_channel AND user_id = auth.uid() AND public.chat_can_see_channel(p_channel);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_set_muted: not a member of this channel' USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------- 4. Mute and the bell ----------

-- A muted member rings only for a direct @mention. chat_post_message
-- writes one row per recipient, its kind chosen by precedence (mention
-- > dm > thread_reply > broadcast), so a muted member who is mentioned
-- arrives here as a mention and passes; any other kind is dropped
-- before chat_notification_to_bell sees it. Like the bell, a failure
-- here never blocks the post: it lets the row through.
CREATE OR REPLACE FUNCTION public.chat_notification_mute_filter()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind <> 'mention' AND EXISTS (
       SELECT 1 FROM public.internal_messages m
         JOIN public.chat_channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = NEW.user_id
        WHERE m.id = NEW.message_id AND cm.muted) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'chat: mute filter for message % failed: %', NEW.message_id, SQLERRM;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chat_notifications_mute_filter ON public.chat_notifications;
CREATE TRIGGER chat_notifications_mute_filter BEFORE INSERT ON public.chat_notifications
  FOR EACH ROW EXECUTE FUNCTION public.chat_notification_mute_filter();

-- ---------- 5. Unread ----------

-- 087's counts plus the caller's `muted`. The counts are unchanged: a
-- muted channel still shows its unread in the channel list. A new
-- return type cannot be replaced in place, hence the DROP; callers read
-- the columns by name, and chat_workspace_badges is recreated below.
DROP FUNCTION IF EXISTS public.chat_unread_counts(uuid);
CREATE FUNCTION public.chat_unread_counts(p_ws uuid)
RETURNS TABLE (channel_id uuid, unread integer, mentions integer, muted boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id,
    (SELECT count(*) FROM public.internal_messages m
      WHERE m.channel_id = c.id AND m.thread_root_id IS NULL
        AND m.author_id IS DISTINCT FROM auth.uid() AND m.deleted_at IS NULL AND m.erased_at IS NULL
        AND m.created_at > greatest(cm.last_read_at, cm.joined_at))::integer,
    (SELECT count(*) FROM public.internal_messages m
       JOIN public.message_mentions mm ON mm.message_id = m.id AND mm.user_id = auth.uid()
      WHERE m.channel_id = c.id
        AND m.author_id IS DISTINCT FROM auth.uid() AND m.deleted_at IS NULL AND m.erased_at IS NULL
        AND m.created_at > greatest(cm.last_read_at, cm.joined_at))::integer,
    cm.muted
    FROM public.chat_channel_members cm
    JOIN public.chat_channels c ON c.id = cm.channel_id
   WHERE cm.user_id = auth.uid() AND c.account_id = p_ws AND c.archived_at IS NULL
     AND public.chat_user_can_read_channel(c.id, auth.uid(), true)
   ORDER BY c.created_at, c.id
$$;

-- The workspace rail: a muted channel's plain unread stays out of the
-- total; its mentions still count.
CREATE OR REPLACE FUNCTION public.chat_workspace_badges()
RETURNS TABLE (account_id uuid, unread integer, mentions integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.account_id,
         coalesce(sum(u.unread) FILTER (WHERE NOT u.muted), 0)::integer,
         coalesce(sum(u.mentions), 0)::integer
    FROM public.profiles p
    LEFT JOIN LATERAL public.chat_unread_counts(p.account_id) u ON true
   WHERE p.user_id = auth.uid() AND p.deactivated_at IS NULL
   GROUP BY p.account_id
   ORDER BY p.account_id
$$;

-- ---------- 6. Privileges ----------
-- As 087: Supabase grants EXECUTE on new functions to PUBLIC, anon,
-- authenticated and service_role. Revoke everything, grant the minimum.

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('chat_assert_can_manage_channel','chat_update_channel','chat_archive_channel',
                'chat_remove_member','chat_set_muted','chat_notification_mute_filter',
                'chat_unread_counts','chat_workspace_badges')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;

-- authenticated: the client API. The gate and the trigger function stay
-- revoked.
GRANT EXECUTE ON FUNCTION
  public.chat_update_channel(uuid, text, text), public.chat_archive_channel(uuid, boolean),
  public.chat_remove_member(uuid, uuid), public.chat_set_muted(uuid, boolean),
  public.chat_unread_counts(uuid), public.chat_workspace_badges()
  TO authenticated;
