-- ============================================================
-- 273_team_chat_fixes.sql — team chat rules found missing by the
-- 2026-11-23 audit
--
--  1. A person could leave a DM between two people. The other side kept
--     writing into it as normal, and the leaver got no bell and no longer
--     saw the channel. chat_leave_channel refuses it, chat_open_dm brings
--     back every named member of an existing DM (it brought back only the
--     caller), and the member rows missing today are put back.
--
-- A DM of three or more people can still be left. Nothing here refuses
-- itself on existing data, so there is no scan before the DDL. Safe to
-- run twice. Apply after 157. Re-applying 087 brings back its
-- chat_leave_channel and chat_open_dm, and re-applying 143 or 157 its
-- chat_open_dm: re-apply this file after them.
-- ============================================================

-- ---------- 1. DMs nobody falls out of ----------

-- chat_leave_channel (087_internal_chat.sql): the two-person refusal.
CREATE OR REPLACE FUNCTION public.chat_leave_channel(p_channel uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- chat_open_dm (157_chat_permissions.sql): the reopen path.
CREATE OR REPLACE FUNCTION public.chat_open_dm(p_ws uuid, p_member_ids uuid[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_role    text := public.chat_ws_role(p_ws);
  v_members uuid[];
  v_key     text;
  v_id      uuid;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'chat_open_dm: not a member of this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'bank_guest' THEN
    RAISE EXCEPTION 'chat_open_dm: bank guests cannot open DMs' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT a.internal_chat_enabled FROM public.accounts a WHERE a.id = p_ws) THEN
    RAISE EXCEPTION 'chat_open_dm: internal chat is disabled for this workspace' USING ERRCODE = 'CH001';
  END IF;
  SELECT array_agg(DISTINCT m ORDER BY m) INTO v_members
    FROM unnest(array_append(coalesce(p_member_ids, '{}'), v_uid)) m WHERE m IS NOT NULL;
  IF cardinality(v_members) NOT BETWEEN 2 AND 8 THEN
    RAISE EXCEPTION 'chat_open_dm: a DM has 2 to 8 members (got %)', cardinality(v_members) USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_members) m
              WHERE coalesce(public.chat_user_role(p_ws, m), 'bank_guest') = 'bank_guest') THEN
    RAISE EXCEPTION 'chat_open_dm: every member must be an active non-guest member of this workspace'
      USING ERRCODE = '42501';
  END IF;
  -- 143: every pair, the caller included, on the new and the reopen path
  -- (the src/lib/chat error mapper keys on this phrase)
  IF EXISTS (SELECT 1 FROM unnest(v_members) x(a) JOIN unnest(v_members) y(b) ON x.a < y.b
              WHERE NOT public.chat_dm_pair_allowed(p_ws, x.a, y.b)) THEN
    RAISE EXCEPTION 'chat_open_dm: direct messages between these people are turned off' USING ERRCODE = '42501';
  END IF;
  -- 157: a group DM (3+ people, the opener included), on reopening too.
  IF cardinality(v_members) >= 3 THEN
    PERFORM public.chat_assert_permission(p_ws, 'open_group_dm');
  END IF;

  v_key := array_to_string(v_members, ',');
  INSERT INTO public.chat_channels (account_id, kind, name, dm_key, created_by)
  VALUES (p_ws, 'dm', NULL, v_key, v_uid)
  ON CONFLICT (account_id, dm_key) WHERE kind = 'dm' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.chat_channels WHERE account_id = p_ws AND kind = 'dm' AND dm_key = v_key;
    -- 273: reopening brings back everyone the caller names, not only the
    -- caller: whoever had left got nothing written here. The checks above
    -- already refused a deactivated person, a guest and a pair 143 blocks.
    INSERT INTO public.chat_channel_members (channel_id, user_id, role)
    SELECT v_id, m, 'member' FROM unnest(v_members) m
    ON CONFLICT DO NOTHING;
    RETURN v_id;
  END IF;
  INSERT INTO public.chat_channel_members (channel_id, user_id, role)
  SELECT v_id, m, 'member' FROM unnest(v_members) m;
  RETURN v_id;
END $$;

-- After the refusal above, so nobody leaves between the two. A removed or
-- deactivated person, or one who is a bank guest now, is left out, and so
-- is a pair 143's rules block: the row would hide the DM from the person
-- who stayed (chat_dm_user_allowed judges every member). Nobody stored
-- when a person left, so what came after their own last message counts as
-- unread: that is where the messages they were never told about are.
INSERT INTO public.chat_channel_members (channel_id, user_id, role, joined_at)
SELECT c.id, m.uid, 'member',
       greatest(c.created_at, (SELECT max(im.created_at) FROM public.internal_messages im
                                WHERE im.channel_id = c.id AND im.author_id = m.uid))
  FROM public.chat_channels c
 CROSS JOIN LATERAL (SELECT x::uuid AS uid FROM unnest(string_to_array(c.dm_key, ',')) x) m
 WHERE c.kind = 'dm' AND cardinality(string_to_array(c.dm_key, ',')) = 2
   AND coalesce(public.chat_user_role(c.account_id, m.uid), 'bank_guest') <> 'bank_guest'
   AND public.chat_dm_pair_allowed(c.account_id, (string_to_array(c.dm_key, ','))[1]::uuid,
                                   (string_to_array(c.dm_key, ','))[2]::uuid)
ON CONFLICT DO NOTHING;

-- CREATE OR REPLACE keeps 087's grants; stated again so this file says
-- what they are.
REVOKE ALL ON FUNCTION public.chat_leave_channel(uuid), public.chat_open_dm(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_leave_channel(uuid), public.chat_open_dm(uuid, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
