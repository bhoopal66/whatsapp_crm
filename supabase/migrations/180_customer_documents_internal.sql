-- ============================================================
-- 180_customer_documents_internal.sql — customer folders also hold
-- files staff upload to a case and case-file PDFs the CRM assembles.
--
-- What it is. 178 records every document or photo a CUSTOMER sends.
-- The case document files (181+) need two more kinds in the same
-- per-customer folder (customer_doc_folders, TC-000123):
--   'staff_upload' a file a staff member uploads to a case (or to the
--                  customer), document or image;
--   'case_build'   a case-file PDF the CRM assembles for a case.
-- Their bytes are not at a public URL: they live in the private
-- Storage bucket 'case-files', so such a row names the object
-- (storage_bucket, storage_path) instead of a media_url, and the NAS
-- worker's claim now returns that pair so the worker can fetch it with
-- the service role. customer_documents_record_internal() writes them.
--
-- What it is not. Nothing in the current workflow changes: 178's
-- customer_documents_record(), _existing(), _settle() and _retry() are
-- untouched, every customer row keeps its media_url, and no app code
-- calls the new function yet.
--
-- Who sees. 178's policies already cover the new rows: same account,
-- and an owner/admin, or someone who can see the customer
-- (can_view_contact). Their third branch, a coordinator share of the
-- document's own chat (coordinator_share_grants), never reveals a new
-- row: a staff upload or case build has no conversation (the
-- customer_documents_source_ids CHECK keeps conversation_id NULL), so a
-- coordinator shared one chat does not see the customer's case files.
--
-- The 'case-files' bucket has no storage.objects policy for any client
-- role: only the service role (which bypasses RLS) reads or writes it.
-- A browser gets a file only through an app route that has checked the
-- caller and then uses the service role. Its type list (PDF, JPEG, PNG)
-- is a subset of 164's safe list; 164's storage_objects_safe_mime
-- trigger is not extended to it, because no client role can upload or
-- copy into it (Storage's copy route needs write access to the
-- destination bucket).
--
-- customer_documents_record_internal() reads cases, which is
-- RLS-forced (122), so, as 178, apply as a superuser or BYPASSRLS role.
--
-- Re-runnable: ON CONFLICT on the bucket, ADD COLUMN IF NOT EXISTS,
-- DROP CONSTRAINT IF EXISTS + ADD (or a pg_constraint guard),
-- CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE, DROP FUNCTION IF EXISTS
-- for the claim (its result type changes).
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '180 must be applied by a superuser or BYPASSRLS role (customer_documents_record_internal reads RLS-forced cases)';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. The private bucket
-- ------------------------------------------------------------
-- 100 MiB: an assembled case file can be large. No storage.objects
-- policy is created for it (see the header): service role only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('case-files', 'case-files', false, 104857600,
        ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[])
ON CONFLICT (id) DO UPDATE
   SET public = false, file_size_limit = 104857600,
       allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[];

-- ------------------------------------------------------------
-- 2. customer_documents: the new sources and their location
-- ------------------------------------------------------------
ALTER TABLE public.customer_documents ADD COLUMN IF NOT EXISTS storage_bucket text NULL;
ALTER TABLE public.customer_documents ADD COLUMN IF NOT EXISTS storage_path text NULL;
ALTER TABLE public.customer_documents ADD COLUMN IF NOT EXISTS case_id uuid NULL;
-- The staff member's auth user id, for 'staff_upload' only. No FK: the
-- record outlives the login, as it outlives the contact and the chat.
ALTER TABLE public.customer_documents ADD COLUMN IF NOT EXISTS uploaded_by uuid NULL;

-- A row has a media_url (the two customer sources) or a Storage object
-- (the two internal ones), never both: see the location CHECKs below.
ALTER TABLE public.customer_documents ALTER COLUMN media_url DROP NOT NULL;

ALTER TABLE public.customer_documents DROP CONSTRAINT IF EXISTS customer_documents_source_check;
ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_source_check
  CHECK (source IN ('chat', 'submission_group', 'staff_upload', 'case_build'));

-- 178's meaning for the customer sources; an internal row comes from
-- no message and no chat.
ALTER TABLE public.customer_documents DROP CONSTRAINT IF EXISTS customer_documents_source_ids;
ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_source_ids CHECK (
  (source = 'chat' AND group_message_id IS NULL)
  OR (source = 'submission_group' AND message_id IS NULL)
  OR (source IN ('staff_upload', 'case_build')
      AND message_id IS NULL AND group_message_id IS NULL AND conversation_id IS NULL));

-- Exactly one location: a media_url, or the (bucket, path) pair.
ALTER TABLE public.customer_documents DROP CONSTRAINT IF EXISTS customer_documents_one_location;
ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_one_location CHECK (
  (media_url IS NOT NULL AND storage_bucket IS NULL AND storage_path IS NULL)
  OR (media_url IS NULL AND storage_bucket IS NOT NULL AND storage_path IS NOT NULL));

