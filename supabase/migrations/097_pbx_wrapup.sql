-- ============================================================
-- 097: the call wrap-up (module 015 §7.3)
-- ============================================================
-- After a call, the person on it has two minutes to add the outcome
-- and a note (the in-call panel's wrap-up; the window is WRAPUP_MS in
-- src/lib/pbx/call-ui.ts, and src/lib/pbx/__tests__/wrap-up.test.ts
-- reads this file to keep the two equal). When the workspace makes outcomes mandatory
-- (pbx_settings.mandatory_disposition, 089) and the window passes with
-- none recorded, the PBX cron (runPbxCron in src/lib/pbx/housekeeping.ts)
-- rings ONE bell, 'call_outcome_due', for the person on the call.
--
-- 1. calls.outcome_reminded_at: stamped in the same statement that
--    rings the bell, so a reminded call is never reminded again. A
--    column rather than a calls.meta key: the event processor rewrites
--    meta from what it read (callMeta in process.ts), and its upserts
--    never name this column, so a late CDR cannot clear the stamp.
-- 2. pbx_outcome_reminders(): the cron's sweep (service role only).
--    Only calls that ended in the last hour AND after outcomes were made
--    mandatory (5.) are considered, so switching them on never rings for
--    the history before it. A reload re-opens an owed wrap-up over the
--    same window (wrapUpCutoff, WRAPUP_OWED_MS).
-- 3. pbx_set_mandatory_disposition(): team leaders and up switch the
--    one setting; every other phone setting stays admin-only (089's
--    pbx_settings RLS is unchanged).
-- 4. notifications_type_check gains 'call_outcome_due' (085 is the
--    last list; every type it names is kept).
-- 5. pbx_settings.mandatory_disposition_since: when outcomes were last
--    made mandatory. A trigger keeps it for every writer (the settings
--    route, 3., the SQL editor): set when mandatory_disposition goes on,
--    kept while it stays on, cleared when it goes off; a value written
--    to it is ignored. A workspace that already had them on is stamped
--    once, now: nothing before this migration is owed.
--
-- Re-runnable.
-- ============================================================

-- ---------- 1. The stamp ----------
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS outcome_reminded_at timestamptz NULL;
COMMENT ON COLUMN public.calls.outcome_reminded_at IS
  'When the person on the call was reminded to add its outcome (pbx_outcome_reminders). Set once; migration 097.';

-- The sweep's candidates: answered, no outcome yet, never reminded.
CREATE INDEX IF NOT EXISTS calls_outcome_due_idx ON public.calls (ended_at)
  WHERE disposition IS NULL AND outcome_reminded_at IS NULL
    AND answered_at IS NOT NULL AND user_id IS NOT NULL;

-- ---------- 5. Since when outcomes are mandatory ----------
ALTER TABLE public.pbx_settings
  ADD COLUMN IF NOT EXISTS mandatory_disposition_since timestamptz NULL;
COMMENT ON COLUMN public.pbx_settings.mandatory_disposition_since IS
  'When mandatory_disposition last went on (NULL while off); set by pbx_settings_mandatory_since, never by a writer. The outcome reminder and a reload''s re-open owe nothing that ended before it. Migration 097.';

CREATE OR REPLACE FUNCTION public.pbx_settings_mandatory_since()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT NEW.mandatory_disposition THEN
    NEW.mandatory_disposition_since := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT OLD.mandatory_disposition
        OR OLD.mandatory_disposition_since IS NULL THEN
    NEW.mandatory_disposition_since := now();
  ELSE
    NEW.mandatory_disposition_since := OLD.mandatory_disposition_since;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pbx_settings_mandatory_since() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS pbx_settings_mandatory_since ON public.pbx_settings;
CREATE TRIGGER pbx_settings_mandatory_since
  BEFORE INSERT OR UPDATE ON public.pbx_settings
  FOR EACH ROW EXECUTE FUNCTION public.pbx_settings_mandatory_since();

-- Already on before 097: owed from now on (the trigger stamps it).
UPDATE public.pbx_settings
   SET mandatory_disposition = true
 WHERE mandatory_disposition AND mandatory_disposition_since IS NULL;

-- ---------- 4. The bell ----------
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
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
    'call_outcome_due'
  ));

