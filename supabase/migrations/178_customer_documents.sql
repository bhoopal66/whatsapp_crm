-- ============================================================
-- 178_customer_documents.sql — every document or photo a customer
-- sends on WhatsApp is recorded against a per-customer folder.
--
-- What it is. A customer gets one folder (customer_doc_folders) the
-- first time they send a document or an image, in a 1:1 chat or in
-- their submission group, with a reference number of its own
-- (TC-000123). Each file is a customer_documents row in that folder.
-- A separate worker process (not part of the app) claims the pending
-- rows, copies the bytes to the NAS under the folder's reference and
-- reports back through the RPCs below: stored, a duplicate of a file
-- already in the folder (same SHA-256), retry later, or failed.
--
-- What it is not. This only records. No message is ever sent, nothing
-- is shown to the customer, and no existing workflow changes: the
-- inbound pipeline, flows, automations, the AI and the submission
-- groups behave exactly as before. The media URL stays the message's
-- own; the NAS copy is an archive beside it.
--
-- Reference numbers. customer_doc_ref_seq feeds
-- customer_doc_format_ref(): six digits zero-padded, more digits once
-- past 999999 (lpad would truncate). A race between two first
-- documents of one contact may burn a number; gaps are fine.
--
-- Who sees. A person sees a customer's folder and documents exactly
-- when they can see the customer: the SELECT policies test the contact
-- with an EXISTS that runs under the caller's own contacts policy
-- (177). Admins and owners see the whole workspace. A row whose contact
-- was deleted (contact_id NULL) is admin-only. No client role writes
-- either table; every write is a SECURITY DEFINER function, granted to
-- the service role (the webhook side and the NAS worker), except
-- customer_documents_retry(), which an owner/admin calls to send a
-- failed file back to the queue.
--
-- Deletion. The contact, conversation, message and group message are
-- ON DELETE SET NULL: the record (and the NAS copy it names) outlives
-- them. So "chat" / "submission_group" only fix which id column may be
-- set; that the right one IS set is checked by
-- customer_documents_record() when the row is written.
--
-- customer_documents_record() reads submission_group_messages and
-- submission_groups, which are RLS-forced (115), so, as 115, this must
-- be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, guarded constraints,
-- CREATE OR REPLACE, DROP POLICY IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '178 must be applied by a superuser or BYPASSRLS role (customer_documents_record reads RLS-forced tables)';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Reference numbers
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.customer_doc_ref_seq AS bigint START 1;

CREATE OR REPLACE FUNCTION public.customer_doc_format_ref(p_n bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT 'TC-' || CASE WHEN p_n < 1000000 THEN lpad(p_n::text, 6, '0') ELSE p_n::text END
$$;

-- ------------------------------------------------------------
-- 2. Tables
-- ------------------------------------------------------------
-- contacts (id, account_id) and conversations (id, account_id) are
-- unique since 086, so those references are composite: a row can never
-- point at another account's contact or chat. messages has no
-- account_id and submission_group_messages no (id, account_id) key, so
-- those two are plain FKs and customer_documents_record() checks the
-- account itself.
CREATE TABLE IF NOT EXISTS public.customer_doc_folders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id     uuid NULL,
  ref            text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  nas_created_at timestamptz NULL,
  CONSTRAINT customer_doc_folders_contact_key UNIQUE (contact_id),
  CONSTRAINT customer_doc_folders_ref_key UNIQUE (ref),
  CONSTRAINT customer_doc_folders_id_account_key UNIQUE (id, account_id),
  CONSTRAINT customer_doc_folders_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE SET NULL (contact_id)
);

