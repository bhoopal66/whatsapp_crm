-- 320: the document attached last is the newest version.
--
-- Classifying a file again as the document it already was kept its version,
-- also below a newer one. So going back to a good v1 after a failed v2 left
-- the case not ready (case_file_ready: a failed file is newer), and a v1 that
-- failed on a mistyped expiry, attached again with the right date after v2
-- passed, was filed as replaced (181's older-pass branch). The screen said
-- "Attached" both times. A file now keeps its version only while it is the
-- type's highest; otherwise it takes the highest + 1 and is judged as any
-- newer upload. A pass replaces the passed one; a failure un-readies the
-- case. Pending and superseded versions count as versions.
--
-- And the name a file is given carries the Dubai day, not the UTC one
-- (src/lib/case-files/day.ts).
--
-- Existing rows are not touched. RESTATES case_document_file_classify (270):
-- re-run 320 after 270. Needs 270. Safe to run twice.
-- supabase/ci/verify-case-file-versions.sql asserts it.

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '320 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regprocedure('public.case_document_file_classify(uuid,uuid,text,integer,text)') IS NULL
     OR to_regprocedure('public.case_document_file_classify(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '320: apply 270_case_file_fixes.sql first (after 181)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.case_document_file_classify(
  p_actor uuid,
  p_file uuid,
  p_doc_key text,
  p_expect_seq integer DEFAULT NULL,
  p_expect_status text DEFAULT NULL
)
RETURNS TABLE (classify_seq integer, version integer, renamed_name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
#variable_conflict use_column
DECLARE
  f         public.case_document_files%ROWTYPE;
  c         public.cases%ROWTYPE;
  s         record;
  v_case    uuid;
  v_mime    text;
  v_ref     text;
  v_company text;
  v_version integer;
  v_name    text;
  v_now     timestamptz := now();
BEGIN
  SELECT x.case_id INTO v_case FROM public.case_document_files x WHERE x.id = p_file;
  IF v_case IS NULL THEN
    RAISE EXCEPTION 'file % not found', p_file USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;
  -- The case first, then the file.
  IF p_actor IS NULL THEN
    PERFORM 1 FROM public.cases x WHERE x.id = v_case FOR NO KEY UPDATE;
  ELSE
    PERFORM public.case_tools_lock_for_write(v_case, p_actor);
  END IF;
  SELECT * INTO f FROM public.case_document_files x WHERE x.id = p_file FOR UPDATE;
  SELECT * INTO c FROM public.cases x WHERE x.id = v_case;
  IF p_actor IS NULL AND c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', c.id
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  IF p_actor IS NULL
     AND (f.status <> 'unclassified' OR f.registered_by IS NOT NULL
          OR NOT (SELECT st.files_intake_prompts FROM public.case_files_settings(c.account_id) st)) THEN
    RAISE EXCEPTION 'file %: only staff may classify it', p_file
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF c.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'case % is closed', c.id USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  -- What the caller decided on, still true under the lock.
  IF f.classify_seq IS DISTINCT FROM coalesce(p_expect_seq, f.classify_seq)
     OR f.status IS DISTINCT FROM coalesce(p_expect_status, f.status) THEN
    RAISE EXCEPTION 'file % changed since it was read', p_file
      USING ERRCODE = 'check_violation', HINT = 'CHECK_MISMATCH';
  END IF;
  -- 181's refusal, kept for a caller that did not read it as superseded
  -- (after the mismatch, which tells a caller that named another status).
  IF f.status = 'superseded' AND p_expect_status IS DISTINCT FROM 'superseded' THEN
    RAISE EXCEPTION 'file % is superseded', p_file USING ERRCODE = 'check_violation', HINT = 'FILE_STATE';
  END IF;
  SELECT * INTO s FROM public.case_file_spec_rows(c.id) r WHERE r.doc_key = p_doc_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document % is not in the file spec of bank % / %', p_doc_key, coalesce(c.bank_code, '(none)'),
      coalesce(c.product, '(none)') USING ERRCODE = 'check_violation', HINT = 'DOC_NOT_REQUIRED';
  END IF;
  IF f.status = 'passed'
     AND (SELECT st.files_checklist_sync FROM public.case_files_settings(c.account_id) st)
     AND NOT public.case_managed_externally(c.account_id) THEN
    -- The checklist no longer has this file as its received copy.
    UPDATE public.case_documents d SET status = 'requested', file_ref = NULL, updated_by = p_actor, updated_at = v_now
     WHERE d.case_id = c.id AND d.file_ref = f.id::text;
  END IF;
  -- 320: only the type's newest file keeps its version.
  IF f.doc_key IS NOT DISTINCT FROM p_doc_key AND f.status <> 'superseded'
     AND NOT EXISTS (SELECT 1 FROM public.case_document_files x
                      WHERE x.case_id = c.id AND x.doc_key = p_doc_key AND x.version > f.version) THEN
    v_version := f.version;
  ELSE
    SELECT coalesce(max(x.version), 0) + 1 INTO v_version FROM public.case_document_files x
     WHERE x.case_id = c.id AND x.doc_key = p_doc_key;
  END IF;
  SELECT g.submission_ref, g.customer_name INTO v_ref, v_company
    FROM public.submission_groups g WHERE g.id = c.group_id;
  IF v_company IS NULL OR v_company ~ '^[[:space:]]*$' THEN
    SELECT k.name INTO v_company FROM public.contacts k WHERE k.id = c.contact_id;
  END IF;
  SELECT d.mime INTO v_mime FROM public.customer_documents d WHERE d.id = f.customer_document_id;
  v_name := public.case_file_render_name(s.name_pattern, coalesce(v_ref, 'CASE-' || left(c.id::text, 8)), v_company,
    p_doc_key, (v_now AT TIME ZONE 'Asia/Dubai')::date, v_mime);
  UPDATE public.case_document_files x
     SET doc_key = p_doc_key, version = v_version, renamed_name = v_name, status = 'pending_checks', checks = NULL,
         pages = NULL, expires_on = NULL, classified_by = p_actor,
         classified_system = CASE WHEN p_actor IS NULL THEN 'system:intake' END,
         classified_at = v_now, classify_seq = f.classify_seq + 1
   WHERE x.id = f.id;
  RETURN QUERY SELECT f.classify_seq + 1, v_version, v_name;
END;
$function$;
REVOKE ALL ON FUNCTION public.case_document_file_classify(uuid, uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.case_document_file_classify(uuid, uuid, text, integer, text) TO service_role;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
