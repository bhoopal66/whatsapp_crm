-- ============================================================
-- 270_case_file_fixes.sql — case file rules found missing by the
-- 2026-11-23 audit
--
--  1. A document replaced by mistake could never come back: a passed
--     check supersedes the type's other file, a superseded file could not
--     be classified (FILE_STATE), and registering the same bytes answers
--     that same row. Staff may now classify a superseded file again: it
--     becomes a new version (the type's highest + 1) pending checks, and
--     nothing is replaced until it passes. The system actor (NULL) still
--     cannot: it only classifies an unclassified file (NOT_ALLOWED). The
--     guard lets a superseded row make that one move and no other.
--  2. Of two Compass updates in flight the older one could write its
--     status on the group last. sg_note_submission_status takes the
--     update's changed_at and ignores a status older than the case's
--     external_changed_at, as case_sync_from_submission (134) does.
--     Read under the group's lock, so a newer update's status is never
--     overwritten once its sync is in.
--
-- Restates bodies of 181 (case_document_files_guard,
-- case_document_file_classify) and 267 (sg_note_submission_status):
-- apply in order, once. Re-applying 115 or 267 afterwards brings the
-- two-argument function back as an overload: apply this file again.
-- Additive for the previous build: 2 keeps the two-argument call.
-- Re-runnable. Asserted by supabase/ci/verify-case-file-fixes.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '270 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regclass('public.case_document_files') IS NULL THEN
    RAISE EXCEPTION '270: apply 181_case_files.sql first (case_document_files)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.submission_groups')
                    AND attname = 'submission_status_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION '270: apply 267_submission_group_fixes.sql first (submission_status_at)';
  END IF;
END $$;

-- ---------- 1. A replaced document can be used again ----------

-- 181's body; a superseded row may go back to pending checks, as a new
-- version classified by a person, and change in no other way.
CREATE OR REPLACE FUNCTION public.case_document_files_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.case_id, NEW.customer_document_id, NEW.registered_by, NEW.registered_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.case_id, OLD.customer_document_id, OLD.registered_by, OLD.registered_at) THEN
    RAISE EXCEPTION 'case_document_files: only the classification and check columns change'
      USING ERRCODE = 'insufficient_privilege', HINT = 'FILE_STATE';
  END IF;
  IF OLD.status = 'superseded'
     AND NOT (NEW.status = 'pending_checks' AND NEW.classified_by IS NOT NULL
              AND NEW.classify_seq = OLD.classify_seq + 1
              AND (NEW.doc_key IS DISTINCT FROM OLD.doc_key OR NEW.version > OLD.version)) THEN
    RAISE EXCEPTION 'case_document_files: a superseded file is final'
      USING ERRCODE = 'check_violation', HINT = 'FILE_STATE';
  END IF;
  RETURN NEW;
END;
$$;

-- 181's body without the refusal of a superseded file, which takes a
-- version of its own.
CREATE OR REPLACE FUNCTION public.case_document_file_classify(p_actor uuid, p_file uuid, p_doc_key text)
RETURNS TABLE (classify_seq integer, version integer, renamed_name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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
  IF f.doc_key IS NOT DISTINCT FROM p_doc_key AND f.status <> 'superseded' THEN
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
    p_doc_key, (v_now AT TIME ZONE 'UTC')::date, v_mime);
  UPDATE public.case_document_files x
     SET doc_key = p_doc_key, version = v_version, renamed_name = v_name, status = 'pending_checks', checks = NULL,
         pages = NULL, expires_on = NULL, classified_by = p_actor,
         classified_system = CASE WHEN p_actor IS NULL THEN 'system:intake' END,
         classified_at = v_now, classify_seq = f.classify_seq + 1
   WHERE x.id = f.id;
  RETURN QUERY SELECT f.classify_seq + 1, v_version, v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.case_document_file_classify(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.case_document_file_classify(uuid, uuid, text) TO service_role;

-- ---------- 2. The older of two updates is not the last word ----------

-- Dropped and created in one statement: two overloads would make the
-- two-argument call of the previous build ambiguous.
DO $$
BEGIN
  DROP FUNCTION IF EXISTS public.sg_note_submission_status(uuid, text);
  -- 267's body; false, and nothing written, when the status is older
  -- than the last update the case took.
  CREATE OR REPLACE FUNCTION public.sg_note_submission_status(
    p_group uuid,
    p_status text,
    p_changed_at timestamptz DEFAULT NULL
  )
  RETURNS boolean
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = ''
  AS $fn$
  DECLARE
    g public.submission_groups%ROWTYPE;
  BEGIN
    SELECT * INTO g FROM public.submission_groups WHERE id = p_group FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    -- NULL on either side is not older, as in 134.
    IF EXISTS (SELECT 1 FROM public.cases c WHERE c.group_id = p_group AND p_changed_at < c.external_changed_at) THEN
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
  $fn$;
  REVOKE ALL ON FUNCTION public.sg_note_submission_status(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.sg_note_submission_status(uuid, text, timestamptz) TO service_role;
END $$;

COMMENT ON FUNCTION public.sg_note_submission_status(uuid, text, timestamptz) IS
  'Stores a submission''s latest status on its group, ENDED included (267), unless p_changed_at is older than the case''s external_changed_at (270; NULL is never older); one that comes after the group ended or the case closed is also logged on the case.';

DO $$ BEGIN
  IF to_regprocedure('public.sg_note_submission_status(uuid,text,timestamptz)') IS NULL
     OR to_regprocedure('public.sg_note_submission_status(uuid,text)') IS NOT NULL
     OR position('is superseded' IN pg_get_functiondef('public.case_document_file_classify(uuid,uuid,text)'::regprocedure)) > 0
     OR position('classify_seq + 1' IN pg_get_functiondef('public.case_document_files_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '270 did not apply completely';
  END IF;
END $$;

RESET lock_timeout;