CREATE TABLE IF NOT EXISTS public.customer_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  folder_id        uuid NOT NULL,
  contact_id       uuid NULL,
  conversation_id  uuid NULL,
  message_id       uuid NULL REFERENCES public.messages(id) ON DELETE SET NULL,
  group_message_id bigint NULL REFERENCES public.submission_group_messages(id) ON DELETE SET NULL,
  source           text NOT NULL,
  kind             text NOT NULL,
  mime             text NULL,
  original_name    text NULL,
  caption          text NULL,
  media_url        text NOT NULL,
  received_at      timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz NULL,
  last_error       text NULL,
  size_bytes       bigint NULL,
  sha256           text NULL,
  nas_name         text NULL,
  duplicate_of     uuid NULL REFERENCES public.customer_documents(id) ON DELETE SET NULL,
  stored_at        timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_documents_message_key UNIQUE (message_id),
  CONSTRAINT customer_documents_group_message_key UNIQUE (group_message_id),
  CONSTRAINT customer_documents_source_check CHECK (source IN ('chat', 'submission_group')),
  CONSTRAINT customer_documents_kind_check CHECK (kind IN ('document', 'image')),
  CONSTRAINT customer_documents_status_check CHECK (status IN ('pending', 'stored', 'duplicate', 'failed')),
  CONSTRAINT customer_documents_media_url_check CHECK (media_url !~ '^[[:space:]]*$'),
  CONSTRAINT customer_documents_sha256_check CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  -- The other source's id is never set; this source's id may go NULL
  -- only through ON DELETE SET NULL (see the header).
  CONSTRAINT customer_documents_source_ids CHECK (
    (source = 'chat' AND group_message_id IS NULL)
    OR (source = 'submission_group' AND message_id IS NULL)),
  CONSTRAINT customer_documents_folder_fkey FOREIGN KEY (folder_id, account_id)
    REFERENCES public.customer_doc_folders (id, account_id) ON DELETE CASCADE,
  CONSTRAINT customer_documents_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id) ON DELETE SET NULL (contact_id),
  CONSTRAINT customer_documents_conversation_fkey FOREIGN KEY (conversation_id, account_id)
    REFERENCES public.conversations (id, account_id) ON DELETE SET NULL (conversation_id)
);

CREATE INDEX IF NOT EXISTS customer_documents_folder_idx
  ON public.customer_documents (folder_id, received_at DESC);
CREATE INDEX IF NOT EXISTS customer_documents_contact_idx
  ON public.customer_documents (contact_id, received_at DESC);
CREATE INDEX IF NOT EXISTS customer_documents_pending_idx
  ON public.customer_documents (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS customer_documents_stored_sha_idx
  ON public.customer_documents (folder_id, sha256) WHERE status = 'stored';
CREATE INDEX IF NOT EXISTS customer_doc_folders_account_idx
  ON public.customer_doc_folders (account_id);

-- ------------------------------------------------------------
-- 3. Row level security: read only, as the customer is
-- ------------------------------------------------------------
ALTER TABLE public.customer_doc_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_documents ENABLE ROW LEVEL SECURITY;

-- The EXISTS runs under the caller's contacts policy (177), so a person
-- below admin sees a folder or document exactly when they can see the
-- customer. Rank 4 is admin (083's current_role_rank).
DROP POLICY IF EXISTS customer_doc_folders_select ON public.customer_doc_folders;
CREATE POLICY customer_doc_folders_select ON public.customer_doc_folders
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND ((SELECT public.current_role_rank()) >= 4
              OR EXISTS (SELECT 1 FROM public.contacts c
                          WHERE c.id = customer_doc_folders.contact_id)));

DROP POLICY IF EXISTS customer_documents_select ON public.customer_documents;
CREATE POLICY customer_documents_select ON public.customer_documents
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND ((SELECT public.current_role_rank()) >= 4
              OR EXISTS (SELECT 1 FROM public.contacts c
                          WHERE c.id = customer_documents.contact_id)));

