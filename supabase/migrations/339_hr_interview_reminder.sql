-- ============================================================
-- 339_hr_interview_reminder.sql — the interview reminder gets its event.
--
-- 203 shipped an 'interview_reminder' trigger and template kind, but
-- nothing stored an interview time and nothing queued the reminder, so
-- the Automated messages screen kept the trigger switched off.
--
--   1. hr_conversations.interview_at (nullable): the recruitment chat's
--      next interview. A column on 200's per-chat row, not a table of its
--      own: a chat has one current interview, like its one stage.
--   2. hr_set_interview(conversation, at) sets or clears it. Same rights
--      as the other HR setters (hr_load_for_write: hr_can_see plus an HR
--      member, lead or admin of the inbox); recruitment chats only, open
--      only, never a past time. Logged in the chat's history as event
--      'interview' (reason = the new time in UTC ISO, NULL = cleared).
--      A change cancels the chat's undecided reminders (last_error
--      'interview_changed'): they were for the old time.
--   3. hr_automsg_enqueue_interview_reminders queues one reminder per
--      (chat, interview_at) once the time is within the next 24 hours
--      (the trigger has no hours setting), never for a past time; the
--      key 'interview:<chat>:<epoch>' makes it once, and a new time gets
--      a new key. params.interview_at carries the time for {slot}. It
--      runs from hr_automsg_enqueue_nudges, which the automations cron
--      already calls every minute. Every guard (trigger switch, consent,
--      opt-out, shared daily cap, approved template) is the claim's, as
--      for every other row.
--   4. hr_automsg_stale_reason answers 'interview_changed' for a reminder
--      whose chat no longer has that interview time ahead of it (moved,
--      cleared, or passed while the row was held), so it is cancelled,
--      never sent late.
--
-- Restates 302's hr_automsg_stale_reason and hr_automsg_enqueue_nudges:
-- apply in order, once (re-running 302 would undo them).
-- Mirrors: src/lib/hr/automsg/types.ts (STALE_REASONS,
-- INTERVIEW_REMINDER_HOURS), src/lib/hr/automsg/slot.ts.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. The interview time ----------

ALTER TABLE public.hr_conversations
  ADD COLUMN IF NOT EXISTS interview_at timestamptz NULL;

ALTER TABLE public.hr_stage_history
  DROP CONSTRAINT IF EXISTS hr_stage_history_event_check;
ALTER TABLE public.hr_stage_history
  ADD CONSTRAINT hr_stage_history_event_check
  CHECK (event IN ('open', 'stage', 'move', 'close', 'reopen', 'interview'));

-- ---------- 2. Setting it ----------

