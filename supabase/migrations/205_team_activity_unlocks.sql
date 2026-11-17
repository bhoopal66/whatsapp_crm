-- ============================================================
-- 205: Team activity, unlock requests.
--
-- 204 blocks a person's send on a company phone number. Here the
-- person may ask for a one-time unlock, and an owner, an admin or the
-- leader of one of their teams approves or denies it:
--
--   1. team_activity_unlocks: one row per request, at most one
--      pending per (person, chat). An approval lasts 2 hours; 204's
--      start_check spends it (status 'used') on that person's next
--      send in that chat. An approved row past expires_at is simply
--      expired: readers treat it so, and the functions below mark it
--      lazily.
--   2. team_activity_request_unlock(block, reason) and
--      team_activity_decide_unlock(id, approve, note) are the only
--      writers. Refusals carry an ERRCODE and a HINT the API maps:
--        42501 not_allowed / unlocks_off, P0002 not_found,
--        23505 already_pending, P0001 already_decided,
--        22023 reason_length / note_length / block_too_old.
--   3. Two bells: team_activity_unlock_request (every live owner and
--      admin, and the live leaders of the requester's teams; never the
--      requester) and team_activity_unlock_decided (the requester).
--      The reason never goes in a bell: a lock screen shows it. Change
--      them together with hrefFor, PUSH_KINDS and kindGroup.
--   4. team_activity_my_day: 204's body, its 'started' figure now
--      leaving out personal numbers, as the enforcement does.
--
-- Re-runnable. Apply after 204.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The table. Clients read (RLS); only the functions below write.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_activity_unlocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  block_id        uuid REFERENCES public.team_activity_blocks(id) ON DELETE SET NULL,
  -- auth user id of the person who was blocked.
  requester_id    uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  rule            text NOT NULL,
  reason          text NOT NULL
                  CHECK (char_length(reason) BETWEEN 5 AND 500
                         AND reason !~ '^[[:space:]]*$'),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'denied', 'used', 'expired')),
  -- auth user id of the decider.
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  expires_at      timestamptz,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS team_activity_unlocks_one_pending
  ON public.team_activity_unlocks (requester_id, conversation_id)
  WHERE status = 'pending';
-- 204's start_check lookup.
CREATE INDEX IF NOT EXISTS team_activity_unlocks_approved_idx
  ON public.team_activity_unlocks (requester_id, conversation_id)
  WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS team_activity_unlocks_account_created_idx
  ON public.team_activity_unlocks (account_id, created_at);

ALTER TABLE public.team_activity_unlocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_activity_unlocks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.team_activity_unlocks TO authenticated, service_role;

-- 204's blocks policy: own rows; owners and admins all of the active
-- account; a leader the rows of the people in the teams they lead.
DROP POLICY IF EXISTS team_activity_unlocks_read ON public.team_activity_unlocks;
CREATE POLICY team_activity_unlocks_read ON public.team_activity_unlocks
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      requester_id = (SELECT auth.uid())
      OR (SELECT public.current_role_rank()) >= 4
      OR (
        (SELECT public.current_role_rank()) = 3
        AND requester_id = ANY (coalesce((SELECT public.team_activity_my_team()), '{}'::uuid[]))
      )
    )
  );

-- ------------------------------------------------------------
-- 2. Bell types: 188's list plus the two unlock types; a later type
--    edits it here. One statement (188): NOT VALID keeps the table
--    scan out of the lock.
-- ------------------------------------------------------------
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check,
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'channel_disconnected',
    'channel_reconnected',
    'team_activity_alert',
    'ai_handoff',
    'task_assigned',
    'task_due',
    'chat_mention',
    'chat_dm',
    'chat_thread_reply',
    'chat_broadcast',
    'call_missed',
    'callback_requested',
    'deal_room_join_request',
    'deal_room_update',
    'call_outcome_due',
    'pbx_connection_silent',
    'pbx_connection_restored',
    'meeting_invite',
    'calendar_invite',
    'calendar_update',
    'calendar_cancelled',
    'calendar_response',
    'event_reminder',
    'meeting_reminder',
    'group_join_request',
    'conversation_shared',
    'insight_attention',
    'submission_group_message',
    'meta_number_alert',
    'team_activity_unlock_request',
    'team_activity_unlock_decided'
  )) NOT VALID;
ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_type_check;

-- Restates 188's push_bell_url with the two unlock types; change it
-- together with hrefFor in src/lib/notifications/target.ts.
CREATE OR REPLACE FUNCTION public.push_bell_url(n public.notifications)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role    text;
  v_chat    text := CASE WHEN n.conversation_id IS NOT NULL THEN '/inbox?c=' || n.conversation_id END;
  v_contact text;
