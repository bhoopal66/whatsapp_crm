-- ============================================================
-- 267_submission_group_fixes.sql — submission group rules found missing
-- by the 2026-11-23 audit
--
--  1. A status after a final one (a correction, "disbursed" after
--     "approved") was stored nowhere: sg_note_submission_status wrote on
--     an ACTIVE group only. It now writes on an ENDED group too, with
--     the time (submission_status_at), and a status that comes after the
--     group ended or the case closed goes on the case timeline
--     (case_detail_log, field 'submission_status'). The case's stage
--     still moves only by case_apply_submission_status, unchanged: a
--     closed case is never reopened or re-decided by a status.
--  2. A customer writing into a group that is ended but still open on
--     WhatsApp (170's two-day hold) rang nobody. The bell goes to the
--     live agent / coordinators whose access was open when it ended;
--     nobody left: the case's agent; none: the owners and admins. At
--     most one per person per group while unread, and per 30 minutes.
--     Those messages count as unread for a person with such an unread
--     bell, and stop counting when the bell is read: an ENDED group has
--     no read marker (173) and an agent cannot open one.
--  3. A send whose gateway call timed out was settled 'failed' and stayed
--     so when WhatsApp's echo proved it went out. sg_reconcile_echo gives
--     the echo to the oldest own row of the last 15 minutes with that
--     text, pending or failed. The echo cannot say which of two identical
--     sends it is, so sg_settle_send, whose id comes from the gateway's
--     own answer, corrects a wrong guess: the id goes to the row it
--     belongs to, and the twin that held it waits again (its own sender,
--     its echo or the 10-minute sweep settles it).
--
-- Restates bodies of 115 (sg_note_submission_status, sg_settle_send,
-- submission_group_messages_settle), 124 (case_timeline), 142
-- (submission_groups_guard) and 173 (sg_ring_customer_message,
-- sg_unread_by_group), and widens 122's case_detail_log_field_check:
-- apply in order, once. Additive for the previous build: no signature
-- changes. Re-runnable. Asserted by supabase/ci/verify-sg-fixes.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '267 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regclass('public.submission_group_reads') IS NULL THEN
    RAISE EXCEPTION '267: apply 173_submission_group_reads.sql first (submission_group_reads)';
  END IF;
END $$;

-- ---------- 1. A status after a final one ----------

ALTER TABLE public.submission_groups ADD COLUMN IF NOT EXISTS submission_status_at timestamptz NULL;
COMMENT ON COLUMN public.submission_groups.submission_status_at IS
  'When submission_status last changed; NULL for a status stored before migration 267.';

DO $$ BEGIN
  ALTER TABLE public.case_detail_log DROP CONSTRAINT IF EXISTS case_detail_log_field_check;
  ALTER TABLE public.case_detail_log ADD CONSTRAINT case_detail_log_field_check
    CHECK (field IN ('bank_code', 'product', 'amount', 'priority', 'due_at', 'submission_status'));
END $$;

-- 142's body; an ENDED group's submission status may still change.
CREATE OR REPLACE FUNCTION public.submission_groups_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_account  uuid;
  v_provider text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.wa_mode = 'none' THEN
      IF NEW.channel_id IS NOT NULL THEN
        RAISE EXCEPTION 'public.submission_groups: a submission without a WhatsApp group has no hosting number'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT w.account_id, w.provider INTO v_account, v_provider
        FROM public.whatsapp_config w WHERE w.id = NEW.channel_id;
      IF v_account IS DISTINCT FROM NEW.account_id OR v_provider IS DISTINCT FROM 'whapi' THEN
        RAISE EXCEPTION 'public.submission_groups: the hosting number must be a Whapi number of the group''s workspace'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.contact_id IS NULL THEN
      RAISE EXCEPTION 'public.submission_groups: a group is inserted with its customer contact'
        USING ERRCODE = 'not_null_violation';
    END IF;
    IF NEW.status <> 'ACTIVE' OR NEW.wa_group_id IS NOT NULL OR NEW.wa_create_claim IS NOT NULL THEN
      RAISE EXCEPTION 'public.submission_groups: a group is inserted ACTIVE, unclaimed and without a WhatsApp group'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id)
       AND (NEW.channel_id IS NOT DISTINCT FROM OLD.channel_id
            OR (NEW.channel_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.whatsapp_config w WHERE w.id = OLD.channel_id)))
       AND (NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id
            OR (NEW.contact_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = OLD.contact_id)))
       AND (to_jsonb(NEW) - 'channel_id' - 'contact_id') = (to_jsonb(OLD) - 'channel_id' - 'contact_id') THEN
      RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.submission_ref IS DISTINCT FROM OLD.submission_ref
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.wa_mode IS DISTINCT FROM OLD.wa_mode  -- 136
       OR NEW.coordinator_phones IS DISTINCT FROM OLD.coordinator_phones THEN  -- 142
      RAISE EXCEPTION 'public.submission_groups: the group identity is fixed (id, account_id, submission_ref, contact_id, channel_id, wa_mode, coordinator_phones; UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.wa_mode = 'none' AND (NEW.wa_group_id IS NOT NULL OR NEW.wa_create_claim IS NOT NULL) THEN
      RAISE EXCEPTION 'public.submission_groups: a submission without a WhatsApp group never gets one (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.wa_group_id IS NOT NULL AND NEW.wa_group_id IS DISTINCT FROM OLD.wa_group_id THEN
      RAISE EXCEPTION 'public.submission_groups: the WhatsApp group id is fixed once set (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.wa_group_id IS NULL AND NEW.wa_group_id IS NOT NULL
       AND (OLD.status <> 'ACTIVE' OR OLD.wa_create_claim IS NULL) THEN
      RAISE EXCEPTION 'public.submission_groups: attaching a WhatsApp group requires a create claim (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status = 'ACTIVE' THEN
      RETURN NEW;
    END IF;
    -- 267: a later status of the submission is still recorded.
    IF NEW.submission_status IS NOT NULL
       AND (to_jsonb(NEW) - 'submission_status' - 'submission_status_at')
         = (to_jsonb(OLD) - 'submission_status' - 'submission_status_at') THEN
      RETURN NEW;
    END IF;
    IF OLD.wa_closed_at IS NULL
       AND (to_jsonb(NEW) - 'wa_closed_at' - 'wa_close_error') = (to_jsonb(OLD) - 'wa_closed_at' - 'wa_close_error') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'public.submission_groups: % refused (groups are archived, never changed after ENDED or deleted)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- 115's, on an ENDED group too. A repeat of the stored status changes