CREATE OR REPLACE FUNCTION public.hr_set_interview(p_conversation_id uuid, p_at timestamptz)
RETURNS public.hr_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  h hr_conversations;
BEGIN
  h := hr_load_for_write(p_conversation_id);
  IF h.closed_at IS NOT NULL THEN PERFORM hr_refuse('CLOSED', 'conversation is closed'); END IF;
  IF h.inbox <> 'recruiter' THEN
    PERFORM hr_refuse('INVALID', 'only a recruitment conversation has an interview time');
  END IF;
  IF p_at IS NOT NULL AND p_at <= now() THEN
    PERFORM hr_refuse('INVALID', 'the interview time is in the past');
  END IF;
  IF h.interview_at IS NOT DISTINCT FROM p_at THEN RETURN h; END IF;
  UPDATE hr_conversations x SET interview_at = p_at
   WHERE x.conversation_id = h.conversation_id;
  INSERT INTO hr_stage_history (conversation_id, account_id, event, from_stage, to_stage,
                                from_inbox, to_inbox, actor, reason)
  VALUES (h.conversation_id, h.account_id, 'interview', h.stage_key, h.stage_key, h.inbox, h.inbox,
          auth.uid(),
          to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  -- The undecided reminders were for the old time. A row being sent
  -- (claim_state set) is left to its claim.
  UPDATE hr_automsg_outbox o
     SET status = 'cancelled', hold_reason = NULL, last_error = 'interview_changed',
         updated_at = now()
   WHERE o.account_id = h.account_id AND o.conversation_id = h.conversation_id
     AND o.trigger = 'interview_reminder'
     AND o.status IN ('queued', 'held', 'failed') AND o.claim_state IS NULL;
  SELECT * INTO h FROM hr_conversations x WHERE x.conversation_id = p_conversation_id;
  RETURN h;
END;
$$;

COMMENT ON FUNCTION public.hr_set_interview(uuid, timestamptz) IS
  'Sets (or, with NULL, clears) a recruitment chat''s interview time; HR members of the inbox. Migration 339.';
REVOKE ALL ON FUNCTION public.hr_set_interview(uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.hr_set_interview(uuid, timestamptz) TO authenticated;

-- ---------- 3. Queueing the reminder ----------

CREATE OR REPLACE FUNCTION public.hr_automsg_enqueue_interview_reminders(
  p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := COALESCE(p_now, now());
  n integer;
BEGIN
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger,
                                 template_kind, language, params, status, dedupe_key,
                                 channel)
  SELECT h.account_id, h.conversation_id, c.contact_id, 'interview_reminder',
         COALESCE(t.template_kind, 'interview_reminder'), 'en',
         jsonb_build_object('interview_at',
           to_char(h.interview_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
         'queued',
         'interview:' || h.conversation_id || ':'
           || floor(extract(epoch FROM h.interview_at))::bigint
           || CASE WHEN t.channel IN ('rcs', 'sms') THEN '|' || t.channel ELSE '' END,
         t.channel
    FROM hr_automsg_triggers t
    JOIN hr_conversations h ON h.account_id = t.account_id
    JOIN conversations c ON c.id = h.conversation_id AND c.account_id = h.account_id
   WHERE t.trigger = 'interview_reminder' AND t.enabled
     AND h.inbox = 'recruiter' AND h.closed_at IS NULL
     AND h.interview_at > v_now
     AND h.interview_at <= v_now + interval '24 hours'
     AND c.personal_owner_id IS NULL AND c.contact_id IS NOT NULL
  ON CONFLICT ON CONSTRAINT hr_automsg_outbox_dedupe DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.hr_automsg_enqueue_interview_reminders(timestamptz) IS
  'Queues one interview reminder per (chat, interview_at) within the next 24 hours. Service role only. Migration 339.';
REVOKE ALL ON FUNCTION public.hr_automsg_enqueue_interview_reminders(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_automsg_enqueue_interview_reminders(timestamptz) TO service_role;

-- RESTATES 302 (its body unchanged) and adds the reminders: the cron's
-- one enqueue call queues both.
CREATE OR REPLACE FUNCTION public.hr_automsg_enqueue_nudges(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n integer;
BEGIN
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger,
                                 template_kind, language, params, status, dedupe_key,
                                 channel)
  SELECT h.account_id, h.conversation_id, c.contact_id, 'reply_overdue_nudge',
         COALESCE(t.template_kind, 'reply_nudge'), 'en', '{}'::jsonb, 'queued',
         'nudge:' || h.conversation_id || ':'
           || floor(extract(epoch FROM h.last_outbound_at))::bigint
           || CASE WHEN t.channel IN ('rcs', 'sms') THEN '|' || t.channel ELSE '' END,
         t.channel
    FROM hr_automsg_triggers t
    JOIN hr_conversations h ON h.account_id = t.account_id
    JOIN conversations c ON c.id = h.conversation_id AND c.account_id = h.account_id
    LEFT JOIN hr_workflow_rules r
      ON r.account_id = h.account_id AND r.key = 'no_activity_recruiter'
   WHERE t.trigger = 'reply_overdue_nudge' AND t.enabled
     AND h.inbox = 'recruiter' AND h.closed_at IS NULL
     AND h.reply_state = 'waiting'
     AND h.last_outbound_at <= COALESCE(p_now, now())
                               - make_interval(hours => COALESCE(r.after_hours, 72))
     -- Only waiting periods that began after the trigger was last switched
     -- or changed, and that became overdue within the last 7 days:
     -- switching it on must not nudge every chat that went quiet any time
     -- before. 302: the 7 days start when the rule's hours are up, not at
     -- our last message, or a rule above 168 hours never fires.
     AND h.last_outbound_at > t.updated_at
     AND h.last_outbound_at >= COALESCE(p_now, now())
                               - (make_interval(hours => COALESCE(r.after_hours, 72)) + interval '7 days')
     AND c.personal_owner_id IS NULL AND c.contact_id IS NOT NULL
  ON CONFLICT ON CONSTRAINT hr_automsg_outbox_dedupe DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- 339: and the interview reminders now due.
  RETURN n + hr_automsg_enqueue_interview_reminders(p_now);
END;
$function$;

-- ---------- 4. A reminder for a time that no longer holds ----------

-- RESTATES 302 (its two branches unchanged) and adds the reminder's.
CREATE OR REPLACE FUNCTION public.hr_automsg_stale_reason(p_trigger text, p_dedupe_key text, p_conversation_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_trigger LIKE 'stage\_%' THEN
      CASE WHEN EXISTS (SELECT 1 FROM hr_conversations h
                         WHERE h.conversation_id = p_conversation_id
                           AND h.inbox = 'recruiter'
                           AND 'stage_' || h.stage_key = p_trigger)
            -- 302: and this row is of the chat's newest move. A key whose
            -- chat has no history at all has nothing to be older than.
            AND split_part(p_dedupe_key, '|', 1) = COALESCE(
                  (SELECT 'hist:' || x.id FROM hr_stage_history x
                    WHERE x.conversation_id = p_conversation_id
                      AND x.event IN ('open', 'stage', 'move')
                    ORDER BY x.id DESC LIMIT 1),
                  split_part(p_dedupe_key, '|', 1))
           THEN NULL ELSE 'stage_changed' END
    WHEN p_trigger = 'reply_overdue_nudge' THEN
      CASE WHEN EXISTS (SELECT 1 FROM hr_conversations h
                         WHERE h.conversation_id = p_conversation_id
                           AND h.reply_state = 'waiting'
                           AND split_part(p_dedupe_key, '|', 1)
                               = 'nudge:' || h.conversation_id || ':'
                                 || floor(extract(epoch FROM h.last_outbound_at))::bigint)
           THEN NULL ELSE 'no_longer_waiting' END
    -- 339: the chat still has this interview time, and it is ahead.
    WHEN p_trigger = 'interview_reminder' THEN
      CASE WHEN EXISTS (SELECT 1 FROM hr_conversations h
                         WHERE h.conversation_id = p_conversation_id
                           AND h.inbox = 'recruiter'
                           AND h.interview_at > now()
                           AND split_part(p_dedupe_key, '|', 1)
                               = 'interview:' || h.conversation_id || ':'
                                 || floor(extract(epoch FROM h.interview_at))::bigint)
           THEN NULL ELSE 'interview_changed' END
  END
$function$;
