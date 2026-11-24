-- ============================================================
-- 312_guest_access_ends.sql — a bank guest's access to a deal room ends
-- with the bank's last person in the WhatsApp group
--
-- 1. deal_room_access (088) counted a bank participant who LEFT the group
--    as being in the room, so the bank's login kept reading new messages
--    (deal_room_visible_since, group_messages_read, deal_room_guest_rooms,
--    deal_room_roster, deal_room_can_post). 'left' now ends access as
--    'removed' does; 'invited' counts as before, and a participant who
--    joins again (deal_room_participant_event) has it back.
--    deal_room_add_guest_user tests the same list: a login it adds is one
--    that can read.
-- 2. The room's chat channel and its members stayed visible to a guest
--    whose bank was removed or switched off: chat_user_can_read_channel
--    and chat_people asked for the membership row only.
--
-- deal_room_open_to_guest is the one guest rule; deal_room_access and the
-- two chat functions call it. It reads tables only (no policy, no chat_*
-- function), so there is no recursion. chat_user_can_read_channel runs for
-- every row of chat_channels_read, and an SQL function's body is planned
-- again on each of those calls. So the rule is a function of its own (a join
-- in that body would be planned for staff too), plpgsql (its plan is kept),
-- and asked after the membership row, for a guest only. The role there is
-- OFFSET 0: pulled up, chat_user_role ran once per mention of r.role, and
-- the new mention would have been one more for staff.
--
-- A guest holds no bell or push of a room (274 rings staff, Team notes are
-- staff-only), so nothing is cleared when the access ends.
--
-- The functions are the catalog's bodies with the marked lines changed;
-- search_path and grants are unchanged. Nothing here refuses itself on
-- existing data. Needs 088 and 277. Re-applying 087, 088, 096, 143, 159 or
-- 277 undoes parts of it: apply in order. Safe to run
-- twice. supabase/ci/verify-guest-access-ends.sql asserts it.
-- ============================================================

SET lock_timeout = '5s';

-- The guest rule. The caller has checked the channel membership row.
CREATE OR REPLACE FUNCTION public.deal_room_open_to_guest(p_channel uuid, p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
      FROM public.deal_rooms r
      JOIN public.profiles p
        ON p.account_id = r.account_id AND p.user_id = p_user
       AND p.account_role = 'bank_guest' AND p.deactivated_at IS NULL
      JOIN public.bank_guest_policies b
        ON b.account_id = p.account_id AND b.bank_code = upper(btrim(p.bank_code)) AND b.guests_allowed
      JOIN public.deal_room_participants x
        ON x.room_id = r.id AND x.role = 'bank_guest' AND x.bank_code = b.bank_code
       AND x.status NOT IN ('pending_approval','rejected','removed','left')   -- 312: 'left'
     WHERE r.channel_id = p_channel);
END $$;

