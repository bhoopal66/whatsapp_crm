-- ============================================================
-- 233_desk_application_view.sql — the application across its banks:
-- one merged checklist, and tasks when a shared document expires or is
-- replaced (design 035 section 5, slice E).
--
--  * desk_application_checklist: for a desk company, the union of the
--    REQUIRED documents (181's case_file_spec_rows) of its open cases the
--    viewer can read, each asked once against the strictest spec (the
--    longest min_valid_days), with each readable case's own status for
--    it. Cases the viewer cannot read are not columns: another bank's
--    coordinator sees only that such a case exists and its stage (231's
--    overview), never its checklist (D11, "stage only").
--  * desk_doc_tasks_due (service role, the automations cron): for every
--    open desk case NOT YET SUBMITTED (group_id NULL: a lead before its
--    submission group), a passed file
--      'expiring'  whose expires_on is within 14 days,
--      'expired'   whose expires_on has passed,
--      'replaced'  whose document a sibling case of the same company has
--                  since superseded with a newer passed version;
--    with whom to tell (the case's coordinator if live staff, else its
--    agent). The app raises one follow-up task per (file, kind)
--    (source_ref 'desk_doc:<file>:<kind>'). A submitted case is never
--    touched, and no file, status or stage is ever changed here.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only. No
-- new tables. Apply as a superuser or BYPASSRLS role after 232.
-- Re-runnable. Asserted by supabase/ci/verify-desk-application-view.sql.
-- docs/case-desk.md is the contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '233 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regclass('public.desk_doc_consents') IS NULL THEN
    RAISE EXCEPTION '233: apply 231_desk_shared_documents.sql first';
  END IF;
END $$;

-- The status a case shows for one required document: its passed file,
-- else its newest classified file's status, else 'missing'.
CREATE OR REPLACE FUNCTION public.desk_case_doc_cell(p_case uuid, p_doc_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT jsonb_build_object('status', f.status, 'file_id', f.id, 'expires_on', f.expires_on)
       FROM public.case_document_files f
      WHERE f.case_id = p_case AND f.doc_key = p_doc_key
      ORDER BY (f.status = 'passed') DESC, f.version DESC NULLS LAST, f.classified_at DESC NULLS LAST
      LIMIT 1),
    jsonb_build_object('status', 'missing'))
$$;

CREATE OR REPLACE FUNCTION public.desk_application_checklist(p_actor uuid, p_account uuid, p_customer uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT public.desk_customer_can_read(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_application_checklist', 'CUSTOMER_NOT_FOUND', 'company not found');
  END IF;
  WITH cs AS (
    SELECT k.id AS case_id, k.case_number, k.bank_code, k.product FROM public.cases k
     WHERE k.account_id = p_account AND k.desk_customer_id = p_customer AND k.closed_at IS NULL
       AND public.case_can_read(k.id, p_actor)
  ), req AS (
    SELECT c.case_id, c.bank_code, c.product, s.doc_key, s."position", s.min_valid_days
      FROM cs c
      CROSS JOIN LATERAL public.case_file_spec_rows(c.case_id) s
     WHERE s.required
  ), keys AS (
    SELECT r.doc_key, min(r."position") AS pos, max(r.min_valid_days) AS strictest,
           jsonb_agg(r.case_id ORDER BY r.case_id) AS required_by,
           (SELECT q.label FROM public.case_doc_requirements q, req r2
             WHERE r2.doc_key = r.doc_key AND q.account_id = p_account AND q.bank_code = r2.bank_code
               AND lower(btrim(q.product)) = lower(btrim(r2.product)) AND q.doc_key = r.doc_key
             LIMIT 1) AS label
      FROM req r GROUP BY r.doc_key
  )
  SELECT jsonb_build_object(
    'cases', (SELECT coalesce(jsonb_agg(jsonb_build_object('case_id', c.case_id, 'case_number', c.case_number,
                                                           'bank_code', c.bank_code) ORDER BY c.case_number), '[]'::jsonb)
                FROM cs c),
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'doc_key', k.doc_key, 'label', k.label, 'min_valid_days', k.strictest,
                'required_by', k.required_by,
                'cells', (SELECT jsonb_object_agg(c.case_id::text, public.desk_case_doc_cell(c.case_id, k.doc_key))
                            FROM cs c WHERE k.required_by @> to_jsonb(c.case_id)))
              ORDER BY k.pos, k.doc_key), '[]'::jsonb)
                FROM keys k))
    INTO v_out;
  RETURN v_out;
END;
$$;

-- ---------- Expiry and replacement (the automations cron) ----------

CREATE OR REPLACE FUNCTION public.desk_doc_tasks_due(p_now timestamptz DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS TABLE (account_id uuid, case_id uuid, case_number text, file_id uuid, doc_key text, kind text,
               expires_on date, assignee uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
   ORDER BY h.account_id, h.case_id, h.id
   LIMIT least(greatest(coalesce(p_limit, 500), 1), 2000)
$$;

REVOKE ALL ON FUNCTION
  public.desk_case_doc_cell(uuid, text), public.desk_application_checklist(uuid, uuid, uuid),
  public.desk_doc_tasks_due(timestamptz, integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_application_checklist(uuid, uuid, uuid), public.desk_doc_tasks_due(timestamptz, integer)
TO service_role;
