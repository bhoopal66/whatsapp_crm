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
--  2. The app decides on a row it read before it downloaded the file, so
--     two people could file one file as two documents, and a file
--     superseded meanwhile could become a failed newest version.
--     case_document_file_classify takes the classify_seq and the status
--     the caller read and refuses (CHECK_MISMATCH) when the locked row has
--     others. Both, because a pass of another file supersedes a row
--     without a new classify_seq. NULL is not checked: the three-argument
--     call of the previous build and of SQL works as before.
--
-- NOT enforced here: that the checks of a file used again will pass. They
-- need the bytes, so the app runs them before it classifies
-- (intake-file.ts, REUSE_WOULD_FAIL). A failed check posted for such a file
-- is stored like any other, and the failed newest version then makes the
-- case not ready (181), supersedes its ready build (182) and deletes its
-- ready mark (184).
--
-- Restates two bodies of 181 (case_document_files_guard,
-- case_document_file_classify): do not re-apply 181 after this file
-- without applying this file again. 181 brings back its guard and the
-- three-argument function as an overload, which makes a three-argument
-- call ambiguous. Additive for the previous build. Re-runnable. Asserted
-- by supabase/ci/verify-case-file-fixes.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '270 must be applied by a superuser or BYPASSRLS role';
  END IF;
  IF to_regclass('public.case_document_files') IS NULL THEN
    RAISE EXCEPTION '270: apply 181_case_files.sql first (case_document_files)';
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

-- ---------- 2. Classified as it was read ----------

-- 181's body without the refusal of a superseded file, which takes a
-- version of its own, and with what the caller read. Dropped and created
-- in one statement: one overload, or PostgREST finds a three-argument
-- call ambiguous.
DO $$
DECLARE
  v_owner regrole := (SELECT p.proowner::regrole FROM pg_proc p WHERE p.oid = coalesce(
    to_regprocedure('public.case_document_file_classify(uuid,uuid,text)'),
    to_regprocedure('public.case_document_file_classify(uuid,uuid,text,integer,text)')));
BEGIN
  DROP FUNCTION IF EXISTS public.case_document_file_classify(uuid, uuid, text);
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
  AS $fn$
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
  $fn$;
  REVOKE ALL ON FUNCTION public.case_document_file_classify(uuid, uuid, text, integer, text)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.case_document_file_classify(uuid, uuid, text, integer, text) TO service_role;
  -- A drop loses the owner a replace would have kept.
  EXECUTE format('ALTER FUNCTION public.case_document_file_classify(uuid, uuid, text, integer, text) OWNER TO %s', v_owner);
END $$;

DO $$ BEGIN
  IF to_regprocedure('public.case_document_file_classify(uuid,uuid,text)') IS NOT NULL
     OR position('CHECK_MISMATCH' IN coalesce(pg_get_functiondef(
          to_regprocedure('public.case_document_file_classify(uuid,uuid,text,integer,text)')), '')) = 0
     OR position('classify_seq + 1' IN pg_get_functiondef('public.case_document_files_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '270 did not apply completely';
  END IF;
END $$;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
