-- 263_release_fixes.sql
--
-- Defects found by the reviewers of release 2026-11-23. Each section
-- restates the current body of a function and changes one rule; the why
-- is here and beside the changed lines.
--
--  1. assignment_rotate_assign: with nobody ticked the turn passed to
--     departments with their own inbox (HR), which moved the chat there.
--  2. case_open: company B's submission took company A's desk case when
--     one phone spoke for both.
--  3. case_document_files_same_customer: two NULL contacts counted as the
--     same customer.
--  4. desk_digest_stop: ignored a digest being sent and every feedback
--     (CSAT) request; it now also cancels the contact's waiting ones.
--  5. response_settings.enabled_at: switching response times on rang a
--     week of old waits.
--  6. desk_doc_tasks_due: files already tasked filled the 500 places.
--  7. recycle_excluded_among: a customer approved since was still offered.
--  8. privacy_broadcast_drafts_*: 0501234567 did not match 971501234567.
--  9. An index for conversation_notes_sync_bells.
-- 10. hr_automsg_due: an SMS backlog starved WhatsApp rows.
-- 11. The digest's template was checked in any language.
--
-- desk_case_open / case_open_lead need no change: an open lead of the
-- same contact and bank outside the caller's application is refused
-- (CASE_CONFLICT), never joined.
--
-- RESTATES bodies of 130, 203, 231, 233, 234, 236, 237 and 256: apply in
-- order, once. Apply as a superuser or a BYPASSRLS role. Safe to re-run.

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '263 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.funnel_chat_reached_tag(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.profiles_drop_report_access()') IS NULL THEN
    RAISE EXCEPTION '263: apply 261_report_counting.sql first';
  END IF;
END $$;

-- ---------- 1. Rotation leaves out departments with their own inbox (RESTATES 236) ----------

CREATE OR REPLACE FUNCTION public.assignment_rotate_assign(p_account_id uuid, p_conversation_id uuid, p_pool_key text, p_candidates uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_conv    record;
  v_limits  boolean := false;
  v_default integer := 30;
  v_list    uuid[];
  v_last    uuid;
  v_start   integer;
  v_n       integer;
  v_cand    uuid;
  v_pick    uuid;
BEGIN
  IF p_account_id IS NULL OR p_conversation_id IS NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'not_found');
  END IF;
  IF p_pool_key IS NULL OR p_pool_key ~ '^[[:space:]]*$' OR char_length(p_pool_key) > 200 THEN
    RAISE EXCEPTION 'A rotation pool key is required (1-200 characters)'
      USING ERRCODE = '22023', HINT = 'bad_pool_key';
  END IF;

  -- One rotation at a time per account: limits count across pools.
  PERFORM pg_advisory_xact_lock(hashtextextended('assignment_rotation:' || p_account_id::text, 0));

  SELECT c.id, c.account_id, c.personal_owner_id, c.assigned_agent_id, c.human_engaged_at
    INTO v_conv
    FROM public.conversations c
   WHERE c.id = p_conversation_id
   FOR UPDATE;
  IF NOT FOUND OR v_conv.account_id IS DISTINCT FROM p_account_id THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'not_found');
  END IF;
  IF v_conv.personal_owner_id IS NOT NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'personal');
  END IF;
  IF v_conv.assigned_agent_id IS NOT NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'already_assigned');
  END IF;
  IF v_conv.human_engaged_at IS NOT NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'engaged');
  END IF;

  SELECT s.limits_enabled, s.default_chat_limit
    INTO v_limits, v_default
    FROM public.assignment_settings s
   WHERE s.account_id = p_account_id;
  v_limits := coalesce(v_limits, false);
  v_default := coalesce(v_default, 30);

  IF p_candidates IS NULL OR cardinality(p_candidates) = 0 THEN
    SELECT coalesce(array_agg(p.user_id ORDER BY p.user_id), '{}')
      INTO v_list
      FROM public.profiles p
     WHERE p.account_id = p_account_id
       AND p.deactivated_at IS NULL
       AND p.account_role::text IN ('agent', 'team_leader')
       -- 263: nobody was picked by name, so people whose department keeps
       -- its own inbox or is restricted stay out (192 would move the chat
       -- into that inbox, 169 the contact with it).
       AND NOT coalesce(public.department_own_inbox(p_account_id, p.department), false)
       AND NOT coalesce(public.department_restricted(p_account_id, p.department), false);
  ELSE
    -- The given order, first occurrence of each person kept.
    SELECT coalesce(array_agg(d.u ORDER BY d.o), '{}')
      INTO v_list
      FROM (SELECT x.u, min(x.o) AS o
              FROM unnest(p_candidates) WITH ORDINALITY x(u, o)
             WHERE x.u IS NOT NULL
             GROUP BY x.u) d;
  END IF;

  v_n := coalesce(cardinality(v_list), 0);
  IF v_n = 0 THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'nobody_eligible');
  END IF;

  SELECT r.last_user_id INTO v_last
    FROM public.assignment_rotation_state r
   WHERE r.account_id = p_account_id AND r.pool_key = p_pool_key;
  -- Start right after the last pick; from the top when they are gone.
  v_start := coalesce(array_position(v_list, v_last), 0);

  FOR i IN 1..v_n LOOP
    v_cand := v_list[((v_start + i - 1) % v_n) + 1];
    IF public.assignment_is_eligible(p_account_id, v_cand, v_limits, v_default) THEN
      v_pick := v_cand;
      EXIT;
    END IF;
  END LOOP;

  IF v_pick IS NULL THEN
    RETURN jsonb_build_object('assigned_to', NULL, 'reason', 'nobody_eligible');
  END IF;

  UPDATE public.conversations
     SET assigned_agent_id = v_pick
   WHERE id = p_conversation_id;

  INSERT INTO public.assignment_rotation_state (account_id, pool_key, last_user_id, updated_at)
  VALUES (p_account_id, p_pool_key, v_pick, now())
  ON CONFLICT (account_id, pool_key) DO UPDATE
    SET last_user_id = excluded.last_user_id,
        updated_at   = excluded.updated_at;

  RETURN jsonb_build_object('assigned_to', v_pick, 'reason', 'assigned');
