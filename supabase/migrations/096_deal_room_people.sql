-- 096: cancelling a deal room that is still being created, and a bank
-- guest added only by someone who manages the room.
--
-- Creating a group is asynchronous (088): the room waits in `creating`
-- until Meta's group_create webhook names its group, and the reconcile
-- fails it after 10 minutes. A manager can now stop that wait. The
-- server route asks deal_room_can_manage as the caller, then calls
-- deal_room_cancel_creation on the service role: only a room still
-- `creating` moves, to `failed` through deal_room_set_status (its
-- status_changed audit row), stamped `cancelled_at`, with a
-- create_cancelled audit row naming who cancelled it.
--
-- A cancelled room never comes back. 088 lets a `failed` room open when
-- its group arrives late, and lets one be requested again; neither
-- applies once it was cancelled:
--  * deal_room_group_created returns NULL instead of opening it, and
--    records the late group once (group_discarded). The webhook then
--    deletes that group at WhatsApp; nobody was ever invited into it,
--    because invites go out only once a room is open.
--  * deal_room_mark_requested refuses it, so neither the create route
--    (cancelled while Meta was still answering the create call) nor the
--    reconcile (which read the room while it was still `creating`)
--    can put it back to `creating`.
--
-- deal_room_add_guest_user (088) checked the caller's account and rank
-- (team leader and up) but never the room, as deal_room_approve_
-- participant did until 095: any team leader could put a bank guest
-- login into any room by id. It now also requires deal_room_can_manage,
-- as deal_room_add_staff always did.
--
-- 088's superuser / BYPASSRLS guard is repeated: this adds a column to
-- deal_rooms and a new SECURITY DEFINER function that writes deal_rooms
-- and deal_room_audit, both RLS-forced, so its owner must bypass RLS
-- (as 088's functions' owner does). The replaced functions keep their
-- owner and grants; their REVOKE / GRANT is restated anyway.
--
-- Re-runnable: the column is added if missing, functions are replaced
-- in place, grants are idempotent.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '096 must be applied by a superuser or BYPASSRLS role (the deal-room functions own RLS-forced tables)';
  END IF;
END $$;

-- When a manager cancelled the room while it was still being created.
ALTER TABLE public.deal_rooms ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
-- Staff read it (the room view says "cancelled" rather than "failed");
-- guests read deal_room_guest_rooms, whose columns are unchanged.
GRANT SELECT (cancelled_at) ON public.deal_rooms TO authenticated;

-- Stop a room that is still `creating`. Returns 'cancelled' when this
-- call (or an earlier one) cancelled it; otherwise the room's status,
-- unchanged: a group that arrived meanwhile opened it, and an open room
-- is closed, not cancelled.
CREATE OR REPLACE FUNCTION public.deal_room_cancel_creation(p_room uuid, p_actor uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_r public.deal_rooms;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'deal rooms: a reason is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE id = p_room FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: room not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_r.cancelled_at IS NOT NULL THEN
    RETURN 'cancelled';   -- replay
  END IF;
  IF v_r.status <> 'creating' THEN
    RETURN v_r.status;
  END IF;
  PERFORM public.deal_room_set_status(p_room, 'failed', p_reason);
  UPDATE public.deal_rooms SET cancelled_at = now() WHERE id = p_room;
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_r.id, v_r.account_id, p_actor, 'create_cancelled',
          jsonb_build_object('reason', p_reason, 'request_id', v_r.create_request_id));
  RETURN 'cancelled';
END $$;