-- Which location: the customer sources keep their media_url, the
-- internal ones are Storage objects.
ALTER TABLE public.customer_documents DROP CONSTRAINT IF EXISTS customer_documents_source_location;
ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_source_location CHECK (
  (source IN ('chat', 'submission_group')) = (media_url IS NOT NULL));

ALTER TABLE public.customer_documents DROP CONSTRAINT IF EXISTS customer_documents_storage_bucket_check;
ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_storage_bucket_check
  CHECK (storage_bucket IS NULL OR storage_bucket = 'case-files');

-- Non-blank, relative, no '..' segment: the worker joins it to nothing
-- on disk, but a path that climbs is never a name we wrote.
ALTER TABLE public.customer_documents DROP CONSTRAINT IF EXISTS customer_documents_storage_path_check;
ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_storage_path_check
  CHECK (storage_path IS NULL
         OR (storage_path !~ '^[[:space:]]*$'
             AND storage_path !~ '^/'
             AND storage_path !~ '(^|/)\.\.(/|$)'));

ALTER TABLE public.customer_documents DROP CONSTRAINT IF EXISTS customer_documents_case_source_check;
ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_case_source_check
  CHECK (case_id IS NULL OR source IN ('staff_upload', 'case_build'));

ALTER TABLE public.customer_documents DROP CONSTRAINT IF EXISTS customer_documents_uploaded_by_check;
ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_uploaded_by_check
  CHECK (uploaded_by IS NULL OR source = 'staff_upload');

DO $$ BEGIN
  -- cases (id, account_id) is unique since 122, so the case reference is
  -- composite like 178's contact one: never another account's case.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'customer_documents_case_fkey'
                    AND conrelid = 'public.customer_documents'::regclass) THEN
    ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_case_fkey
      FOREIGN KEY (case_id, account_id) REFERENCES public.cases (id, account_id)
      ON DELETE SET NULL (case_id);
  END IF;
  -- One row per Storage object: what makes the record call idempotent.
  -- NULLs are distinct, so the customer rows never collide.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'customer_documents_storage_key'
                    AND conrelid = 'public.customer_documents'::regclass) THEN
    ALTER TABLE public.customer_documents ADD CONSTRAINT customer_documents_storage_key
      UNIQUE (storage_bucket, storage_path);
  END IF;
END $$;

-- For the ON DELETE SET NULL of a case.
CREATE INDEX IF NOT EXISTS customer_documents_case_idx
  ON public.customer_documents (case_id) WHERE case_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. The contact's folder (shared helper)
