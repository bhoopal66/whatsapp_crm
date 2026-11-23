-- ============================================================
-- 268_reminders_and_numbers.sql — reminders that were lost, and
-- figures that counted what they should not (2026-11-23 audit)
--
--  1. calendar_reminder_sweep rang a reminder only in the five minutes
--     from its time, so a restart or a database stall at 09:00 (when
--     every preset reminder falls) dropped them for good. Now a task
--     rings up to 12 hours late (its 15-minute heads-up only while the
--     due time is ahead), an event or meeting up to 30 minutes late and
--     never after its end. calendar_reminders_sent still makes a second
--     ring impossible: its 14 days outlast every window. Whether a task
--     is open, where it is due and whose it is are read when it rings.
--     Past the first five minutes a heads-up, event or meeting rings
--     only if it was already set when its time came: a task snoozed for
--     10 minutes, or a meeting made 5 minutes ahead, is not "late". Of
--     one event's late reminders only the newest rings. A late ring says
--     so ("Overdue", "Due in 4 minutes", "Started").
--     What is already late when this file first applies is marked as
--     sent, so deploying rings nothing old. Only the first time: the
--     block runs only while the old sweep is the live one, so a second
--     apply cannot silence a reminder the new sweep still owes. What is
--     inside the old five minutes is left to ring. Recurring events are
--     expanded in the app (src/lib/calendar/reminders.ts, same rules).
--  2. push_still_allowed: a task_due push held through quiet hours rang
--     in the morning for work already done, or someone else's by then.
--  3. team_activity_starts, team_activity_report, team_activity_chats:
--     an HR person's private chats (conversations.personal_owner_id,
--     whatsapp_config.is_personal) counted as starts, chases, number
--     risk and alerts; 204 excluded them from the limits only. The alert
--     sweep reads starts, so it needs no change of its own.
--  4. dashboard_message_series, dashboard_response_time: personal chats
--     counted, and a bot's answer counted as a person's reply.
--
-- Restates bodies of 058, 073, 190, 197 and 216: apply in order, once
-- (re-applying one of those undoes this one).
-- Signatures and columns are unchanged, so the previous build works.
-- Re-runnable. Asserted by supabase/ci/verify-reminders-and-numbers.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '268 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.team_activity_chats(timestamptz,timestamptz,text,uuid,uuid,text,integer)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = 'conversations' AND column_name = 'personal_owner_id') THEN
    RAISE EXCEPTION '268: apply 191 and 216 first';
  END IF;
END $$;

-- ---------- 1. Late reminders still ring ----------

-- The first apply only (see above): keys as calendar_reminder_sweep
-- builds them.
DO $$ BEGIN
  IF pg_get_functiondef('public.calendar_reminder_sweep(timestamptz)'::regprocedure) LIKE '%interval ''12 hours''%' THEN
    RETURN;
  END IF;
  INSERT INTO public.calendar_reminders_sent (key, user_id, sent_at)
  SELECT DISTINCT ON (k.key) k.key, k.user_id, now()
    FROM (
      SELECT 'tk0:' || t.id || ':' || floor(extract(epoch FROM t.due_at))::bigint || ':' || t.assigned_to AS key,
             t.assigned_to AS user_id
        FROM public.tasks t
       WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
         AND t.due_at <= now() - interval '5 minutes'
         AND t.due_at > now() - interval '12 hours'
      UNION ALL
      SELECT 'tk:' || t.id || ':' || floor(extract(epoch FROM t.due_at))::bigint || ':' || t.assigned_to,
             t.assigned_to
        FROM public.tasks t
       WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
         AND t.due_at > now() AND t.due_at <= now() + interval '10 minutes'
      UNION ALL
      SELECT 'ev:' || e.id || ':' || floor(extract(epoch FROM e.start_at))::bigint || ':' || o.off || ':' || r.user_id,
             r.user_id
        FROM public.calendar_events e
        CROSS JOIN LATERAL (
          SELECT e.created_by AS user_id, e.reminders AS offsets
          UNION ALL
          SELECT a.user_id, coalesce(a.reminders, e.reminders)
            FROM public.calendar_event_attendees a WHERE a.event_id = e.id
        ) r
        CROSS JOIN LATERAL unnest(r.offsets) AS o(off)
       WHERE e.status = 'confirmed' AND e.rrule IS NULL
         AND e.start_at > now() - interval '30 minutes'
         AND e.start_at <= now() + interval '40320 minutes'
         AND e.start_at - make_interval(mins => o.off) <= now() - interval '5 minutes'
         AND e.start_at - make_interval(mins => o.off) > now() - interval '30 minutes'
      UNION ALL
      SELECT 'mt:' || m.id || ':' || floor(extract(epoch FROM m.scheduled_start))::bigint || ':' || o.off || ':' || r.user_id,
             r.user_id
        FROM public.meetings m
        CROSS JOIN LATERAL (
          SELECT m.host_user_id AS user_id
          UNION SELECT i.user_id FROM public.meeting_invitees i WHERE i.meeting_id = m.id
        ) r
        CROSS JOIN LATERAL (VALUES (10), (0)) AS o(off)
       WHERE m.status = 'scheduled'
         AND m.scheduled_start - make_interval(mins => o.off) <= now() - interval '5 minutes'
         AND m.scheduled_start - make_interval(mins => o.off) > now() - interval '30 minutes'
    ) k
   ORDER BY k.key
  ON CONFLICT (key) DO NOTHING;
END $$;

