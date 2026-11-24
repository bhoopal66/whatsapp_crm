-- ============================================================
-- 303_desk_fixes.sql — case desk and case cron fixes.
--
--  1. desk_tray_file / desk_tray_resolve require case_can_write, as
--     intake_file does (CASE_NOT_FOUND): a team leader could file into
--     another team's case and read its number.
--  2. Tray reason 'copy_failed' and desk_tray_copy_failed: a document the
--     app could not route or copy becomes a tray row instead of a log
--     line. Only a document that is the desk's (a staff phone, a linked
--     sender, a desk number), and never one already filed or copied.
--  3. desk_tray_page: the tray with its total (desk_tray_list, which the
--     build before this one calls, is unchanged). Resolved: newest first.
--  4. desk_tray_file finds a copy already made (an upload of the tray
--     item's or the document's id): filed -> the tray item resolves to
--     THAT case; untagged -> outcome 'waiting'.
--  5. case_rule_last_activity counts files and the group's last customer
--     or staff message.
--  6. case_rules_sweep: one failing rule or case is a WARNING, its claim
--     rolled back, and the others still run.
--  7. cases.group_end_tried_at: the group-end sweep takes the case tried
--     longest ago, at most every 30 minutes each.
--
-- Bodies are patched from the catalog by line (CREATE OR REPLACE keeps
-- grants, owner and search_path); a line already patched is left, a line
-- not found refuses. Apply after 300, as a superuser or BYPASSRLS role.
-- Re-runnable. Asserted by supabase/ci/verify-desk-fixes.sql.
-- ============================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION pg_temp.patch_303(p_fn text, p_old text, p_new text,
                                              p_old2 text DEFAULT '', p_new2 text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_def text := pg_get_functiondef(p_fn::regprocedure);
BEGIN
  IF position(p_new IN v_def) > 0 THEN RETURN; END IF;
  IF position(p_old IN v_def) = 0 OR (p_old2 <> '' AND position(p_old2 IN v_def) = 0) THEN
    RAISE EXCEPTION '303: % is not the body this migration patches', p_fn;
  END IF;
  v_def := replace(v_def, p_old, p_new);
  -- replace() with an empty search text answers the text unchanged.
  EXECUTE replace(v_def, p_old2, p_new2);
END;
$p$;

-- ---------- 1 and 4. Filing from the tray ----------

SELECT pg_temp.patch_303('public.desk_tray_file(uuid, uuid, uuid, uuid, text, timestamptz)',
$o$'that case belongs to another bank');
  END IF;
$o$, $n$'that case belongs to another bank');
  END IF;
  -- 303: filing writes the case, as intake_file asks.
  IF NOT public.case_can_write(p_case, p_actor) THEN
    PERFORM public.desk_refuse('desk_tray_file', 'CASE_NOT_FOUND', 'case not found');
  END IF;
$n$);

SELECT pg_temp.patch_303('public.desk_tray_file(uuid, uuid, uuid, uuid, text, timestamptz)',
$o$  v_name text;
BEGIN$o$, $n$  v_name text;
  v_copy  uuid;   -- 303
  v_where uuid;
  v_state text;
BEGIN$n$);

SELECT pg_temp.patch_303('public.desk_tray_file(uuid, uuid, uuid, uuid, text, timestamptz)',
$o$'this item was already sorted');
  END IF;
