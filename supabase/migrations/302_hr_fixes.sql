-- ============================================================
-- 302_hr_fixes.sql — five HR faults.
--
--   1. Two interview messages after a stage correction. With the messages
--      held (quiet hours, kill switch), interview -> manager_interview ->
--      interview left two rows of one trigger, both "still true" by the
--      stage name alone. hr_automsg_stale_reason now also wants a stage
--      row to be of the chat's newest open / stage / move.
--   2. A "no activity" rule above 168 hours never nudged: the window was
--      the last 7 days since our last message. It is now 7 days since the
--      message became overdue.
--   3. More than 100 held messages starved newer held ones: a drain reads
--      one page. hr_automsg_due_page leaves out the ids already seen, so
--      the drain can read on. A new name, not a parameter of
--      hr_automsg_due: re-running 263 would bring the two-argument one
--      back beside it and PostgREST would refuse both as ambiguous. The
--      old build keeps calling hr_automsg_due, which has one body with it.
--   4. One chat's error undid the whole hr_sweep, every tick again.
--   5. An HR line connected by somebody outside HR made candidates the HR
--      inbox never shows: hr_lines_set refuses to add one
--      (LINE_OWNER_NOT_HR); lines already saved are left alone.
--
-- Every other body is the latest one (275, 226, 263, 200, 213), with its
-- grants and search_path unchanged. Those files re-run revert theirs:
-- apply in order.
-- Mirrors: src/lib/hr/types.ts (HR_ERROR_CODES), src/lib/hr/lines-view.ts.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. Only the newest stage row is still true ----------

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
  END
$function$;

-- ---------- 2. Nudges of a long rule ----------

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
  RETURN n;
END;
$function$;

-- ---------- 3. Pages of due messages ----------

CREATE OR REPLACE FUNCTION public.hr_automsg_due_page(p_limit integer, p_account_id uuid, p_exclude uuid[])
 RETURNS SETOF hr_automsg_outbox
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- 263: channels take turns, each in 203's order, so a backlog on one
  -- (SMS waiting for the gateway) cannot starve another. With one channel
  -- this is 203's order exactly.
  SELECT o.* FROM hr_automsg_outbox o
    JOIN (SELECT x.id, row_number() OVER (
                   PARTITION BY x.channel
                   ORDER BY CASE x.status WHEN 'queued' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
                            x.created_at, x.id) AS turn
            FROM hr_automsg_outbox x
           WHERE x.status IN ('queued', 'held', 'failed') AND x.claim_state IS NULL AND x.attempts < 3
             AND (p_account_id IS NULL OR x.account_id = p_account_id)
             AND x.id <> ALL (COALESCE(p_exclude, '{}'::uuid[]))) q ON q.id = o.id
   -- Queued first, then failed, then held, each oldest first: many held
   -- rows must not starve newly queued ones under the limit.
   ORDER BY q.turn, CASE o.status WHEN 'queued' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
            o.created_at, o.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
$function$;

COMMENT ON FUNCTION public.hr_automsg_due_page(integer, uuid, uuid[]) IS
  'The next page of undecided HR messages, in hr_automsg_due''s order, without the ids in p_exclude. Service role only. Migration 302.';