-- nothing and writes nothing. True when the group exists (ACTIVE, or
-- ENDED with a different status).
CREATE OR REPLACE FUNCTION public.sg_note_submission_status(p_group uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  g public.submission_groups%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.submission_groups WHERE id = p_group FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF g.submission_status IS NOT DISTINCT FROM p_status THEN
    RETURN g.status = 'ACTIVE';
  END IF;
  UPDATE public.submission_groups
     SET submission_status = p_status, submission_status_at = clock_timestamp()
   WHERE id = p_group;
  INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
  SELECT c.id, c.account_id, 'submission_status', g.submission_status, p_status, NULL, 'api'
    FROM public.cases c
   WHERE c.group_id = p_group
     AND (g.status = 'ENDED' OR c.closed_at IS NOT NULL);
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.sg_note_submission_status(uuid, text) IS
  'Stores a submission''s latest status on its group, ENDED included (267); one that comes after the group ended or the case closed is also logged on the case.';

-- 124's body, plus 267's later statuses.
CREATE OR REPLACE FUNCTION public.case_timeline(p_actor uuid, p_case uuid)
RETURNS TABLE (at timestamptz, kind text, ref_id text, actor uuid, summary text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT coalesce(public.case_can_read(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'case %: % may not read it', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY
    SELECT e.at, e.kind, e.ref_id, e.actor, e.summary FROM (
      SELECT h.changed_at AS at, 'stage'::text AS kind, h.id::text AS ref_id, h.actor_id AS actor,
             coalesce(h.from_stage || ' -> ', '') || h.to_stage || coalesce(' (' || h.outcome || ')', '') AS summary,
             h.id AS sk
        FROM public.case_stage_history h WHERE h.case_id = p_case
      UNION ALL
      SELECT t.created_at, 'task', t.id::text, t.created_by, t.title, 0::bigint
        FROM public.case_tasks t WHERE t.case_id = p_case
      UNION ALL
      SELECT l.changed_at, 'task_status', l.task_id::text, l.actor_id,
             t.title || ': ' || l.from_status || ' -> ' || l.to_status, l.id
        FROM public.case_task_status_log l JOIN public.case_tasks t ON t.id = l.task_id
       WHERE l.case_id = p_case AND l.from_status IS NOT NULL
      UNION ALL
      SELECT n.created_at, 'note', n.id::text, n.author_id, left(n.body, 200), 0::bigint
        FROM public.case_notes n WHERE n.case_id = p_case
      UNION ALL
      SELECT d.updated_at, 'document', d.doc_key, d.updated_by,
             d.doc_key || ': ' || d.status || coalesce(' [file ' || d.file_ref || ']', ''), 0::bigint
        FROM public.case_documents d WHERE d.case_id = p_case
      UNION ALL
      SELECT s.changed_at, 'sla', s.timer, s.actor_id,
             s.timer || ': ' || coalesce(s.from_state, 'none') || ' -> ' || s.to_state, s.id
        FROM public.case_sla_state_log s WHERE s.case_id = p_case
      UNION ALL
      SELECT b.contacted_at, 'bank_contact', b.id::text, b.author_id,
             b.contact_name || ': ' || left(b.summary, 200), 0::bigint
        FROM public.case_bank_contacts b WHERE b.case_id = p_case
      UNION ALL
      SELECT dl.changed_at, 'submission_status', dl.id::text, dl.actor_id,
             coalesce(dl.from_value || ' -> ', '') || dl.to_value, dl.id
        FROM public.case_detail_log dl WHERE dl.case_id = p_case AND dl.field = 'submission_status'
    ) e
    ORDER BY e.at, e.kind, e.sk, e.ref_id;
END;
$$;

-- ---------- 2. A customer writing into an ended group still open on WhatsApp ----------

-- 173's body; an ENDED group rings until its WhatsApp group is closed.
CREATE OR REPLACE FUNCTION public.sg_ring_customer_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '1s'
AS $$
DECLARE
  g       public.submission_groups%ROWTYPE;
  v_who   text;
  v_users uuid[];
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
      -- On the list at the end: sg_read_role's rule (115).
      SELECT array_agg(DISTINCT a.user_id) INTO v_users
        FROM public.submission_group_access a
       WHERE a.group_id = NEW.group_id
         AND a.added_at <= g.ended_at AND (a.removed_at IS NULL OR a.removed_at >= g.ended_at)
         AND a.label IN ('agent', 'coordinator')
         AND public.sg_is_staff(NEW.account_id, a.user_id);
      IF v_users IS NULL THEN
        SELECT array_agg(c.agent_id) INTO v_users
          FROM public.cases c
         WHERE c.group_id = NEW.group_id AND public.sg_is_staff(NEW.account_id, c.agent_id);
      END IF;
      IF v_users IS NULL THEN
        SELECT array_agg(p.user_id) INTO v_users
          FROM public.profiles p
         WHERE p.account_id = NEW.account_id AND p.deactivated_at IS NULL
           AND p.account_role IN ('owner', 'admin');
      END IF;
    END IF;
    INSERT INTO public.notifications (account_id, user_id, type, title, body, meta)
    SELECT NEW.account_id, w.user_id, 'submission_group_message',
           'Customer message: ' || v_who,
           CASE WHEN g.status = 'ACTIVE' THEN 'New message in the submission group'
                ELSE 'New message in the submission group (ended)' END,
           jsonb_build_object('group_id', NEW.group_id)
      FROM unnest(v_users) w(user_id)
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
          AND n.account_id = NEW.account_id
          AND n.type = 'submission_group_message'
          AND n.meta ->> 'group_id' = NEW.group_id::text));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sg_ring_customer_message: group %: % (%)', NEW.group_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

-- 173's trigger without its NOT post_end: the function decides.
CREATE OR REPLACE TRIGGER submission_group_messages_ring
  AFTER INSERT ON public.submission_group_messages
  FOR EACH ROW
  WHEN (NEW.direction = 'in' AND NEW.sender_kind = 'customer')
  EXECUTE FUNCTION public.sg_ring_customer_message();

-- 173's body, plus the ended-but-open groups the caller has an unread bell of.
CREATE OR REPLACE FUNCTION public.sg_unread_by_group()
RETURNS TABLE (group_id uuid, unread integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
   GROUP BY g.id
$$;

-- ---------- 3. A send WhatsApp delivered is not a failed one ----------

-- 115's body; the two reconciling functions below may also claim a failed
-- row and move an id between two sends with the same text.
CREATE OR REPLACE FUNCTION public.submission_group_messages_settle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'send_status' - 'wa_message_id') = (to_jsonb(OLD) - 'send_status' - 'wa_message_id')
     AND (NEW.send_status = 'sent') = (NEW.wa_message_id IS NOT NULL)
     AND ((OLD.send_status = 'pending' AND NEW.send_status IN ('sent', 'blocked', 'failed'))
          OR (coalesce(current_setting('sg.reconcile', true), '') = 'on'
              AND ((OLD.send_status = 'failed' AND NEW.send_status = 'sent')
                   OR (OLD.send_status = 'sent' AND NEW.send_status IN ('sent', 'pending'))))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'public.submission_group_messages: % refused (only pending -> sent | blocked | failed, once)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- WhatsApp's echo of one of our own sends: the oldest own row of the last
-- 15 minutes with that exact prefixed text (a caption for an attachment)
-- and no WhatsApp id, pending or failed, becomes 'sent'. False when the id
-- is already on a row or nothing matches. p_sent_at is WhatsApp's time in
-- whole seconds; a row written after that second is not the one it echoes.
CREATE OR REPLACE FUNCTION public.sg_reconcile_echo(p_group uuid, p_wa_message_id text, p_type text,
  p_text text, p_sent_at timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_wa_message_id IS NULL OR coalesce(p_text, '') = '' THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sg_echo:' || p_group::text, 0));
  IF EXISTS (SELECT 1 FROM public.submission_group_messages m
              WHERE m.group_id = p_group AND m.wa_message_id = p_wa_message_id) THEN
    RETURN false;
  END IF;
  SELECT m.id INTO v_id
    FROM public.submission_group_messages m
   WHERE m.group_id = p_group
     AND m.direction = 'out'
     AND m.send_status IN ('pending', 'failed')
     AND m.wa_message_id IS NULL
     AND m.created_at > now() - interval '15 minutes'
     AND (p_sent_at IS NULL OR m.created_at < p_sent_at + interval '1 second')
     AND m.prefixed_body = p_text
     AND (m.type = 'text') = (coalesce(p_type, 'text') = 'text')
   -- Attachments without a caption all read the same: the same kind first.
   ORDER BY (m.type = coalesce(p_type, 'text')) DESC, m.created_at, m.id
   LIMIT 1
   FOR UPDATE;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM set_config('sg.reconcile', 'on', true);
  UPDATE public.submission_group_messages
     SET send_status = 'sent', wa_message_id = p_wa_message_id
   WHERE id = v_id;
  PERFORM set_config('sg.reconcile', '', true);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.sg_reconcile_echo(uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sg_reconcile_echo(uuid, text, text, text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.sg_reconcile_echo(uuid, text, text, text, timestamptz) IS
  'Settles as sent the oldest pending or failed own row (15 minutes) an echo of our own number is of; false if none, or the id is known. Migration 267.';

-- 115's, plus the correction of an echo that claimed an identical row:
-- p_wa_message_id is the gateway's answer for this very row.
CREATE OR REPLACE FUNCTION public.sg_settle_send(p_message bigint, p_status text, p_wa_message_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m public.submission_group_messages%ROWTYPE;
  t public.submission_group_messages%ROWTYPE;
BEGIN
  IF p_status = 'sent' AND p_wa_message_id IS NOT NULL THEN
    SELECT * INTO m FROM public.submission_group_messages x WHERE x.id = p_message AND x.direction = 'out';
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('sg_echo:' || m.group_id::text, 0));
    SELECT * INTO m FROM public.submission_group_messages x WHERE x.id = p_message FOR UPDATE;
    SELECT * INTO t FROM public.submission_group_messages x
     WHERE x.group_id = m.group_id AND x.wa_message_id = p_wa_message_id AND x.id <> m.id
       AND x.direction = 'out' AND x.prefixed_body = m.prefixed_body
       AND (x.type = 'text') = (m.type = 'text')
       FOR UPDATE;
    IF m.send_status = 'sent' AND t.id IS NOT NULL THEN
      -- Both went out, each settled with the other's echo.
      RETURN true;
    END IF;
    IF m.send_status = 'sent' AND m.wa_message_id IS DISTINCT FROM p_wa_message_id
       AND NOT EXISTS (SELECT 1 FROM public.submission_group_messages x
                        WHERE x.group_id = m.group_id AND x.wa_message_id = p_wa_message_id) THEN
      -- An echo of a twin claimed this row: it takes its own id, and the
      -- twin's goes to the twin.
      PERFORM set_config('sg.reconcile', 'on', true);
      UPDATE public.submission_group_messages SET wa_message_id = p_wa_message_id WHERE id = m.id;
      PERFORM set_config('sg.reconcile', '', true);
      PERFORM public.sg_reconcile_echo(m.group_id, m.wa_message_id, m.type, m.prefixed_body);
      RETURN true;
    END IF;
    IF m.send_status = 'pending' AND t.id IS NOT NULL THEN
      PERFORM set_config('sg.reconcile', 'on', true);
      UPDATE public.submission_group_messages SET send_status = 'pending', wa_message_id = NULL WHERE id = t.id;
      PERFORM set_config('sg.reconcile', '', true);
    END IF;
  END IF;
  UPDATE public.submission_group_messages
     SET send_status = p_status,
         wa_message_id = CASE WHEN p_status = 'sent' THEN p_wa_message_id END
   WHERE id = p_message AND direction = 'out' AND send_status = 'pending';
  RETURN FOUND;
END;
$$;

DO $$ BEGIN
  IF to_regprocedure('public.sg_reconcile_echo(uuid,text,text,text,timestamptz)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'submission_groups'
                       AND column_name = 'submission_status_at')
     OR pg_get_functiondef('public.submission_groups_guard()'::regprocedure) NOT LIKE '%submission_status_at%'
     OR pg_get_functiondef('public.case_timeline(uuid,uuid)'::regprocedure) NOT LIKE '%submission_status%'
     OR pg_get_functiondef('public.sg_ring_customer_message()'::regprocedure) NOT LIKE '%wa_closed_at%'
     OR has_function_privilege('authenticated', 'public.sg_reconcile_echo(uuid,text,text,text,timestamptz)', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.submission_group_messages'::regclass
                     AND t.tgname = 'submission_group_messages_ring'
                     AND pg_get_triggerdef(t.oid) NOT LIKE '%post_end%') THEN
    RAISE EXCEPTION '267 did not apply completely';
  END IF;
END $$;

RESET lock_timeout;