END;
$function$;

-- ---------- 2. A desk lead takes only its own company's submission (RESTATES 130) ----------

CREATE OR REPLACE FUNCTION public.case_open(p_group uuid, p_bank_code text, p_bank_name text, p_product text, p_amount numeric, p_actor uuid)
 RETURNS TABLE(case_id uuid, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_account uuid;
  v_contact uuid;
  v_role    text := 'api';
  v_agent   uuid;
  v_coord   uuid;
  v_stage   text;
  v_id      uuid;
  l         public.cases%ROWTYPE;
  v_name    text;
  v_take    boolean;
BEGIN
  SELECT g.account_id, g.contact_id, public.desk_normalise_name(g.customer_name)
    INTO v_account, v_contact, v_name FROM public.submission_groups g WHERE g.id = p_group;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'submission group % not found', p_group USING ERRCODE = 'no_data_found', HINT = 'GROUP_NOT_FOUND';
  END IF;
  IF p_actor IS NOT NULL THEN
    v_role := public.case_account_role(v_account, p_actor);
    IF v_role IS NULL OR v_role NOT IN ('super_admin', 'admin') THEN
      RAISE EXCEPTION 'group %: % may not open its case', p_group, p_actor
        USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
    END IF;
  END IF;
  IF p_bank_code IS NOT NULL THEN
    INSERT INTO public.case_banks (account_id, code, name)
    VALUES (v_account, p_bank_code, coalesce(nullif(btrim(p_bank_name), ''), p_bank_code))
    ON CONFLICT ON CONSTRAINT case_banks_pkey DO NOTHING;
  END IF;

  SELECT x.id INTO v_id FROM public.cases x WHERE x.group_id = p_group;
  IF v_id IS NULL THEN
    SELECT a.user_id INTO v_coord FROM public.submission_group_access a
     WHERE a.group_id = p_group AND a.label = 'coordinator' AND a.removed_at IS NULL
     ORDER BY a.added_at, a.id LIMIT 1;
    IF p_bank_code IS NOT NULL THEN
      PERFORM 1 FROM public.case_banks b WHERE b.account_id = v_account AND b.code = p_bank_code FOR SHARE;
    END IF;
    v_stage := public.case_submitted_stage(v_account, p_bank_code);
    -- 130: the open lead of the (account, contact, bank) takes the group.
    -- FOR UPDATE, not FOR NO KEY UPDATE: the UPDATE below sets group_id,
    -- which UNIQUE cases_one_per_group covers, so it takes FOR UPDATE
    -- anyway; taking it here avoids a lock upgrade mid-transaction.
    IF v_contact IS NOT NULL AND p_bank_code IS NOT NULL THEN
      -- Waits out a concurrent case_open_lead of the triple, so its lead
      -- is found below rather than a second case opened beside it.
      PERFORM public.case_lead_lock(v_account, v_contact, p_bank_code);
      SELECT * INTO l FROM public.cases x
       WHERE x.account_id = v_account AND x.contact_id = v_contact AND x.bank_code = p_bank_code
         AND x.group_id IS NULL AND x.closed_at IS NULL
       FOR UPDATE;
      v_take := FOUND;
      -- 263: one phone (a PRO) may speak for several companies, so a case
      -- desk lead takes only its own company's submission: by name, or,
      -- when the submission names none, when the contact speaks for that
      -- one company alone. Otherwise the lead stays open, untouched, and
      -- the submission opens its own case below.
      IF v_take AND l.desk_customer_id IS NOT NULL THEN
        IF v_name <> '' THEN
          v_take := EXISTS (SELECT 1 FROM public.desk_customers dc
                             WHERE dc.id = l.desk_customer_id
                               AND public.desk_normalise_name(dc.legal_name) = v_name);
        ELSE
          SELECT coalesce(count(*) = 1 AND bool_and(lk.customer_id = l.desk_customer_id), false) INTO v_take
            FROM public.desk_customer_contacts lk
           WHERE lk.account_id = v_account AND lk.contact_id = v_contact;
        END IF;
      END IF;
      IF v_take THEN
        UPDATE public.cases x
           SET group_id = p_group,
               product = coalesce(p_product, x.product),
               amount = coalesce(p_amount, x.amount),
               coordinator_id = coalesce(v_coord, x.coordinator_id),
               stage = v_stage
         WHERE x.id = l.id;
        -- The history row is the stage_change SLA event (124's
        -- case_stage_history_sla trigger): every timer is reset for the
        -- new stage at the row's changed_at, the server clock.
        INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, actor_id, actor_role)
        VALUES (l.id, v_account, l.stage, v_stage, p_actor, v_role);
        RETURN QUERY SELECT l.id, false;
        RETURN;
      END IF;
    END IF;
    SELECT a.user_id INTO v_agent FROM public.submission_group_access a
     WHERE a.group_id = p_group AND a.label = 'agent' AND a.removed_at IS NULL
     ORDER BY a.added_at, a.id LIMIT 1;
    IF v_agent IS NULL THEN
      RAISE EXCEPTION 'submission group % has no agent on its access list', p_group
        USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'NO_AGENT';
    END IF;
    INSERT INTO public.cases AS c (account_id, group_id, contact_id, bank_code, product, amount, agent_id,
                                   coordinator_id, stage)
    VALUES (v_account, p_group, v_contact, p_bank_code, p_product, p_amount, v_agent, v_coord, v_stage)
    ON CONFLICT ON CONSTRAINT cases_one_per_group DO NOTHING
    RETURNING c.id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, actor_id, actor_role)
      VALUES (v_id, v_account, NULL, v_stage, p_actor, v_role);
      RETURN QUERY SELECT v_id, true;
      RETURN;
    END IF;
    -- Lost a concurrent open: the other call's row, read fresh.
    SELECT x.id INTO v_id FROM public.cases x WHERE x.group_id = p_group;
  END IF;
  PERFORM public.case_fill_details(v_id, p_bank_code, p_product, p_amount, p_actor, v_role);
  RETURN QUERY SELECT v_id, false;
