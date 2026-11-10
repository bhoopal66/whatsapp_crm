-- =============================================================================
-- 181 - Case document files (ported from the outside package's module 021a)
-- =============================================================================
--
-- A case's received files, each one a customer_documents row (178, 180)
-- registered against the case, classified as one of the case's required
-- documents (doc_key), renamed from a per-bank pattern, checked by the TS
-- checker, and passed or failed.
--
-- SPEC  case_file_specs: per (account, bank, product, doc_key) the
--   position, name pattern ({{case}} {{company}} {{doc}} {{yyyymmdd}}),
--   required, max_mb, allowed_mime (pdf/jpeg/png at most),
--   min_valid_days and merged. Written only by case_file_spec_set
--   (owner/admin, audited in case_file_spec_audit). With no rows for the
--   case's bank + product, the spec is derived from 123's
--   case_doc_requirements with the column defaults. Products match
--   case-insensitively on trimmed text, as 123 does.
--   {{case}} = submission_groups.submission_ref, else 'CASE-' + the first 8
--   characters of the case id; {{company}} = submission_groups.customer_name,
--   else the contact's name.
-- FILES case_document_files: one row per (case, customer document).
--   Rows are never deleted; only the classification and check columns
--   change, and only through:
--   case_document_file_register -> 'unclassified' (idempotent);
--   case_document_file_classify -> 'pending_checks' (bumps classify_seq);
--   case_document_file_check_result -> 'passed' | 'failed' (names the
--     doc_key and classify_seq it answers; a pass supersedes the previous
--     passed file of that doc_key).
--   A NULL actor is the system intake (WhatsApp media): it registers only a
--   customer-sent document, and classifies only a file it registered, once,
--   while files_intake_prompts is on.
-- READY case_file_ready(case): every required doc_key has a passed file and
--   no FAILED file of a higher version (false when nothing is required).
--
-- Every automatic behaviour is OFF by default (case_account_settings), and
-- none runs while case_managed_externally(account) (134):
--   files_checklist_sync  a pass marks case_documents 'received' (file_ref =
--                         the file id, updated_by NULL); a failed check
--                         newer than the passed file posts one system note
--                         to the coordinator;
--   files_ready_move      with files_ready_from_stage / _to_stage set, a
--                         file becoming 'passed' moves an open case at the
--                         from-stage to the to-stage once the case is file
--                         ready (actor NULL, role 'system:files') and posts
--                         one system note;
--   files_intake_prompts  the system intake may classify.
-- Lock order everywhere: the case FOR NO KEY UPDATE, then the file row.
-- Two results completing one case serialize on the case row, so it moves
-- once and gets one note.
--
-- Refusals (hint): NOT_ALLOWED, BANK_UNKNOWN, SPEC_INVALID, DOCS_INVALID,
-- CASE_NOT_FOUND, CASE_CLOSED, NO_CONTACT, FILE_NOT_FOUND, FILE_INVALID,
-- FILE_STATE, DOC_NOT_REQUIRED, CHECKS_INVALID, CHECK_MISMATCH,
-- SETTING_INVALID.
--
-- Re-runnable. Apply as a superuser or BYPASSRLS role (the tables force RLS
-- and the functions write them as their owner).
-- =============================================================================

-- ---------- 1. Spec ----------

CREATE TABLE IF NOT EXISTS public.case_file_specs (
  account_id     uuid    NOT NULL REFERENCES public.accounts(id),
  bank_code      text    NOT NULL,
  product        text    NOT NULL,
  doc_key        text    NOT NULL,
  position       integer NOT NULL DEFAULT 1,
  name_pattern   text    NOT NULL,
  required       boolean NOT NULL DEFAULT true,
  max_mb         integer NOT NULL DEFAULT 10,
  allowed_mime   text[]  NOT NULL DEFAULT ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[],
  min_valid_days integer NULL,
  merged         boolean NOT NULL DEFAULT true,
  CONSTRAINT case_file_specs_pkey PRIMARY KEY (account_id, bank_code, product, doc_key),
  CONSTRAINT case_file_specs_bank_fkey FOREIGN KEY (account_id, bank_code)
    REFERENCES public.case_banks (account_id, code),
  CONSTRAINT case_file_specs_product_check CHECK (product !~ '^[[:space:]]*$' AND char_length(product) <= 200),
  CONSTRAINT case_file_specs_key_check CHECK (doc_key ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT case_file_specs_position_check CHECK (position > 0),
  CONSTRAINT case_file_specs_pattern_check
    CHECK (name_pattern !~ '^[[:space:]]*$' AND char_length(name_pattern) <= 200),
  CONSTRAINT case_file_specs_max_mb_check CHECK (max_mb BETWEEN 1 AND 100),
  CONSTRAINT case_file_specs_mime_check
    CHECK (cardinality(allowed_mime) > 0
           AND allowed_mime <@ ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[]),
  CONSTRAINT case_file_specs_valid_days_check CHECK (min_valid_days IS NULL OR min_valid_days >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS case_file_specs_product_ci_key
  ON public.case_file_specs (account_id, bank_code, lower(btrim(product)), doc_key);

COMMENT ON TABLE public.case_file_specs IS
  'File specification per (account, bank, product; product case-insensitive, trimmed). Written only through case_file_spec_set (owner/admin). Migration 181.';

CREATE TABLE IF NOT EXISTS public.case_file_spec_audit (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  bank_code  text NOT NULL,
  product    text NOT NULL,
  actor_id   uuid NOT NULL,
  rows       jsonb NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_file_spec_audit_account_idx
  ON public.case_file_spec_audit (account_id, at);

COMMENT ON TABLE public.case_file_spec_audit IS
  'Append-only: every case_file_spec_set call with the rows it stored. Migration 181.';

DROP TRIGGER IF EXISTS case_file_spec_audit_append_only ON public.case_file_spec_audit;
CREATE TRIGGER case_file_spec_audit_append_only
  BEFORE UPDATE OR DELETE ON public.case_file_spec_audit
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_file_spec_audit_no_truncate ON public.case_file_spec_audit;
CREATE TRIGGER case_file_spec_audit_no_truncate
  BEFORE TRUNCATE ON public.case_file_spec_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 2. Files ----------

CREATE TABLE IF NOT EXISTS public.case_document_files (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL,
  case_id              uuid NOT NULL,
  customer_document_id uuid NOT NULL REFERENCES public.customer_documents(id),
  doc_key              text NULL,
  version              integer NULL,
  status               text NOT NULL DEFAULT 'unclassified',
  classify_seq         integer NOT NULL DEFAULT 0,
  checks               jsonb NULL,
  pages                integer NULL,
  expires_on           date NULL,
  renamed_name         text NULL,
  classified_by        uuid NULL,
  classified_system    text NULL,
  classified_at        timestamptz NULL,
  registered_by        uuid NULL,
  registered_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_document_files_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_document_files_one_per_document UNIQUE (case_id, customer_document_id),
  CONSTRAINT case_document_files_status_check
    CHECK (status IN ('unclassified', 'pending_checks', 'passed', 'failed', 'superseded')),
  CONSTRAINT case_document_files_key_check CHECK (doc_key IS NULL OR doc_key ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT case_document_files_version_check CHECK (version IS NULL OR version > 0),
  CONSTRAINT case_document_files_seq_check CHECK (classify_seq >= 0),
  CONSTRAINT case_document_files_checks_check CHECK (checks IS NULL OR jsonb_typeof(checks) = 'array'),
  CONSTRAINT case_document_files_pages_check CHECK (pages IS NULL OR pages >= 0),
  CONSTRAINT case_document_files_name_check
    CHECK (renamed_name IS NULL OR renamed_name ~ '^[A-Za-z0-9._-]{1,120}$'),
  CONSTRAINT case_document_files_system_check
    CHECK (classified_system IS NULL OR classified_system IN ('system:intake')),
  CONSTRAINT case_document_files_one_classifier
    CHECK (classified_by IS NULL OR classified_system IS NULL),
  CONSTRAINT case_document_files_classified
    CHECK (status = 'unclassified'
           OR (doc_key IS NOT NULL AND version IS NOT NULL AND renamed_name IS NOT NULL AND classified_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS case_document_files_one_passed
  ON public.case_document_files (case_id, doc_key) WHERE status = 'passed';
CREATE INDEX IF NOT EXISTS case_document_files_case_key_idx
  ON public.case_document_files (case_id, doc_key, version);
CREATE INDEX IF NOT EXISTS case_document_files_document_idx
  ON public.case_document_files (customer_document_id);

COMMENT ON TABLE public.case_document_files IS
  'A customer document registered against a case, its classification (doc_key, version, renamed_name) and check result. Never deleted; written only through the case_document_file_* functions. Migration 181.';

-- Only the classification and check columns change; a superseded file is
-- final; rows are never deleted.
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
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'case_document_files: a superseded file is final'
      USING ERRCODE = 'check_violation', HINT = 'FILE_STATE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS case_document_files_guard ON public.case_document_files;
CREATE TRIGGER case_document_files_guard
  BEFORE UPDATE ON public.case_document_files
  FOR EACH ROW EXECUTE FUNCTION public.case_document_files_guard();
DROP TRIGGER IF EXISTS case_document_files_no_delete ON public.case_document_files;
CREATE TRIGGER case_document_files_no_delete
  BEFORE DELETE ON public.case_document_files
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_document_files_no_truncate ON public.case_document_files;
CREATE TRIGGER case_document_files_no_truncate
  BEFORE TRUNCATE ON public.case_document_files
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 3. Settings (all off by default) ----------

ALTER TABLE public.case_account_settings ADD COLUMN IF NOT EXISTS files_checklist_sync boolean NOT NULL DEFAULT false;
ALTER TABLE public.case_account_settings ADD COLUMN IF NOT EXISTS files_ready_move boolean NOT NULL DEFAULT false;
ALTER TABLE public.case_account_settings ADD COLUMN IF NOT EXISTS files_ready_from_stage text NULL;
ALTER TABLE public.case_account_settings ADD COLUMN IF NOT EXISTS files_ready_to_stage text NULL;
ALTER TABLE public.case_account_settings ADD COLUMN IF NOT EXISTS files_intake_prompts boolean NOT NULL DEFAULT false;

ALTER TABLE public.case_account_settings DROP CONSTRAINT IF EXISTS case_account_settings_files_ready_pair;
ALTER TABLE public.case_account_settings ADD CONSTRAINT case_account_settings_files_ready_pair
  CHECK ((files_ready_from_stage IS NULL) = (files_ready_to_stage IS NULL));

COMMENT ON COLUMN public.case_account_settings.files_checklist_sync IS
  'A passed file marks the case checklist received; a newer failed file notes the coordinator. Default off. Migration 181.';
COMMENT ON COLUMN public.case_account_settings.files_ready_move IS
  'A file-ready case at files_ready_from_stage moves to files_ready_to_stage. Default off. Migration 181.';
COMMENT ON COLUMN public.case_account_settings.files_intake_prompts IS
  'The WhatsApp intake may classify the files it registered. Default off. Migration 181.';

-- The account's file settings; the defaults when it has no row.
CREATE OR REPLACE FUNCTION public.case_files_settings(p_account uuid)
RETURNS TABLE (files_checklist_sync boolean, files_ready_move boolean, files_ready_from_stage text,
               files_ready_to_stage text, files_intake_prompts boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(s.files_checklist_sync, false), coalesce(s.files_ready_move, false),
         s.files_ready_from_stage, s.files_ready_to_stage, coalesce(s.files_intake_prompts, false)
    FROM (SELECT 1) one
    LEFT JOIN public.case_account_settings s ON s.account_id = p_account
$$;

-- 136's setter shape, one per switch. Returns the stored value.
CREATE OR REPLACE FUNCTION public.case_settings_set_files_switch(p_actor uuid, p_account uuid, p_switch text,
  p_on boolean)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := public.case_account_role(p_account, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the case settings of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_on IS NULL OR p_switch IS NULL
     OR p_switch NOT IN ('files_checklist_sync', 'files_ready_move', 'files_intake_prompts') THEN
    RAISE EXCEPTION 'SETTING_INVALID: % must be a files switch set to true or false', p_switch
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  INSERT INTO public.case_account_settings AS s (account_id, files_checklist_sync, files_ready_move,
    files_intake_prompts, updated_at, updated_by)
  VALUES (p_account, p_switch = 'files_checklist_sync' AND p_on, p_switch = 'files_ready_move' AND p_on,
          p_switch = 'files_intake_prompts' AND p_on, now(), p_actor)
  ON CONFLICT (account_id) DO UPDATE
    SET files_checklist_sync = CASE WHEN p_switch = 'files_checklist_sync' THEN p_on ELSE s.files_checklist_sync END,
        files_ready_move     = CASE WHEN p_switch = 'files_ready_move' THEN p_on ELSE s.files_ready_move END,
        files_intake_prompts = CASE WHEN p_switch = 'files_intake_prompts' THEN p_on ELSE s.files_intake_prompts END,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  RETURN p_on;
END;
$$;

-- The File ready stage pair. Both NULL clears it. Otherwise both must be
-- in the account's default stage list, neither pre-submission nor final,
-- different, and the from-stage before the to-stage.
CREATE OR REPLACE FUNCTION public.case_settings_set_files_ready_stages(p_actor uuid, p_account uuid,
  p_from text, p_to text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role   text;
  v_stages text[];
  v_from   integer;
  v_to     integer;
BEGIN
  v_role := public.case_account_role(p_account, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the case settings of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF (p_from IS NULL) <> (p_to IS NULL) THEN
    RAISE EXCEPTION 'SETTING_INVALID: set both File ready stages or neither'
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  IF p_from IS NOT NULL THEN
    v_stages := public.case_stages_for_bank(p_account, NULL);
    v_from := array_position(v_stages, p_from);
    v_to := array_position(v_stages, p_to);
    IF v_from IS NULL OR v_to IS NULL THEN
      RAISE EXCEPTION 'SETTING_INVALID: % / % is not in the default stage list', p_from, p_to
        USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
    END IF;
    IF public.case_stage_is_presub(p_from) OR public.case_stage_is_presub(p_to) THEN
      RAISE EXCEPTION 'SETTING_INVALID: a pre-submission stage cannot be a File ready stage'
        USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
    END IF;
    IF p_from IN ('Approved', 'Declined', 'Withdrawn', 'Closed') OR p_to IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN
      RAISE EXCEPTION 'SETTING_INVALID: a final stage cannot be a File ready stage'
        USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
    END IF;
    IF v_from >= v_to THEN
      RAISE EXCEPTION 'SETTING_INVALID: % must come before %', p_from, p_to
        USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
    END IF;
  END IF;
  INSERT INTO public.case_account_settings AS s (account_id, files_ready_from_stage, files_ready_to_stage,
    updated_at, updated_by)
  VALUES (p_account, p_from, p_to, now(), p_actor)
  ON CONFLICT (account_id) DO UPDATE
    SET files_ready_from_stage = EXCLUDED.files_ready_from_stage,
        files_ready_to_stage = EXCLUDED.files_ready_to_stage,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  RETURN p_from IS NOT NULL;
END;
$$;

-- ---------- 4. Naming (mirrors src/lib/case-files render-name; exact port) ----------

CREATE OR REPLACE FUNCTION public.case_file_render_name(p_pattern text, p_case text, p_company text, p_doc text, p_date date, p_mime text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v text;
  v_ext text := CASE p_mime WHEN 'application/pdf' THEN '.pdf' WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png' ELSE '' END;
BEGIN
  v := replace(replace(replace(replace(coalesce(p_pattern, ''), '{{case}}', coalesce(p_case, '')), '{{company}}', coalesce(p_company, '')),
               '{{doc}}', coalesce(p_doc, '')), '{{yyyymmdd}}', to_char(p_date, 'YYYYMMDD'));
  v := regexp_replace(v, '[^A-Za-z0-9._-]+', '_', 'g');
  v := regexp_replace(v, '^[._-]+|[._-]+$', '', 'g');
  v := regexp_replace(left(v, 120 - length(v_ext)), '[._-]+$', '');
  IF v = '' THEN v := 'file'; END IF;
  RETURN v || v_ext;
END;
$$;

-- ---------- 5. The effective spec of a case ----------

-- Spec rows for the case's bank + product; else derived from
-- case_doc_requirements (all required, pattern
-- '{{case}}_{{doc}}_{{yyyymmdd}}', the column defaults otherwise).
CREATE OR REPLACE FUNCTION public.case_file_spec_rows(p_case uuid)
RETURNS TABLE (doc_key text, "position" integer, name_pattern text, required boolean, max_mb integer,
               allowed_mime text[], min_valid_days integer, merged boolean, from_spec boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF EXISTS (SELECT 1 FROM public.case_file_specs s
              WHERE s.account_id = c.account_id AND s.bank_code = c.bank_code
                AND lower(btrim(s.product)) = lower(btrim(c.product))) THEN
    RETURN QUERY
      SELECT s.doc_key, s.position, s.name_pattern, s.required, s.max_mb, s.allowed_mime, s.min_valid_days,
             s.merged, true
        FROM public.case_file_specs s
       WHERE s.account_id = c.account_id AND s.bank_code = c.bank_code
         AND lower(btrim(s.product)) = lower(btrim(c.product))
       ORDER BY s.position, s.doc_key;
  ELSE
    RETURN QUERY
      SELECT r.doc_key, r.position, '{{case}}_{{doc}}_{{yyyymmdd}}'::text, true, 10,
             ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[], NULL::integer, true, false
        FROM public.case_doc_requirements r
       WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
         AND lower(btrim(r.product)) = lower(btrim(c.product))
       ORDER BY r.position, r.doc_key;
  END IF;
END;
$$;

-- ---------- 6. Spec setter (owner/admin of the actor's active workspace; audited) ----------

-- p_rows: array of {doc_key, name_pattern, position?, required?, max_mb?,
-- allowed_mime?, min_valid_days?, merged?}; merged must be the same on
-- every row; every doc_key a document requirement of the bank + product.
-- An empty array removes the spec (the requirements apply again).
-- Returns the audit row id.
CREATE OR REPLACE FUNCTION public.case_file_spec_set(p_actor uuid, p_bank_code text, p_product text, p_rows jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_after   jsonb;
  v_id      uuid;
BEGIN
  SELECT p.account_id INTO v_account FROM public.profiles p
   WHERE p.user_id = p_actor AND p.is_active AND p.deactivated_at IS NULL;
  IF v_account IS NULL OR coalesce(public.case_account_role(v_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure file specs', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = v_account AND b.code = p_bank_code FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  IF p_product IS NULL OR p_product ~ '^[[:space:]]*$' OR char_length(p_product) > 200
     OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e
                 WHERE jsonb_typeof(e) <> 'object'
                    OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k
                                WHERE k NOT IN ('doc_key', 'name_pattern', 'position', 'required', 'max_mb',
                                                'allowed_mime', 'min_valid_days', 'merged'))
                    OR jsonb_typeof(e -> 'doc_key') IS DISTINCT FROM 'string' OR (e ->> 'doc_key') !~ '^[a-z0-9_]{1,64}$'
                    OR jsonb_typeof(e -> 'name_pattern') IS DISTINCT FROM 'string'
                    OR (e ->> 'name_pattern') ~ '^[[:space:]]*$'
                    OR char_length(e ->> 'name_pattern') > 200
                    OR regexp_replace(e ->> 'name_pattern', '\{\{(case|company|doc|yyyymmdd)\}\}', '', 'g') ~ '\{\{|\}\}'
                    OR (e ? 'position' AND ((e ->> 'position') !~ '^[0-9]{1,9}$' OR (e ->> 'position')::integer <= 0))
                    OR (e ? 'required' AND jsonb_typeof(e -> 'required') <> 'boolean')
                    OR (e ? 'merged' AND jsonb_typeof(e -> 'merged') <> 'boolean')
                    OR (e ? 'max_mb' AND ((e ->> 'max_mb') !~ '^[0-9]{1,3}$' OR (e ->> 'max_mb')::integer NOT BETWEEN 1 AND 100))
                    OR (e ? 'min_valid_days' AND jsonb_typeof(e -> 'min_valid_days') <> 'null'
                        AND ((e ->> 'min_valid_days') !~ '^[0-9]{1,4}$' OR (e ->> 'min_valid_days')::integer > 3650))
                    OR (e ? 'allowed_mime' AND (jsonb_typeof(e -> 'allowed_mime') <> 'array'
                        OR jsonb_array_length(e -> 'allowed_mime') = 0
                        OR EXISTS (SELECT 1 FROM jsonb_array_elements(e -> 'allowed_mime') m
                                    WHERE jsonb_typeof(m) <> 'string'
                                       OR (m #>> '{}') NOT IN ('application/pdf', 'image/jpeg', 'image/png')))))
     OR (SELECT count(DISTINCT e ->> 'doc_key') <> count(*) FROM jsonb_array_elements(p_rows) e)
     OR (SELECT count(DISTINCT coalesce((e ->> 'position')::integer, 1)) <> count(*) FROM jsonb_array_elements(p_rows) e)
     OR (SELECT count(DISTINCT coalesce((e ->> 'merged')::boolean, true)) > 1 FROM jsonb_array_elements(p_rows) e) THEN
    RAISE EXCEPTION 'file spec must be an array of {doc_key, name_pattern, position?, required?, max_mb?, allowed_mime?, min_valid_days?, merged?} with unique keys and positions, known placeholders, allowed_mime within pdf/jpeg/png and one merged value'
      USING ERRCODE = 'check_violation', HINT = 'SPEC_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e
              WHERE NOT EXISTS (SELECT 1 FROM public.case_doc_requirements q
                                 WHERE q.account_id = v_account AND q.bank_code = p_bank_code
                                   AND lower(btrim(q.product)) = lower(btrim(p_product))
                                   AND q.doc_key = e ->> 'doc_key')) THEN
    RAISE EXCEPTION 'every doc_key of the file spec must be a document requirement of bank % / %', p_bank_code, p_product
      USING ERRCODE = 'check_violation', HINT = 'DOCS_INVALID';
  END IF;
  DELETE FROM public.case_file_specs s
   WHERE s.account_id = v_account AND s.bank_code = p_bank_code
     AND lower(btrim(s.product)) = lower(btrim(p_product));
  INSERT INTO public.case_file_specs (account_id, bank_code, product, doc_key, position, name_pattern, required,
    max_mb, allowed_mime, min_valid_days, merged)
  SELECT v_account, p_bank_code, btrim(p_product), e ->> 'doc_key', coalesce((e ->> 'position')::integer, 1),
         e ->> 'name_pattern', coalesce((e ->> 'required')::boolean, true), coalesce((e ->> 'max_mb')::integer, 10),
         coalesce((SELECT array_agg(m #>> '{}') FROM jsonb_array_elements(e -> 'allowed_mime') m),
                  ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[]),
         (e ->> 'min_valid_days')::integer, coalesce((e ->> 'merged')::boolean, true)
    FROM jsonb_array_elements(p_rows) e;
  SELECT coalesce(jsonb_agg(to_jsonb(s) - 'account_id' - 'bank_code' - 'product' ORDER BY s.position, s.doc_key), '[]'::jsonb)
    INTO v_after
    FROM public.case_file_specs s
   WHERE s.account_id = v_account AND s.bank_code = p_bank_code
     AND lower(btrim(s.product)) = lower(btrim(p_product));
  INSERT INTO public.case_file_spec_audit (account_id, bank_code, product, actor_id, rows)
  VALUES (v_account, p_bank_code, btrim(p_product), p_actor, v_after)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------- 7. Register ----------

-- Register's rules that need no document (the case exists, the actor may
-- write it unless NULL = the system intake, it is open and has a contact),
-- so the caller refuses before it stores any bytes. True or raises.
CREATE OR REPLACE FUNCTION public.case_document_file_can_register(p_actor uuid, p_case uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.cases%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    PERFORM 1 FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
    END IF;
  ELSE
    PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  -- The intake never acts on a case Compass manages (134's rule, as
  -- isManagedExternally); staff are not refused here.
  IF p_actor IS NULL AND c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', p_case
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  IF c.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'case % is closed', p_case USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  IF c.contact_id IS NULL THEN
    RAISE EXCEPTION 'case % has no customer contact', p_case USING ERRCODE = 'check_violation', HINT = 'NO_CONTACT';
  END IF;
  RETURN true;
END;
$$;

-- Registers a customer document of the case's own customer (same account,
-- documents.contact_id = cases.contact_id). Idempotent: the same pair
-- returns the same file id. A NULL actor (system intake) registers only a
-- document the customer sent (source chat / submission_group).
CREATE OR REPLACE FUNCTION public.case_document_file_register(p_actor uuid, p_case uuid, p_customer_document_id uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c    public.cases%ROWTYPE;
  d    public.customer_documents%ROWTYPE;
  v_id uuid;
BEGIN
  PERFORM public.case_document_file_can_register(p_actor, p_case);
  SELECT x.id INTO v_id FROM public.case_document_files x
   WHERE x.case_id = p_case AND x.customer_document_id = p_customer_document_id;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  SELECT * INTO d FROM public.customer_documents x WHERE x.id = p_customer_document_id;
  IF NOT FOUND OR d.account_id <> c.account_id THEN
    RAISE EXCEPTION 'document % not found', p_customer_document_id
      USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;
  IF d.contact_id IS DISTINCT FROM c.contact_id THEN
    RAISE EXCEPTION 'document % is not the case customer''s', p_customer_document_id
      USING ERRCODE = 'check_violation', HINT = 'FILE_INVALID';
  END IF;
  IF p_actor IS NULL AND d.source NOT IN ('chat', 'submission_group') THEN
    RAISE EXCEPTION 'the intake registers only documents the customer sent'
      USING ERRCODE = 'check_violation', HINT = 'FILE_INVALID';
  END IF;
  INSERT INTO public.case_document_files (account_id, case_id, customer_document_id, registered_by)
  VALUES (c.account_id, p_case, p_customer_document_id, p_actor)
  ON CONFLICT ON CONSTRAINT case_document_files_one_per_document DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT x.id INTO v_id FROM public.case_document_files x
     WHERE x.case_id = p_case AND x.customer_document_id = p_customer_document_id;
  END IF;
  RETURN v_id;
END;
$$;

-- ---------- 8. Classify ----------

-- Classifies (or reclassifies) a file as one doc_key of the case's spec:
-- the next version of that doc_key (kept when the doc_key is unchanged),
-- the renamed name, status pending_checks, classify_seq + 1. A staff actor
-- needs write permission; a NULL actor is the system intake (its own
-- unclassified file, once, while files_intake_prompts is on).
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
  IF f.status = 'superseded' THEN
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
  IF f.doc_key IS NOT DISTINCT FROM p_doc_key THEN
    v_version := f.version;
  ELSE
    SELECT coalesce(max(x.version), 0) + 1 INTO v_version FROM public.case_document_files x
     WHERE x.case_id = c.id AND x.doc_key = p_doc_key AND x.id <> f.id;
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

-- ---------- 9. Ready ----------

CREATE OR REPLACE FUNCTION public.case_file_ready(p_case uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.case_file_spec_rows(p_case) r WHERE r.required)
     AND NOT EXISTS (SELECT 1 FROM public.case_file_spec_rows(p_case) r
                      WHERE r.required
                        AND NOT EXISTS (SELECT 1 FROM public.case_document_files f
                                         WHERE f.case_id = p_case AND f.doc_key = r.doc_key AND f.status = 'passed'
                                           AND NOT EXISTS (SELECT 1 FROM public.case_document_files g
                                                            WHERE g.case_id = f.case_id AND g.doc_key = f.doc_key
                                                              AND g.status = 'failed' AND g.version > f.version)))
$$;

-- ---------- 10. Check result (the TS checker) ----------

-- p_doc_key / p_classify_seq: the classification the checks were run for;
-- any other (a concurrent reclassify) is refused CHECK_MISMATCH.
CREATE OR REPLACE FUNCTION public.case_document_file_check_result(p_file uuid, p_doc_key text, p_classify_seq integer,
  p_checks jsonb, p_pages integer, p_expires_on date)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  f        public.case_document_files%ROWTYPE;
  c        public.cases%ROWTYPE;
  v_case   uuid;
  v_ok     boolean;
  v_status text;
  v_sync   boolean;
  v_detail text;
BEGIN
  SELECT x.case_id INTO v_case FROM public.case_document_files x WHERE x.id = p_file;
  IF v_case IS NULL THEN
    RAISE EXCEPTION 'file % not found', p_file USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;
  -- The case first: two results completing one case serialize here, so
  -- exactly one sees it file ready.
  SELECT * INTO c FROM public.cases x WHERE x.id = v_case FOR NO KEY UPDATE;
  SELECT * INTO f FROM public.case_document_files x WHERE x.id = p_file FOR UPDATE;
  IF f.status <> 'pending_checks' THEN
    RAISE EXCEPTION 'file % is %, not pending checks', p_file, f.status
      USING ERRCODE = 'check_violation', HINT = 'FILE_STATE';
  END IF;
  IF (f.doc_key, f.classify_seq) IS DISTINCT FROM (p_doc_key, p_classify_seq) THEN
    RAISE EXCEPTION 'file %: the checks are for another classification', p_file
      USING ERRCODE = 'check_violation', HINT = 'CHECK_MISMATCH';
  END IF;
  IF c.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'case % is closed', c.id USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  IF jsonb_typeof(p_checks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_checks) = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_checks) e
                 WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'name') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(e -> 'ok') IS DISTINCT FROM 'boolean'
                    OR (e ? 'detail' AND jsonb_typeof(e -> 'detail') NOT IN ('string', 'null')))
     OR (p_pages IS NOT NULL AND p_pages < 0) THEN
    RAISE EXCEPTION 'checks must be a non-empty array of {name, ok, detail?}'
      USING ERRCODE = 'check_violation', HINT = 'CHECKS_INVALID';
  END IF;
  v_ok := NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_checks) e WHERE NOT (e ->> 'ok')::boolean);
  v_status := CASE WHEN v_ok THEN 'passed' ELSE 'failed' END;
  v_sync := (SELECT st.files_checklist_sync FROM public.case_files_settings(c.account_id) st)
            AND NOT public.case_managed_externally(c.account_id);
  IF v_ok THEN
    UPDATE public.case_document_files x SET status = 'superseded'
     WHERE x.case_id = f.case_id AND x.doc_key = f.doc_key AND x.status = 'passed' AND x.id <> f.id;
    IF v_sync THEN
      INSERT INTO public.case_documents AS d (case_id, account_id, doc_key, status, file_ref, updated_by, updated_at)
      VALUES (c.id, c.account_id, f.doc_key, 'received', f.id::text, NULL, now())
      ON CONFLICT ON CONSTRAINT case_documents_pkey DO UPDATE
        SET status = EXCLUDED.status, file_ref = EXCLUDED.file_ref,
            updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
    END IF;
  END IF;
  -- The ready-move trigger fires here when the file becomes passed.
  UPDATE public.case_document_files x SET checks = p_checks, pages = p_pages, expires_on = p_expires_on, status = v_status
   WHERE x.id = f.id;
  -- A failure newer than the doc_key's passed file un-readies the case:
  -- one coordinator note; the stage is not moved back.
  IF NOT v_ok AND v_sync
     AND EXISTS (SELECT 1 FROM public.case_file_spec_rows(c.id) r WHERE r.doc_key = f.doc_key AND r.required)
     AND EXISTS (SELECT 1 FROM public.case_document_files p
                  WHERE p.case_id = f.case_id AND p.doc_key = f.doc_key AND p.status = 'passed' AND p.version < f.version) THEN
    SELECT string_agg((e ->> 'name') || coalesce(': ' || (e ->> 'detail'), ''), '; ') INTO v_detail
      FROM jsonb_array_elements(p_checks) e WHERE NOT (e ->> 'ok')::boolean;
    PERFORM public.case_note_add_system(c.id, 'system:files',
      left(coalesce('@' || c.coordinator_id::text || ' ', '') || 'Latest upload of ' || f.doc_key
           || ' failed its checks: ' || v_detail, 10000));
  END IF;
  RETURN v_status;
END;
$$;

-- ---------- 11. File ready: the stage move ----------

-- Moves an open case at the account's from-stage to its to-stage when
-- files_ready_move is on, the to-stage is in the case's bank list, the
-- account is not managed externally and the case is file ready. 166's
-- non-final move shape, actor NULL, role 'system:files', plus one system
-- note. Returns whether it moved. Executable by no API role.
CREATE OR REPLACE FUNCTION public.case_files_ready_move(p_case uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c  public.cases%ROWTYPE;
  st record;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND OR c.closed_at IS NOT NULL OR c.stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN
    RETURN false;
  END IF;
  SELECT * INTO st FROM public.case_files_settings(c.account_id);
  IF NOT st.files_ready_move OR st.files_ready_from_stage IS NULL OR st.files_ready_to_stage IS NULL
     OR public.case_managed_externally(c.account_id)
     OR c.stage <> st.files_ready_from_stage
     OR NOT (st.files_ready_to_stage = ANY (public.case_stages_for_bank(c.account_id, c.bank_code)))
     OR NOT public.case_file_ready(c.id) THEN
    RETURN false;
  END IF;
  UPDATE public.cases x SET stage = st.files_ready_to_stage WHERE x.id = c.id;
  INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
  VALUES (c.id, c.account_id, c.stage, st.files_ready_to_stage, c.outcome, NULL, 'system:files');
  PERFORM public.case_note_add_system(c.id, 'system:files',
    coalesce('@' || c.coordinator_id::text || ' ', '')
    || 'File ready: every required document is received and checked; the case moved to '
    || st.files_ready_to_stage || '.');
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_document_files_ready_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.case_files_ready_move(NEW.case_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_document_files_ready ON public.case_document_files;
CREATE TRIGGER case_document_files_ready
  AFTER UPDATE OF status ON public.case_document_files
  FOR EACH ROW WHEN (NEW.status = 'passed' AND OLD.status IS DISTINCT FROM 'passed')
  EXECUTE FUNCTION public.case_document_files_ready_hook();

-- ---------- 12. Row-level security ----------

ALTER TABLE public.case_file_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_specs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_spec_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_spec_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_document_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_document_files FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_file_specs_select ON public.case_file_specs;
CREATE POLICY case_file_specs_select ON public.case_file_specs FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id));

DROP POLICY IF EXISTS case_document_files_select ON public.case_document_files;
CREATE POLICY case_document_files_select ON public.case_document_files FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

-- ---------- 13. Privileges ----------

REVOKE ALL ON public.case_file_specs, public.case_file_spec_audit, public.case_document_files
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_file_specs, public.case_document_files TO authenticated, service_role;
GRANT SELECT ON public.case_file_spec_audit TO service_role;

REVOKE ALL ON FUNCTION
  public.case_document_files_guard(),
  public.case_document_files_ready_hook(),
  public.case_files_settings(uuid),
  public.case_settings_set_files_switch(uuid, uuid, text, boolean),
  public.case_settings_set_files_ready_stages(uuid, uuid, text, text),
  public.case_file_render_name(text, text, text, text, date, text),
  public.case_file_spec_rows(uuid),
  public.case_file_spec_set(uuid, text, text, jsonb),
  public.case_document_file_can_register(uuid, uuid),
  public.case_document_file_register(uuid, uuid, uuid),
  public.case_document_file_classify(uuid, uuid, text),
  public.case_file_ready(uuid),
  public.case_document_file_check_result(uuid, text, integer, jsonb, integer, date),
  public.case_files_ready_move(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_files_settings(uuid),
  public.case_settings_set_files_switch(uuid, uuid, text, boolean),
  public.case_settings_set_files_ready_stages(uuid, uuid, text, text),
  public.case_file_render_name(text, text, text, text, date, text),
  public.case_file_spec_rows(uuid),
  public.case_file_spec_set(uuid, text, text, jsonb),
  public.case_document_file_can_register(uuid, uuid),
  public.case_document_file_register(uuid, uuid, uuid),
  public.case_document_file_classify(uuid, uuid, text),
  public.case_file_ready(uuid),
  public.case_document_file_check_result(uuid, text, integer, jsonb, integer, date)
  TO service_role;
