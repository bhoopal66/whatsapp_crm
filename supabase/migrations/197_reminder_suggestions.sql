-- ============================================================
-- 197_reminder_suggestions.sql — reminder suggestions on chat
-- messages, and a task reminder at the moment it falls due
-- (docs/jev-insights.md "Reminder suggestions", src/lib/reminders/*).
--
-- 1. ai_insight_settings.reminder_suggest_enabled (default false). The
--    switch for the whole feature; off means nothing is judged and no
--    suggestion is stored, exactly as before 197.
--
-- 2. message_reminder_suggestions. A chat message that names a later
--    time ("call me tomorrow at 3") gets at most one row (message_id is
--    UNIQUE): who wrote it, what it is about, the instant meant, the
--    words that named it and Jev's probability. The inbox shows "Add
--    reminder" under the message; adding it files a follow-up task
--    (tasks, 085) and marks the row 'added' with task_id, dismissing it
--    marks it 'dismissed'.
--    Clients only READ. Every write is the service role's: the
--    background judgment inserts, and the add/dismiss route checks the
--    caller before updating. So authenticated gets SELECT and nothing
--    else. The one policy is "same account, and the caller can see the
--    chat": its EXISTS runs under the caller's own conversations RLS, so
--    whoever sees the chat (admins, own and assigned agents, leaders'
--    teams, coordinator shares, personal-chat owners) sees its
--    suggestions, and nobody else does. A bank guest's
--    current_account_id() is NULL, so a guest sees none.
--    Deleting the task leaves the row (task_id goes NULL); deleting the
--    message, chat or account removes it. The CHECK lists equal
--    REMINDER_SIDES / REMINDER_KINDS / REMINDER_SUGGESTION_STATUSES in
--    src/lib/reminders/types.ts (types.test.ts reads this file).
--    The table is in supabase_realtime so the inbox picks a suggestion
--    up the moment it lands (realtime replays RLS per subscriber).
--
-- 3. calendar_reminder_sweep (108, 112) also rings task_due WHEN a task
--    falls due, not only 15 minutes before. 112's body plus:
--    * a due-now branch, key 'tk0:<task>:<epoch of due_at>:<assignee>',
--      in the 5 minutes from due_at, with the 15-minute branch's
--      filters (open, assigned, live staff). A snoozed task (due_at
--      moved) has a new epoch, so it rings again at its new time.
--    * the 15-minute key is unchanged ('tk:…'), so keys already sent
--      keep deduping; its body now says 'Due in 15 minutes · <time>'.
--    * task_due and meeting_reminder meta carry 'offset' (a number:
--      15 or 0 for tasks, 10 or 0 for meetings) so a client can tell
--      the two bells apart, as event_reminder's meta already does.
--    Signature, LANGUAGE, SECURITY DEFINER, search_path, the 14-day
--    purge and the claimed/rung shape are 112's; privileges are
--    restated (service role only).
--
-- 4. push_on_notification (109) tags a task_due push 'task:<task id>'
--    instead of 'bell:<row id>'. Reminder pushes now stay on screen
--    until dismissed (public/sw.js), so per-row tags would leave a
--    task's heads-up and its due-now ring as two sticky notifications;
--    with one tag per task the due-now push replaces the heads-up (and
--    buzzes again: renotify), and a snoozed task's next ring replaces
--    the last. Every other type keeps 'bell:<row id>'.
--
-- Apply in order, once: re-applying 112 after 197 would drop the due-now
-- ring and the offset meta (part 3), and re-applying 109 would put the
-- per-row push tag back (part 4).
--
-- The sweep reads RLS-forced tables, so, as 108 and 112, apply as a
-- superuser or BYPASSRLS role.
--
-- Re-runnable: ADD COLUMN / CREATE ... IF NOT EXISTS, guarded policy
-- and publication, CREATE OR REPLACE. Applying it twice changes nothing.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '197 must be applied by a superuser or BYPASSRLS role (calendar_reminder_sweep reads RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. The switch ----------

ALTER TABLE public.ai_insight_settings
  ADD COLUMN IF NOT EXISTS reminder_suggest_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ai_insight_settings.reminder_suggest_enabled IS
  'Suggest a reminder under a chat message that names a later time (migration 197). Off: nothing is judged or stored.';

-- ---------- 2. The suggestions ----------

CREATE TABLE IF NOT EXISTS public.message_reminder_suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  side            text NOT NULL CHECK (side IN ('customer', 'agent')),
  kind            text NOT NULL CHECK (kind IN ('call', 'documents', 'payment', 'meeting', 'follow_up')),
  due_at          timestamptz NOT NULL,
  date_only       boolean NOT NULL DEFAULT false,
  phrase          text NOT NULL CHECK (char_length(phrase) BETWEEN 1 AND 120),
  p               real NOT NULL CHECK (p >= 0 AND p <= 1),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'added', 'dismissed')),
  task_id         uuid NULL REFERENCES public.tasks(id) ON DELETE SET NULL,
  acted_by        uuid NULL,
  acted_at        timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.message_reminder_suggestions IS
  'One reminder suggestion per chat message that names a later time (migration 197). Clients read (whoever can see the chat); only the service role writes.';
COMMENT ON COLUMN public.message_reminder_suggestions.side IS
  'Who wrote the message: customer or agent.';
COMMENT ON COLUMN public.message_reminder_suggestions.kind IS
  'What the reminder is about, as Jev judged it.';
COMMENT ON COLUMN public.message_reminder_suggestions.due_at IS
  'The instant the message means.';
COMMENT ON COLUMN public.message_reminder_suggestions.date_only IS
  'The message gave a day but no time of day; due_at is 09:00 in the account''s time zone.';
COMMENT ON COLUMN public.message_reminder_suggestions.phrase IS
  'The words of the message that name the time (1 to 120 characters).';
COMMENT ON COLUMN public.message_reminder_suggestions.p IS
  'Jev''s probability that this is something to be reminded of.';
COMMENT ON COLUMN public.message_reminder_suggestions.status IS
  'open, added (task_id is the follow-up task) or dismissed.';
COMMENT ON COLUMN public.message_reminder_suggestions.task_id IS
  'The follow-up task it became; NULL again if that task is deleted.';
COMMENT ON COLUMN public.message_reminder_suggestions.acted_by IS
  'auth user id of the person who added or dismissed it. No FK.';

CREATE INDEX IF NOT EXISTS message_reminder_suggestions_conv_idx
  ON public.message_reminder_suggestions (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_reminder_suggestions_task_idx
  ON public.message_reminder_suggestions (task_id) WHERE task_id IS NOT NULL;

ALTER TABLE public.message_reminder_suggestions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.message_reminder_suggestions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.message_reminder_suggestions TO authenticated;
GRANT ALL ON public.message_reminder_suggestions TO service_role;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'message_reminder_suggestions'
      AND policyname = 'message_reminder_suggestions_select'
  ) THEN
    CREATE POLICY message_reminder_suggestions_select
      ON public.message_reminder_suggestions
      FOR SELECT TO authenticated
      USING (
        account_id = public.current_account_id()
        AND EXISTS (SELECT 1 FROM public.conversations c
                     WHERE c.id = message_reminder_suggestions.conversation_id)
      );
  END IF;
END $$;

COMMENT ON POLICY message_reminder_suggestions_select ON public.message_reminder_suggestions IS
  'Same account, and the caller can see the chat (the EXISTS runs under the caller''s conversations RLS). Migration 197.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'message_reminder_suggestions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reminder_suggestions;
  END IF;
END $$;

-- ---------- 3. Tasks ring when due ----------

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
               jsonb_build_object('meeting_id', m.id, 'offset', o.off)
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
               'Due in 15 minutes · ' || calendar_time_label(t.account_id, t.due_at),
               t.contact_id, t.conversation_id,
               jsonb_build_object('task_id', t.id, 'offset', 15)
          FROM tasks t
         WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
           AND t.due_at > p_now + interval '10 minutes'
           AND t.due_at <= p_now + interval '15 minutes'
           AND calendar_is_live_staff(t.assigned_to, t.account_id)
        UNION ALL
        SELECT 'tk0:' || t.id || ':' || floor(extract(epoch FROM t.due_at))::bigint || ':' || t.assigned_to,
               t.assigned_to, t.account_id, 'task_due',
               t.title,
               'Due now · ' || calendar_time_label(t.account_id, t.due_at),
               t.contact_id, t.conversation_id,
               jsonb_build_object('task_id', t.id, 'offset', 0)
          FROM tasks t
         WHERE t.status = 'open' AND t.assigned_to IS NOT NULL
           AND t.due_at <= p_now
           AND p_now < t.due_at + interval '5 minutes'
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
  'Service role. Rings due event_reminder (one-off events), meeting_reminder (10 and 0 min) and task_due (15 min before and when due) bells once each; meta carries the offset. Returns how many. Migrations 108, 112, 197.';

REVOKE ALL ON FUNCTION public.calendar_reminder_sweep(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_reminder_sweep(timestamptz) TO service_role;

-- ---------- 4. One phone notification per task ----------

CREATE OR REPLACE FUNCTION public.push_on_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.push_enqueue(NEW.user_id, NEW.account_id, NEW.type, NEW.title, NEW.body,
                              public.push_bell_url(NEW),
                              CASE WHEN NEW.type = 'task_due' AND (NEW.meta ->> 'task_id') IS NOT NULL
                                   THEN 'task:' || (NEW.meta ->> 'task_id')
                                   ELSE 'bell:' || NEW.id END);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push: bell row % not queued: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.push_on_notification() IS
  'AFTER INSERT on notifications: queues the bell row as a push. Tag ''task:<task id>'' for task_due (one device notification per task), ''bell:<row id>'' otherwise. Migrations 109, 197.';

REVOKE ALL ON FUNCTION public.push_on_notification() FROM PUBLIC, anon, authenticated;