BEGIN
  SELECT p.account_role::text INTO v_role FROM public.profiles p
   WHERE p.user_id = n.user_id AND p.account_id = n.account_id AND p.deactivated_at IS NULL;
  CASE
    WHEN n.type IN ('conversation_assigned', 'ai_handoff', 'conversation_shared',
                    'insight_attention') THEN
      RETURN coalesce(v_chat, '/notifications');
    WHEN n.type IN ('task_assigned', 'task_due') THEN
      RETURN coalesce('/contacts/' || n.contact_id, v_chat, '/calls');
    WHEN n.type IN ('call_missed', 'callback_requested', 'call_outcome_due') THEN
      v_contact := coalesce(n.contact_id::text, n.meta ->> 'contact_id');
      RETURN CASE WHEN public.push_is_uuid(v_contact) THEN '/contacts/' || v_contact ELSE '/calls' END;
    WHEN n.type IN ('deal_room_join_request', 'deal_room_update') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'room_id')
                  THEN '/chat/rooms/' || (n.meta ->> 'room_id') ELSE '/notifications' END;
    WHEN n.type IN ('channel_disconnected', 'channel_reconnected', 'meta_number_alert') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=whatsapp' ELSE '/notifications' END;
    WHEN n.type IN ('pbx_connection_silent', 'pbx_connection_restored') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=phone-system' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_alert' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin', 'team_leader') THEN '/team-activity' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_unlock_request' THEN
      RETURN '/team-activity?tab=unlocks';
    WHEN n.type = 'team_activity_unlock_decided' THEN
      RETURN '/my-activity';
    WHEN n.type = 'meeting_invite' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'meeting_id')
                  THEN '/meetings/' || (n.meta ->> 'meeting_id') ELSE '/notifications' END;
    WHEN n.type = 'submission_group_message' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'group_id')
                  THEN '/submission-groups/' || (n.meta ->> 'group_id') ELSE '/notifications' END;
    ELSE
      RETURN '/notifications';
  END CASE;
END $$;

