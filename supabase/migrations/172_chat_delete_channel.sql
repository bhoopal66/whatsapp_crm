-- ============================================================
-- 172_chat_delete_channel.sql — delete a team chat channel for good.
--
-- The product rule, fixed in SQL like 168 and deliberately not in 157's
-- permission matrix (its 12 capabilities are pinned to a CHECK):
--
--   * a live owner / admin deletes any team or private channel showing
--     in their app (chat_user_can_read_channel: a private channel they
--     are not a member of is not, and chat_admin_read_private is a read,
--     not a way in);
--   * a team leader or coordinator (168's: a live agent with a
--     coordinator_banks row) deletes the ones they created and can read;
--   * a plain agent, a viewer and a bank guest never, even as creator;
--   * a DM or deal room never: a deal room owns its channel
--     (deal_rooms.channel_id is NOT NULL).
--
-- An archived channel is deletable. With internal_chat_enabled off the
-- writer raises CH001 like every other chat write. There is no default
-- channel: nothing provisions one and none has to survive.
--
-- The audit log. chat_audit_log.channel_id had a NO ACTION FK to
-- chat_channels, so a channel with any audit row could not be deleted.
-- ON DELETE SET NULL would have the delete UPDATE rows of an append-only
-- table, which needs its guard weakened and loses which channel each row
-- was about. So the FK is dropped and the column becomes a plain uuid,
-- as push_outbox's is: no audit row is ever rewritten or removed, the
-- guard is untouched, and earlier rows keep naming the channel by id.
-- Only SECURITY DEFINER functions write this table, each from a channel
-- row it has just read, so the FK was guarding nothing else. The
-- delete_channel row carries the name and kind the id can no longer
-- answer, and counts, never message text.
--
-- Edit history stays append-only: chat_delete_channel uses the existing
-- chat.erase door, which also needs the table owner, so the function is
-- given internal_message_edits' owner below (a new function otherwise
-- belongs to whoever applied this file).
--
-- Files are not touched here. With no attachment row an object is
-- unreadable at once (chat_storage_can_read) and the chat_orphan_files
-- sweep removes it once it is 24 hours old.
--
-- Must be applied by a superuser or BYPASSRLS role, like 087 and 157-160.
-- Re-runnable; no BEGIN/COMMIT. Nothing is granted to service_role
-- (verify-internal-chat-admin.sql pins that list).
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '172 must be applied by a superuser or BYPASSRLS role (the chat functions own RLS-forced tables)';
  END IF;
END $$;

-- ---------- Audit actions (160's list plus delete_channel) ----------

-- Re-runnable without loss: re-running an older file on a newer
-- database must not narrow the list, so the constraint is replaced only
-- when it does not already name every action below. 157-160 skip their
-- own recreation on this superset for the same reason.
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
       AND pg_get_constraintdef(c.oid) LIKE '%''export_channel''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''delete_channel''%') THEN
    ALTER TABLE public.chat_audit_log DROP CONSTRAINT IF EXISTS chat_audit_log_action_check;
    ALTER TABLE public.chat_audit_log ADD CONSTRAINT chat_audit_log_action_check CHECK (action IN (
      'admin_read_private','erase_person','add_members','set_member_role',
      'update_channel','archive_channel','unarchive_channel','remove_member',
      'set_permissions','update_settings','update_policy','update_sensitive_guard',
      'set_audience','moderate_delete','restrict_member','export_channel',
      'delete_channel'));
  END IF;
END $$;

-- ---------- The audit log outlives the channel (see the header) ----------

ALTER TABLE public.chat_audit_log DROP CONSTRAINT IF EXISTS chat_audit_log_channel_id_fkey;
COMMENT ON COLUMN public.chat_audit_log.channel_id IS
  'The channel the row is about. Plain uuid, no FK since 172: the log outlives a deleted channel.';

-- ---------- Who may delete ----------

CREATE OR REPLACE FUNCTION public.chat_can_delete_channel(p_channel uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT c.kind IN ('team','private')
       AND a.internal_chat_enabled
       AND public.chat_user_can_read_channel(c.id, auth.uid(), true)
       AND (r.class IN ('owner','admin')
            OR (c.created_by = auth.uid()
                AND (r.class = 'team_leader'
                     OR (r.class = 'agent'
                         AND EXISTS (SELECT 1 FROM public.coordinator_banks cb
                                      WHERE cb.account_id = c.account_id
                                        AND cb.user_id = auth.uid())))))
      FROM public.chat_channels c
      JOIN public.accounts a ON a.id = c.account_id
      JOIN LATERAL (SELECT public.chat_role_class(c.account_id, auth.uid()) AS class) r ON r.class IS NOT NULL
     WHERE c.id = p_channel), false)
$$;

-- ---------- The delete ----------

