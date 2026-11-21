-- ============================================================
-- 235_desk_worklist_suggest.sql — the desk in My worklist, and the
-- input for a suggested case (design 035 D8 and D12, slice G).
--
--  * desk_worklist(actor, account): what waits for this person at the
--    desk, as counts with the oldest age: tray documents they may sort
--    (230's rule), uploads in the sorting queues they sort (220's rule),
--    their own uploads still waiting for tags, and their open desk
--    follow-up tasks (230/232/233's source_refs). Counts only.
--  * desk_tray_suggest_input(actor, account, tray): what a suggestion may
--    see of one OPEN tray document the actor may sort: its kind, type,
--    caption and file name, and per candidate case (ordinal, in the
--    tray's order) the bank, product and the required documents still
--    missing or rejected. No company or person names, no ids beyond the
--    case ids the app maps the answer back to. The suggestion (a Jev
--    selection judgment, lib/desk/suggest.ts) is advice only: nothing
--    here or there files, links, messages or changes a stage.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only. No
-- new tables. Apply as a superuser or BYPASSRLS role after 234.
-- Re-runnable. Asserted by supabase/ci/verify-desk-worklist-suggest.sql.
-- docs/case-desk.md is the contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '235 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regclass('public.desk_digest_outbox') IS NULL THEN
    RAISE EXCEPTION '235: apply 234_desk_reminder_digest.sql first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.desk_worklist(p_actor uuid, p_account uuid, p_now timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
BEGIN
  IF public.case_account_role(p_account, p_actor) IS NULL THEN
    PERFORM public.desk_refuse('desk_worklist', 'NOT_ALLOWED', 'staff only');
  END IF;
  RETURN jsonb_build_object(
    'tray', (SELECT jsonb_build_object('count', count(*),
                     'oldest_seconds', floor(extract(epoch FROM v_now - min(t.received_at)))::bigint)
               FROM public.desk_tray t
              WHERE t.account_id = p_account AND t.state = 'open'
                AND public.desk_tray_can_sort(p_actor, p_account, t.candidates)),
    'queue', (SELECT jsonb_build_object('count', count(*),
                      'oldest_seconds', floor(extract(epoch FROM v_now - min(i.received_at)))::bigint)
                FROM public.intake_items i
               WHERE i.account_id = p_account AND i.state = 'untagged'
                 AND public.intake_scope_ok(p_actor, p_account, i.queue_bank_code)),
    'mine', (SELECT jsonb_build_object('count', count(*),
                     'oldest_seconds', floor(extract(epoch FROM v_now - min(i.received_at)))::bigint)
               FROM public.intake_items i
              WHERE i.account_id = p_account AND i.uploaded_by = p_actor AND i.state = 'untagged'),
    'tasks', (SELECT jsonb_build_object('count', count(*),
                      'oldest_seconds', floor(extract(epoch FROM v_now - min(k.created_at)))::bigint)
                FROM public.tasks k
               WHERE k.account_id = p_account AND k.assigned_to = p_actor AND k.status = 'open'
                 AND k.source = 'automation'
                 AND (k.source_ref LIKE 'desk\_tray:%' OR k.source_ref LIKE 'desk\_queue:%'
                      OR k.source_ref LIKE 'desk\_doc:%'))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_tray_suggest_input(p_actor uuid, p_account uuid, p_tray uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t public.desk_tray%ROWTYPE;
  d public.customer_documents%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.desk_tray x WHERE x.id = p_tray AND x.account_id = p_account;
  IF NOT FOUND OR NOT public.desk_tray_can_sort(p_actor, p_account, t.candidates) THEN
    PERFORM public.desk_refuse('desk_tray_suggest_input', 'TRAY_NOT_FOUND', 'tray item not found');
  END IF;
  IF t.state <> 'open' THEN
    PERFORM public.desk_refuse('desk_tray_suggest_input', 'TRAY_NOT_OPEN', 'this item was already sorted');
  END IF;
  SELECT * INTO d FROM public.customer_documents x WHERE x.id = t.customer_document_id;
  RETURN jsonb_build_object(
    'kind', d.kind, 'mime', d.mime, 'caption', d.caption, 'original_name', d.original_name,
    'candidates', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'case_id', k.id, 'bank_code', k.bank_code, 'product', k.product,
               'missing', (SELECT coalesce(jsonb_agg(coalesce(
                                 (SELECT q.label FROM public.case_doc_requirements q
                                   WHERE q.account_id = p_account AND q.doc_key = s.doc_key LIMIT 1),
                                 initcap(replace(s.doc_key, '_', ' '))) ORDER BY s."position"), '[]'::jsonb)
                             FROM public.case_file_spec_rows(k.id) s
                            WHERE s.required
                              AND public.desk_case_doc_cell(k.id, s.doc_key)->>'status' IN ('missing', 'failed')))
             ORDER BY e.ord), '[]'::jsonb)
        FROM jsonb_array_elements(t.candidates) WITH ORDINALITY e(c, ord)
        JOIN public.cases k ON k.id = (e.c->>'case_id')::uuid AND k.account_id = p_account
       WHERE k.closed_at IS NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.desk_worklist(uuid, uuid, timestamptz),
  public.desk_tray_suggest_input(uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.desk_worklist(uuid, uuid, timestamptz),
  public.desk_tray_suggest_input(uuid, uuid, uuid)
TO service_role;
