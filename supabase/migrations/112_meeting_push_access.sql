-- ============================================================
-- 112_meeting_push_access.sql — access fixes from the 2026-10-16
-- audit (on top of 106, 108, 109 and 110; docs/meetings.md,
-- docs/push.md)
--
--  * A removed person no longer sees the meeting. 110 refused only
--    their join and their posts; meeting_row_visible (106) still let an
--    invitee or, on an open meeting, anyone removed read the meeting
--    row, every seat and the room's chat — live, through realtime.
--    Now an invitation or open_to_workspace counts only while no
--    meeting_removed_users row names the caller. The host and owners/
--    admins are unaffected (the moderate route never removes them).
--    Letting the person back in (deleting the row) restores it.
--  * calendar_reminder_sweep (108) no longer rings meeting_reminder
--    for a removed person. 108's function, byte for byte, plus that
--    one NOT EXISTS.
--  * push_outbox.message_id: the team-chat message a chat_message row
--    carries. push_on_chat_message (109's, plus the column) records it,
--    and push_still_allowed (109's, plus one clause) skips a row whose
--    message was deleted, erased or edited after it was queued, so the
--    old words never reach a lock screen. Rows queued before 112 have
--    no message_id and are judged as before.
--
-- Reads RLS-forced tables, so, as 106–110, apply as a superuser or
-- BYPASSRLS role.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '112 must be applied by a superuser or BYPASSRLS role (its functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. A removal hides the meeting ----------

CREATE OR REPLACE FUNCTION public.meeting_row_visible(
  p_account_id uuid, p_host_user_id uuid, p_open boolean, p_meeting uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_account_id IS NOT NULL
     AND p_account_id = current_account_id()
     AND (current_role_rank() >= 4
          OR p_host_user_id = auth.uid()
          OR ((p_open
               OR EXISTS (SELECT 1 FROM meeting_invitees i
                           WHERE i.meeting_id = p_meeting AND i.user_id = auth.uid()))
              AND NOT EXISTS (SELECT 1 FROM meeting_removed_users r
                               WHERE r.meeting_id = p_meeting AND r.user_id = auth.uid())));
$$;

-- ---------- 2. No reminders for a removed person ----------

CREATE OR REPLACE FUNCTION public.calendar_reminder_sweep(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM calendar_reminders_sent WHERE sent_at < p_now - interval '14 days';

  WITH recipients AS (
    SELECT e.id AS event_id, e.created_by AS user_id, e.reminders AS offsets
      FROM calendar_events e
     WHERE e.status = 'confirmed' AND e.rrule IS NULL
       AND e.start_at > p_now - interval '5 minutes'
       AND e.start_at <= p_now + interval '40320 minutes'
    UNION ALL
    SELECT e.id, a.user_id, coalesce(a.reminders, e.reminders)
      FROM calendar_events e
      JOIN calendar_event_attendees a ON a.event_id = e.id
     WHERE e.status = 'confirmed' AND e.rrule IS NULL
       AND e.start_at > p_now - interval '5 minutes'
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
               calendar_offset_label(o.off) || ' · '
                 || calendar_time_label(e.account_id, e.start_at, e.all_day, e.time_zone) AS body,
               NULL::uuid AS contact_id, NULL::uuid AS conversation_id,
               jsonb_build_object('event_id', e.id, 'occurrence_start', e.start_at, 'offset', o.off) AS meta
          FROM recipients r
          JOIN calendar_events e ON e.id = r.event_id
          CROSS JOIN LATERAL unnest(r.offsets) AS o(off)
         WHERE e.start_at - make_interval(mins => o.off) <= p_now
           AND p_now < e.start_at - make_interval(mins => o.off) + interval '5 minutes'
           AND calendar_is_live_staff(r.user_id, e.account_id)
        UNION ALL
        SELECT 'mt:' || m.id || ':' || floor(extract(epoch FROM m.scheduled_start))::bigint || ':' || o.off || ':' || r.user_id,
               r.user_id, m.account_id, 'meeting_reminder',
               m.title,
               calendar_offset_label(o.off) || ' · '
                 || calendar_time_label(m.account_id, m.scheduled_start),
               NULL, NULL,
               jsonb_build_object('meeting_id', m.id)
          FROM meetings m
          CROSS JOIN LATERAL (
            SELECT m.host_user_id AS user_id
            UNION SELECT i.user_id FROM meeting_invitees i WHERE i.meeting_id = m.id
          ) r
          CROSS JOIN LATERAL (VALUES (10), (0)) AS o(off)
         WHERE m.status = 'scheduled' AND m.scheduled_start IS NOT NULL
           AND m.scheduled_start > p_now - interval '5 minutes'
           AND m.scheduled_start <= p_now + interval '10 minutes'
           AND m.scheduled_start - make_interval(mins => o.off) <= p_now
           AND p_now < m.scheduled_start - make_interval(mins => o.off) + interval '5 minutes'
           AND calendar_is_live_staff(r.user_id, m.account_id)
           AND NOT EXISTS (SELECT 1 FROM meeting_removed_users mr
                            WHERE mr.meeting_id = m.id AND mr.user_id = r.user_id)
        UNION ALL
        SELECT 'tk:' || t.id || ':' || floor(extract(epoch FROM t.due_at))::bigint || ':' || t.assigned_to,
               t.assigned_to, t.account_id, 'task_due',
               t.title,
               'Due ' || calendar_time_label(t.account_id, t.due_at),
               t.contact_id, t.conversation_id,
               jsonb_build_object('task_id', t.id)
          FROM tasks t
         WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
           AND t.due_at > p_now + interval '10 minutes'
           AND t.due_at <= p_now + interval '15 minutes'
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

-- ---------- 3. Queued chat pushes follow the message ----------

ALTER TABLE public.push_outbox ADD COLUMN IF NOT EXISTS message_id uuid;
COMMENT ON COLUMN public.push_outbox.message_id IS
  'chat_message rows: the internal_messages row it carries; push_still_allowed skips it once deleted, erased or edited. No FK. Migration 112.';

CREATE OR REPLACE FUNCTION public.push_on_chat_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_msg    public.internal_messages;
  v_ch     public.chat_channels;
  v_author text;
  v_title  text;
  v_body   text;
  v_files  integer;
  v_fnames integer;
  v_url    text;
BEGIN
  -- Deferred to commit: read the row as it is now (deleted in the meantime → nothing).
  SELECT * INTO v_msg FROM public.internal_messages WHERE id = NEW.id;
  IF NOT FOUND OR v_msg.author_kind <> 'user' OR v_msg.author_id IS NULL
     OR v_msg.deleted_at IS NOT NULL OR v_msg.erased_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_ch FROM public.chat_channels WHERE id = v_msg.channel_id;

  SELECT nullif(btrim(p.full_name), '') INTO v_author
    FROM public.profiles p WHERE p.user_id = v_msg.author_id AND p.account_id = v_ch.account_id;
  v_author := coalesce(v_author, 'Someone');
  v_title := CASE WHEN v_ch.kind = 'dm' THEN v_author ELSE v_author || ' in #' || v_ch.name END;

  -- A files-only post's body is its file names joined by ', ' (composer.ts filesOnlyBody).
  SELECT count(*), coalesce(sum(char_length(btrim(a.name))), 0)
         + 2 * greatest(count(*) - 1, 0)
    INTO v_files, v_fnames
    FROM public.message_attachments a WHERE a.message_id = v_msg.id;
  v_body := public.chat_render_mentions(v_msg.body, v_ch.account_id);
  IF v_files > 0 THEN
    v_body := CASE
      WHEN char_length(btrim(v_msg.body)) = v_fnames
           AND NOT EXISTS (SELECT 1 FROM public.message_attachments a
                            WHERE a.message_id = v_msg.id AND position(btrim(a.name) IN v_msg.body) = 0)
        THEN '📎 Attachment'
      ELSE '📎 ' || v_body
    END;
  END IF;
  v_body := left(v_body, 140);
  v_url := '/chat/' || v_ch.id
           || CASE WHEN v_msg.thread_root_id IS NOT NULL THEN '?thread=' || v_msg.thread_root_id ELSE '' END;

  INSERT INTO public.push_outbox (user_id, account_id, kind, title, body, url, tag, channel_id, source_user_id, message_id)
  SELECT cm.user_id, v_ch.account_id, 'chat_message', left(v_title, 120), v_body, v_url, 'chat:' || v_ch.id,
         v_ch.id, v_msg.author_id, v_msg.id
    FROM public.chat_channel_members cm
   WHERE cm.channel_id = v_ch.id
     AND cm.user_id <> v_msg.author_id
     AND EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = cm.user_id)
     AND (NOT cm.muted
          OR EXISTS (SELECT 1 FROM public.message_mentions mm
                      WHERE mm.message_id = v_msg.id AND mm.user_id = cm.user_id))
     AND public.push_eligible(cm.user_id, v_ch.account_id, 'chat_message')
     AND public.chat_user_can_read_channel(v_ch.id, cm.user_id, true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push: chat message % not queued: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.push_still_allowed(o public.push_outbox)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.push_eligible(o.user_id, o.account_id, o.kind)
     AND CASE o.kind
           WHEN 'whatsapp_message' THEN EXISTS (
             SELECT 1 FROM public.conversations cv
              WHERE cv.id = o.conversation_id AND cv.account_id = o.account_id
                AND public.can_view_conversation_for_user(o.user_id, o.account_id, cv.user_id, cv.assigned_agent_id))
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
           ELSE true
         END
$$;
