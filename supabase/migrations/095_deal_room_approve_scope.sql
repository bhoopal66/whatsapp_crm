-- 095: a bank guest is approved only by someone who manages the room.
--
-- deal_room_approve_participant (088) checked the caller's account and
-- rank (team leader and up) but never the room, so any team leader of
-- the workspace could let a bank officer into any room, or turn one
-- away, by participant id: one they could not even see. It now also
-- requires deal_room_can_manage on the participant's room, the rule the
-- other staff operations on a room use: owners and admins, a team
-- leader who sees the room's customer (deal_room_leader_sees), or one
-- who administers the room's channel or owns its contact. The rank
-- check stays: an agent cannot decide even in a room they manage,
-- because the approval is the team leader's check on the agent.
--
-- CREATE OR REPLACE with 088's signature keeps the function's owner, so
-- 088's superuser / BYPASSRLS guard is not repeated: it is about who
-- owns the deal-room functions, and replacing one changes neither its
-- owner nor its grants (only that owner may replace it). 088's REVOKE /
-- GRANT for it is restated anyway, so the end state does not depend on
-- that.
--
-- Re-runnable: the function is replaced in place.

CREATE OR REPLACE FUNCTION public.deal_room_approve_participant(p_participant_id uuid, p_approve boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p   public.deal_room_participants;
  v_new text;
BEGIN
  SELECT * INTO v_p FROM public.deal_room_participants WHERE id = p_participant_id FOR UPDATE;
  IF v_uid IS NULL OR NOT FOUND OR v_p.account_id IS DISTINCT FROM public.current_account_id() THEN
    RAISE EXCEPTION 'deal rooms: participant not found' USING ERRCODE = '42501';
  END IF;
  IF public.current_role_rank() < 3 THEN
    RAISE EXCEPTION 'deal rooms: only a team leader or an admin can approve a participant' USING ERRCODE = '42501';
  END IF;
  -- Before any state check, so a room the caller cannot manage says
  -- nothing about itself.
  IF NOT public.deal_room_can_manage(v_p.room_id) THEN
    RAISE EXCEPTION 'deal rooms: only a manager of this room can approve a participant' USING ERRCODE = '42501';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'deal rooms: approve or reject' USING ERRCODE = '22023';
  END IF;
  IF v_p.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'deal rooms: % is not waiting for approval (status %)', v_p.display_name, v_p.status
      USING ERRCODE = '22023';
  END IF;
  -- Closing or closed: nobody joins any more (the history stays readable).
  -- A suspended room may still decide: invites go out only once it is open.
  IF EXISTS (SELECT 1 FROM public.deal_rooms r WHERE r.id = v_p.room_id AND r.status IN ('closing','closed')) THEN
    RAISE EXCEPTION 'deal rooms: the room is closed' USING ERRCODE = '22023';
  END IF;
  IF p_approve AND v_p.role = 'bank_guest'
     AND NOT EXISTS (SELECT 1 FROM public.bank_guest_policies b
                      WHERE b.account_id = v_p.account_id AND b.bank_code = v_p.bank_code AND b.guests_allowed) THEN
    RAISE EXCEPTION 'deal rooms: % officers cannot join customer groups (the bank''s DSA agreement is not checked)',
      v_p.bank_code USING ERRCODE = '22023';
  END IF;
  v_new := CASE WHEN p_approve THEN 'invited' ELSE 'rejected' END;
  UPDATE public.deal_room_participants SET status = v_new WHERE id = v_p.id;
  INSERT INTO public.deal_room_audit (room_id, account_id, actor_id, action, detail)
  VALUES (v_p.room_id, v_p.account_id, v_uid,
          CASE WHEN p_approve THEN 'participant_approved' ELSE 'participant_rejected' END,
          jsonb_build_object('participant_id', v_p.id, 'role', v_p.role, 'bank_code', v_p.bank_code));
  RETURN v_new;
END $$;

-- As 088: a client function, signed-in callers only.
REVOKE ALL ON FUNCTION public.deal_room_approve_participant(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deal_room_approve_participant(uuid, boolean) TO authenticated;