CREATE OR REPLACE FUNCTION public.chat_delete_channel(p_channel uuid, p_confirm_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_ch      public.chat_channels;
  v_ids     uuid[];
  v_members integer;
  v_files   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'chat_delete_channel: no authenticated user' USING ERRCODE = '42501';
  END IF;
  -- An insert's FK check takes KEY SHARE on the channel row, which this
  -- lock blocks: a post in flight either committed first and is deleted
  -- below, or waits and then fails on the FK.
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = p_channel FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat_delete_channel: channel not found' USING ERRCODE = 'P0002';
  END IF;
  IF public.chat_role_class(v_ch.account_id, v_uid) IS NULL THEN
    RAISE EXCEPTION 'chat_delete_channel: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = v_ch.account_id) THEN
    RAISE EXCEPTION 'chat_delete_channel: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  IF NOT public.chat_can_delete_channel(p_channel) THEN
    RAISE EXCEPTION 'chat_delete_channel: you may not delete this channel' USING ERRCODE = '42501';
  END IF;
  IF p_confirm_name IS DISTINCT FROM v_ch.name THEN
    RAISE EXCEPTION 'chat_delete_channel: the confirmation does not match the channel name' USING ERRCODE = '22023';
  END IF;

  -- The same for a message's dependants: a reaction, pin or save landing
  -- between its table's delete and the messages' would fail this whole
  -- transaction on the FK. Locked, it waits and fails on its own.
  SELECT coalesce(array_agg(x.id), '{}') INTO v_ids
    FROM (SELECT m.id FROM public.internal_messages m WHERE m.channel_id = p_channel FOR UPDATE) x;
  SELECT count(*) INTO v_members FROM public.chat_channel_members WHERE channel_id = p_channel;
  SELECT count(*) INTO v_files FROM public.message_attachments WHERE message_id = ANY (v_ids);

  -- First, as 160's export does. Counts only: no message text.
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, channel_id, detail)
  VALUES (v_ch.account_id, v_uid, 'delete_channel', p_channel,
          jsonb_build_object('name', v_ch.name, 'kind', v_ch.kind,
                             'messages', cardinality(v_ids), 'members', v_members,
                             'attachments', v_files));

  DELETE FROM public.shared_calls WHERE message_id = ANY (v_ids);
  DELETE FROM public.shared_conversations WHERE message_id = ANY (v_ids);
  DELETE FROM public.message_attachments WHERE message_id = ANY (v_ids);
  DELETE FROM public.chat_voice_plays WHERE message_id = ANY (v_ids);
  DELETE FROM public.saved_messages WHERE message_id = ANY (v_ids);
  DELETE FROM public.internal_message_reactions WHERE message_id = ANY (v_ids);
  DELETE FROM public.message_mentions WHERE message_id = ANY (v_ids);
  DELETE FROM public.message_mentions_broadcast WHERE message_id = ANY (v_ids);
  DELETE FROM public.chat_notifications WHERE message_id = ANY (v_ids);
  DELETE FROM public.message_pins WHERE channel_id = p_channel OR message_id = ANY (v_ids);

  PERFORM set_config('chat.erase', 'on', true);
  DELETE FROM public.internal_message_edits WHERE message_id = ANY (v_ids);
  PERFORM set_config('chat.erase', 'off', true);

  -- One statement: thread_root_id and reply_to_id are NO ACTION FKs,
  -- checked at its end, and 156 keeps both inside the channel.
  DELETE FROM public.internal_messages WHERE channel_id = p_channel;

  DELETE FROM public.chat_typing WHERE channel_id = p_channel;
  DELETE FROM public.chat_channel_restrictions WHERE channel_id = p_channel;
  DELETE FROM public.chat_channel_teams WHERE channel_id = p_channel;
  DELETE FROM public.chat_channel_members WHERE channel_id = p_channel;

  -- No FK reaches these two (087's bell meta, 109's "a row whose channel
  -- is gone is skipped"), but both quote the messages.
  DELETE FROM public.notifications
   WHERE account_id = v_ch.account_id
     AND type IN ('chat_mention','chat_dm','chat_thread_reply','chat_broadcast')
     AND meta->>'channel_id' = p_channel::text;
  DELETE FROM public.push_outbox
   WHERE account_id = v_ch.account_id AND kind = 'chat_message'
     AND (channel_id = p_channel OR message_id = ANY (v_ids));

  DELETE FROM public.chat_channels WHERE id = p_channel;
END $$;

-- chat_append_only_guard opens edit history to the table owner only.
-- The check goes with it: the delete runs as that owner, and the check
-- is revoked from PUBLIC, so it must be the owner's to call.
DO $$
DECLARE v_owner name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner FROM pg_class c
   WHERE c.oid = 'public.internal_message_edits'::regclass;
  EXECUTE format('ALTER FUNCTION public.chat_can_delete_channel(uuid) OWNER TO %I', v_owner);
  EXECUTE format('ALTER FUNCTION public.chat_delete_channel(uuid, text) OWNER TO %I', v_owner);
END $$;

REVOKE ALL ON FUNCTION public.chat_can_delete_channel(uuid),
  public.chat_delete_channel(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_can_delete_channel(uuid),
  public.chat_delete_channel(uuid, text)
  TO authenticated;