-- ------------------------------------------------------------
-- 178's folder rule: created on the contact's first document, a race
-- burns a number and the loser reads the winner's. The caller has
-- already checked the contact is in p_account_id. Internal: no client
-- role and not the service role may execute it; the SECURITY DEFINER
-- functions run as its owner. 178's customer_documents_record() keeps
-- its own inline copy of these lines, unchanged.
CREATE OR REPLACE FUNCTION public.customer_documents_folder(p_account_id uuid, p_contact_id uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_folder uuid;
BEGIN
  SELECT f.id INTO v_folder FROM public.customer_doc_folders f WHERE f.contact_id = p_contact_id;
  IF v_folder IS NULL THEN
    INSERT INTO public.customer_doc_folders (account_id, contact_id, ref)
    VALUES (p_account_id, p_contact_id,
            public.customer_doc_format_ref(nextval('public.customer_doc_ref_seq')))
    ON CONFLICT (contact_id) DO NOTHING;
    SELECT f.id INTO v_folder FROM public.customer_doc_folders f WHERE f.contact_id = p_contact_id;
  END IF;
  RETURN v_folder;
END;
$$;

-- ------------------------------------------------------------
-- 4. Recording an internal file
-- ------------------------------------------------------------
-- Returns the row's id and its folder's reference. Recording the same
-- Storage object twice leaves one row and returns the same pair (the
-- first call's row, even if a later call names another contact).
CREATE OR REPLACE FUNCTION public.customer_documents_record_internal(
  p_account_id uuid, p_contact_id uuid, p_source text, p_kind text,
  p_storage_bucket text, p_storage_path text, p_received_at timestamptz,
  p_mime text DEFAULT NULL, p_original_name text DEFAULT NULL,
  p_case_id uuid DEFAULT NULL, p_uploaded_by uuid DEFAULT NULL)
RETURNS TABLE (document_id uuid, ref text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_folder uuid;
  v_id     uuid;
  v_ref    text;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('staff_upload', 'case_build') THEN
    RAISE EXCEPTION 'customer_documents_record_internal: source % is not valid', p_source
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF p_kind IS NULL
     OR (p_source = 'staff_upload' AND p_kind NOT IN ('document', 'image'))
     OR (p_source = 'case_build' AND p_kind <> 'document') THEN
    RAISE EXCEPTION 'customer_documents_record_internal: kind % is not valid for %', p_kind, p_source
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF p_storage_bucket IS DISTINCT FROM 'case-files' THEN
    RAISE EXCEPTION 'customer_documents_record_internal: bucket % is not valid', p_storage_bucket
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF p_storage_path IS NULL
     OR p_storage_path ~ '^[[:space:]]*$'
     OR p_storage_path ~ '^/'
     OR p_storage_path ~ '(^|/)\.\.(/|$)' THEN
    RAISE EXCEPTION 'customer_documents_record_internal: storage path is blank, absolute or climbs'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF p_received_at IS NULL OR p_account_id IS NULL THEN
    RAISE EXCEPTION 'customer_documents_record_internal: account or received_at is missing'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF (p_source = 'staff_upload' AND p_uploaded_by IS NULL)
     OR (p_source = 'case_build' AND (p_uploaded_by IS NOT NULL OR p_case_id IS NULL)) THEN
    RAISE EXCEPTION 'customer_documents_record_internal: the uploader and case do not match source %', p_source
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;

  PERFORM 1 FROM public.contacts c
   WHERE c.id = p_contact_id AND c.account_id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_documents_record_internal: contact not found in this account'
      USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;

  -- A live agent, team leader, admin or owner of this account (115's
  -- staff rule: never a viewer, a bank guest or a deactivated row).
  IF p_source = 'staff_upload' AND NOT public.sg_is_staff(p_account_id, p_uploaded_by) THEN
    RAISE EXCEPTION 'customer_documents_record_internal: the uploader is not live staff of this account'
      USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;

  IF p_case_id IS NOT NULL THEN
    PERFORM 1 FROM public.cases k
     WHERE k.id = p_case_id AND k.account_id = p_account_id AND k.contact_id = p_contact_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_documents_record_internal: no case of this contact matches'
        USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
    END IF;
  END IF;

  v_folder := public.customer_documents_folder(p_account_id, p_contact_id);

  INSERT INTO public.customer_documents
    (account_id, folder_id, contact_id, source, kind, mime, original_name,
     storage_bucket, storage_path, case_id, uploaded_by, received_at)
  VALUES
    (p_account_id, v_folder, p_contact_id, p_source, p_kind, left(p_mime, 127),
     left(p_original_name, 255), p_storage_bucket, p_storage_path, p_case_id,
     p_uploaded_by, p_received_at)
  ON CONFLICT (storage_bucket, storage_path) DO NOTHING;

  SELECT d.id, f.ref INTO v_id, v_ref
    FROM public.customer_documents d
    JOIN public.customer_doc_folders f ON f.id = d.folder_id
   WHERE d.storage_bucket = p_storage_bucket AND d.storage_path = p_storage_path;
  RETURN QUERY SELECT v_id, v_ref;
END;
$$;

-- ------------------------------------------------------------
-- 5. The NAS worker's claim returns the Storage object
-- ------------------------------------------------------------
-- 178's claim, with storage_bucket and storage_path appended after
-- claimed_at (NULL for the customer rows, whose bytes are at
-- media_url, itself NULL for the internal rows). The result type
-- changes, hence the DROP.
DROP FUNCTION IF EXISTS public.customer_documents_claim(integer);
CREATE FUNCTION public.customer_documents_claim(p_limit integer DEFAULT 10)
RETURNS TABLE (id uuid, folder_id uuid, ref text, kind text, mime text,
               original_name text, caption text, media_url text,
               received_at timestamptz, attempts integer, claimed_at timestamptz,
               storage_bucket text, storage_path text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_at timestamptz := clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'customer_documents_claim: limit % is outside 1..50', p_limit
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT d.id
      FROM public.customer_documents d
     WHERE d.status = 'pending'
       AND d.next_attempt_at <= v_at
       AND (d.claimed_at IS NULL OR d.claimed_at < v_at - interval '15 minutes')
     ORDER BY d.received_at, d.id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.customer_documents d
       SET claimed_at = v_at, attempts = d.attempts + 1
      FROM picked
     WHERE d.id = picked.id
    RETURNING d.id, d.folder_id, d.kind, d.mime, d.original_name, d.caption,
              d.media_url, d.received_at, d.attempts, d.claimed_at,
              d.storage_bucket, d.storage_path
  )
  SELECT upd.id, upd.folder_id, f.ref, upd.kind, upd.mime, upd.original_name,
         upd.caption, upd.media_url, upd.received_at, upd.attempts, upd.claimed_at,
         upd.storage_bucket, upd.storage_path
    FROM upd
    JOIN public.customer_doc_folders f ON f.id = upd.folder_id
   ORDER BY upd.received_at, upd.id;
END;
$$;

-- ------------------------------------------------------------
-- 6. Grants
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.customer_documents_folder(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.customer_documents_record_internal(uuid, uuid, text, text, text, text,
  timestamptz, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_documents_record_internal(uuid, uuid, text, text, text, text,
  timestamptz, text, text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.customer_documents_claim(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_documents_claim(integer) TO service_role;