-- ---------- 2. The sweep ----------
-- A call is due when its workspace makes outcomes mandatory, the person
-- on it answered it (user_id, answered_at), it has a customer
-- (not internal), is not erased, has no outcome, and ended between an
-- hour and two minutes ago, after outcomes were made mandatory. Each due call is stamped and, while its
-- person is still a live staff member of that workspace, gets one bell
-- linking to the customer. SKIP LOCKED: overlapping sweeps share the
-- work and never ring twice. Returns the bells rung.
CREATE OR REPLACE FUNCTION public.pbx_outcome_reminders(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rung integer;
BEGIN
  WITH due AS (
    SELECT c.id
      FROM calls c
      JOIN pbx_settings s ON s.account_id = c.account_id AND s.mandatory_disposition
     WHERE c.outcome_reminded_at IS NULL
       AND c.disposition IS NULL
       AND c.answered_at IS NOT NULL
       AND c.user_id IS NOT NULL
       AND c.direction <> 'internal'
       AND c.erased_at IS NULL
       AND c.ended_at <= now() - interval '2 minutes'
       AND c.ended_at > now() - interval '1 hour'
       AND c.ended_at > s.mandatory_disposition_since
     ORDER BY c.ended_at
     LIMIT GREATEST(COALESCE(p_limit, 200), 1)
     FOR UPDATE OF c SKIP LOCKED
  ), stamped AS (
    UPDATE calls c
       SET outcome_reminded_at = now()
      FROM due
     WHERE c.id = due.id
    RETURNING c.id, c.account_id, c.user_id, c.contact_id, c.conversation_id, c.remote_number
  )
  INSERT INTO notifications (account_id, user_id, type, contact_id, conversation_id,
                             actor_user_id, title, body, meta)
  SELECT st.account_id, st.user_id, 'call_outcome_due', ct.id,
         CASE WHEN ct.id IS NOT NULL THEN st.conversation_id END, NULL,
         'Add the outcome for your call with '
           || COALESCE(NULLIF(btrim(ct.name), ''), '+' || NULLIF(st.remote_number, ''), 'an unknown caller'),
         NULL,
         jsonb_build_object('call_id', st.id, 'contact_id', ct.id)
    FROM stamped st
    LEFT JOIN contacts ct ON ct.id = st.contact_id AND ct.account_id = st.account_id
   WHERE EXISTS (
     SELECT 1 FROM profiles p
      WHERE p.user_id = st.user_id
        AND p.account_id = st.account_id
        AND p.deactivated_at IS NULL
        AND p.account_role <> 'bank_guest');
  GET DIAGNOSTICS v_rung = ROW_COUNT;
  RETURN v_rung;
END;
$$;
COMMENT ON FUNCTION public.pbx_outcome_reminders(integer) IS
  'PBX cron: one call_outcome_due bell per answered call left without an outcome for 2 minutes, where outcomes are mandatory; stamps calls.outcome_reminded_at. Service role only. Migration 097.';

-- ---------- 3. Leaders switch mandatory outcomes ----------
CREATE OR REPLACE FUNCTION public.pbx_set_mandatory_disposition(p_on boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := current_account_id();
BEGIN
  IF auth.uid() IS NULL OR v_account IS NULL OR COALESCE(current_role_rank(), 0) < 3 THEN
    RAISE EXCEPTION 'Only a team leader or above can make call outcomes mandatory'
      USING ERRCODE = '42501';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'Mandatory outcomes must be on or off' USING ERRCODE = '22023';
  END IF;
  -- pbx_settings_stamp records the caller as updated_by.
  INSERT INTO pbx_settings (account_id, mandatory_disposition)
  VALUES (v_account, p_on)
  ON CONFLICT (account_id) DO UPDATE SET mandatory_disposition = EXCLUDED.mandatory_disposition;
END;
$$;
COMMENT ON FUNCTION public.pbx_set_mandatory_disposition(boolean) IS
  'Team leader and up: switch pbx_settings.mandatory_disposition of the caller''s active workspace, and nothing else. Migration 097.';

-- ---------- Privileges ----------
REVOKE ALL ON FUNCTION public.pbx_outcome_reminders(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pbx_outcome_reminders(integer) TO service_role;
REVOKE ALL ON FUNCTION public.pbx_set_mandatory_disposition(boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.pbx_set_mandatory_disposition(boolean) TO authenticated;