REVOKE ALL ON FUNCTION public.hr_automsg_due_page(integer, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hr_automsg_due_page(integer, uuid, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.hr_automsg_due(p_limit integer DEFAULT 100, p_account_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF hr_automsg_outbox
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- 302: one body, in hr_automsg_due_page.
  SELECT * FROM hr_automsg_due_page(p_limit, p_account_id, NULL)
$function$;

-- ---------- 4. One chat's error is its own ----------

CREATE OR REPLACE FUNCTION public.hr_sweep(p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now timestamptz := COALESCE(p_now, now());
  r hr_workflow_rules;
  h hr_conversations;
  n integer;
  v_created integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR r IN SELECT * FROM hr_workflow_rules w
            WHERE w.enabled AND w.trigger_kind IN ('reply_overdue', 'no_activity')
            ORDER BY w.account_id, w.key
  LOOP
    FOR h IN SELECT * FROM hr_conversations x
              WHERE x.account_id = r.account_id AND x.inbox = r.inbox AND x.closed_at IS NULL
                AND ((r.trigger_kind = 'reply_overdue'
                      AND x.reply_state IN ('new', 'reply_due')
                      AND x.last_inbound_at IS NOT NULL
                      AND x.last_inbound_at < v_now - make_interval(hours => r.after_hours))
                  OR (r.trigger_kind = 'no_activity'
                      AND x.inbox = 'recruiter'
                      AND x.reply_state = 'waiting'
                      AND x.last_outbound_at < v_now - make_interval(hours => r.after_hours)))
              ORDER BY x.conversation_id
    LOOP
      -- 302: one chat's error must not undo the whole sweep. The once-only
      -- claim (hr_rule_fired) is written inside hr_apply_rule, so it rolls
      -- back with the failed chat and the next tick tries that chat again.
      BEGIN
        n := hr_apply_rule(r, h.conversation_id,
               format('%s:%s', r.trigger_kind,
                      extract(epoch FROM CASE WHEN r.trigger_kind = 'reply_overdue'
                                              THEN h.last_inbound_at ELSE h.last_outbound_at END)),
               v_now);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'hr_sweep: rule % on chat %: % (%)', r.key, h.conversation_id, SQLERRM, SQLSTATE;
        CONTINUE;
      END;
      IF r.action = 'task' THEN
        IF n > 0 THEN v_created := v_created + 1; ELSE v_skipped := v_skipped + 1; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
END;
$function$;

-- ---------- 5. A new HR line's owner is in HR ----------

CREATE OR REPLACE FUNCTION public.hr_lines_set(p_channel_ids uuid[], p_auto_open boolean, p_expected timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid := current_account_id();
  v_ids uuid[] := COALESCE(p_channel_ids, '{}'::uuid[]);
  v_current timestamptz;
BEGIN
  IF v_account IS NULL OR hr_role(v_account, v_uid, 'recruiter') IS DISTINCT FROM 'admin' THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only an owner or admin may change the HR lines');
  END IF;
  IF p_auto_open IS NULL THEN
    PERFORM hr_refuse('INVALID', 'auto_open is true or false');
  END IF;
  IF array_position(v_ids, NULL) IS NOT NULL OR EXISTS (
       SELECT 1 FROM unnest(v_ids) AS x(id)
        WHERE NOT EXISTS (SELECT 1 FROM whatsapp_config w
                           WHERE w.id = x.id AND w.account_id = v_account)) THEN
    PERFORM hr_refuse('INVALID', 'every HR line must be a WhatsApp number of this workspace');
  END IF;

  -- The settings row first: its row lock serialises two admins saving at
  -- once, and its updated_at is the version the caller loaded. A save
  -- made against anything older is refused before any write, so admin
  -- A's save never silently undoes admin B's.
  SELECT s.updated_at INTO v_current
    FROM hr_line_settings s WHERE s.account_id = v_account
     FOR UPDATE;
  IF v_current IS DISTINCT FROM p_expected THEN
    PERFORM hr_refuse('STALE', 'the HR lines changed since they were loaded');
  END IF;

  -- 302: a chat on an HR line belongs to the number's owner, and only an
  -- HR owner's chats are in the HR inbox: anybody else's line made
  -- candidates HR does not see. Only for a number being added; a line
  -- already saved stays until somebody unticks it.
  IF EXISTS (
       SELECT 1 FROM unnest(v_ids) AS x(id)
         JOIN whatsapp_config w ON w.id = x.id AND w.account_id = v_account
        WHERE NOT EXISTS (SELECT 1 FROM hr_lines l
                           WHERE l.channel_id = x.id AND l.account_id = v_account)
          AND NOT EXISTS (SELECT 1 FROM profiles p
                           WHERE p.user_id = w.user_id AND p.account_id = v_account
                             AND p.department = 'hr')) THEN
    PERFORM hr_refuse('LINE_OWNER_NOT_HR', 'a new HR line must be connected by somebody in the HR department');
  END IF;

  -- clock_timestamp(), not now(): two saves in one transaction still get
  -- two versions.
  IF v_current IS NULL THEN
    INSERT INTO hr_line_settings (account_id, auto_open_recruiter, updated_at, updated_by)
    VALUES (v_account, p_auto_open, clock_timestamp(), v_uid)
    ON CONFLICT (account_id) DO NOTHING;
    IF NOT FOUND THEN  -- a racing first save won
      PERFORM hr_refuse('STALE', 'the HR lines changed since they were loaded');
    END IF;
  ELSE
    UPDATE hr_line_settings s
       SET auto_open_recruiter = p_auto_open,
           updated_at = clock_timestamp(),
           updated_by = v_uid
     WHERE s.account_id = v_account;
  END IF;

  DELETE FROM hr_lines l
   WHERE l.account_id = v_account AND NOT (l.channel_id = ANY (v_ids));
  INSERT INTO hr_lines (channel_id, account_id, created_by)
  SELECT DISTINCT x.id, v_account, v_uid FROM unnest(v_ids) AS x(id)
  ON CONFLICT (channel_id) DO NOTHING;

  RETURN hr_lines_json(v_account);
END;
$function$;

RESET lock_timeout;
