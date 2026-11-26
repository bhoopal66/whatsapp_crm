-- 308: a customer who left a submission group under a hidden number, and
-- who hears of a customer's message after the end. Restates 173's, 267's and
-- 295's functions: apply in order, once.
--
-- A hidden (@lid) member leaving may be the customer. 174 wrote nothing for
-- it, so 'joined' stayed for good: the membership cron skips 'joined' and
-- Resend refuses it. The webhook now reports 'left_unsure'.
-- Apply before the build that sends it.

SET lock_timeout = '5s';

-- 174's body plus 'left_unsure' (never stored): only 'joined' is touched, it
-- becomes 'unknown' and, with no check on record, is first in line for the
-- cron's next read (sg_membership_due). Any other state keeps its stamp.
CREATE OR REPLACE FUNCTION public.sg_note_customer_membership(p_group uuid, p_state text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('unknown', 'unsure', 'left_unsure', 'joined', 'absent') THEN
    RAISE EXCEPTION 'submission group membership: % is not a state', coalesce(p_state, 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_state = 'left_unsure' THEN
    UPDATE public.submission_groups
       SET customer_membership = 'unknown', customer_checked_at = NULL
     WHERE id = p_group AND status = 'ACTIVE' AND customer_membership = 'joined';
    RETURN FOUND;
  END IF;
  UPDATE public.submission_groups
     SET customer_membership = CASE
           WHEN p_state = 'unknown' THEN customer_membership
           WHEN p_state = 'unsure' AND customer_membership <> 'absent' THEN customer_membership
           WHEN p_state = 'unsure' THEN 'unknown'
           ELSE p_state
         END,
         customer_checked_at = now()
   WHERE id = p_group AND status = 'ACTIVE';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_note_customer_membership(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_note_customer_membership(uuid, text)
  TO service_role;

-- ------------------------------------------------------------
-- A customer's message after the end. The bell named people who could not
-- open the group ("This group does not exist"): an ENDED group is read only
-- by owners, admins, coordinators and team leads (sg_can_read), and admins
-- were rung only when nobody else was found.
-- ------------------------------------------------------------

-- The contacts SELECT policy (contacts_select) asked for somebody else than
-- the caller. Coordinator shares are left out: they open a chat, and a person
-- missed here is only not rung. A change to that policy changes this too.
CREATE OR REPLACE FUNCTION public.sg_user_sees_contact(p_account uuid, p_user uuid, p_contact uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH me AS (
    SELECT p.user_id, p.account_role FROM public.profiles p
     WHERE p.user_id = p_user AND p.account_id = p_account
       AND p.deactivated_at IS NULL
       AND p.account_role IN ('agent', 'team_leader', 'admin', 'owner')
  ), people AS (
    SELECT me.user_id FROM me
    UNION
    SELECT tm.user_id
      FROM me
      JOIN public.teams t ON t.account_id = p_account AND t.leader_user_id = me.user_id
      JOIN public.team_members tm ON tm.team_id = t.id AND tm.account_id = t.account_id
     WHERE me.account_role IN ('team_leader', 'admin', 'owner')
  )
  SELECT EXISTS (
    SELECT 1 FROM me, public.contacts k
     WHERE k.id = p_contact AND k.account_id = p_account
       AND (me.account_role IN ('admin', 'owner')
            OR k.user_id IN (SELECT user_id FROM people)
            OR EXISTS (
              SELECT 1 FROM public.conversations v
               WHERE v.contact_id = k.id
                 AND (v.user_id IN (SELECT user_id FROM people)
                      OR v.assigned_agent_id IN (SELECT user_id FROM people)
                      OR v.channel_id IN (
                        SELECT w.id FROM public.whatsapp_config w
                         WHERE w.is_personal AND w.account_id = p_account
                           AND w.user_id IN (SELECT user_id FROM people))))))
$$;

REVOKE ALL ON FUNCTION public.sg_user_sees_contact(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_user_sees_contact(uuid, uuid, uuid) TO service_role;

-- 267's body; only the ENDED branch changes. Those of the list at the end who
-- may read the group now are rung with the group, an agent whose access ended
-- with it is rung with the customer (contact_id, meta.ended) when they may see
-- the customer, and the owner and admins are rung when nobody of the list may
-- read it.
CREATE OR REPLACE FUNCTION public.sg_ring_customer_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '1s'
AS $function$
DECLARE
  g       public.submission_groups%ROWTYPE;
  v_who   text;
  v_users  uuid[];
  v_agents uuid[]; -- rung with the customer's page
BEGIN
  IF NEW.direction IS DISTINCT FROM 'in' OR NEW.sender_kind IS DISTINCT FROM 'customer' THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT * INTO g FROM public.submission_groups x
     WHERE x.id = NEW.group_id
       AND ((x.status = 'ACTIVE' AND NOT NEW.post_end)
            OR (x.status = 'ENDED' AND x.wa_mode = 'group' AND x.wa_closed_at IS NULL));
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_who := CASE WHEN g.customer_name IS NULL OR g.customer_name ~ '^[[:space:]]*$'
                  THEN g.submission_ref ELSE g.customer_name END;
    IF g.status = 'ACTIVE' THEN
      SELECT array_agg(w.user_id) INTO v_users
        FROM (SELECT a.user_id FROM public.submission_group_access a
               WHERE a.group_id = NEW.group_id AND a.removed_at IS NULL
                 AND a.label IN ('agent', 'coordinator')
                 AND public.sg_is_staff(NEW.account_id, a.user_id)
              UNION
              SELECT b.user_id FROM public.cases c
                JOIN public.coordinator_banks b
                  ON b.account_id = c.account_id AND b.bank_code = c.bank_code
               WHERE c.group_id = NEW.group_id
                 AND public.sg_holds_group_bank(NEW.group_id, b.user_id)) w;
    ELSE
      -- On the list at the end: sg_read_role's rule (115). With nobody left
      -- on it, the case's agent.
      SELECT array_agg(w.user_id) FILTER (WHERE w.reads),
             array_agg(w.user_id) FILTER (WHERE w.agent AND NOT w.reads
               AND public.sg_user_sees_contact(NEW.account_id, w.user_id, g.contact_id))
        INTO v_users, v_agents
        FROM (WITH pool AS (
                SELECT a.user_id, bool_or(a.label = 'agent') AS agent
                  FROM public.submission_group_access a
                 WHERE a.group_id = NEW.group_id
                   AND a.added_at <= g.ended_at AND (a.removed_at IS NULL OR a.removed_at >= g.ended_at)
                   AND a.label IN ('agent', 'coordinator')
                   AND public.sg_is_staff(NEW.account_id, a.user_id)
                 GROUP BY a.user_id)
              SELECT p.user_id, p.agent, public.sg_can_read(NEW.group_id, p.user_id) AS reads
                FROM (SELECT * FROM pool
                      UNION ALL
                      SELECT c.agent_id, true FROM public.cases c
                       WHERE c.group_id = NEW.group_id AND NOT EXISTS (SELECT 1 FROM pool)
                         AND public.sg_is_staff(NEW.account_id, c.agent_id)) p) w;
      IF v_users IS NULL THEN
        SELECT array_agg(p.user_id) INTO v_users
          FROM public.profiles p
         WHERE p.account_id = NEW.account_id AND p.deactivated_at IS NULL
           AND p.account_role IN ('owner', 'admin');
      END IF;
    END IF;
    -- A bell of before the end opens the group, which they lost: it would
    -- silence the one that opens the customer.
    UPDATE public.notifications n SET read_at = now()
     WHERE n.user_id = ANY (v_agents)
       AND n.read_at IS NULL
       AND n.account_id = NEW.account_id
       AND n.type = 'submission_group_message'
       AND n.meta ->> 'group_id' = NEW.group_id::text
       AND NOT n.meta ? 'ended';
    INSERT INTO public.notifications (account_id, user_id, type, title, body, contact_id, meta)
    SELECT NEW.account_id, w.user_id, 'submission_group_message',
           'Customer message: ' || v_who,
           CASE WHEN g.status = 'ACTIVE' THEN 'New message in the submission group'
                ELSE 'New message in the submission group (ended)' END,
           CASE WHEN w.lost THEN g.contact_id END,
           jsonb_build_object('group_id', NEW.group_id)
             || CASE WHEN w.lost THEN '{"ended": true}'::jsonb ELSE '{}'::jsonb END
      FROM (SELECT u, false FROM unnest(v_users) u
            UNION ALL
            SELECT u, true FROM unnest(v_agents) u) w(user_id, lost)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.notifications n
        WHERE n.user_id = w.user_id
          AND n.read_at IS NULL
          AND n.account_id = NEW.account_id
          AND n.type = 'submission_group_message'
          AND n.meta ->> 'group_id' = NEW.group_id::text)
       AND (g.status = 'ACTIVE' OR NOT EXISTS (
       SELECT 1 FROM public.notifications n
        WHERE n.user_id = w.user_id
          AND n.created_at > now() - interval '30 minutes'
          AND n.created_at >= g.ended_at  -- a bell of before the end answers nothing asked after it
          AND (NOT w.lost OR n.meta ? 'ended')  -- nor does one that opens the group they lost
          AND n.account_id = NEW.account_id
          AND n.type = 'submission_group_message'
          AND n.meta ->> 'group_id' = NEW.group_id::text));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sg_ring_customer_message: group %: % (%)', NEW.group_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.sg_ring_customer_message()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_ring_customer_message() TO service_role;

-- 267's body; an ENDED group counts only for who may open it, so the
-- sidebar never counts a message its list cannot show.
CREATE OR REPLACE FUNCTION public.sg_unread_by_group()
 RETURNS TABLE(group_id uuid, unread integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT g.id, count(*)::integer
    FROM public.sg_visible_ids() v(id)
    JOIN public.submission_groups g ON g.id = v.id
    LEFT JOIN public.submission_group_reads r
      ON r.group_id = g.id AND r.user_id = auth.uid()
    JOIN public.submission_group_messages m
      ON m.group_id = g.id
     AND m.direction = 'in'
     AND NOT m.post_end
     AND m.created_at > coalesce(r.last_read_at, now() - interval '7 days')
   WHERE g.account_id = public.current_account_id()
     AND g.status = 'ACTIVE'
     AND g.wa_mode = 'group'
   GROUP BY g.id
  UNION ALL
  SELECT g.id, count(*)::integer
    FROM (SELECT n.meta ->> 'group_id' AS gid, min(n.created_at) AS since, max(n.created_at) AS newest
            FROM public.notifications n
           WHERE n.user_id = auth.uid()
             AND n.read_at IS NULL
             AND n.account_id = public.current_account_id()
             AND n.type = 'submission_group_message'
           GROUP BY 1) b
    JOIN public.submission_groups g ON g.id::text = b.gid
    JOIN public.submission_group_messages m
      ON m.group_id = g.id
     AND m.direction = 'in'
     AND m.sender_kind = 'customer'
     AND m.post_end
     AND m.created_at >= b.since
   WHERE g.account_id = public.current_account_id()
     AND public.sg_is_staff(g.account_id, auth.uid())
     -- An unread bell of before the end counts only for those on the list
     -- at the end: someone taken off it must not learn of a later message.
     AND (b.newest >= g.ended_at OR EXISTS (
       SELECT 1 FROM public.submission_group_access a
        WHERE a.group_id = g.id AND a.user_id = auth.uid()
          AND a.added_at <= g.ended_at AND (a.removed_at IS NULL OR a.removed_at >= g.ended_at)
          AND a.label IN ('agent', 'coordinator')))
     AND g.status = 'ENDED'
     AND g.wa_mode = 'group'
     AND g.wa_closed_at IS NULL
     AND public.sg_can_read(g.id, auth.uid())
   GROUP BY g.id
$function$;

REVOKE ALL ON FUNCTION public.sg_unread_by_group()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_unread_by_group() TO authenticated, service_role;

-- 173's body; opening the archive of an ENDED group clears it too.
CREATE OR REPLACE FUNCTION public.sg_mark_read(p_group uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_acct uuid;
BEGIN
  -- A refusal, not a silent no-op, as 146: a caller that cannot see the
  -- group has a bug (or a stale tab after a workspace switch).
  SELECT g.account_id INTO v_acct FROM public.submission_groups g
   WHERE g.id = p_group AND v_uid IS NOT NULL
     AND (g.id IN (SELECT public.sg_visible_ids())
          OR (g.status = 'ENDED' AND g.account_id = public.current_account_id()
              AND public.sg_can_read(g.id, v_uid)));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_visible: this group is not visible to you'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.submission_group_reads AS r (group_id, account_id, user_id, last_read_at)
  VALUES (p_group, v_acct, v_uid, now())
  ON CONFLICT (group_id, user_id) DO UPDATE
    SET last_read_at = greatest(r.last_read_at, EXCLUDED.last_read_at);

  -- Someone who opens the group without clicking the bell has read it,
  -- and an unread bell would silence the group for them for good (one
  -- unread bell per person per group).
  UPDATE public.notifications n SET read_at = now()
   WHERE n.user_id = v_uid
     AND n.read_at IS NULL
     AND n.account_id = v_acct
     AND n.type = 'submission_group_message'
     AND n.meta ->> 'group_id' = p_group::text;
END
$function$;

REVOKE ALL ON FUNCTION public.sg_mark_read(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sg_mark_read(uuid) TO authenticated, service_role;

-- 295's body; a submission group bell with meta.ended opens the customer.
-- Pairs with hrefFor in src/lib/notifications/target.ts.
CREATE OR REPLACE FUNCTION public.push_bell_url(n notifications)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role    text;
  v_chat    text := CASE WHEN n.conversation_id IS NOT NULL THEN '/inbox?c=' || n.conversation_id END;
  v_contact text;
BEGIN
  SELECT p.account_role::text INTO v_role FROM public.profiles p
   WHERE p.user_id = n.user_id AND p.account_id = n.account_id AND p.deactivated_at IS NULL;
  CASE
    WHEN n.type IN ('conversation_assigned', 'ai_handoff', 'conversation_shared',
                    'insight_attention', 'chat_note_mention', 'response_target_missed',
                    'response_escalated', 'response_unassigned') THEN
      RETURN coalesce(v_chat, '/notifications');
    WHEN n.type = 'task_due' THEN
      RETURN coalesce('/contacts/' || n.contact_id, '/calendar');
    WHEN n.type = 'task_assigned' THEN
      RETURN coalesce('/contacts/' || n.contact_id, v_chat, '/calls');
    WHEN n.type IN ('call_missed', 'callback_requested', 'call_outcome_due') THEN
      v_contact := coalesce(n.contact_id::text, n.meta ->> 'contact_id');
      RETURN CASE WHEN public.push_is_uuid(v_contact) THEN '/contacts/' || v_contact ELSE '/calls' END;
    WHEN n.type IN ('deal_room_join_request', 'deal_room_update', 'deal_room_message') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'room_id')
                  THEN '/chat/rooms/' || (n.meta ->> 'room_id') ELSE '/notifications' END;
    WHEN n.type = 'webhook_disabled' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=api' ELSE '/notifications' END;
    WHEN n.type = 'inbound_message_failed' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=whatsapp' ELSE '/notifications' END;
    WHEN n.type = ANY (ARRAY['channel_disconnected', 'channel_reconnected'])
         AND n.meta -> 'personal' = 'true'::jsonb THEN
      RETURN '/settings?tab=profile';
    WHEN n.type = 'work_handed_over' THEN
      RETURN '/inbox';
    WHEN n.type = 'retention_failed' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=privacy' ELSE '/notifications' END;
    WHEN n.type IN ('channel_disconnected', 'channel_reconnected', 'meta_number_alert') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=whatsapp' ELSE '/notifications' END;
    WHEN n.type IN ('pbx_connection_silent', 'pbx_connection_restored') THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin') THEN '/settings?tab=phone-system' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_alert' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin', 'team_leader') THEN '/team-activity' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_unlock_request' THEN
      RETURN CASE WHEN v_role IN ('owner', 'admin', 'team_leader') THEN '/team-activity?tab=unlocks' ELSE '/notifications' END;
    WHEN n.type = 'team_activity_unlock_decided' THEN
      RETURN '/my-activity';
    WHEN n.type IN ('meeting_invite', 'meeting_update', 'meeting_cancelled') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'meeting_id')
                  THEN '/meetings/' || (n.meta ->> 'meeting_id') ELSE '/notifications' END;
    WHEN n.type = 'meeting_reminder' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'meeting_id')
                  THEN '/meetings/' || (n.meta ->> 'meeting_id') ELSE '/notifications' END;
    WHEN n.type IN ('calendar_invite', 'calendar_update', 'calendar_cancelled', 'calendar_response', 'event_reminder') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'event_id')
                  THEN '/calendar?event=' || (n.meta ->> 'event_id') ELSE '/notifications' END;
    WHEN n.type = 'group_join_request' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'group_id')
                  THEN '/groups/' || (n.meta ->> 'group_id') || '?tab=requests' ELSE '/notifications' END;
    WHEN n.type = 'submission_group_message' AND n.meta -> 'ended' = 'true'::jsonb THEN
      RETURN coalesce('/contacts/' || n.contact_id, '/notifications');
    WHEN n.type = 'submission_group_message' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> 'group_id')
                  THEN '/submission-groups/' || (n.meta ->> 'group_id') ELSE '/notifications' END;
    ELSE
      RETURN '/notifications';
  END CASE;
END $function$;

REVOKE ALL ON FUNCTION public.push_bell_url(public.notifications)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.push_bell_url(public.notifications) TO service_role;

RESET lock_timeout;