REVOKE ALL ON public.customer_doc_folders FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.customer_documents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.customer_doc_folders TO authenticated, service_role;
GRANT SELECT ON public.customer_documents TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.customer_doc_ref_seq FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Recording (the webhook side)
-- ------------------------------------------------------------
-- Returns the folder's reference. Recording the same message twice
-- leaves one row and returns the same reference.
CREATE OR REPLACE FUNCTION public.customer_documents_record(
  p_account_id uuid, p_contact_id uuid, p_source text, p_kind text,
  p_media_url text, p_received_at timestamptz,
  p_conversation_id uuid DEFAULT NULL, p_message_id uuid DEFAULT NULL,
  p_group_message_id bigint DEFAULT NULL, p_mime text DEFAULT NULL,
  p_original_name text DEFAULT NULL, p_caption text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_folder uuid;
  v_ref    text;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('chat', 'submission_group') THEN
    RAISE EXCEPTION 'customer_documents_record: source % is not valid', p_source
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('document', 'image') THEN
    RAISE EXCEPTION 'customer_documents_record: kind % is not valid', p_kind
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF p_media_url IS NULL OR p_media_url ~ '^[[:space:]]*$' THEN
    RAISE EXCEPTION 'customer_documents_record: media_url is blank'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF p_received_at IS NULL THEN
    RAISE EXCEPTION 'customer_documents_record: received_at is missing'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  IF p_account_id IS NULL
     OR (p_source = 'chat'
         AND (p_message_id IS NULL OR p_conversation_id IS NULL OR p_group_message_id IS NOT NULL))
     OR (p_source = 'submission_group'
         AND (p_group_message_id IS NULL OR p_message_id IS NOT NULL OR p_conversation_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'customer_documents_record: the ids do not match source %', p_source
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;

  PERFORM 1 FROM public.contacts c
   WHERE c.id = p_contact_id AND c.account_id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_documents_record: contact not found in this account'
      USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;

  IF p_source = 'chat' THEN
    PERFORM 1
       FROM public.messages m
       JOIN public.conversations cv ON cv.id = m.conversation_id
      WHERE m.id = p_message_id
        AND m.sender_type = 'customer'
        AND m.conversation_id = p_conversation_id
        AND cv.account_id = p_account_id
        AND cv.contact_id = p_contact_id;
  ELSE
    PERFORM 1
       FROM public.submission_group_messages gm
       JOIN public.submission_groups g ON g.id = gm.group_id
      WHERE gm.id = p_group_message_id
        AND gm.direction = 'in'
        AND gm.account_id = p_account_id
        AND g.contact_id = p_contact_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_documents_record: no customer message of this contact matches'
      USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;

  -- The contact's folder, created on its first document. A race between
  -- two first documents burns a number; the loser reads the winner's.
  SELECT f.id INTO v_folder FROM public.customer_doc_folders f WHERE f.contact_id = p_contact_id;
  IF v_folder IS NULL THEN
    INSERT INTO public.customer_doc_folders (account_id, contact_id, ref)
    VALUES (p_account_id, p_contact_id,
            public.customer_doc_format_ref(nextval('public.customer_doc_ref_seq')))
    ON CONFLICT (contact_id) DO NOTHING;
    SELECT f.id INTO v_folder FROM public.customer_doc_folders f WHERE f.contact_id = p_contact_id;
  END IF;

  INSERT INTO public.customer_documents
    (account_id, folder_id, contact_id, conversation_id, message_id, group_message_id,
     source, kind, mime, original_name, caption, media_url, received_at)
  VALUES
    (p_account_id, v_folder, p_contact_id, p_conversation_id, p_message_id, p_group_message_id,
     p_source, p_kind, left(p_mime, 127), left(p_original_name, 255), left(p_caption, 1000),
     p_media_url, p_received_at)
  ON CONFLICT DO NOTHING;

  -- The reference of the folder that holds this message's row, which is
  -- this contact's unless the message was recorded before its chat moved
  -- to another contact.
  SELECT f.ref INTO v_ref
    FROM public.customer_documents d
    JOIN public.customer_doc_folders f ON f.id = d.folder_id
   WHERE (p_source = 'chat' AND d.message_id = p_message_id)
      OR (p_source = 'submission_group' AND d.group_message_id = p_group_message_id);
  RETURN v_ref;
END;
$$;

-- ------------------------------------------------------------
-- 5. The NAS worker
-- ------------------------------------------------------------
-- Claims up to p_limit due rows, oldest received first. A claim older
-- than 15 minutes is taken as abandoned (the worker died mid-copy).
CREATE OR REPLACE FUNCTION public.customer_documents_claim(p_limit integer DEFAULT 10)
RETURNS TABLE (id uuid, folder_id uuid, ref text, kind text, mime text,
               original_name text, caption text, media_url text,
               received_at timestamptz, attempts integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
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
       AND d.next_attempt_at <= now()
       AND (d.claimed_at IS NULL OR d.claimed_at < now() - interval '15 minutes')
     ORDER BY d.received_at, d.id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.customer_documents d
       SET claimed_at = now(), attempts = d.attempts + 1
      FROM picked
     WHERE d.id = picked.id
    RETURNING d.id, d.folder_id, d.kind, d.mime, d.original_name, d.caption,
              d.media_url, d.received_at, d.attempts
  )
  SELECT upd.id, upd.folder_id, f.ref, upd.kind, upd.mime, upd.original_name,
         upd.caption, upd.media_url, upd.received_at, upd.attempts
    FROM upd
    JOIN public.customer_doc_folders f ON f.id = upd.folder_id
   ORDER BY upd.received_at, upd.id;
END;
$$;

-- The NAS name of a file already stored in the folder with this hash,
-- else NULL: the worker skips the copy and settles 'duplicate'.
CREATE OR REPLACE FUNCTION public.customer_documents_existing(p_folder_id uuid, p_sha256 text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text;
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'customer_documents_existing: sha256 is not 64 lowercase hex digits'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;
  SELECT d.nas_name INTO v_name
    FROM public.customer_documents d
   WHERE d.folder_id = p_folder_id AND d.sha256 = p_sha256 AND d.status = 'stored'
   ORDER BY d.stored_at, d.id
   LIMIT 1;
  RETURN v_name;
END;
$$;

-- Settles a pending row: 'stored', 'duplicate', 'retry' or 'failed'.
-- Returns the resulting status.
CREATE OR REPLACE FUNCTION public.customer_documents_settle(
  p_id uuid, p_outcome text, p_sha256 text DEFAULT NULL, p_size bigint DEFAULT NULL,
  p_nas_name text DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_doc  public.customer_documents%ROWTYPE;
  v_orig public.customer_documents%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('stored', 'duplicate', 'retry', 'failed') THEN
    RAISE EXCEPTION 'customer_documents_settle: outcome % is not valid', p_outcome
      USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
  END IF;

  SELECT * INTO v_doc FROM public.customer_documents d WHERE d.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_documents_settle: document % not found', p_id
      USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;
  IF v_doc.status <> 'pending' THEN
    RAISE EXCEPTION 'customer_documents_settle: document % is %, not pending', p_id, v_doc.status
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'STATE';
  END IF;

  IF p_outcome IN ('stored', 'duplicate') THEN
    IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'customer_documents_settle: sha256 is not 64 lowercase hex digits'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
    END IF;
    IF p_size IS NULL OR p_size < 0 THEN
      RAISE EXCEPTION 'customer_documents_settle: size is missing or negative'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
    END IF;
  END IF;

  IF p_outcome = 'stored' THEN
    IF p_nas_name IS NULL
       OR octet_length(p_nas_name) NOT BETWEEN 1 AND 255
       OR p_nas_name IN ('.', '..')
       OR strpos(p_nas_name, '/') > 0
       OR strpos(p_nas_name, '\') > 0 THEN
      RAISE EXCEPTION 'customer_documents_settle: nas_name is not a plain file name'
        USING ERRCODE = 'invalid_parameter_value', HINT = 'INVALID';
    END IF;
    UPDATE public.customer_documents d
       SET status = 'stored', sha256 = p_sha256, size_bytes = p_size, nas_name = p_nas_name,
           stored_at = now(), claimed_at = NULL, last_error = NULL
     WHERE d.id = p_id;
    UPDATE public.customer_doc_folders f
       SET nas_created_at = coalesce(f.nas_created_at, now())
     WHERE f.id = v_doc.folder_id;
    RETURN 'stored';
  END IF;

  IF p_outcome = 'duplicate' THEN
    SELECT * INTO v_orig
      FROM public.customer_documents d
     WHERE d.folder_id = v_doc.folder_id AND d.sha256 = p_sha256 AND d.status = 'stored'
     ORDER BY d.stored_at, d.id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer_documents_settle: no stored file in the folder has this sha256'
        USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
    END IF;
    UPDATE public.customer_documents d
       SET status = 'duplicate', duplicate_of = v_orig.id, nas_name = v_orig.nas_name,
           sha256 = p_sha256, size_bytes = p_size, stored_at = now(), claimed_at = NULL,
           last_error = NULL
     WHERE d.id = p_id;
    RETURN 'duplicate';
  END IF;

  IF p_outcome = 'retry' AND v_doc.attempts < 10 THEN
    UPDATE public.customer_documents d
       SET last_error = left(p_error, 500), claimed_at = NULL,
           next_attempt_at = now() + least(power(2, v_doc.attempts), 360) * interval '1 minute'
     WHERE d.id = p_id;
    RETURN 'pending';
  END IF;

  -- 'failed', or a retry with the attempts spent.
  UPDATE public.customer_documents d
     SET status = 'failed', last_error = left(p_error, 500), claimed_at = NULL
   WHERE d.id = p_id;
  RETURN 'failed';
END;
$$;

-- ------------------------------------------------------------
-- 6. A person sends a failed file back to the queue
-- ------------------------------------------------------------
-- A live owner/admin of the document's account, working in it now.
-- Another account's document answers NOT_FOUND, never NOT_ALLOWED, so
-- it does not reveal that the id exists.
CREATE OR REPLACE FUNCTION public.customer_documents_retry(p_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid := public.current_account_id();
  v_status  text;
BEGIN
  IF v_account IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'customer_documents_retry: only an owner or admin may retry a document'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT d.status INTO v_status
    FROM public.customer_documents d
   WHERE d.id = p_id AND d.account_id = v_account
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_documents_retry: document % not found', p_id
      USING ERRCODE = 'no_data_found', HINT = 'NOT_FOUND';
  END IF;
  IF v_status <> 'failed' THEN
    RAISE EXCEPTION 'customer_documents_retry: document % is %, not failed', p_id, v_status
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'STATE';
  END IF;
  UPDATE public.customer_documents d
     SET status = 'pending', attempts = 0, next_attempt_at = now(), claimed_at = NULL,
         last_error = NULL
   WHERE d.id = p_id;
  RETURN 'pending';
END;
$$;

-- ------------------------------------------------------------
-- 7. Grants
-- ------------------------------------------------------------
-- customer_doc_format_ref is pure and keeps the default EXECUTE.
REVOKE ALL ON FUNCTION public.customer_documents_record(uuid, uuid, text, text, text, timestamptz,
  uuid, uuid, bigint, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_documents_record(uuid, uuid, text, text, text, timestamptz,
  uuid, uuid, bigint, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.customer_documents_claim(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_documents_claim(integer) TO service_role;

REVOKE ALL ON FUNCTION public.customer_documents_existing(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_documents_existing(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.customer_documents_settle(uuid, text, text, bigint, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_documents_settle(uuid, text, text, bigint, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.customer_documents_retry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_documents_retry(uuid) TO authenticated;