REVOKE ALL ON FUNCTION public.push_bell_url(public.notifications) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Asking. The caller must be the blocked person, in the block's
--    account (their active one), within 24 hours of the block, with
--    the account's allow_unlock_requests on.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_request_unlock(
  p_block_id uuid,
  p_reason   text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := public.current_account_id();
  v_block   record;
  v_cfg     record;
  v_reason  text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_id      uuid;
  v_name    text;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL THEN
    RAISE EXCEPTION 'Not a member of an account'
      USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;

  SELECT b.* INTO v_block
  FROM public.team_activity_blocks b
  WHERE b.id = p_block_id AND b.account_id = v_account;
  IF NOT FOUND OR v_block.conversation_id IS NULL THEN
    RAISE EXCEPTION 'Block not found'
      USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;
  IF v_block.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the person who was blocked can ask to unlock'
      USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;

  SELECT * INTO v_cfg FROM public.team_activity_limits(v_account);
  IF NOT coalesce(v_cfg.allow_unlock_requests, true) THEN
    RAISE EXCEPTION 'Unlock requests are turned off'
      USING ERRCODE = '42501', HINT = 'unlocks_off';
  END IF;

  IF v_block.created_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'This block is more than 24 hours old'
      USING ERRCODE = '22023', HINT = 'block_too_old';
  END IF;
  IF v_reason ~ '^[[:space:]]*$' OR char_length(v_reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'The reason must be 5 to 500 characters'
      USING ERRCODE = '22023', HINT = 'reason_length';
  END IF;

  -- Lazily: approvals of this person in this chat that ran out.
  UPDATE public.team_activity_unlocks u
     SET status = 'expired'
   WHERE u.requester_id = v_uid
     AND u.conversation_id = v_block.conversation_id
     AND u.status = 'approved'
     AND u.expires_at <= now();

  BEGIN
    INSERT INTO public.team_activity_unlocks
      (account_id, block_id, requester_id, conversation_id, rule, reason)
    VALUES
      (v_account, v_block.id, v_uid, v_block.conversation_id, v_block.rule, v_reason)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A request for this chat is already waiting'
      USING ERRCODE = '23505', HINT = 'already_pending';
  END;

  SELECT coalesce(nullif(btrim(p.full_name), ''), 'A team member') INTO v_name
  FROM public.profiles p
  WHERE p.user_id = v_uid AND p.account_id = v_account;
  v_name := coalesce(v_name, 'A team member');

  -- Live owners and admins, and the live leaders of the requester's
  -- teams in this account; never the requester.
  INSERT INTO public.notifications (account_id, user_id, type, title, body, meta)
  SELECT v_account, r.user_id, 'team_activity_unlock_request',
         'Unlock request: ' || v_name,
         v_name || ' asks to send past the "' || replace(v_block.rule, '_', ' ') || '" restriction',
         jsonb_build_object('unlock_id', v_id, 'rule', v_block.rule,
                            'requester_id', v_uid)
  FROM (
    SELECT p.user_id
    FROM public.profiles p
    WHERE p.account_id = v_account
      AND p.deactivated_at IS NULL
      AND p.account_role::text IN ('owner', 'admin')
    UNION
    SELECT p.user_id
    FROM public.teams t
    JOIN public.team_members tm ON tm.team_id = t.id
    JOIN public.profiles p ON p.user_id = t.leader_user_id AND p.account_id = t.account_id
    WHERE t.account_id = v_account
      AND tm.user_id = v_uid
      AND p.deactivated_at IS NULL
      AND p.account_role::text = 'team_leader'
  ) r
  WHERE r.user_id IS DISTINCT FROM v_uid;

  RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_request_unlock(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_request_unlock(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 4. Deciding. An owner or admin of the request's account (their
--    active one), or a team leader who leads a team the requester is
--    in; never the requester; only a pending request.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_decide_unlock(
  p_id      uuid,
  p_approve boolean,
  p_note    text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := public.current_account_id();
  v_rank    integer := coalesce(public.current_role_rank(), 0);
  v_row     public.team_activity_unlocks;
  v_note    text := nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '');
  v_status  text;
  v_name    text;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL THEN
    RAISE EXCEPTION 'Not a member of an account'
      USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'Approve or deny'
      USING ERRCODE = '22023', HINT = 'invalid';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'The note must be at most 500 characters'
      USING ERRCODE = '22023', HINT = 'note_length';
  END IF;

  SELECT u.* INTO v_row
  FROM public.team_activity_unlocks u
  WHERE u.id = p_id AND u.account_id = v_account
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unlock request not found'
      USING ERRCODE = 'P0002', HINT = 'not_found';
  END IF;

  IF v_row.requester_id = v_uid THEN
    RAISE EXCEPTION 'You cannot decide your own request'
      USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;
  IF NOT (
    v_rank >= 4
    OR (v_rank = 3 AND EXISTS (
      SELECT 1
      FROM public.teams t
      JOIN public.team_members tm ON tm.team_id = t.id
      WHERE t.account_id = v_account
        AND t.leader_user_id = v_uid
        AND tm.user_id = v_row.requester_id))
  ) THEN
    RAISE EXCEPTION 'Only an owner, an admin or their team leader can decide'
      USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;

  IF v_row.status = 'approved' AND v_row.expires_at <= now() THEN
    UPDATE public.team_activity_unlocks SET status = 'expired' WHERE id = v_row.id;
    v_row.status := 'expired';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This request was already decided'
      USING ERRCODE = 'P0001', HINT = 'already_decided';
  END IF;

  v_status := CASE WHEN p_approve THEN 'approved' ELSE 'denied' END;
  UPDATE public.team_activity_unlocks
     SET status        = v_status,
         decided_by    = v_uid,
         decided_at    = now(),
         decision_note = v_note,
         expires_at    = CASE WHEN p_approve THEN now() + interval '2 hours' END
   WHERE id = v_row.id;

  SELECT coalesce(nullif(btrim(p.full_name), ''), 'Your manager') INTO v_name
  FROM public.profiles p
  WHERE p.user_id = v_uid AND p.account_id = v_account;
  v_name := coalesce(v_name, 'Your manager');

  INSERT INTO public.notifications (account_id, user_id, type, title, body, meta)
  VALUES (
    v_account, v_row.requester_id, 'team_activity_unlock_decided',
    CASE WHEN p_approve THEN 'Unlock approved' ELSE 'Unlock denied' END,
    CASE WHEN p_approve
         THEN v_name || ' approved your request. You can send one message in that chat within 2 hours.'
         ELSE v_name || ' denied your request.' END,
    jsonb_build_object('unlock_id', v_row.id, 'rule', v_row.rule, 'status', v_status));

  RETURN v_status;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_decide_unlock(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_decide_unlock(uuid, boolean, text) TO authenticated;

-- ------------------------------------------------------------
-- 5. The employee's day: 204's body, with 'started' (and the figures
--    drawn from the same set) leaving out personal numbers.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_my_day(p_tz text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_account   uuid := current_account_id();
  v_cfg       record;
  v_tz        text;
  v_today     timestamptz;
  v_result    jsonb;
  v_rr_starts integer;
  v_rr_replied integer;
  v_throttled boolean := false;
  v_effective integer;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL THEN
    RAISE EXCEPTION 'Not a member of an account' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cfg FROM team_activity_limits(v_account);
  v_tz := coalesce(v_cfg.timezone, team_activity_valid_zone(p_tz), 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  v_effective := v_cfg.daily_new_chats_per_user;
  IF v_cfg.enforce_reply_rate THEN
    SELECT r.starts, r.replied INTO v_rr_starts, v_rr_replied
    FROM team_activity_user_reply_rate(v_account, v_uid) r;
    IF v_rr_starts >= 5 AND v_rr_replied * 100.0 / nullif(v_rr_starts, 0) < v_cfg.min_reply_rate THEN
      v_throttled := true;
      v_effective := ceil(v_effective * v_cfg.reply_rate_throttle_pct / 100.0)::integer;
    END IF;
  END IF;

  WITH s AS (
    SELECT * FROM team_activity_starts(v_account, v_today, 'infinity')
  ),
  -- The per-person limit protects the phone numbers (Whapi and
  -- OpenWA): only chats this person started on one count towards it.
  mine AS (
    SELECT * FROM s
    WHERE s.sender_type = 'agent' AND s.sender_id = v_uid AND s.provider IN ('whapi', 'openwa')
      -- 205: a personal number is outside the restrictions, so it is
      -- outside the figure the composer compares with the limit.
      AND NOT EXISTS (SELECT 1 FROM whatsapp_config pw
                      WHERE pw.id = s.channel_id AND coalesce(pw.is_personal, false))
  )
  SELECT jsonb_build_object(
    'tz', v_tz,
    'day', (now() AT TIME ZONE v_tz)::date,
    'started', (SELECT count(*) FROM mine),
    'new_contacts', (SELECT count(*) FROM mine WHERE mine.new_contact),
    'no_reply', (SELECT count(*) FROM mine WHERE NOT mine.replied),
    'numbers', coalesce((
      -- effective_daily_limit: a phone number's limit today (lower
      -- while it warms up); NULL for an official number, which has none.
      SELECT jsonb_agg(jsonb_build_object(
        'channel_id', x.channel_id, 'started', x.n,
        'warming_up', w.provider IN ('whapi', 'openwa')
                      AND coalesce(now() - w.created_at < interval '14 days', false),
        'effective_daily_limit', CASE WHEN w.provider IN ('whapi', 'openwa') THEN
          team_activity_number_limit(w.created_at, v_cfg.daily_new_chats_per_number) END))
      FROM (
        SELECT s.channel_id, count(*) AS n
        FROM s WHERE s.channel_id IS NOT NULL
        GROUP BY s.channel_id
      ) x
      JOIN whatsapp_config w ON w.id = x.channel_id
    ), '[]'::jsonb),
    'limits', jsonb_build_object(
      'daily_new_chats_per_user', v_cfg.daily_new_chats_per_user,
      'daily_new_chats_per_number', v_cfg.daily_new_chats_per_number,
      'max_unanswered_in_row', v_cfg.max_unanswered_in_row,
      'block_over_limit', v_cfg.block_over_limit
    ),
    -- Whether the restrictions apply to this caller at all.
    'blocked_when_over', v_cfg.block_over_limit AND current_role_rank() < 5,
    'restrictions', jsonb_build_object(
      'on', v_cfg.block_over_limit,
      'owner_exempt', coalesce(current_role_rank() >= 5, false),
      'rules', jsonb_build_object(
        'daily_user', v_cfg.enforce_daily_user,
        'daily_number', v_cfg.enforce_daily_number,
        'burst', v_cfg.enforce_burst,
        'quiet_hours', v_cfg.enforce_quiet_hours,
        'chase', v_cfg.enforce_chase,
        'links_first', v_cfg.enforce_links_first,
        'same_opener', v_cfg.enforce_same_opener,
        'reply_rate', v_cfg.enforce_reply_rate,
        'jev', v_cfg.enforce_jev),
      'quiet_hours', jsonb_build_object(
        'start', v_cfg.quiet_hours_start,
        'end', v_cfg.quiet_hours_end,
        'tz', coalesce(v_cfg.timezone, 'UTC')),
      'effective_user_limit', v_effective,
      'throttled', v_throttled,
      'same_opener_max', v_cfg.same_opener_max,
      'burst_limit', v_cfg.burst_new_chats_10min,
      'max_unanswered_in_row', v_cfg.max_unanswered_in_row,
      'unlock_requests', v_cfg.allow_unlock_requests)
  )
  INTO v_result;

  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_my_day(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_my_day(text) TO authenticated;