END;
$function$;

-- ---------- 3. Two unknown customers are not the same customer (RESTATES 231) ----------

CREATE OR REPLACE FUNCTION public.case_document_files_same_customer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_doc_contact  uuid;
  v_case_contact uuid;
  v_company      uuid;
  v_doc_case     uuid;
BEGIN
  SELECT d.contact_id, d.case_id INTO v_doc_contact, v_doc_case FROM public.customer_documents d WHERE d.id = NEW.customer_document_id;
  SELECT k.contact_id, k.desk_customer_id INTO v_case_contact, v_company FROM public.cases k WHERE k.id = NEW.case_id;
  -- 263: equal and known (NULL = NULL is nobody), or recorded for this case.
  IF v_doc_contact = v_case_contact OR v_doc_case = NEW.case_id THEN
    RETURN NEW;
  END IF;
  IF v_company IS NOT NULL AND v_doc_contact IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.desk_customer_contacts l
                WHERE l.customer_id = v_company AND l.contact_id = v_doc_contact)
       OR EXISTS (SELECT 1 FROM public.cases o
                   WHERE o.desk_customer_id = v_company AND o.contact_id = v_doc_contact)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'case_document_files: the document belongs to another customer'
    USING ERRCODE = 'check_violation', HINT = 'CROSS_CUSTOMER';
END;
$function$;

-- ---------- 4. A STOP while a digest or a feedback request is on its way (RESTATES 234) ----------

CREATE OR REPLACE FUNCTION public.desk_digest_stop(p_account uuid, p_contact uuid, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.desk_digest_outbox o
                  WHERE o.account_id = p_account AND o.contact_id = p_contact
                    AND o.status IN ('sending', 'sent', 'unconfirmed')
                    AND o.created_at > coalesce(p_now, now()) - interval '30 days')
     AND NOT EXISTS (SELECT 1 FROM public.case_csat_requests q
                      WHERE q.account_id = p_account AND q.contact_id = p_contact
                        AND q.status IN ('sending', 'sent', 'unconfirmed')
                        AND coalesce(q.sent_at, q.claimed_at, q.created_at)
                            > coalesce(p_now, now()) - interval '30 days') THEN
    RETURN false;
  END IF;
  UPDATE public.desk_digest_outbox o SET status = 'cancelled', status_reason = 'opted_out'
   WHERE o.account_id = p_account AND o.contact_id = p_contact AND o.status = 'queued';
  UPDATE public.case_csat_requests q SET status = 'cancelled', status_reason = 'opted_out'
   WHERE q.account_id = p_account AND q.contact_id = p_contact AND q.status IN ('queued', 'held');
  UPDATE public.contacts c SET opted_out_at = coalesce(p_now, now())
   WHERE c.id = p_contact AND c.account_id = p_account AND c.opted_out_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$function$;