$o$, $n$'this item was already sorted');
  END IF;
  -- 303: a copy made earlier (its id is the tray item's, or the document's
  -- for a staff phone) is never made twice.
  SELECT i.id, i.state, coalesce(i.filed_case_id, o.filed_case_id) INTO v_copy, v_state, v_where
    FROM public.intake_items i
    LEFT JOIN public.intake_items o ON o.id = i.duplicate_of_item
   WHERE i.id IN (p_tray, t.customer_document_id) AND i.account_id = p_account
     AND i.state IN ('filed', 'duplicate', 'untagged')
   ORDER BY (i.state = 'untagged') LIMIT 1;
  IF v_state = 'untagged' THEN
    RETURN QUERY SELECT 'waiting'::text, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  ELSIF v_where IS NOT NULL THEN
    UPDATE public.desk_tray x
       SET state = 'filed', resolved_by = p_actor, resolved_at = v_now, resolved_case_id = v_where,
           resolved_item_id = v_copy
     WHERE x.id = p_tray;
    RETURN QUERY SELECT 'filed'::text,
      (SELECT x.case_number FROM public.cases x WHERE x.id = v_where AND public.case_can_read(v_where, p_actor)),
      NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
$n$);

SELECT pg_temp.patch_303('public.desk_tray_resolve(uuid, uuid, uuid, uuid, uuid, timestamptz)',
$o$  IF NOT EXISTS (SELECT 1 FROM public.intake_items i$o$,
$n$  -- 303: as desk_tray_file and intake_file.
  IF NOT public.case_can_write(p_case, p_actor) THEN
    PERFORM public.desk_refuse('desk_tray_resolve', 'CASE_NOT_FOUND', 'case not found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.intake_items i$n$);

-- ---------- 2. A document that could not be routed or copied ----------

ALTER TABLE public.desk_tray
  DROP CONSTRAINT IF EXISTS desk_tray_reason_check,
  ADD CONSTRAINT desk_tray_reason_check CHECK (reason IN ('unknown_sender', 'no_open_case', 'many_companies',
    'many_cases', 'evidence_conflict', 'other_person', 'file_refused', 'copy_failed'));

CREATE OR REPLACE FUNCTION public.desk_tray_copy_failed(p_account uuid, p_message uuid, p_channel uuid,
                                                        p_now timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s       public.desk_settings%ROWTYPE;
  d       public.customer_documents%ROWTYPE;
  v_custs uuid[];
  v_cands jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM public.desk_settings x WHERE x.account_id = p_account;
  IF NOT coalesce(s.routing_enabled, false) THEN RETURN 'off'; END IF;
  SELECT * INTO d FROM public.customer_documents x WHERE x.message_id = p_message AND x.account_id = p_account;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF d.source <> 'chat' OR d.contact_id IS NULL THEN RETURN 'ignored'; END IF;
  -- The failure may be only the answer's: what happened stands.
  IF EXISTS (SELECT 1 FROM public.desk_tray t WHERE t.customer_document_id = d.id) THEN RETURN 'tray'; END IF;
  IF EXISTS (SELECT 1 FROM public.intake_items i WHERE i.id = d.id AND i.account_id = p_account)
     OR EXISTS (SELECT 1 FROM public.case_document_files f
                  JOIN public.cases k ON k.id = f.case_id AND k.desk_customer_id IS NOT NULL
                 WHERE f.customer_document_id = d.id) THEN
    RETURN 'done';
  END IF;
  -- Whose document is the desk's: 230's own rule.
  IF public.desk_staff_for_contact(p_account, d.contact_id) IS NULL THEN
    SELECT coalesce(array_agg(x.customer_id), '{}') INTO v_custs
      FROM public.desk_customers_for_contact(p_account, d.contact_id) x;
    IF cardinality(v_custs) > 0 THEN
      v_cands := public.desk_route_candidates(p_account, d.contact_id, v_custs, '{}', '{}');
    ELSIF p_channel IS NULL OR NOT p_channel = ANY (coalesce(s.desk_channel_ids, '{}')) THEN
      RETURN 'ignored';
    END IF;
  END IF;
  INSERT INTO public.desk_tray (account_id, customer_document_id, contact_id, conversation_id, channel_id,
                                reason, candidates, duty_user_id, received_at)
  VALUES (p_account, d.id, d.contact_id, d.conversation_id, p_channel, 'copy_failed', v_cands,
          s.duty_user_id, coalesce(d.received_at, p_now, now()))
  ON CONFLICT (customer_document_id) DO NOTHING;
  RETURN 'tray';
END;
$$;

-- ---------- 3. The tray, with its total ----------

CREATE OR REPLACE FUNCTION public.desk_tray_page(p_actor uuid, p_account uuid, p_state text DEFAULT 'open',
                                                 p_limit integer DEFAULT 100, p_now timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now   timestamptz := coalesce(p_now, now());
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
  v_role  text := public.case_account_role(p_account, p_actor);
  v_total integer;
  v_items jsonb;
BEGIN
  IF v_role IS NULL THEN
    PERFORM public.desk_refuse('desk_tray_page', 'NOT_ALLOWED', 'staff only');
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('open', 'filed', 'dismissed') THEN
    PERFORM public.desk_refuse('desk_tray_page', 'INVALID', 'state is open, filed or dismissed');
  END IF;
  SELECT count(*) INTO v_total FROM public.desk_tray t
   WHERE t.account_id = p_account AND t.state = p_state
     AND (v_role IN ('team_lead', 'admin', 'super_admin')
          OR public.desk_tray_can_sort(p_actor, p_account, t.candidates));
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'tray_id', p.id, 'reason', p.reason, 'candidates', p.candidates, 'state', p.state,
           'received_at', p.received_at,
           'age_seconds', greatest(0, extract(epoch FROM v_now - p.received_at))::bigint,
           'escalated_at', p.escalated_at, 'duty_user_id', p.duty_user_id, 'contact_id', p.contact_id,
           'contact_name', c.name, 'contact_phone', c.phone, 'conversation_id', p.conversation_id,
           'sender_companies', (SELECT coalesce(jsonb_agg(jsonb_build_object('company', x.legal_name, 'role', x.role)
                                                          ORDER BY x.legal_name), '[]'::jsonb)
                                  FROM public.desk_customers_for_contact(p_account, p.contact_id) x),
           'document_kind', d.kind, 'mime', d.mime, 'original_name', d.original_name, 'caption', d.caption,
           'size_bytes', d.size_bytes, 'media_url', d.media_url, 'resolved_case_id', p.resolved_case_id,
           'dismiss_reason', p.dismiss_reason) ORDER BY p.n), '[]'::jsonb)
    INTO v_items
    FROM (SELECT t.*, row_number() OVER (ORDER BY CASE WHEN p_state = 'open' THEN t.received_at END,
                                                  t.resolved_at DESC, t.received_at, t.id) AS n
            FROM public.desk_tray t
           WHERE t.account_id = p_account AND t.state = p_state
             AND (v_role IN ('team_lead', 'admin', 'super_admin')
                  OR public.desk_tray_can_sort(p_actor, p_account, t.candidates))
           ORDER BY n LIMIT v_limit) p
    JOIN public.customer_documents d ON d.id = p.customer_document_id
    LEFT JOIN public.contacts c ON c.id = p.contact_id;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

REVOKE ALL ON FUNCTION
  public.desk_tray_copy_failed(uuid, uuid, uuid, timestamptz),
  public.desk_tray_page(uuid, uuid, text, integer, timestamptz)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_tray_copy_failed(uuid, uuid, uuid, timestamptz),
  public.desk_tray_page(uuid, uuid, text, integer, timestamptz)
TO service_role;

-- ---------- 5. What counts as activity ----------

SELECT pg_temp.patch_303('public.case_rule_last_activity(uuid)',
$o$               WHERE s.case_id = p_case AND s.actor_role <> 'system'
                 AND NOT (s.actor_id IS NULL AND s.actor_role = 'system:rules')   -- 214
$o$, $n$               WHERE s.case_id = p_case AND s.actor_role <> 'system'
                 AND NOT (s.actor_id IS NULL AND s.actor_role = 'system:rules')   -- 214
    UNION ALL SELECT f.registered_at FROM public.case_document_files f WHERE f.case_id = p_case   -- 303
    UNION ALL (SELECT g.created_at FROM public.cases k   -- 303: submission_group_messages_group_created_idx
                 JOIN public.submission_group_messages g ON g.group_id = k.group_id
                WHERE k.id = p_case AND g.system_kind IS NULL
                  AND (g.direction = 'out' OR g.sender_kind IN ('customer', 'coordinator'))
                ORDER BY g.created_at DESC LIMIT 1)
$n$);

-- ---------- 6. One failing rule does not stop the sweep ----------

SELECT pg_temp.patch_303('public.case_rules_fire(text, uuid, timestamptz, text)',
$o$  LOOP
    -- A rule whose days$o$, $n$  LOOP
   BEGIN   -- 303
    -- A rule whose days$n$,
$o$    v_n := v_n + 1;
  END LOOP;$o$, $n$    v_n := v_n + 1;
   EXCEPTION WHEN others THEN
    -- 303: on the sweep, this rule's work and its run row (the once-only
    -- claim) are rolled back and tried again next time; on a write, as before.
    IF p_trigger NOT IN ('no_activity', 'sla_overdue') THEN RAISE; END IF;
    RAISE WARNING 'case_rules: rule % failed on case % (%): % %', r.rule_id, p_case, p_trigger, SQLSTATE, SQLERRM;
   END;
  END LOOP;$n$);
SELECT pg_temp.patch_303('public.case_rules_sweep(timestamptz)',
$o$    v_runs := public.case_rules_fire('no_activity'$o$, $n$    BEGIN   -- 303
    v_runs := public.case_rules_fire('no_activity'$n$,
$o$to_char(v.idle_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
$o$, $n$to_char(v.idle_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    EXCEPTION WHEN others THEN
      v_runs := 0;
      RAISE WARNING 'case_rules_sweep: no_activity failed on case %: % %', v.id, SQLSTATE, SQLERRM;
    END;
$n$);
SELECT pg_temp.patch_303('public.case_rules_sweep(timestamptz)',
$o$    v_runs := public.case_rules_fire('sla_overdue'$o$, $n$    BEGIN   -- 303
    v_runs := public.case_rules_fire('sla_overdue'$n$,
$o$to_char(v.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
$o$, $n$to_char(v.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    EXCEPTION WHEN others THEN
      v_runs := 0;
      RAISE WARNING 'case_rules_sweep: sla_overdue failed on case %: % %', v.case_id, SQLSTATE, SQLERRM;
    END;
$n$);

-- ---------- 7. The group-end sweep takes turns ----------

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS group_end_tried_at timestamptz NULL;
COMMENT ON COLUMN public.cases.group_end_tried_at IS
  'When ending this case''s group was last tried (case_claim_group_end_system); orders and spaces the sweep. Migration 303.';

SELECT pg_temp.patch_303('public.case_claim_group_end_system(uuid, interval)',
$o$  UPDATE public.cases x SET group_end_claimed_at = now() WHERE x.id = p_case;$o$,
$n$  UPDATE public.cases x SET group_end_claimed_at = now(), group_end_tried_at = now() WHERE x.id = p_case;$n$);
SELECT pg_temp.patch_303('public.case_claim_group_end_system(uuid, interval)',
$o$    RETURN QUERY SELECT false, c.stage, 'NOT_FINAL'::text$o$,
$n$    UPDATE public.cases x SET group_end_tried_at = now() WHERE x.id = p_case;   -- 303
    RETURN QUERY SELECT false, c.stage, 'NOT_FINAL'::text$n$);
SELECT pg_temp.patch_303('public.case_pending_group_end(interval, integer)',
$o$   ORDER BY c.closed_at, c.id$o$,
$n$     AND (c.group_end_tried_at IS NULL OR c.group_end_tried_at < now() - interval '30 minutes')   -- 303
   ORDER BY c.group_end_tried_at NULLS FIRST, c.closed_at, c.id$n$);

DROP FUNCTION pg_temp.patch_303(text, text, text, text, text);
RESET lock_timeout;