-- 197's body with the wider windows.
CREATE OR REPLACE FUNCTION public.calendar_reminder_sweep(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Until here a reminder is on time; after it, late.
  c_on_time constant interval := interval '5 minutes';
  -- REMINDER_WINDOW_MS in src/lib/calendar/reminders.ts.
  c_event   constant interval := interval '30 minutes';
  c_task    constant interval := interval '12 hours';
  v_count integer;
BEGIN
  -- Longer than any window above, or a purged key would ring again.
  DELETE FROM calendar_reminders_sent WHERE sent_at < p_now - interval '14 days';

  WITH recipients AS (
    -- set_at: when this person's reminder was last made or moved.
    SELECT e.id AS event_id, e.created_by AS user_id, e.reminders AS offsets, e.updated_at AS set_at
      FROM calendar_events e
     WHERE e.status = 'confirmed' AND e.rrule IS NULL
       AND e.start_at > p_now - c_event
       AND e.start_at <= p_now + interval '40320 minutes'
    UNION ALL
    SELECT e.id, a.user_id, coalesce(a.reminders, e.reminders), greatest(e.updated_at, a.created_at)
      FROM calendar_events e
      JOIN calendar_event_attendees a ON a.event_id = e.id
     WHERE e.status = 'confirmed' AND e.rrule IS NULL
       AND e.start_at > p_now - c_event
       AND e.start_at <= p_now + interval '40320 minutes'
       AND a.response <> 'declined'
  ),
  due AS (
    SELECT DISTINCT ON (k.key) k.*
      FROM (
        SELECT 'ev:' || e.id || ':' || floor(extract(epoch FROM e.start_at))::bigint
                 || ':' || o.off || ':' || r.user_id AS key,
               r.user_id, e.account_id, 'event_reminder'::text AS type,
               e.title,
               CASE
                 WHEN p_now < x.ring_at + c_on_time THEN calendar_offset_label(o.off)
                 WHEN e.start_at <= p_now THEN 'Started'
                 WHEN e.start_at <= p_now + interval '1 hour'
                   THEN calendar_offset_label(ceil(extract(epoch FROM e.start_at - p_now) / 60.0)::integer)
                 ELSE calendar_offset_label(o.off)
               END || ' · '
                 || calendar_time_label(e.account_id, e.start_at, e.all_day, e.time_zone) AS body,
               NULL::uuid AS contact_id, NULL::uuid AS conversation_id,
               jsonb_build_object('event_id', e.id, 'occurrence_start', e.start_at, 'offset', o.off) AS meta
          FROM recipients r
          JOIN calendar_events e ON e.id = r.event_id
          CROSS JOIN LATERAL unnest(r.offsets) AS o(off)
          CROSS JOIN LATERAL (SELECT e.start_at - make_interval(mins => o.off) AS ring_at) x
         WHERE x.ring_at <= p_now
           AND p_now < x.ring_at + c_event
           -- An all-day single day may be stored with end = start (108).
           AND p_now < CASE WHEN e.all_day THEN greatest(e.end_at, e.start_at + interval '1 day') ELSE e.end_at END
           AND (p_now < x.ring_at + c_on_time
                OR (r.set_at <= x.ring_at
                    AND NOT EXISTS (SELECT 1 FROM unnest(r.offsets) AS n(off)
                                     WHERE n.off < o.off
                                       AND e.start_at - make_interval(mins => n.off) <= p_now)))
           AND calendar_is_live_staff(r.user_id, e.account_id)
        UNION ALL
        SELECT 'mt:' || m.id || ':' || floor(extract(epoch FROM m.scheduled_start))::bigint || ':' || o.off || ':' || r.user_id,
               r.user_id, m.account_id, 'meeting_reminder',
               m.title,
               CASE
                 WHEN p_now < x.ring_at + c_on_time THEN calendar_offset_label(o.off)
                 WHEN m.scheduled_start <= p_now THEN 'Started'
                 ELSE calendar_offset_label(ceil(extract(epoch FROM m.scheduled_start - p_now) / 60.0)::integer)
               END || ' · '
                 || calendar_time_label(m.account_id, m.scheduled_start),
               NULL, NULL,
               jsonb_build_object('meeting_id', m.id, 'offset', o.off)
          FROM meetings m
          CROSS JOIN LATERAL (
            SELECT m.host_user_id AS user_id, m.updated_at AS set_at
            UNION SELECT i.user_id, greatest(m.updated_at, i.created_at)
                    FROM meeting_invitees i
                   WHERE i.meeting_id = m.id AND i.user_id <> m.host_user_id
          ) r
          CROSS JOIN LATERAL (VALUES (10), (0)) AS o(off)
          CROSS JOIN LATERAL (SELECT m.scheduled_start - make_interval(mins => o.off) AS ring_at) x
         WHERE m.status = 'scheduled' AND m.scheduled_start IS NOT NULL
           AND m.scheduled_start > p_now - c_event
           AND m.scheduled_start <= p_now + interval '10 minutes'
           AND (m.scheduled_end IS NULL OR m.scheduled_end > p_now)
           AND x.ring_at <= p_now
           AND p_now < x.ring_at + c_event
           AND (p_now < x.ring_at + c_on_time
                OR (r.set_at <= x.ring_at AND (o.off = 0 OR m.scheduled_start > p_now)))
           AND calendar_is_live_staff(r.user_id, m.account_id)
           AND NOT EXISTS (SELECT 1 FROM meeting_removed_users mr
                            WHERE mr.meeting_id = m.id AND mr.user_id = r.user_id)
        UNION ALL
        SELECT 'tk:' || t.id || ':' || floor(extract(epoch FROM t.due_at))::bigint || ':' || t.assigned_to,
               t.assigned_to, t.account_id, 'task_due',
               t.title,
               CASE WHEN t.due_at > p_now + interval '10 minutes' THEN 'Due in 15 minutes'
                    WHEN t.due_at <= p_now + interval '1 minute' THEN 'Due in 1 minute'
                    ELSE 'Due in ' || ceil(extract(epoch FROM t.due_at - p_now) / 60.0)::integer || ' minutes'
               END || ' · ' || calendar_time_label(t.account_id, t.due_at),
               t.contact_id, t.conversation_id,
               jsonb_build_object('task_id', t.id, 'offset', 15)
          FROM tasks t
         WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
           AND t.due_at > p_now
           AND t.due_at <= p_now + interval '15 minutes'
           AND (t.due_at > p_now + interval '10 minutes'
                OR t.updated_at <= t.due_at - interval '15 minutes')
           AND calendar_is_live_staff(t.assigned_to, t.account_id)
        UNION ALL
        SELECT 'tk0:' || t.id || ':' || floor(extract(epoch FROM t.due_at))::bigint || ':' || t.assigned_to,
               t.assigned_to, t.account_id, 'task_due',
               t.title,
               CASE WHEN p_now < t.due_at + c_on_time THEN 'Due now' ELSE 'Overdue' END
                 || ' · ' || calendar_time_label(t.account_id, t.due_at),
               t.contact_id, t.conversation_id,
               jsonb_build_object('task_id', t.id, 'offset', 0)
          FROM tasks t
         WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
           AND t.due_at <= p_now
           AND t.due_at > p_now - c_task
           AND calendar_is_live_staff(t.assigned_to, t.account_id)
      ) k
     ORDER BY k.key
  ),
  claimed AS (
    INSERT INTO calendar_reminders_sent (key, user_id, sent_at)
    SELECT key, user_id, p_now FROM due
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  ),
  rung AS (
    INSERT INTO notifications (account_id, user_id, type, title, body, contact_id, conversation_id, meta)
    SELECT d.account_id, d.user_id, d.type, d.title, d.body, d.contact_id, d.conversation_id, d.meta
      FROM due d JOIN claimed c ON c.key = d.key
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM rung;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.calendar_reminder_sweep(timestamptz) IS
  'Service role. Rings due event_reminder (one-off events), meeting_reminder (10 and 0 min) and task_due (15 min before and when due) bells once each; late ones too: tasks 12 h, events and meetings 30 min and not after their end (268). Returns how many. Migrations 108, 112, 197, 268.';

REVOKE ALL ON FUNCTION public.calendar_reminder_sweep(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_reminder_sweep(timestamptz) TO service_role;

-- ---------- 2. No push for a task that is done or someone else's ----------

-- 190's body plus the task_due branch.
CREATE OR REPLACE FUNCTION public.push_still_allowed(o public.push_outbox)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.push_eligible(o.user_id, o.account_id, o.kind)
     AND CASE o.kind
           WHEN 'whatsapp_message' THEN EXISTS (
             SELECT 1 FROM public.conversations cv
              WHERE cv.id = o.conversation_id AND cv.account_id = o.account_id
                AND public.can_view_conversation_for_user(o.user_id, o.account_id, cv.user_id, cv.assigned_agent_id, cv.channel_id))
           WHEN 'chat_message' THEN EXISTS (
             SELECT 1 FROM public.chat_channel_members cm
               JOIN public.chat_channels ch ON ch.id = cm.channel_id
              WHERE cm.channel_id = o.channel_id AND cm.user_id = o.user_id AND ch.account_id = o.account_id)
             AND coalesce(public.chat_user_can_read_channel(o.channel_id, o.user_id, true), false)
             -- 112: never the words of a message deleted, erased or
             -- edited since it was queued (NULL: queued before 112). A
             -- row is queued as its message is inserted, so any edit
             -- came after it.
             AND (o.message_id IS NULL OR EXISTS (
               SELECT 1 FROM public.internal_messages im
                WHERE im.id = o.message_id
                  AND im.deleted_at IS NULL AND im.erased_at IS NULL
                  AND im.edited_at IS NULL))
           -- 268: a reminder held through quiet hours, for work done or handed
           -- on since. The task id is in the tag (197); other tags pass.
           WHEN 'task_due' THEN CASE
             WHEN o.tag ~ '^task:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN EXISTS (
               SELECT 1 FROM public.tasks t
                WHERE t.id = substr(o.tag, 6)::uuid AND t.account_id = o.account_id
                  AND t.status = 'open' AND t.assigned_to = o.user_id)
             ELSE true END
           ELSE true
         END
$$;

REVOKE ALL ON FUNCTION public.push_still_allowed(public.push_outbox) FROM PUBLIC, anon, authenticated;

-- ---------- 3. Team activity is about company numbers ----------

-- 073's body; a personal chat or number never starts anything. The alert
-- sweep (204), the daily and unlock checks read starts only through here.
CREATE OR REPLACE FUNCTION public.team_activity_starts(
  p_account uuid,
  p_from    timestamptz,
  p_to      timestamptz
)
RETURNS TABLE (
  message_id      uuid,
  conversation_id uuid,
  sender_type     text,
  sender_id       uuid,
  -- NULL when the message recorded no number (see the backfill).
  channel_id      uuid,
  started_at      timestamptz,
  new_contact     boolean,
  replied         boolean,
  has_link        boolean,
  opener_hash     text,
  preview         text,
  -- 'whapi' / 'meta': the number's, else the message's own provider.
  provider        text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH win AS (
    SELECT
      m.id,
      m.conversation_id,
      m.sender_type,
      m.sender_id,
      m.created_at,
      m.content_text,
      m.channel_id,
      m.provider,
      lag(m.created_at) OVER (
        PARTITION BY m.conversation_id ORDER BY m.created_at, m.id
      ) AS prev_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = p_account
      AND c.personal_owner_id IS NULL
      AND m.created_at >= p_from - interval '24 hours'
      AND m.created_at < p_to
      -- Refused by WhatsApp: reached nobody, so neither a start nor the
      -- message a later one follows.
      AND m.status <> 'failed'
  ),
  candidates AS (
    SELECT w.*
    FROM win w
    WHERE w.sender_type <> 'customer'
      AND w.created_at >= p_from
      AND (w.prev_at IS NULL OR w.prev_at <= w.created_at - interval '24 hours')
  ),
  starts AS (
    SELECT
      cd.*,
      lead(cd.created_at) OVER (
        PARTITION BY cd.conversation_id ORDER BY cd.created_at, cd.id
      ) AS next_start_at
    FROM candidates cd
    -- Answering a customer who wrote last is a reply, however late. The
    -- previous message may be older than the scan, so it is looked up.
    WHERE coalesce((
      SELECT x.sender_type
      FROM messages x
      WHERE x.conversation_id = cd.conversation_id
        AND x.status <> 'failed'
        AND (x.created_at < cd.created_at
             OR (x.created_at = cd.created_at AND x.id < cd.id))
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT 1
    ), '') <> 'customer'
  )
  SELECT
    s.id,
    s.conversation_id,
    s.sender_type,
    s.sender_id,
    s.channel_id,
    s.created_at,
    NOT EXISTS (
      SELECT 1 FROM messages x
      WHERE x.conversation_id = s.conversation_id
        AND x.sender_type = 'customer'
        AND x.created_at < s.created_at
    ),
    EXISTS (
      SELECT 1 FROM messages x
      WHERE x.conversation_id = s.conversation_id
        AND x.sender_type = 'customer'
        AND x.created_at > s.created_at
        AND (s.next_start_at IS NULL OR x.created_at < s.next_start_at)
    ),
    coalesce(s.content_text ~* '(https?://|www\.|wa\.me/)', false),
    -- Identical openers are compared on a whitespace- and case-folded
    -- hash; short texts ("Hi") are too common to mean anything.
    CASE WHEN char_length(btrim(coalesce(s.content_text, ''))) >= 20
         THEN md5(lower(regexp_replace(btrim(s.content_text), '\s+', ' ', 'g')))
    END,
    left(s.content_text, 160),
    coalesce(w.provider, s.provider)
  FROM starts s
  LEFT JOIN whatsapp_config w ON w.id = s.channel_id AND w.account_id = p_account
  WHERE NOT coalesce(w.is_personal, false);
$$;

REVOKE ALL ON FUNCTION public.team_activity_starts(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_starts(uuid, timestamptz, timestamptz) TO authenticated, service_role;

-- 216's body; personal chats and numbers left out of the messages, the
-- numbers and the waiting customers.
CREATE OR REPLACE FUNCTION public.team_activity_report(
  p_from       timestamptz,
  p_to         timestamptz,
  p_tz         text DEFAULT NULL,
  p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
-- 216: plan every call for its own arguments (see the header).
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_uid     uuid := auth.uid();
  v_rank    integer := current_role_rank();
  -- Self scope (206): an agent's own figures only.
  v_self    boolean := false;
  v_cfg     record;
  v_tz      text;
  v_today   timestamptz;
  v_result  jsonb;
  -- Team scope: the people counted, the teams' names, and today's new
  -- chats per number on the whole number (number id -> count).
  v_team       uuid[];
  v_team_names jsonb := '[]'::jsonb;
  v_nums       jsonb;
  -- Team scope: the conversations the leader's RLS shows them.
  v_convs      uuid[];
BEGIN
  IF v_account IS NULL OR v_uid IS NULL OR v_rank IS NULL OR v_rank < 2 THEN
    RAISE EXCEPTION 'Only owners and admins (team leaders for their team, agents for themselves) can view team activity'
      USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The range must be shorter than 100 days'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_cfg FROM team_activity_limits(v_account);
  -- The admin's switches (204); no settings row means on.
  IF v_rank = 3 AND NOT coalesce(v_cfg.leader_view_enabled, true) THEN
    RAISE EXCEPTION 'Team activity is turned off for team leaders'
      USING ERRCODE = '42501', HINT = 'leader_view_off';
  END IF;
  IF v_rank = 2 AND NOT coalesce(v_cfg.agent_view_enabled, true) THEN
    RAISE EXCEPTION 'Team activity is turned off for agents'
      USING ERRCODE = '42501', HINT = 'agent_view_off';
  END IF;
  v_tz := coalesce(v_cfg.timezone, team_activity_valid_zone(p_tz), 'UTC');
  v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  IF v_rank = 2 THEN
    -- Self scope: the caller is the only person counted, in the
    -- conversations their RLS shows them (as 074 does for a leader).
    -- v_nums stays NULL: no whole-number figure; the numbers listed
    -- are cut to those the caller started chats on, below.
    v_self := true;
    v_team := ARRAY[v_uid];
    -- 216: the policy's predicate once per distinct (owner, assignee,
    -- number, pinned number) tuple, not once per conversation; the
    -- same set (see the header).
    WITH tuples AS MATERIALIZED (
      SELECT DISTINCT c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id
      FROM conversations c
      WHERE c.account_id = v_account
    ),
    allowed AS MATERIALIZED (
      SELECT t.*
      FROM tuples t
      WHERE can_view_conversation(v_account, t.user_id, t.assigned_agent_id,
                                  t.channel_id, t.send_channel_id)
    )
    SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_convs
    FROM conversations c
    JOIN allowed a
      ON  a.user_id           IS NOT DISTINCT FROM c.user_id
      AND a.assigned_agent_id IS NOT DISTINCT FROM c.assigned_agent_id
      AND a.channel_id        IS NOT DISTINCT FROM c.channel_id
      AND a.send_channel_id   IS NOT DISTINCT FROM c.send_channel_id
    WHERE c.account_id = v_account;
  ELSIF v_rank = 3 THEN
    v_team := team_activity_my_team();
    SELECT coalesce(jsonb_agg(t.name ORDER BY t.name), '[]'::jsonb) INTO v_team_names
    FROM teams t
    WHERE t.account_id = v_account AND t.leader_user_id = auth.uid();
    SELECT coalesce(jsonb_object_agg(x.channel_id::text, x.today_started), '{}'::jsonb)
      INTO v_nums
    FROM team_activity_team_number_counts(p_from, p_to, p_tz) x;
    -- What conversations_select / messages_select would show them,
    -- asked once per distinct tuple (216, as above).
    WITH tuples AS MATERIALIZED (
      SELECT DISTINCT c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id
      FROM conversations c
      WHERE c.account_id = v_account
    ),
    allowed AS MATERIALIZED (
      SELECT t.*
      FROM tuples t
      WHERE can_view_conversation(v_account, t.user_id, t.assigned_agent_id,
                                  t.channel_id, t.send_channel_id)
    )
    SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_convs
    FROM conversations c
    JOIN allowed a
      ON  a.user_id           IS NOT DISTINCT FROM c.user_id
      AND a.assigned_agent_id IS NOT DISTINCT FROM c.assigned_agent_id
      AND a.channel_id        IS NOT DISTINCT FROM c.channel_id
      AND a.send_channel_id   IS NOT DISTINCT FROM c.send_channel_id
    WHERE c.account_id = v_account;
  END IF;

  WITH
  numbers AS (
    SELECT w.id AS channel_id, w.provider, w.label, w.waba_id, w.phone_number_id,
           w.status, w.is_primary, w.created_at, w.connected_at
    FROM whatsapp_config w
    WHERE w.account_id = v_account
      -- Team scope: the numbers the team used or is allocated to.
      AND NOT coalesce(w.is_personal, false)
      AND (v_nums IS NULL OR v_nums ? w.id::text)
  ),
  start_rows AS (
    SELECT
      s.*,
      CASE
        WHEN s.sender_type = 'bot' THEN 'bot'
        WHEN s.sender_id IS NULL THEN 'api'
        ELSE 'person'
      END AS kind,
      CASE WHEN s.sender_type = 'agent' THEN s.sender_id END AS key_id,
      (s.started_at AT TIME ZONE v_tz)::date AS local_day,
      extract(hour FROM s.started_at AT TIME ZONE v_tz)::int AS local_hour,
      -- Younger than a day and not answered yet: too early to tell.
      (NOT s.replied AND s.started_at > now() - interval '24 hours') AS pending,
      -- opener_key() reads NULL as '', so this is its whole input.
      coalesce(mm.content_text, '') AS opener_text
    FROM team_activity_starts(v_account, least(p_from, v_today), 'infinity') s
    LEFT JOIN messages mm ON mm.id = s.message_id
    -- Team scope: chats the team's people started, nobody else's, in
    -- conversations the leader can see.
    WHERE v_team IS NULL
       OR (s.sender_type = 'agent' AND s.sender_id = ANY (v_team)
           -- Self scope counts every start the caller made, as
           -- team_activity_start_check does: a chat reassigned away
           -- stays in their own figures (it is their message).
           AND (v_self OR s.conversation_id = ANY (v_convs)))
  ),
  -- 216: team_activity_opener_key() (IMMUTABLE, ~0.1 ms a call) once
  -- per distinct first message, not once per start: templates repeat.
  opener_keys AS MATERIALIZED (
    SELECT d.opener_text, team_activity_opener_key(d.opener_text) AS opener_key
    FROM (SELECT DISTINCT opener_text FROM start_rows) d
  ),
  all_starts AS (
    SELECT r.*, ok.opener_key
    FROM start_rows r
    JOIN opener_keys ok ON ok.opener_text = r.opener_text
  ),
  -- Same text opening five or more chats on one number.
  openers AS (
    SELECT channel_id, opener_hash, count(DISTINCT conversation_id) AS chats
    FROM all_starts
    WHERE opener_hash IS NOT NULL AND started_at >= p_from AND started_at < p_to
    GROUP BY channel_id, opener_hash
  ),
  -- The same normalised first message from the same sender at least
  -- twice in the range.
  similars AS (
    SELECT kind, key_id, opener_key, count(*) AS n
    FROM all_starts
    WHERE opener_key IS NOT NULL AND started_at >= p_from AND started_at < p_to
    GROUP BY kind, key_id, opener_key
  ),
  rs_all AS (
    SELECT
      a.*,
      coalesce(o.chats, 0) >= 5 AS identical,
      coalesce(si.n, 0) >= 2 AS is_similar,
      CASE
        WHEN v_cfg.quiet_hours_start = v_cfg.quiet_hours_end THEN false
        WHEN v_cfg.quiet_hours_start < v_cfg.quiet_hours_end
          THEN a.local_hour >= v_cfg.quiet_hours_start AND a.local_hour < v_cfg.quiet_hours_end
        ELSE a.local_hour >= v_cfg.quiet_hours_start OR a.local_hour < v_cfg.quiet_hours_end
      END AS night
    FROM all_starts a
    LEFT JOIN openers o
      ON o.opener_hash = a.opener_hash
     AND o.channel_id IS NOT DISTINCT FROM a.channel_id
    LEFT JOIN similars si
      ON si.kind = a.kind
     AND si.key_id IS NOT DISTINCT FROM a.key_id
     AND si.opener_key = a.opener_key
    WHERE a.started_at >= p_from AND a.started_at < p_to
  ),
  rs AS (
    SELECT * FROM rs_all
    WHERE p_channel_id IS NULL OR channel_id = p_channel_id
  ),
  today_starts AS (
    SELECT * FROM all_starts WHERE started_at >= v_today
  ),
  -- Messages of every conversation that moved in the range, from where
  -- its current stretch began: the start of the customer's stretch
  -- that ended with their last message before the range (the message
  -- before that stretch is included as its boundary), or the start of
  -- the conversation when the customer never wrote before the range.
  -- So an unanswered run or a wait is counted from its real start,
  -- however long ago.
  conv_in AS (
    SELECT DISTINCT m.conversation_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = v_account
      AND c.personal_owner_id IS NULL
      AND (v_convs IS NULL OR c.id = ANY (v_convs))
      AND m.created_at >= p_from
      AND m.created_at < p_to
  ),
  bounds AS (
    SELECT
      ci.conversation_id,
      (SELECT max(o.created_at)
         FROM messages o
        WHERE o.conversation_id = ci.conversation_id
          AND o.sender_type <> 'customer'
          AND o.status <> 'failed'
          AND o.created_at < lc.at) AS lb
    FROM conv_in ci
    CROSS JOIN LATERAL (
      SELECT max(x.created_at) AS at
      FROM messages x
      WHERE x.conversation_id = ci.conversation_id
        AND x.sender_type = 'customer'
        AND x.status <> 'failed'
        AND x.created_at < p_from
    ) lc
  ),
  msgs AS (
    SELECT
      m.id,
      m.conversation_id,
      m.sender_type,
      m.sender_id,
      m.status,
      m.created_at,
      m.channel_id,
      coalesce(w.provider, m.provider) AS provider,
      m.sender_type = 'customer' AS is_customer,
      -- Team scope: the chat's handler (assignee, else owner) is one of
      -- the team's people. Decides which customer messages count.
      (v_team IS NULL OR EXISTS (
        SELECT 1 FROM conversations hc
        WHERE hc.id = m.conversation_id
          AND coalesce(hc.assigned_agent_id, hc.user_id) = ANY (v_team)
      )) AS in_team
    FROM bounds b
    JOIN messages m ON m.conversation_id = b.conversation_id
    LEFT JOIN whatsapp_config w ON w.id = m.channel_id AND w.account_id = v_account
    WHERE m.created_at >= coalesce(b.lb, '-infinity'::timestamptz)
      AND NOT coalesce(w.is_personal, false)
      AND m.created_at < p_to
  ),
  -- Runs and response times count what reached WhatsApp: a refused
  -- send is no reply and no part of a run.
  seq AS (
    SELECT
      msgs.*,
      lag(is_customer) OVER w AS prev_customer,
      lag(created_at) OVER w AS prev_at,
      sum(is_customer::int) OVER w AS grp
    FROM msgs
    WHERE status <> 'failed'
    WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id)
  ),
  seq2 AS (
    SELECT
      seq.*,
      -- When the customer's current unanswered stretch began (058's rule).
      max(CASE WHEN is_customer AND prev_customer IS NOT TRUE THEN created_at END)
        OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS cust_run_start,
      -- 1 for the first message after the customer last wrote, 2 for the next…
      CASE WHEN NOT is_customer THEN
        count(*) FILTER (WHERE NOT is_customer)
          OVER (PARTITION BY conversation_id, grp ORDER BY created_at, id)
      END AS run_pos,
      -- The same, with a follow-up sent within 10 minutes of the
      -- previous message of the stretch counted as part of it.
      CASE WHEN NOT is_customer THEN
        count(*) FILTER (
          WHERE NOT is_customer
            AND (prev_customer IS NOT FALSE OR created_at - prev_at > interval '10 minutes')
        ) OVER (PARTITION BY conversation_id, grp ORDER BY created_at, id)
      END AS chase_pos
    FROM seq
  ),
  -- Every outbound message in the range. Refused sends are added back
  -- here: they count as sent and as failed, with no run position.
  om_all AS (
    SELECT
      CASE
        WHEN s2.sender_type = 'bot' THEN 'bot'
        WHEN s2.sender_id IS NULL THEN 'api'
        ELSE 'person'
      END AS kind,
      CASE WHEN s2.sender_type = 'agent' THEN s2.sender_id END AS key_id,
      s2.channel_id,
      s2.provider,
      s2.conversation_id,
      s2.status,
      s2.created_at,
      s2.run_pos,
      s2.chase_pos,
      -- 0 while the customer has never written in the conversation.
      s2.grp,
      s2.prev_customer,
      s2.cust_run_start
    FROM seq2 s2
    WHERE NOT s2.is_customer AND s2.created_at >= p_from
      AND (v_team IS NULL OR (s2.sender_type = 'agent' AND s2.sender_id = ANY (v_team)))
    UNION ALL
    SELECT
      CASE
        WHEN f.sender_type = 'bot' THEN 'bot'
        WHEN f.sender_id IS NULL THEN 'api'
        ELSE 'person'
      END,
      CASE WHEN f.sender_type = 'agent' THEN f.sender_id END,
      f.channel_id,
      f.provider,
      f.conversation_id,
      f.status,
      f.created_at,
      NULL::bigint,
      NULL::bigint,
      NULL::bigint,
      NULL::boolean,
      NULL::timestamptz
    FROM msgs f
    WHERE f.status = 'failed' AND NOT f.is_customer AND f.created_at >= p_from
      AND (v_team IS NULL OR (f.sender_type = 'agent' AND f.sender_id = ANY (v_team)))
  ),
  om AS (
    SELECT * FROM om_all
    WHERE p_channel_id IS NULL OR channel_id = p_channel_id
  ),
  inbound AS (
    SELECT * FROM msgs
    WHERE is_customer AND created_at >= p_from AND in_team
      AND (p_channel_id IS NULL OR channel_id = p_channel_id)
  ),
  -- ---------------- per sender ----------------
  s_starts AS (
    SELECT
      kind, key_id,
      count(*) AS chats_started,
      count(*) FILTER (WHERE new_contact) AS new_contacts,
      count(*) FILTER (WHERE NOT replied) AS no_reply,
      count(*) FILTER (WHERE NOT pending) AS mature_started,
      count(*) FILTER (WHERE NOT replied AND NOT pending) AS mature_no_reply,
      count(*) FILTER (WHERE pending) AS pending_reply,
      count(*) FILTER (WHERE new_contact AND NOT replied) AS new_contacts_no_reply,
      count(*) FILTER (WHERE new_contact AND has_link) AS links_first,
      count(*) FILTER (WHERE identical) AS identical_openers,
      count(*) FILTER (WHERE is_similar) AS similar_openers,
      count(*) FILTER (WHERE night) AS night_starts
    FROM rs
    GROUP BY kind, key_id
  ),
  -- The per-person limits protect the phone numbers (Whapi and
  -- OpenWA): the busiest day, the days at the limit, the bursts and
  -- today's count are over chats started on phone numbers only.
  s_days AS (
    SELECT
      kind, key_id,
      max(n) AS peak_day,
      count(*) FILTER (
        WHERE kind = 'person' AND n > v_cfg.daily_new_chats_per_user
      ) AS days_over_limit,
      count(*) FILTER (
        WHERE kind = 'person' AND n >= v_cfg.daily_new_chats_per_user
      ) AS days_at_limit
    FROM (
      SELECT kind, key_id, local_day, count(*) AS n
      FROM rs
      WHERE provider IN ('whapi', 'openwa')
      GROUP BY kind, key_id, local_day
    ) d
    GROUP BY kind, key_id
  ),
  s_burst AS (
    SELECT kind, key_id, max(n) AS burst_10min
    FROM (
      SELECT
        kind, key_id,
        count(*) OVER (
          PARTITION BY kind, key_id ORDER BY started_at
          RANGE BETWEEN interval '10 minutes' PRECEDING AND CURRENT ROW
        ) AS n
      FROM rs
      WHERE provider IN ('whapi', 'openwa')
    ) b
    GROUP BY kind, key_id
  ),
  s_today AS (
    SELECT kind, key_id, count(*) AS today_starts
    FROM today_starts
    WHERE provider IN ('whapi', 'openwa')
      AND (p_channel_id IS NULL OR channel_id = p_channel_id)
    GROUP BY kind, key_id
  ),
  s_msgs AS (
    SELECT
      kind, key_id,
      count(*) AS messages_sent,
      count(DISTINCT conversation_id) AS conversations,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status = 'failed' AND provider IN ('whapi', 'openwa')) AS failed_phone,
      count(*) FILTER (WHERE status = 'failed' AND provider = 'meta') AS failed_official,
      count(*) FILTER (WHERE status IN ('delivered', 'read')) AS delivered,
      count(*) FILTER (WHERE status = 'read') AS read,
      count(*) FILTER (WHERE run_pos > v_cfg.max_unanswered_in_row) AS unanswered_over_limit,
      count(DISTINCT conversation_id) FILTER (
        WHERE run_pos > v_cfg.max_unanswered_in_row
      ) AS unanswered_chats,
      coalesce(max(run_pos), 0) AS max_unanswered_run,
      coalesce(max(chase_pos), 0) AS longest_chase,
      count(DISTINCT (created_at AT TIME ZONE v_tz)::date) AS active_days
    FROM om
    GROUP BY kind, key_id
  ),
  -- Chats this sender kept writing to past the limit (follow-ups
  -- within 10 minutes counted once): to someone who never wrote in the
  -- conversation, or to someone who did.
  s_chase AS (
    SELECT
      kind, key_id,
      count(*) FILTER (WHERE is_new) AS chase_new,
      count(*) FILTER (WHERE NOT is_new) AS chase_existing
    FROM (
      SELECT kind, key_id, conversation_id, bool_or(grp = 0) AS is_new
      FROM om
      WHERE chase_pos > v_cfg.max_unanswered_in_row
      GROUP BY kind, key_id, conversation_id
    ) x
    GROUP BY kind, key_id
  ),
  s_replies AS (
    SELECT
      kind, key_id,
      count(*) AS replies,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM created_at - cust_run_start) / 60.0
      ) AS response_median_min
    FROM om
    WHERE kind = 'person'
      AND prev_customer IS TRUE
      AND cust_run_start IS NOT NULL
      AND created_at >= cust_run_start
    GROUP BY kind, key_id
  ),
  -- Customers waiting now: the customer wrote last, in the last 7
  -- days (older waits are ignored). Recent = under 24 hours.
  waits AS (
    SELECT
      c.assigned_agent_id AS key_id,
      lm.created_at,
      lm.created_at > now() - interval '24 hours' AS recent
    FROM conversations c
    CROSS JOIN LATERAL (
      -- A refused reply leaves the customer waiting.
      SELECT m.sender_type, m.created_at
      FROM messages m
      WHERE m.conversation_id = c.id
        AND m.status <> 'failed'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) lm
    WHERE c.account_id = v_account
      AND c.status <> 'closed'
      AND c.last_message_at > now() - interval '7 days'
      AND lm.sender_type = 'customer'
      AND lm.created_at > now() - interval '7 days'
      AND c.personal_owner_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM whatsapp_config pw
                      WHERE pw.id = c.channel_id AND pw.is_personal)
      AND (p_channel_id IS NULL OR c.channel_id = p_channel_id)
      AND (v_team IS NULL OR coalesce(c.assigned_agent_id, c.user_id) = ANY (v_team))
      AND (v_convs IS NULL OR c.id = ANY (v_convs))
      -- Self scope: chats assigned to the caller; nothing unassigned.
      AND (NOT v_self OR c.assigned_agent_id = v_uid)
  ),
  s_waiting AS (
    SELECT
      key_id,
      count(*) AS waiting,
      count(*) FILTER (WHERE recent) AS waiting_recent,
      count(*) FILTER (WHERE NOT recent) AS waiting_older,
      max(extract(epoch FROM now() - created_at) / 60.0) AS oldest_min
    FROM waits
    GROUP BY key_id
  ),
  s_broadcasts AS (
    SELECT
      b.user_id AS key_id,
      count(DISTINCT b.id) AS broadcasts,
      count(*) FILTER (WHERE r.status IN ('sent', 'delivered', 'read', 'replied')) AS sent,
      count(*) FILTER (WHERE r.status = 'failed') AS failed,
      count(*) FILTER (WHERE r.status = 'replied' OR r.replied_at IS NOT NULL) AS replied
    FROM broadcasts b
    JOIN broadcast_recipients r ON r.broadcast_id = b.id
    WHERE b.account_id = v_account
      AND p_channel_id IS NULL
      -- Every recipient change touches its broadcast (the aggregate
      -- trigger), so one untouched since the range began has nothing in
      -- it; this keeps old campaigns' recipients out of the scan.
      AND b.updated_at >= p_from
      AND r.status <> 'pending'
      AND coalesce(r.sent_at, r.created_at) >= p_from
      AND coalesce(r.sent_at, r.created_at) < p_to
    GROUP BY b.user_id
  ),
  people AS (
    SELECT p.user_id, p.full_name, p.email, p.account_role::text AS role, p.avatar_url
    FROM profiles p
    WHERE p.account_id = v_account
  ),
  keys AS (
    SELECT * FROM (
      SELECT 'person'::text AS kind, user_id AS key_id FROM people
      UNION SELECT kind, key_id FROM s_starts
      UNION SELECT kind, key_id FROM s_msgs
      UNION SELECT kind, key_id FROM s_today
      UNION SELECT 'person', key_id FROM s_broadcasts
      UNION SELECT 'person', key_id FROM s_waiting WHERE key_id IS NOT NULL
    ) k
    -- Team scope: the team's people only.
    WHERE v_team IS NULL OR (k.kind = 'person' AND k.key_id = ANY (v_team))
  ),
  -- ---------------- per number ----------------
  -- Only the account's numbers: starts with no number recorded are
  -- counted once, in unattributed_starts.
  n_starts AS (
    SELECT
      channel_id,
      count(*) AS chats_started,
      count(*) FILTER (WHERE new_contact) AS new_contacts,
      count(*) FILTER (WHERE NOT replied) AS no_reply,
      count(*) FILTER (WHERE NOT pending) AS mature_started,
      count(*) FILTER (WHERE NOT replied AND NOT pending) AS mature_no_reply,
      count(*) FILTER (WHERE pending) AS pending_reply,
      count(*) FILTER (WHERE new_contact AND has_link) AS links_first,
      count(*) FILTER (WHERE identical) AS identical_openers,
      count(*) FILTER (WHERE night) AS night_starts
    FROM rs_all
    WHERE channel_id IS NOT NULL
    GROUP BY channel_id
  ),
  -- days_at_limit: phone numbers only, against the limit that applied
  -- that day (a warming-up number's lower one).
  n_days AS (
    SELECT
      d.channel_id,
      max(d.n) AS peak_day,
      count(*) FILTER (WHERE d.n > v_cfg.daily_new_chats_per_number) AS days_over_limit,
      count(*) FILTER (
        WHERE d.n >= team_activity_number_limit(
          nb.created_at, v_cfg.daily_new_chats_per_number,
          least(now(), (d.local_day + 1)::timestamp AT TIME ZONE v_tz))
      ) AS days_at_limit
    FROM (
      SELECT channel_id, local_day, count(*) AS n
      FROM rs_all
      WHERE channel_id IS NOT NULL
      GROUP BY channel_id, local_day
    ) d
    JOIN numbers nb ON nb.channel_id = d.channel_id
    GROUP BY d.channel_id
  ),
  n_burst AS (
    SELECT channel_id, max(n) AS burst_10min
    FROM (
      SELECT
        channel_id,
        count(*) OVER (
          PARTITION BY channel_id ORDER BY started_at
          RANGE BETWEEN interval '10 minutes' PRECEDING AND CURRENT ROW
        ) AS n
      FROM rs_all
      WHERE channel_id IS NOT NULL
    ) b
    GROUP BY channel_id
  ),
  n_today AS (
    SELECT channel_id, count(*) AS today_starts
    FROM today_starts
    WHERE channel_id IS NOT NULL
    GROUP BY channel_id
  ),
  n_msgs AS (
    SELECT
      channel_id,
      count(*) AS messages_sent,
      count(DISTINCT conversation_id) AS conversations,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status IN ('delivered', 'read')) AS delivered,
      count(*) FILTER (WHERE status = 'read') AS read,
      count(*) FILTER (WHERE run_pos > v_cfg.max_unanswered_in_row) AS unanswered_over_limit
    FROM om_all
    WHERE channel_id IS NOT NULL
    GROUP BY channel_id
  ),
  n_inbound AS (
    SELECT channel_id, count(*) AS received
    FROM msgs
    WHERE is_customer AND created_at >= p_from AND channel_id IS NOT NULL AND in_team
    GROUP BY channel_id
  ),
  -- ---------------- over time ----------------
  days AS (
    SELECT d::date AS day
    FROM generate_series(
      (p_from AT TIME ZONE v_tz)::date::timestamp,
      ((p_to - interval '1 microsecond') AT TIME ZONE v_tz)::date::timestamp,
      interval '1 day'
    ) d
  ),
  d_starts AS (
    SELECT local_day AS day,
           count(*) AS started,
           count(*) FILTER (WHERE NOT replied) AS no_reply,
           count(*) FILTER (WHERE pending) AS pending_reply,
           count(*) FILTER (WHERE new_contact) AS new_contacts
    FROM rs GROUP BY local_day
  ),
  d_out AS (
    SELECT (created_at AT TIME ZONE v_tz)::date AS day, count(*) AS sent
    FROM om GROUP BY 1
  ),
  d_in AS (
    SELECT (created_at AT TIME ZONE v_tz)::date AS day, count(*) AS received
    FROM inbound GROUP BY 1
  ),
  hours AS (
    SELECT h FROM generate_series(0, 23) h
  ),
  h_starts AS (
    SELECT local_hour AS h, count(*) AS started FROM rs GROUP BY local_hour
  ),
  h_out AS (
    SELECT extract(hour FROM created_at AT TIME ZONE v_tz)::int AS h, count(*) AS sent
    FROM om GROUP BY 1
  )
  SELECT jsonb_build_object(
    'tz', v_tz,
    'today', (now() AT TIME ZONE v_tz)::date,
    'from', p_from,
    'to', p_to,
    'channel_id', p_channel_id,
    'generated_at', now(),
    'scope', CASE WHEN v_self THEN 'self'
                  WHEN v_team IS NULL THEN 'account' ELSE 'team' END,
    'team_names', v_team_names,
    'limits', jsonb_build_object(
      'daily_new_chats_per_user', v_cfg.daily_new_chats_per_user,
      'daily_new_chats_per_number', v_cfg.daily_new_chats_per_number,
      'min_reply_rate', v_cfg.min_reply_rate,
      'max_unanswered_in_row', v_cfg.max_unanswered_in_row,
      'burst_new_chats_10min', v_cfg.burst_new_chats_10min,
      'quiet_hours_start', v_cfg.quiet_hours_start,
      'quiet_hours_end', v_cfg.quiet_hours_end,
      'timezone', v_cfg.timezone,
      'notify', v_cfg.notify,
      'block_over_limit', v_cfg.block_over_limit,
      'saved', v_cfg.saved
    ),
    'waiting_unassigned', coalesce(
      (SELECT waiting FROM s_waiting WHERE key_id IS NULL), 0),
    'waiting_unassigned_recent', coalesce(
      (SELECT waiting_recent FROM s_waiting WHERE key_id IS NULL), 0),
    'waiting_recent', (SELECT count(*) FROM waits WHERE recent),
    'waiting_older', (SELECT count(*) FROM waits WHERE NOT recent),
    'unattributed_starts', (SELECT count(*) FROM rs_all WHERE channel_id IS NULL),
    'senders', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', k.kind,
        'user_id', k.key_id,
        'name', pe.full_name,
        'email', pe.email,
        'role', pe.role,
        'avatar_url', pe.avatar_url,
        'messages_sent', coalesce(sm.messages_sent, 0),
        'conversations', coalesce(sm.conversations, 0),
        'failed', coalesce(sm.failed, 0),
        'failed_phone', coalesce(sm.failed_phone, 0),
        'failed_official', coalesce(sm.failed_official, 0),
        'delivered', coalesce(sm.delivered, 0),
        'read', coalesce(sm.read, 0),
        'active_days', coalesce(sm.active_days, 0),
        'chats_started', coalesce(ss.chats_started, 0),
        'new_contacts', coalesce(ss.new_contacts, 0),
        'no_reply', coalesce(ss.no_reply, 0),
        'mature_started', coalesce(ss.mature_started, 0),
        'mature_no_reply', coalesce(ss.mature_no_reply, 0),
        'pending_reply', coalesce(ss.pending_reply, 0),
        'new_contacts_no_reply', coalesce(ss.new_contacts_no_reply, 0),
        'links_first', coalesce(ss.links_first, 0),
        'identical_openers', coalesce(ss.identical_openers, 0),
        'similar_openers', coalesce(ss.similar_openers, 0),
        'night_starts', coalesce(ss.night_starts, 0),
        'peak_day', coalesce(sd.peak_day, 0),
        'days_over_limit', coalesce(sd.days_over_limit, 0),
        'days_at_limit', coalesce(sd.days_at_limit, 0),
        'today_starts', coalesce(st.today_starts, 0),
        'burst_10min', coalesce(sb.burst_10min, 0),
        'unanswered_over_limit', coalesce(sm.unanswered_over_limit, 0),
        'unanswered_chats', coalesce(sm.unanswered_chats, 0),
        'max_unanswered_run', coalesce(sm.max_unanswered_run, 0),
        'longest_chase', coalesce(sm.longest_chase, 0),
        'chase_new', coalesce(sc.chase_new, 0),
        'chase_existing', coalesce(sc.chase_existing, 0),
        -- The API and bots do not "reply": no figures rather than 0.
        'replies', CASE WHEN k.kind = 'person' THEN coalesce(sr.replies, 0) END,
        'response_median_min', CASE WHEN k.kind = 'person'
                                    THEN round(sr.response_median_min::numeric, 1) END,
        'waiting', coalesce(sw.waiting, 0),
        'waiting_recent', coalesce(sw.waiting_recent, 0),
        'waiting_older', coalesce(sw.waiting_older, 0),
        'waiting_oldest_min', round(sw.oldest_min::numeric, 0),
        'broadcasts', coalesce(bc.broadcasts, 0),
        'broadcast_sent', coalesce(bc.sent, 0),
        'broadcast_failed', coalesce(bc.failed, 0),
        'broadcast_replied', coalesce(bc.replied, 0)
      ) ORDER BY coalesce(ss.chats_started, 0) DESC, coalesce(sm.messages_sent, 0) DESC,
                 pe.full_name NULLS LAST, k.kind)
      FROM keys k
      LEFT JOIN people pe ON k.kind = 'person' AND pe.user_id = k.key_id
      LEFT JOIN s_starts ss ON ss.kind = k.kind AND ss.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_days sd ON sd.kind = k.kind AND sd.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_burst sb ON sb.kind = k.kind AND sb.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_today st ON st.kind = k.kind AND st.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_msgs sm ON sm.kind = k.kind AND sm.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_chase sc ON sc.kind = k.kind AND sc.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_replies sr ON sr.kind = k.kind AND sr.key_id IS NOT DISTINCT FROM k.key_id
      LEFT JOIN s_waiting sw ON k.kind = 'person' AND sw.key_id = k.key_id
      LEFT JOIN s_broadcasts bc ON k.kind = 'person' AND bc.key_id = k.key_id
    ), '[]'::jsonb),
    'numbers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'channel_id', nb.channel_id,
        'provider', nb.provider,
        'kind', CASE nb.provider WHEN 'whapi' THEN 'phone' WHEN 'openwa' THEN 'phone' WHEN 'meta' THEN 'official' END,
        'label', nb.label,
        'waba_id', nb.waba_id,
        'phone_number_id', nb.phone_number_id,
        'status', nb.status,
        'is_primary', nb.is_primary,
        'connected_at', nb.connected_at,
        'created_at', nb.created_at,
        'age_days', floor(extract(epoch FROM now() - nb.created_at) / 86400)::integer,
        'warming_up', nb.provider IN ('whapi', 'openwa')
                      AND coalesce(now() - nb.created_at < interval '14 days', false),
        'effective_daily_limit', CASE WHEN nb.provider IN ('whapi', 'openwa') THEN
          team_activity_number_limit(nb.created_at, v_cfg.daily_new_chats_per_number) END,
        'messages_sent', coalesce(nm.messages_sent, 0),
        'received', coalesce(ni.received, 0),
        'conversations', coalesce(nm.conversations, 0),
        'failed', coalesce(nm.failed, 0),
        'delivered', coalesce(nm.delivered, 0),
        'read', coalesce(nm.read, 0),
        'unanswered_over_limit', coalesce(nm.unanswered_over_limit, 0),
        'chats_started', coalesce(ns.chats_started, 0),
        'new_contacts', coalesce(ns.new_contacts, 0),
        'no_reply', coalesce(ns.no_reply, 0),
        'mature_started', coalesce(ns.mature_started, 0),
        'mature_no_reply', coalesce(ns.mature_no_reply, 0),
        'pending_reply', coalesce(ns.pending_reply, 0),
        'links_first', coalesce(ns.links_first, 0),
        'identical_openers', coalesce(ns.identical_openers, 0),
        'night_starts', coalesce(ns.night_starts, 0),
        'peak_day', coalesce(nd.peak_day, 0),
        'days_over_limit', coalesce(nd.days_over_limit, 0),
        'days_at_limit', CASE WHEN nb.provider IN ('whapi', 'openwa') THEN coalesce(nd.days_at_limit, 0) END,
        'burst_10min', coalesce(nbu.burst_10min, 0),
        'today_starts', coalesce(nt.today_starts, 0),
        'today_started', coalesce(nt.today_starts, 0)
      )
      -- Team scope: today's new chats on the whole number, everyone's.
      || CASE WHEN v_nums IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
           'number_today_started', coalesce((v_nums ->> nb.channel_id::text)::integer, 0)) END
      ORDER BY nb.is_primary DESC NULLS LAST, nb.provider, nb.created_at, nb.channel_id)
      FROM numbers nb
      LEFT JOIN n_starts ns ON ns.channel_id = nb.channel_id
      LEFT JOIN n_days nd ON nd.channel_id = nb.channel_id
      LEFT JOIN n_burst nbu ON nbu.channel_id = nb.channel_id
      LEFT JOIN n_today nt ON nt.channel_id = nb.channel_id
      LEFT JOIN n_msgs nm ON nm.channel_id = nb.channel_id
      LEFT JOIN n_inbound ni ON ni.channel_id = nb.channel_id
      -- Self scope: only the numbers the caller started chats on.
      WHERE NOT v_self
         OR EXISTS (SELECT 1 FROM rs_all ra WHERE ra.channel_id = nb.channel_id)
    ), '[]'::jsonb),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'day', d.day,
        'started', coalesce(ds.started, 0),
        'no_reply', coalesce(ds.no_reply, 0),
        'pending_reply', coalesce(ds.pending_reply, 0),
        'new_contacts', coalesce(ds.new_contacts, 0),
        'sent', coalesce(dout.sent, 0),
        'received', coalesce(din.received, 0)
      ) ORDER BY d.day)
      FROM days d
      LEFT JOIN d_starts ds ON ds.day = d.day
      LEFT JOIN d_out dout ON dout.day = d.day
      LEFT JOIN d_in din ON din.day = d.day
    ), '[]'::jsonb),
    'hourly', (
      SELECT jsonb_agg(jsonb_build_object(
        'hour', hr.h,
        'started', coalesce(hs.started, 0),
        'sent', coalesce(ho.sent, 0)
      ) ORDER BY hr.h)
      FROM hours hr
      LEFT JOIN h_starts hs ON hs.h = hr.h
      LEFT JOIN h_out ho ON ho.h = hr.h
    )
  )
  INTO v_result;

  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_report(timestamptz, timestamptz, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_report(timestamptz, timestamptz, text, uuid) TO authenticated;

-- 216's body: the list behind the report's chases, with the same rule.
CREATE OR REPLACE FUNCTION public.team_activity_chats(
  p_from       timestamptz,
  p_to         timestamptz,
  p_kind       text,
  p_user_id    uuid DEFAULT NULL,
  p_channel_id uuid DEFAULT NULL,
  p_filter     text DEFAULT 'no_reply',
  p_limit      integer DEFAULT 200
)
RETURNS TABLE (
  conversation_id uuid,
  contact_id      uuid,
  contact_name    text,
  contact_phone   text,
  at              timestamptz,
  new_contact     boolean,
  replied         boolean,
  has_link        boolean,
  in_a_row        integer,
  preview         text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_account uuid := current_account_id();
  v_uid     uuid := auth.uid();
  v_rank    integer := current_role_rank();
  v_view    record;
  v_max     integer;
  v_limit   integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  -- Team scope: the conversations the leader's RLS shows them; NULL
  -- (the whole account) for owners and admins.
  v_convs   uuid[];
BEGIN
  IF v_account IS NULL OR v_uid IS NULL OR v_rank IS NULL OR v_rank < 2 THEN
    RAISE EXCEPTION 'Only owners and admins (team leaders for their team, agents for themselves) can view team activity'
      USING ERRCODE = '42501';
  END IF;
  -- The admin's switches (204); no settings row means on.
  IF v_rank IN (2, 3) THEN
    SELECT l.agent_view_enabled, l.leader_view_enabled INTO v_view
    FROM team_activity_limits(v_account) l;
    IF v_rank = 3 AND NOT coalesce(v_view.leader_view_enabled, true) THEN
      RAISE EXCEPTION 'Team activity is turned off for team leaders'
        USING ERRCODE = '42501', HINT = 'leader_view_off';
    END IF;
    IF v_rank = 2 AND NOT coalesce(v_view.agent_view_enabled, true) THEN
      RAISE EXCEPTION 'Team activity is turned off for agents'
        USING ERRCODE = '42501', HINT = 'agent_view_off';
    END IF;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('person', 'api', 'bot')
     OR (p_kind = 'person' AND p_user_id IS NULL)
     -- An agent opens only their own starts.
     OR (v_rank = 2 AND (p_kind <> 'person' OR p_user_id <> v_uid))
     OR (v_rank = 3
         AND (p_kind <> 'person' OR NOT p_user_id = ANY (team_activity_my_team()))) THEN
    RAISE EXCEPTION 'Unknown sender' USING ERRCODE = '22023';
  END IF;
  IF p_filter IS NULL OR p_filter NOT IN ('no_reply', 'all', 'unanswered') THEN
    RAISE EXCEPTION 'Unknown filter' USING ERRCODE = '22023';
  END IF;
  IF v_rank IN (2, 3) THEN
    -- 216: the same predicate once per distinct (owner, assignee,
    -- number, pinned number) tuple, as in the report.
    WITH tuples AS MATERIALIZED (
      SELECT DISTINCT c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id
      FROM conversations c
      WHERE c.account_id = v_account
    ),
    allowed AS MATERIALIZED (
      SELECT t.*
      FROM tuples t
      WHERE can_view_conversation(v_account, t.user_id, t.assigned_agent_id,
                                  t.channel_id, t.send_channel_id)
    )
    SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_convs
    FROM conversations c
    JOIN allowed a
      ON  a.user_id           IS NOT DISTINCT FROM c.user_id
      AND a.assigned_agent_id IS NOT DISTINCT FROM c.assigned_agent_id
      AND a.channel_id        IS NOT DISTINCT FROM c.channel_id
      AND a.send_channel_id   IS NOT DISTINCT FROM c.send_channel_id
    WHERE c.account_id = v_account;
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '100 days' THEN
    RAISE EXCEPTION 'The range must be shorter than 100 days'
      USING ERRCODE = '22023';
  END IF;

  IF p_filter = 'unanswered' THEN
    SELECT l.max_unanswered_in_row INTO v_max FROM team_activity_limits(v_account) l;
    RETURN QUERY
    -- From where each conversation's current stretch began, as in
    -- the report (073): a run is counted from its real start.
    WITH conv_in AS (
      SELECT DISTINCT m.conversation_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = v_account
        AND c.personal_owner_id IS NULL
        AND (v_convs IS NULL OR c.id = ANY (v_convs))
        AND m.created_at >= p_from
        AND m.created_at < p_to
    ),
    bounds AS (
      SELECT ci.conversation_id,
        (SELECT max(o.created_at) FROM messages o
          WHERE o.conversation_id = ci.conversation_id
            AND o.sender_type <> 'customer' AND o.status <> 'failed'
            AND o.created_at < lc.at) AS lb
      FROM conv_in ci
      CROSS JOIN LATERAL (
        SELECT max(x.created_at) AS at FROM messages x
        WHERE x.conversation_id = ci.conversation_id
          AND x.sender_type = 'customer' AND x.status <> 'failed'
          AND x.created_at < p_from
      ) lc
    ),
    msgs AS (
      SELECT
        m.id, m.conversation_id, m.sender_type, m.sender_id, m.created_at, m.content_text,
        m.channel_id,
        m.sender_type = 'customer' AS is_customer
      FROM bounds b
      JOIN messages m ON m.conversation_id = b.conversation_id
      WHERE m.created_at >= coalesce(b.lb, '-infinity'::timestamptz)
        AND m.created_at < p_to
        AND m.status <> 'failed'
        AND NOT EXISTS (SELECT 1 FROM whatsapp_config pw
                        WHERE pw.id = m.channel_id AND pw.is_personal)
    ),
    seq AS (
      SELECT msgs.*,
        sum(is_customer::int) OVER (
          PARTITION BY conversation_id ORDER BY created_at, id
        ) AS grp
      FROM msgs
    ),
    pos AS (
      SELECT seq.*,
        CASE WHEN NOT is_customer THEN
          count(*) FILTER (WHERE NOT is_customer)
            OVER (PARTITION BY conversation_id, grp ORDER BY created_at, id)
        END AS run_pos
      FROM seq
    ),
    hits AS (
      SELECT DISTINCT ON (p.conversation_id)
        p.conversation_id, p.created_at, p.run_pos, p.content_text
      FROM pos p
      WHERE NOT p.is_customer
        AND p.created_at >= p_from
        AND p.run_pos > v_max
        AND (p_channel_id IS NULL OR p.channel_id = p_channel_id)
        AND CASE p_kind
              WHEN 'bot' THEN p.sender_type = 'bot'
              WHEN 'api' THEN p.sender_type = 'agent' AND p.sender_id IS NULL
              ELSE p.sender_type = 'agent' AND p.sender_id = p_user_id
            END
      ORDER BY p.conversation_id, p.run_pos DESC, p.created_at DESC
    )
    SELECT
      h.conversation_id, c.contact_id, ct.name, ct.phone, h.created_at,
      NOT EXISTS (
        SELECT 1 FROM messages x
        WHERE x.conversation_id = h.conversation_id AND x.sender_type = 'customer'
      ),
      false,
      coalesce(h.content_text ~* '(https?://|www\.|wa\.me/)', false),
      h.run_pos::integer,
      left(h.content_text, 160)
    FROM hits h
    JOIN conversations c ON c.id = h.conversation_id
    LEFT JOIN contacts ct
      ON ct.id = c.contact_id AND ct.account_id = v_account
     AND (v_convs IS NULL OR can_view_contact(ct.account_id, ct.id, ct.user_id))
    ORDER BY h.run_pos DESC, h.created_at DESC
    LIMIT v_limit;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    s.conversation_id, c.contact_id, ct.name, ct.phone, s.started_at,
    s.new_contact, s.replied, s.has_link,
    -- The opener plus everything that reached WhatsApp after it before
    -- the customer answered.
    (SELECT count(*)::integer
       FROM messages x
      WHERE x.conversation_id = s.conversation_id
        AND x.sender_type <> 'customer'
        AND x.status <> 'failed'
        AND x.created_at >= s.started_at
        AND x.created_at < coalesce((
              SELECT min(y.created_at) FROM messages y
               WHERE y.conversation_id = s.conversation_id
                 AND y.sender_type = 'customer'
                 AND y.created_at > s.started_at
            ), 'infinity'::timestamptz)),
    s.preview
  FROM team_activity_starts(v_account, p_from, 'infinity') s
  JOIN conversations c ON c.id = s.conversation_id
  LEFT JOIN contacts ct
      ON ct.id = c.contact_id AND ct.account_id = v_account
     AND (v_convs IS NULL OR can_view_contact(ct.account_id, ct.id, ct.user_id))
  WHERE s.started_at < p_to
    AND (v_convs IS NULL OR s.conversation_id = ANY (v_convs))
    AND (p_channel_id IS NULL OR s.channel_id = p_channel_id)
    AND (p_filter = 'all' OR NOT s.replied)
    AND CASE p_kind
          WHEN 'bot' THEN s.sender_type = 'bot'
          WHEN 'api' THEN s.sender_type = 'agent' AND s.sender_id IS NULL
          ELSE s.sender_type = 'agent' AND s.sender_id = p_user_id
        END
  ORDER BY s.started_at DESC
  LIMIT v_limit;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_chats(timestamptz, timestamptz, text, uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_chats(timestamptz, timestamptz, text, uuid, uuid, text, integer) TO authenticated;

-- ---------- 4. The home dashboard ----------

-- 058's body without personal chats.
CREATE OR REPLACE FUNCTION public.dashboard_message_series(
  p_since TIMESTAMPTZ,
  p_tz    TEXT
)
RETURNS TABLE (day DATE, incoming BIGINT, outgoing BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (m.created_at AT TIME ZONE p_tz)::date AS day,
    count(*) FILTER (WHERE m.sender_type = 'customer') AS incoming,
    count(*) FILTER (WHERE m.sender_type <> 'customer') AS outgoing
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id AND c.personal_owner_id IS NULL
  WHERE m.created_at >= p_since
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.dashboard_message_series(timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_message_series(timestamptz, text) TO authenticated;

-- 058's body without personal chats, and only replies by a person: an
-- agent row that names who wrote it. AI, flow and automation sends are
-- 'bot' rows; an agent row with no name came from the API or the phone.
-- As in team activity, a reply is a person's message right after the
-- customer's, so what a bot answered first is nobody's response time.
CREATE OR REPLACE FUNCTION public.dashboard_response_time(
  p_since            TIMESTAMPTZ,
  p_tz               TEXT,
  p_this_week_start  TIMESTAMPTZ,
  p_last_week_start  TIMESTAMPTZ
)
RETURNS TABLE (dow INT, period TEXT, samples BIGINT, total_minutes DOUBLE PRECISION)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH ordered AS (
    SELECT
      m.conversation_id,
      m.id,
      m.created_at,
      m.sender_type = 'customer' AS is_customer,
      (m.sender_type = 'agent' AND m.sender_id IS NOT NULL) AS is_person,
      lag(m.sender_type = 'customer') OVER w AS prev_customer
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id AND c.personal_owner_id IS NULL
    WHERE m.created_at >= p_since
    WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id)
  ),
  marked AS (
    SELECT
      o.*,
      -- created_at of the most recent customer run start so far;
      -- rows are time-ordered, so the latest start is the max.
      max(CASE WHEN o.is_customer AND o.prev_customer IS NOT TRUE
               THEN o.created_at END)
        OVER (PARTITION BY o.conversation_id
              ORDER BY o.created_at, o.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_start_at
    FROM ordered o
  ),
  pairs AS (
    SELECT
      run_start_at AS customer_at,
      extract(epoch FROM (created_at - run_start_at)) / 60.0 AS minutes
    FROM marked
    WHERE is_person
      AND prev_customer IS TRUE
      AND run_start_at IS NOT NULL
  )
  SELECT
    (extract(isodow FROM (p.customer_at AT TIME ZONE p_tz))::int - 1) AS dow,
    CASE
      WHEN p.customer_at >= p_this_week_start THEN 'this_week'
      WHEN p.customer_at >= p_last_week_start THEN 'last_week'
      ELSE 'earlier'
    END AS period,
    count(*) AS samples,
    sum(p.minutes)::double precision AS total_minutes
  FROM pairs p
  WHERE p.minutes >= 0
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;

REVOKE ALL ON FUNCTION public.dashboard_response_time(timestamptz, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_response_time(timestamptz, text, timestamptz, timestamptz) TO authenticated;

DO $$ BEGIN
  IF pg_get_functiondef('public.calendar_reminder_sweep(timestamptz)'::regprocedure) NOT LIKE '%interval ''12 hours''%'
     OR pg_get_functiondef('public.push_still_allowed(public.push_outbox)'::regprocedure) NOT LIKE '%task_due%'
     OR pg_get_functiondef('public.team_activity_starts(uuid,timestamptz,timestamptz)'::regprocedure) NOT LIKE '%is_personal%'
     OR pg_get_functiondef('public.team_activity_report(timestamptz,timestamptz,text,uuid)'::regprocedure) NOT LIKE '%is_personal%'
     OR pg_get_functiondef('public.dashboard_response_time(timestamptz,text,timestamptz,timestamptz)'::regprocedure) NOT LIKE '%is_person%' THEN
    RAISE EXCEPTION '268 did not apply completely';
  END IF;
END $$;

RESET lock_timeout;