-- As 088, plus: a cancelled room is never asked for again.
CREATE OR REPLACE FUNCTION public.deal_room_mark_requested(p_room uuid, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_r public.deal_rooms;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF btrim(coalesce(p_request_id, '')) = '' THEN
    RAISE EXCEPTION 'deal rooms: a request id is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms WHERE id = p_room FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: room not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_r.create_request_id IS NOT DISTINCT FROM p_request_id THEN
    RETURN;   -- replay
  END IF;
  IF v_r.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'deal rooms: the room was cancelled' USING ERRCODE = '22023';
  END IF;
  IF v_r.status NOT IN ('creating','failed') OR v_r.wa_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'deal rooms: the room is % and cannot be created again', v_r.status USING ERRCODE = '22023';
  END IF;
  UPDATE public.deal_rooms SET create_request_id = p_request_id, status = 'creating', last_error = NULL
   WHERE id = p_room;
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_r.id, v_r.account_id, NULL, 'create_requested', jsonb_build_object('request_id', p_request_id));
END $$;

-- As 088, plus: a cancelled room's group is recorded once and the room
-- stays failed (NULL: nothing opened, so the caller invites nobody).
CREATE OR REPLACE FUNCTION public.deal_room_group_created(p_account uuid, p_request_id text, p_group_id text,
                                                          p_invite_link_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_r public.deal_rooms;
BEGIN
  PERFORM public.deal_room_assert_service();
  IF btrim(coalesce(p_group_id, '')) = '' THEN
    RAISE EXCEPTION 'deal rooms: a group id is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_r FROM public.deal_rooms
   WHERE create_request_id = p_request_id AND account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal rooms: no room for create request %', p_request_id USING ERRCODE = 'P0002';
  END IF;
  IF v_r.cancelled_at IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.deal_room_audit a
                    WHERE a.room_id = v_r.id AND a.action = 'group_discarded'
                      AND a.detail ->> 'group_id' = p_group_id) THEN
      INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
      VALUES (v_r.id, v_r.account_id, NULL, 'group_discarded',
              jsonb_build_object('group_id', p_group_id, 'request_id', p_request_id));
    END IF;
    RETURN NULL;
  END IF;
  IF v_r.wa_group_id IS NOT NULL THEN
    IF v_r.wa_group_id <> p_group_id THEN
      RAISE EXCEPTION 'deal rooms: the room already has another group' USING ERRCODE = '22023';
    END IF;
    IF p_invite_link_hash IS NOT NULL THEN
      UPDATE public.deal_rooms SET invite_link_hash = p_invite_link_hash WHERE id = v_r.id;
    END IF;
    RETURN v_r.id;   -- replay
  END IF;
  IF v_r.status NOT IN ('creating','failed') THEN
    RAISE EXCEPTION 'deal rooms: the room is % and cannot open', v_r.status USING ERRCODE = '22023';
  END IF;
  UPDATE public.deal_rooms
     SET wa_group_id = p_group_id, invite_link_hash = p_invite_link_hash, status = 'open',
         opened_at = now(), last_error = NULL
   WHERE id = v_r.id;
  UPDATE public.deal_room_participants SET status = 'joined', joined_at = now()
   WHERE room_id = v_r.id AND role = 'business';
  PERFORM public.deal_room_refresh_count(v_r.id);
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_r.id, v_r.account_id, NULL, 'group_created', jsonb_build_object('group_id', p_group_id));
  RETURN v_r.id;
END $$;

-- As 088, plus: the caller must manage the room (deal_room_can_manage),
-- checked before any state check, as in 095.
CREATE OR REPLACE FUNCTION public.deal_room_add_guest_user(p_room uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
                    AND x.status NOT IN ('pending_approval','rejected','removed')) THEN
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
END $$;

-- Grants, as 088: the new function and the server ones for the service
-- role only, the guest-adding one for signed-in callers.
REVOKE ALL ON FUNCTION public.deal_room_cancel_creation(uuid, uuid, text),
  public.deal_room_mark_requested(uuid, text),
  public.deal_room_group_created(uuid, text, text, text),
  public.deal_room_add_guest_user(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_room_cancel_creation(uuid, uuid, text),
  public.deal_room_mark_requested(uuid, text),
  public.deal_room_group_created(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.deal_room_add_guest_user(uuid, uuid) TO authenticated;