-- ---------- 5. No backlog of bells when response times are switched on (RESTATES 237, 256) ----------

ALTER TABLE public.response_settings ADD COLUMN IF NOT EXISTS enabled_at timestamptz;
UPDATE public.response_settings SET enabled_at = now() WHERE enabled AND enabled_at IS NULL;

CREATE OR REPLACE FUNCTION public.response_settings_set(p_enabled boolean, p_timezone text, p_hours jsonb, p_target_minutes integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := public.current_account_id();
  v_row     public.response_settings;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL
     OR NOT public.is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Only an owner or admin can change response times'
      USING ERRCODE = '42501', HINT = 'not_allowed';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled is required' USING ERRCODE = '22023', HINT = 'invalid_enabled';
  END IF;
  IF p_timezone IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown time zone' USING ERRCODE = '22023', HINT = 'invalid_timezone';
  END IF;
  IF NOT coalesce(public.response_hours_valid(p_hours), false) THEN
    RAISE EXCEPTION 'Business hours are not valid' USING ERRCODE = '22023', HINT = 'invalid_hours';
  END IF;
  IF p_target_minutes IS NULL OR p_target_minutes NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'The target must be 1 to 1440 minutes'
      USING ERRCODE = '22023', HINT = 'invalid_target';
  END IF;

  INSERT INTO public.response_settings AS s
    (account_id, enabled, timezone, hours, target_minutes, updated_at, updated_by, enabled_at)
  VALUES (v_account, p_enabled, p_timezone, p_hours, p_target_minutes, now(), v_uid,
          CASE WHEN p_enabled THEN now() END)
  ON CONFLICT (account_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        timezone = EXCLUDED.timezone,
        hours = EXCLUDED.hours,
        target_minutes = EXCLUDED.target_minutes,
        updated_at = now(),
        updated_by = v_uid,
        -- 263: the moment it was switched on; other saves keep it.
        enabled_at = CASE WHEN NOT EXCLUDED.enabled THEN NULL
                          WHEN s.enabled THEN coalesce(s.enabled_at, now())
                          ELSE now() END
  RETURNING s.* INTO v_row;

  RETURN jsonb_build_object(
    'enabled', v_row.enabled,
    'timezone', v_row.timezone,
    'hours', v_row.hours,
    'target_minutes', v_row.target_minutes,
    'updated_at', v_row.updated_at
  );
END $function$;

CREATE OR REPLACE FUNCTION public.response_escalation_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s           record;
  c           record;
  v_mins      integer;
  v_assignee  uuid;
  v_name      text;
  v_leaders   uuid[];
  v_meta      jsonb;
  v_wait      text;
  n_accounts  integer := 0;
  n_failed    integer := 0;
  n_chats     integer := 0;
  n_bells     integer := 0;
  n_trimmed   integer := 0;
BEGIN
  FOR s IN
    SELECT r.account_id, r.timezone, r.hours, r.target_minutes,
           -- 263: waits from before the switch went on ring nobody.
           coalesce(r.enabled_at, now()) AS enabled_at
      FROM public.response_settings r
      JOIN public.accounts a ON a.id = r.account_id
     WHERE r.enabled
       AND a.archived_at IS NULL
  LOOP
    n_accounts := n_accounts + 1;
    BEGIN
      -- Each chat's level is worked out before the LIMIT (256): business
      -- minutes, and whether its assignee is live staff here (else it is
      -- 'unassigned'). Chats under target, or already rung at their
      -- level, are left out so they cannot crowd out newer waits.
      FOR c IN
        SELECT q.id, q.contact_id, q.assigned_agent_id, q.since, q.who, q.mins
          FROM (
            SELECT cv.id, cv.contact_id, cv.assigned_agent_id,
                   cv.customer_waiting_since AS since,
                   coalesce(nullif(btrim(ct.name), ''), ct.phone, 'A customer') AS who,
                   bm.mins,
                   CASE
                     WHEN NOT EXISTS (
                       SELECT 1 FROM public.profiles p
                        WHERE p.user_id = cv.assigned_agent_id
                          AND p.account_id = s.account_id
                          AND p.deactivated_at IS NULL
                          AND p.account_role <> 'bank_guest') THEN 'unassigned'
                     WHEN bm.mins >= 2 * s.target_minutes THEN 'escalated'
                     ELSE 'target'
                   END AS level
              FROM public.conversations cv
              LEFT JOIN public.contacts ct ON ct.id = cv.contact_id
             CROSS JOIN LATERAL (
               SELECT public.response_business_minutes(
                        s.hours, s.timezone, cv.customer_waiting_since, now()) AS mins) bm
             WHERE cv.account_id = s.account_id
               AND cv.customer_waiting_since IS NOT NULL
               AND cv.personal_owner_id IS NULL
               AND cv.status <> 'closed'
               AND cv.customer_waiting_since <= now() - make_interval(mins => s.target_minutes)
               AND cv.customer_waiting_since >= now() - interval '7 days'
               AND cv.customer_waiting_since >= s.enabled_at
               AND NOT EXISTS (
                 SELECT 1 FROM public.response_escalations e
                  WHERE e.conversation_id = cv.id
                    AND e.waiting_since = cv.customer_waiting_since
                    AND e.level = 'escalated')
          ) q
         WHERE q.mins >= s.target_minutes
           AND NOT EXISTS (
             SELECT 1 FROM public.response_escalations e
              WHERE e.conversation_id = q.id
                AND e.waiting_since = q.since
                AND e.level = q.level)
         ORDER BY q.since
         LIMIT 500
      LOOP
        v_mins := c.mins;
        CONTINUE WHEN v_mins < s.target_minutes;
        n_chats := n_chats + 1;
        v_wait := public.response_minutes_label(v_mins);

        -- A live, non-guest assignee in this workspace, else none.
        SELECT p.user_id, coalesce(nullif(btrim(p.full_name), ''), p.email)
          INTO v_assignee, v_name
          FROM public.profiles p
         WHERE p.user_id = c.assigned_agent_id
           AND p.account_id = s.account_id
           AND p.deactivated_at IS NULL
           AND p.account_role <> 'bank_guest'
         LIMIT 1;
        IF NOT FOUND THEN
          v_assignee := NULL;
          v_name := NULL;
        END IF;

        v_meta := jsonb_build_object(
          'waiting_since', c.since,
          'business_minutes', v_mins,
          'target_minutes', s.target_minutes,
          'assignee_id', v_assignee);

        IF v_assignee IS NULL THEN
          n_bells := n_bells + public.response_ring(
            s.account_id, c.id, c.contact_id, c.since, 'unassigned',
            public.response_admins(s.account_id), v_mins,
            'response_unassigned',
            'A customer is waiting and nobody is assigned',
            c.who || ' has waited ' || v_wait || ' (business hours) with no one assigned.',
            v_meta || jsonb_build_object('level', 'unassigned'));
          CONTINUE;
        END IF;

        n_bells := n_bells + public.response_ring(
          s.account_id, c.id, c.contact_id, c.since, 'target',
          ARRAY[v_assignee], v_mins,
          'response_target_missed',
          'A customer is waiting for your reply',
          c.who || ' has waited ' || v_wait || ' (business hours), past the '
            || public.response_minutes_label(s.target_minutes) || ' target.',
          v_meta || jsonb_build_object('level', 'target'));

        IF v_mins >= 2 * s.target_minutes THEN
          SELECT coalesce(array_agg(DISTINCT t.leader_user_id), '{}')
            INTO v_leaders
            FROM public.team_members tm
            JOIN public.teams t ON t.id = tm.team_id AND t.account_id = s.account_id
            JOIN public.profiles lp ON lp.user_id = t.leader_user_id
                                   AND lp.account_id = s.account_id
                                   AND lp.deactivated_at IS NULL
           WHERE tm.account_id = s.account_id
             AND tm.user_id = v_assignee
             AND t.leader_user_id IS NOT NULL
             AND t.leader_user_id <> v_assignee;
          IF cardinality(v_leaders) = 0 THEN
            v_leaders := public.response_admins(s.account_id);
          END IF;
          n_bells := n_bells + public.response_ring(
            s.account_id, c.id, c.contact_id, c.since, 'escalated',
            v_leaders, v_mins,
            'response_escalated',
            'A customer has waited twice the target',
            c.who || ' has waited ' || v_wait || ' (business hours) for '
              || coalesce(v_name, 'their agent') || '.',
            v_meta || jsonb_build_object('level', 'escalated'));
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      n_failed := n_failed + 1;
      RAISE WARNING 'response_escalation_sweep: account % failed: % (%)',
        s.account_id, SQLERRM, SQLSTATE;
    END;
  END LOOP;

  DELETE FROM public.response_escalations
   WHERE id IN (SELECT e.id FROM public.response_escalations e
                 WHERE e.created_at < now() - interval '14 days'
                 LIMIT 5000);
  GET DIAGNOSTICS n_trimmed = ROW_COUNT;

  RETURN jsonb_build_object(
    'accounts', n_accounts,
    'failed', n_failed,
    'chats', n_chats,
    'notifications', n_bells,
    'trimmed', n_trimmed);
END $function$;

-- ---------- 6. Document tasks already made no longer fill the list (RESTATES 233) ----------

CREATE OR REPLACE FUNCTION public.desk_doc_tasks_due(p_now timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 500)
 RETURNS TABLE(account_id uuid, case_id uuid, case_number text, file_id uuid, doc_key text, kind text, expires_on date, assignee uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH open_cases AS (
    SELECT k.* FROM public.cases k
     WHERE k.desk_customer_id IS NOT NULL AND k.closed_at IS NULL AND k.group_id IS NULL
  ), passed AS (
    SELECT f.*, k.case_number AS cnum, k.desk_customer_id AS company,
           coalesce(CASE WHEN public.case_account_role(k.account_id, k.coordinator_id) IS NOT NULL
                         THEN k.coordinator_id END, k.agent_id) AS who
      FROM public.case_document_files f
      JOIN open_cases k ON k.id = f.case_id
     WHERE f.status = 'passed'
  ), hits AS (
    SELECT p.account_id, p.case_id, p.cnum, p.id, p.doc_key,
           CASE WHEN p.expires_on < public.desk_today(p_now) THEN 'expired' ELSE 'expiring' END AS kind,
           p.expires_on, p.who
      FROM passed p
     WHERE p.expires_on IS NOT NULL AND p.expires_on <= public.desk_today(p_now) + 14
    UNION ALL
    SELECT p.account_id, p.case_id, p.cnum, p.id, p.doc_key, 'replaced', p.expires_on, p.who
      FROM passed p
     WHERE EXISTS (SELECT 1 FROM public.case_document_files g
                     JOIN public.cases o ON o.id = g.case_id
                    WHERE g.customer_document_id = p.customer_document_id
                      AND o.desk_customer_id = p.company AND o.id <> p.case_id
                      AND g.status = 'superseded')
  )
  SELECT h.account_id, h.case_id, h.cnum, h.id, h.doc_key, h.kind, h.expires_on, h.who
    FROM hits h
   -- 263: a file already tasked (src/lib/desk/escalate.ts runDeskDocTasks;
   -- UNIQUE (account_id, source, source_ref)) must not hold a place.
   WHERE NOT EXISTS (SELECT 1 FROM public.tasks t
                      WHERE t.account_id = h.account_id AND t.source = 'automation'
                        AND t.source_ref = 'desk_doc:' || h.id::text || ':' || h.kind)
   ORDER BY h.account_id, h.case_id, h.id
   LIMIT least(greatest(coalesce(p_limit, 500), 1), 2000)
$function$;

-- ---------- 7. Approved since the ending: not for recycling (RESTATES 256) ----------

CREATE OR REPLACE FUNCTION public.recycle_excluded_among(p_contact_ids uuid[], p_ended timestamp with time zone[])
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x.cid
    FROM unnest(p_contact_ids, p_ended) AS x(cid, ended)
   WHERE public.current_account_id() IS NOT NULL
     AND public.current_role_rank() >= 3
     AND EXISTS (SELECT 1 FROM public.contacts ct
                  WHERE ct.id = x.cid AND ct.account_id = public.current_account_id())
     AND (
       -- Active again: a case or lead of any bank is still open.
       EXISTS (SELECT 1 FROM public.cases c
                WHERE c.account_id = public.current_account_id()
                  AND c.contact_id = x.cid AND c.closed_at IS NULL)
       -- 263: another bank has approved them since.
       OR EXISTS (SELECT 1 FROM public.cases c
                   WHERE c.account_id = public.current_account_id()
                     AND c.contact_id = x.cid AND c.outcome = 'Approved'
                     AND c.closed_at >= x.ended)
       -- Came back: the customer wrote after the ending.
       OR EXISTS (SELECT 1
                    FROM public.conversations cv
                    JOIN public.messages m ON m.conversation_id = cv.id
                   WHERE cv.account_id = public.current_account_id()
                     AND cv.contact_id = x.cid
                     AND cv.personal_owner_id IS NULL
                     AND m.sender_type = 'customer'
                     AND m.created_at > x.ended)
     )
$function$;

-- ---------- 8. Draft rows match a phone by its last 9 digits (RESTATES 256) ----------

CREATE OR REPLACE FUNCTION public.privacy_broadcast_drafts_erase(p_account uuid, p_contact uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_digits text;
  v_n int := 0;
BEGIN
  SELECT public.privacy_digits(coalesce(c.phone_normalized, c.phone)) INTO v_digits
    FROM public.contacts c
   WHERE c.account_id = p_account AND c.id = p_contact;
  IF v_digits IS NOT NULL THEN
    DELETE FROM public.broadcast_drafts d
     WHERE d.account_id = p_account
       AND jsonb_typeof(d.state -> 'audience' -> 'csvContacts') = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(d.state -> 'audience' -> 'csvContacts') e
          WHERE jsonb_typeof(e) = 'object'
            AND (public.privacy_digits(e ->> 'phone') = v_digits
              OR (length(public.privacy_digits(e ->> 'phone')) >= 9 AND length(v_digits) >= 9
                  AND right(public.privacy_digits(e ->> 'phone'), 9) = right(v_digits, 9))));
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('counts', jsonb_build_object('broadcast_drafts', v_n),
                            'objects', '[]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.privacy_broadcast_drafts_export(p_account uuid, p_contact uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH c AS (
    SELECT public.privacy_digits(coalesce(ct.phone_normalized, ct.phone)) AS digits
      FROM public.contacts ct
     WHERE ct.account_id = p_account AND ct.id = p_contact
  )
  SELECT jsonb_build_object('broadcast_drafts', coalesce(jsonb_agg(
           jsonb_build_object('broadcast_id', d.broadcast_id, 'updated_at', d.updated_at,
                              'csv_row', e.row) ORDER BY d.updated_at), '[]'::jsonb))
    FROM c
    JOIN public.broadcast_drafts d ON d.account_id = p_account
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(d.state -> 'audience' -> 'csvContacts') = 'array'
                THEN d.state -> 'audience' -> 'csvContacts' ELSE '[]'::jsonb END) AS e(row)
   WHERE c.digits IS NOT NULL
     AND jsonb_typeof(e.row) = 'object'
     AND (public.privacy_digits(e.row ->> 'phone') = c.digits
              OR (length(public.privacy_digits(e.row ->> 'phone')) >= 9 AND length(c.digits) >= 9
                  AND right(public.privacy_digits(e.row ->> 'phone'), 9) = right(c.digits, 9)))
$function$;

-- ---------- 9. The bells of a note, by index ----------

CREATE INDEX IF NOT EXISTS idx_notifications_chat_note_mention
  ON public.notifications ((meta->>'note_id')) WHERE type = 'chat_note_mention';

-- ---------- 10. Channels take turns under the automated-message limit (RESTATES 203) ----------

CREATE OR REPLACE FUNCTION public.hr_automsg_due(p_limit integer DEFAULT 100, p_account_id uuid DEFAULT NULL::uuid)
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
             AND (p_account_id IS NULL OR x.account_id = p_account_id)) q ON q.id = o.id
   -- Queued first, then failed, then held, each oldest first: many held
   -- rows must not starve newly queued ones under the limit.
   ORDER BY q.turn, CASE o.status WHEN 'queued' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
            o.created_at, o.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
$function$;

-- ---------- 11. The digest template is approved in the language it is sent in (RESTATES 234) ----------

-- A signature of its own: the two-argument form stays (unused), so
-- re-running 234 cannot make a call ambiguous.
CREATE OR REPLACE FUNCTION public.desk_digest_template_ok(p_account uuid, p_name text, p_language text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.message_templates t
                  WHERE t.account_id = p_account AND t.name = p_name
                    AND coalesce(t.language, 'en_US') = p_language
                    AND lower(coalesce(t.status, '')) = 'approved'
                    AND lower(coalesce(t.category, '')) = 'utility'
                    AND t.body_text LIKE '%{{1}}%' AND t.body_text LIKE '%{{2}}%')
$$;
REVOKE ALL ON FUNCTION public.desk_digest_template_ok(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.desk_digest_settings_set(p_actor uuid, p_account uuid, p_enabled boolean, p_template_name text, p_language text, p_send_hour integer, p_gap_days integer, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_name text := public.desk_clean(p_template_name);
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('admin', 'super_admin'), false) IS NOT TRUE THEN
    PERFORM public.desk_refuse('desk_digest_settings_set', 'NOT_ALLOWED', 'owners and admins only');
  END IF;
  IF p_enabled IS NULL OR p_send_hour IS NULL OR p_send_hour NOT BETWEEN 8 AND 20
     OR p_gap_days IS NULL OR p_gap_days NOT BETWEEN 1 AND 14
     OR coalesce(p_language, '') !~ '^[a-z]{2}(_[A-Z]{2})?$' THEN
    PERFORM public.desk_refuse('desk_digest_settings_set', 'INVALID', 'send hour 8-20, gap 1-14 days, a language code');
  END IF;
  IF p_enabled AND (v_name IS NULL OR NOT public.desk_digest_template_ok(p_account, v_name, p_language)) THEN
    PERFORM public.desk_refuse('desk_digest_settings_set', 'TEMPLATE_INVALID',
      'an approved utility template in that language whose body has {{1}} and {{2}}');
  END IF;
  INSERT INTO public.desk_digest_settings AS s (account_id, enabled, template_name, language, send_hour, gap_days,
                                               updated_by, updated_at)
  VALUES (p_account, p_enabled, v_name, p_language, p_send_hour, p_gap_days, p_actor, coalesce(p_now, now()))
  ON CONFLICT (account_id) DO UPDATE
     SET enabled = excluded.enabled, template_name = excluded.template_name, language = excluded.language,
         send_hour = excluded.send_hour, gap_days = excluded.gap_days, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at;
  IF NOT p_enabled THEN
    UPDATE public.desk_digest_outbox o SET status = 'cancelled', status_reason = 'switched_off'
     WHERE o.account_id = p_account AND o.status = 'queued';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.desk_digest_enqueue(p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_today date := public.desk_today(p_now);
  v_hour  integer := extract(hour FROM v_now AT TIME ZONE 'Asia/Dubai')::integer;
  s       public.desk_digest_settings%ROWTYPE;
  r       record;
  v_sum   record;
  v_to    record;
  v_n     integer := 0;
  v_id    uuid;
BEGIN
  FOR s IN SELECT * FROM public.desk_digest_settings x WHERE x.enabled AND x.template_name IS NOT NULL LOOP
    CONTINUE WHEN v_hour < s.send_hour OR v_hour >= 21;
    CONTINUE WHEN NOT public.desk_digest_template_ok(s.account_id, s.template_name, s.language);
    FOR r IN
      SELECT d.id AS customer_id, a.app_number
        FROM public.desk_customers d
        JOIN public.desk_applications a ON a.customer_id = d.id AND a.status = 'open'
       WHERE d.account_id = s.account_id AND d.merged_into IS NULL
         AND EXISTS (SELECT 1 FROM public.cases k WHERE k.desk_customer_id = d.id
                       AND k.closed_at IS NULL AND k.group_id IS NULL)
         -- Not again within gap_days of the last digest ...
         AND NOT EXISTS (SELECT 1 FROM public.desk_digest_outbox o
                          WHERE o.customer_id = d.id AND o.status <> 'cancelled'
                            AND o.local_day > v_today - s.gap_days)
         -- ... nor of the last document any of its people sent.
         AND NOT EXISTS (SELECT 1 FROM public.customer_documents cd
                          WHERE cd.account_id = s.account_id
                            AND cd.received_at > v_now - make_interval(days => s.gap_days)
                            AND cd.contact_id IN (SELECT l.contact_id FROM public.desk_customer_contacts l
                                                   WHERE l.customer_id = d.id
                                                  UNION
                                                  SELECT k.contact_id FROM public.cases k
                                                   WHERE k.desk_customer_id = d.id))
    LOOP
      SELECT * INTO v_sum FROM public.desk_digest_summary(s.account_id, r.customer_id);
      CONTINUE WHEN coalesce(v_sum.pending, 0) = 0 OR v_sum.summary IS NULL;
      SELECT * INTO v_to FROM public.desk_digest_recipient(s.account_id, r.customer_id);
      CONTINUE WHEN v_to.contact_id IS NULL;
      v_id := NULL;
      INSERT INTO public.desk_digest_outbox AS o (account_id, customer_id, contact_id, conversation_id, local_day,
                                                  app_number, summary, pending, created_at)
      VALUES (s.account_id, r.customer_id, v_to.contact_id, v_to.conversation_id, v_today, r.app_number,
              v_sum.summary, v_sum.pending, v_now)
      ON CONFLICT (customer_id, local_day) DO NOTHING
      RETURNING o.id INTO v_id;
      IF v_id IS NOT NULL THEN
        v_n := v_n + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.desk_digest_claim(p_now timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, account_id uuid, contact_id uuid, conversation_id uuid, app_number text, summary text, template_name text, language text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_today date := public.desk_today(p_now);
  v_hour  integer := extract(hour FROM v_now AT TIME ZONE 'Asia/Dubai')::integer;
  o       public.desk_digest_outbox%ROWTYPE;
  s       public.desk_digest_settings%ROWTYPE;
  ct      public.contacts%ROWTYPE;
  v_sent  integer;
BEGIN
  -- A claim with no result for 10 minutes may have reached the gateway:
  -- never resent.
  UPDATE public.desk_digest_outbox x SET status = 'unconfirmed'
   WHERE x.status = 'sending' AND x.claimed_at < v_now - interval '10 minutes';

  IF v_hour < 8 OR v_hour >= 21 THEN
    RETURN;  -- quiet hours: nothing leaves, the rows wait
  END IF;

  FOR o IN SELECT * FROM public.desk_digest_outbox x WHERE x.status = 'queued' AND x.local_day <= v_today
            ORDER BY x.created_at LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
            FOR UPDATE SKIP LOCKED LOOP
    SELECT * INTO s FROM public.desk_digest_settings x WHERE x.account_id = o.account_id;
    IF NOT coalesce(s.enabled, false) OR s.template_name IS NULL
       OR NOT public.desk_digest_template_ok(o.account_id, s.template_name, s.language) THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'switched_off' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    IF o.local_day < v_today THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'stale' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    SELECT * INTO ct FROM public.contacts x WHERE x.id = o.contact_id;
    IF ct.opted_out_at IS NOT NULL OR ct.do_not_contact_at IS NOT NULL THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'opted_out' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    -- The daily cap: 3 automated messages per person per Dubai day,
    -- HR automated messages and these digests together.
    SELECT (SELECT count(*) FROM public.hr_automsg_outbox h
             WHERE h.contact_id = o.contact_id AND h.status = 'sent'
               AND (h.sent_at AT TIME ZONE 'Asia/Dubai')::date = v_today)
         + (SELECT count(*) FROM public.desk_digest_outbox d
             WHERE d.contact_id = o.contact_id AND d.local_day = v_today
               AND d.status IN ('sent', 'sending', 'unconfirmed'))
      INTO v_sent;
    IF v_sent >= 3 THEN
      UPDATE public.desk_digest_outbox x SET status = 'cancelled', status_reason = 'daily_cap' WHERE x.id = o.id;
      CONTINUE;
    END IF;
    UPDATE public.desk_digest_outbox x
       SET status = 'sending', attempts = x.attempts + 1, claimed_at = v_now
     WHERE x.id = o.id;
    RETURN QUERY SELECT o.id, o.account_id, o.contact_id, o.conversation_id, o.app_number, o.summary,
                        s.template_name, s.language;
  END LOOP;
END;
$function$;