REVOKE ALL ON FUNCTION public.deal_room_open_to_guest(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.deal_room_open_to_guest(uuid, uuid) IS
  'The bank guest half of deal_room_access (312): a live guest of the room''s workspace whose bank is switched on and still has a person in the WhatsApp group. Membership of the channel is the caller''s check. Definer-only.';

CREATE OR REPLACE FUNCTION public.deal_room_access(p_room uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
           WHEN r.account_id = public.current_account_id()
                AND (public.current_role_rank() >= 4
                     OR (public.current_role_rank() = 3 AND public.deal_room_leader_sees(r.id))) THEN 'supervisor'
           WHEN r.account_id = public.current_account_id() AND m.user_id IS NOT NULL THEN 'staff'
           WHEN m.user_id IS NOT NULL
                AND public.deal_room_open_to_guest(r.channel_id, auth.uid()) THEN 'guest'   -- 312
         END
    FROM public.deal_rooms r
    LEFT JOIN public.chat_channel_members m ON m.channel_id = r.channel_id AND m.user_id = auth.uid()
   WHERE r.id = p_room AND auth.uid() IS NOT NULL
$function$;

CREATE OR REPLACE FUNCTION public.deal_room_add_guest_user(p_room uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_r    public.deal_rooms;
  v_bank text;
BEGIN
  SELECT * INTO v_r FROM public.deal_rooms WHERE id = p_room;
  IF v_uid IS NULL OR NOT FOUND OR v_r.account_id IS DISTINCT FROM public.current_account_id()
     OR public.current_role_rank() < 3 THEN
    RAISE EXCEPTION 'deal rooms: only a team leader or an admin can add a bank guest' USING ERRCODE = '42501';
  END IF;
  IF NOT public.deal_room_can_manage(p_room) THEN
    RAISE EXCEPTION 'deal rooms: only a manager of this room can add a bank guest' USING ERRCODE = '42501';
  END IF;
  IF v_r.status IN ('closing','closed') THEN   -- as deal_room_add_staff
    RAISE EXCEPTION 'deal rooms: the room is closed' USING ERRCODE = '22023';
  END IF;
  SELECT upper(btrim(p.bank_code)) INTO v_bank FROM public.profiles p
   WHERE p.account_id = v_r.account_id AND p.user_id = p_user_id
     AND p.account_role = 'bank_guest' AND p.deactivated_at IS NULL;
  IF v_bank IS NULL THEN
    RAISE EXCEPTION 'deal rooms: that person is not a bank guest of this workspace' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.deal_room_participants x
                  WHERE x.room_id = p_room AND x.role = 'bank_guest' AND x.bank_code = v_bank
                    AND x.status NOT IN ('pending_approval','rejected','removed','left')) THEN   -- 312: 'left'
    RAISE EXCEPTION 'deal rooms: this room has no approved % participant', v_bank USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bank_guest_policies b
                  WHERE b.account_id = v_r.account_id AND b.bank_code = v_bank AND b.guests_allowed) THEN
    RAISE EXCEPTION 'deal rooms: % officers cannot join customer groups (the bank''s DSA agreement is not checked)',
      v_bank USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.chat_channel_members (channel_id, user_id, role)
  VALUES (v_r.channel_id, p_user_id, 'guest') ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
    VALUES (v_r.id, v_r.account_id, v_uid, 'guest_user_added',
            jsonb_build_object('user_id', p_user_id, 'bank_code', v_bank));
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.chat_user_can_read_channel(p_channel uuid, p_user uuid, p_messages boolean DEFAULT true)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.chat_channels c
      JOIN public.accounts a ON a.id = c.account_id
      JOIN LATERAL (SELECT public.chat_user_role(c.account_id, p_user) AS role OFFSET 0) r ON r.role IS NOT NULL   -- 312: OFFSET 0
     WHERE c.id = p_channel
       AND (a.internal_chat_enabled OR r.role IN ('owner','admin'))   -- disabled: history for admins only
       AND NOT (p_messages AND c.kind = 'deal_room' AND r.role = 'bank_guest')   -- Team notes are staff-only
       -- a current role of bank_guest is a guest everywhere: private
       -- channels and deal rooms they are a member of only
       AND ((c.kind = 'team' AND r.role <> 'bank_guest')
            OR ((c.kind IN ('private','deal_room') OR r.role <> 'bank_guest')
                AND EXISTS (SELECT 1 FROM public.chat_channel_members cm
                             WHERE cm.channel_id = c.id AND cm.user_id = p_user)
                -- 312: a deal room's channel ends for a guest with the room
                AND (c.kind <> 'deal_room' OR r.role <> 'bank_guest'
                     OR public.deal_room_open_to_guest(c.id, p_user))))
       -- 143: a DM this member may no longer have is hidden, not deleted
       AND (c.kind <> 'dm' OR public.chat_dm_user_allowed(c.id, p_user))
       -- 159: a restricted team channel is hidden from everyone outside
       -- its audience, members included (the row stays)
       AND (c.kind <> 'team' OR public.chat_user_in_channel_audience(c.id, p_user)))
$function$;

CREATE OR REPLACE FUNCTION public.chat_people(p_ws uuid)
 RETURNS TABLE(user_id uuid, full_name text, avatar_url text, role text, bank_code text, presence_status text, last_seen_at timestamp with time zone, deactivated boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.user_id, p.full_name, p.avatar_url, p.account_role::text, p.bank_code, mp.status, mp.last_seen_at,
         p.deactivated_at IS NOT NULL
    FROM (SELECT public.chat_ws_role(p_ws) AS role) me
    JOIN public.profiles p ON p.account_id = p_ws
    LEFT JOIN public.member_presence mp ON mp.user_id = p.user_id AND mp.account_id = p.account_id
   WHERE me.role IS NOT NULL
     AND (me.role <> 'bank_guest'
          -- 312: not through a deal room whose access has ended. The array
          -- names no column of p, so it is read once, and not for staff.
          OR EXISTS (SELECT 1 FROM public.chat_channel_members theirs
                      WHERE theirs.user_id = p.user_id
                        AND theirs.channel_id = ANY (ARRAY(
                          SELECT c.id FROM public.chat_channel_members mine
                            JOIN public.chat_channels c ON c.id = mine.channel_id AND c.account_id = p_ws
                           WHERE mine.user_id = auth.uid()
                             AND (c.kind <> 'deal_room'
                                  OR public.deal_room_open_to_guest(c.id, mine.user_id))))))
   ORDER BY p.full_name, p.user_id
$function$;

NOTIFY pgrst, 'reload schema';
