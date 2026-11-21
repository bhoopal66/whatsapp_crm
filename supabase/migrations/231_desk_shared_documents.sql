-- ============================================================
-- 231_desk_shared_documents.sql — one document, several banks, with the
-- company's consent per bank (design 035 D5, D11 and D13, slice B).
--
--  * A document is stored once (178's customer_documents) and LINKED into
--    each bank case as its own case_document_files row (181), so every
--    case keeps its own status: a rejection at one bank never changes
--    another bank's row. Nothing is copied.
--  * The database refuses a cross-customer link (design test 1):
--    case_document_files_same_customer (BEFORE INSERT, every writer)
--    accepts a document only when its contact is the case's contact, or,
--    for a desk case, a contact who acts for the case's company (229) or
--    is the contact of another case of that company. CROSS_CUSTOMER
--    otherwise. 181's register already held the first rule; desk links
--    widen it to the company and no further.
--  * Reuse needs consent: desk_doc_consents holds the company's consent
--    per bank (granted with evidence, revoked with a reason, never
--    deleted; at most one live row per company and bank). Linking into a
--    bank's case without a live consent for that bank is CONSENT_MISSING
--    (design test 6). Whether a WhatsApp reply is enough evidence is a
--    legal question (design section 8, flag 1); the register records
--    what the person entered.
--  * desk_doc_link(actor, file, target case): the file's case readable by
--    the actor, the target an open desk case of the SAME company at
--    another bank (or the same bank, another product) the actor can write
--    (or team leader and up). Idempotent.
--  * desk_company_overview: for anyone who can read one of the company's
--    cases (229's rule), every case of the company with its stage only
--    (D11: another bank's coordinator sees that a case exists and its
--    stage, never its files, notes or reasons); the files of the cases
--    the actor can read; the consents.
--
-- Refusals (HINT): INVALID, NOT_ALLOWED, CUSTOMER_NOT_FOUND,
-- FILE_NOT_FOUND, CASE_NOT_FOUND, CASE_CLOSED, CROSS_CUSTOMER,
-- CONSENT_MISSING, CONSENT_NOT_FOUND, REASON_REQUIRED.
--
-- PRIVILEGES: SECURITY DEFINER, search_path '', service_role only; the
-- consent table forces RLS with no policy and no grants. Apply as a
-- superuser or BYPASSRLS role after 230. Re-runnable. Asserted by
-- supabase/ci/verify-desk-shared-documents.sql. docs/case-desk.md is the
-- contract.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '231 must be applied by a superuser or BYPASSRLS role (the desk functions read RLS-forced tables)';
  END IF;
  IF to_regclass('public.desk_tray') IS NULL THEN
    RAISE EXCEPTION '231: apply 230_desk_whatsapp_routing.sql first';
  END IF;
END $$;

-- ---------- 1. The database refuses a cross-customer link ----------

CREATE OR REPLACE FUNCTION public.case_document_files_same_customer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_doc_contact  uuid;
  v_case_contact uuid;
  v_company      uuid;
BEGIN
  SELECT d.contact_id INTO v_doc_contact FROM public.customer_documents d WHERE d.id = NEW.customer_document_id;
  SELECT k.contact_id, k.desk_customer_id INTO v_case_contact, v_company FROM public.cases k WHERE k.id = NEW.case_id;
  IF v_doc_contact IS NOT DISTINCT FROM v_case_contact THEN
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
$$;

DROP TRIGGER IF EXISTS case_document_files_same_customer ON public.case_document_files;
CREATE TRIGGER case_document_files_same_customer
  BEFORE INSERT ON public.case_document_files
  FOR EACH ROW EXECUTE FUNCTION public.case_document_files_same_customer();

-- ---------- 2. Consent per bank ----------

CREATE TABLE IF NOT EXISTS public.desk_doc_consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL,
  customer_id    uuid NOT NULL,
  bank_code      text NOT NULL,
  evidence       text NOT NULL,
  granted_by     uuid NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_by     uuid NULL,
  revoked_at     timestamptz NULL,
  revoke_reason  text NULL,
  CONSTRAINT desk_doc_consents_customer_fkey FOREIGN KEY (customer_id, account_id)
    REFERENCES public.desk_customers (id, account_id) ON DELETE CASCADE,
  CONSTRAINT desk_doc_consents_evidence_check
    CHECK (evidence !~ '^[[:space:]]*$' AND char_length(evidence) BETWEEN 3 AND 500),
  CONSTRAINT desk_doc_consents_revoke_check CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
        AND revoke_reason !~ '^[[:space:]]*$' AND char_length(revoke_reason) BETWEEN 3 AND 500))
);
CREATE UNIQUE INDEX IF NOT EXISTS desk_doc_consents_one_live
  ON public.desk_doc_consents (customer_id, bank_code) WHERE revoked_at IS NULL;
ALTER TABLE public.desk_doc_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desk_doc_consents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.desk_doc_consents FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.desk_doc_consents IS
  'A desk company''s consent to reuse its documents at a bank: evidence as entered, revoked with a reason, '
  'never deleted. Linking a document into a bank''s case needs a live row. Migration 231.';

-- Rows are never deleted, and only a live row is ever revoked, once.
CREATE OR REPLACE FUNCTION public.desk_doc_consents_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A company deleted with everything it owns: the cascade only.
    IF NOT EXISTS (SELECT 1 FROM public.desk_customers d WHERE d.id = OLD.customer_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'desk_doc_consents: rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR (NEW.id, NEW.account_id, NEW.customer_id, NEW.bank_code, NEW.evidence, NEW.granted_by, NEW.granted_at)
        IS DISTINCT FROM
        (OLD.id, OLD.account_id, OLD.customer_id, OLD.bank_code, OLD.evidence, OLD.granted_by, OLD.granted_at) THEN
    RAISE EXCEPTION 'desk_doc_consents: a consent is only revoked, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS desk_doc_consents_guard ON public.desk_doc_consents;
CREATE TRIGGER desk_doc_consents_guard
  BEFORE UPDATE OR DELETE ON public.desk_doc_consents
  FOR EACH ROW EXECUTE FUNCTION public.desk_doc_consents_guard();

CREATE OR REPLACE FUNCTION public.desk_consent_grant(p_actor uuid, p_account uuid, p_customer uuid,
  p_bank_code text, p_evidence text, p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ev text := public.desk_clean(p_evidence);
  v_id uuid;
BEGIN
  IF NOT public.desk_customer_can_read(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_consent_grant', 'CUSTOMER_NOT_FOUND', 'company not found');
  END IF;
  IF NOT public.desk_customer_can_manage(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_consent_grant', 'NOT_ALLOWED', 'you cannot change this company');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code) THEN
    PERFORM public.desk_refuse('desk_consent_grant', 'INVALID', 'not a bank of this workspace');
  END IF;
  IF v_ev IS NULL OR char_length(v_ev) NOT BETWEEN 3 AND 500 THEN
    PERFORM public.desk_refuse('desk_consent_grant', 'REASON_REQUIRED', 'record the evidence of consent (3-500 characters)');
  END IF;
  SELECT c.id INTO v_id FROM public.desk_doc_consents c
   WHERE c.customer_id = p_customer AND c.bank_code = p_bank_code AND c.revoked_at IS NULL;
  IF v_id IS NOT NULL THEN
    RETURN v_id;  -- already granted: the first evidence stands
  END IF;
  INSERT INTO public.desk_doc_consents AS c (account_id, customer_id, bank_code, evidence, granted_by, granted_at)
  VALUES (p_account, p_customer, p_bank_code, v_ev, p_actor, coalesce(p_now, now()))
  ON CONFLICT (customer_id, bank_code) WHERE revoked_at IS NULL DO NOTHING
  RETURNING c.id INTO v_id;
  IF v_id IS NULL THEN
    SELECT c.id INTO v_id FROM public.desk_doc_consents c
     WHERE c.customer_id = p_customer AND c.bank_code = p_bank_code AND c.revoked_at IS NULL;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_consent_revoke(p_actor uuid, p_account uuid, p_customer uuid,
  p_bank_code text, p_reason text, p_now timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reason text := public.desk_clean(p_reason);
  v_n      integer;
BEGIN
  IF NOT public.desk_customer_can_read(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_consent_revoke', 'CUSTOMER_NOT_FOUND', 'company not found');
  END IF;
  IF NOT public.desk_customer_can_manage(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_consent_revoke', 'NOT_ALLOWED', 'you cannot change this company');
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) NOT BETWEEN 3 AND 500 THEN
    PERFORM public.desk_refuse('desk_consent_revoke', 'REASON_REQUIRED', 'a reason of 3 to 500 characters');
  END IF;
  UPDATE public.desk_doc_consents c
     SET revoked_at = coalesce(p_now, now()), revoked_by = p_actor, revoke_reason = v_reason
   WHERE c.customer_id = p_customer AND c.account_id = p_account AND c.bank_code = p_bank_code
     AND c.revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    PERFORM public.desk_refuse('desk_consent_revoke', 'CONSENT_NOT_FOUND', 'no live consent for that bank');
  END IF;
END;
$$;

-- ---------- 3. Link one document into a sibling case ----------

CREATE OR REPLACE FUNCTION public.desk_doc_link(p_actor uuid, p_account uuid, p_file uuid, p_target uuid,
  p_now timestamptz DEFAULT NULL)
RETURNS TABLE (file_id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  f   public.case_document_files%ROWTYPE;
  s   public.cases%ROWTYPE;
  t   public.cases%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO f FROM public.case_document_files x WHERE x.id = p_file AND x.account_id = p_account;
  IF NOT FOUND OR NOT public.case_can_read(f.case_id, p_actor) THEN
    PERFORM public.desk_refuse('desk_doc_link', 'FILE_NOT_FOUND', 'file not found');
  END IF;
  SELECT * INTO s FROM public.cases x WHERE x.id = f.case_id;
  SELECT * INTO t FROM public.cases x WHERE x.id = p_target AND x.account_id = p_account FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT (public.case_can_read(t.id, p_actor)
                       OR coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false)) THEN
    PERFORM public.desk_refuse('desk_doc_link', 'CASE_NOT_FOUND', 'case not found');
  END IF;
  IF s.desk_customer_id IS NULL OR t.desk_customer_id IS DISTINCT FROM s.desk_customer_id OR t.id = s.id THEN
    PERFORM public.desk_refuse('desk_doc_link', 'CROSS_CUSTOMER', 'only another case of the same company');
  END IF;
  IF NOT (public.case_can_write(t.id, p_actor)
          OR coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false)) THEN
    PERFORM public.desk_refuse('desk_doc_link', 'NOT_ALLOWED', 'you cannot change that case');
  END IF;
  IF t.closed_at IS NOT NULL THEN
    PERFORM public.desk_refuse('desk_doc_link', 'CASE_CLOSED', 'the case is closed');
  END IF;
  IF t.bank_code IS DISTINCT FROM s.bank_code
     AND NOT EXISTS (SELECT 1 FROM public.desk_doc_consents c
                      WHERE c.customer_id = t.desk_customer_id AND c.bank_code = t.bank_code AND c.revoked_at IS NULL) THEN
    PERFORM public.desk_refuse('desk_doc_link', 'CONSENT_MISSING', 'the company has not agreed to reuse its documents at that bank');
  END IF;

  SELECT x.id INTO v_id FROM public.case_document_files x
   WHERE x.case_id = t.id AND x.customer_document_id = f.customer_document_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;
  INSERT INTO public.case_document_files AS x (account_id, case_id, customer_document_id, registered_by, registered_at)
  VALUES (p_account, t.id, f.customer_document_id, p_actor, coalesce(p_now, now()))
  ON CONFLICT (case_id, customer_document_id) DO NOTHING
  RETURNING x.id INTO v_id;
  IF v_id IS NULL THEN
    SELECT x.id INTO v_id FROM public.case_document_files x
     WHERE x.case_id = t.id AND x.customer_document_id = f.customer_document_id;
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_id, true;
END;
$$;

-- ---------- 4. The company across banks ----------

-- {cases: every case of the company, stage only (+ can_read / can_write),
--  files: those of the cases the actor can read, shared = on more than one
--  of the company's cases, consents: live and revoked}.
CREATE OR REPLACE FUNCTION public.desk_company_overview(p_actor uuid, p_account uuid, p_customer uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lead boolean;
BEGIN
  IF NOT public.desk_customer_can_read(p_actor, p_account, p_customer) THEN
    PERFORM public.desk_refuse('desk_company_overview', 'CUSTOMER_NOT_FOUND', 'company not found');
  END IF;
  v_lead := coalesce(public.case_account_role(p_account, p_actor) IN ('team_lead', 'admin', 'super_admin'), false);
  RETURN jsonb_build_object(
    'cases', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'case_id', k.id, 'case_number', k.case_number, 'bank_code', k.bank_code,
                'product', k.product, 'stage', k.stage, 'closed', k.closed_at IS NOT NULL,
                'can_read', public.case_can_read(k.id, p_actor),
                'can_write', v_lead OR public.case_can_write(k.id, p_actor))
              ORDER BY k.case_number), '[]'::jsonb)
                FROM public.cases k WHERE k.account_id = p_account AND k.desk_customer_id = p_customer),
    'files', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'file_id', f.id, 'case_id', f.case_id, 'customer_document_id', f.customer_document_id,
                'doc_key', f.doc_key, 'status', f.status, 'version', f.version, 'expires_on', f.expires_on,
                'original_name', d.original_name, 'kind', d.kind, 'registered_at', f.registered_at,
                'shared', (SELECT count(*) FROM public.case_document_files g
                             JOIN public.cases o ON o.id = g.case_id AND o.desk_customer_id = p_customer
                            WHERE g.customer_document_id = f.customer_document_id) > 1)
              ORDER BY f.registered_at), '[]'::jsonb)
                FROM public.case_document_files f
                JOIN public.cases k ON k.id = f.case_id
                JOIN public.customer_documents d ON d.id = f.customer_document_id
               WHERE k.account_id = p_account AND k.desk_customer_id = p_customer
                 AND public.case_can_read(k.id, p_actor)),
    'consents', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'bank_code', c.bank_code, 'evidence', c.evidence, 'granted_at', c.granted_at,
                'revoked_at', c.revoked_at, 'revoke_reason', c.revoke_reason)
              ORDER BY c.granted_at DESC), '[]'::jsonb)
                FROM public.desk_doc_consents c WHERE c.customer_id = p_customer AND c.account_id = p_account)
  );
END;
$$;

-- ---------- 5. Privacy: the consents of companies a person acts for ----------

CREATE OR REPLACE FUNCTION public.privacy_desk_consents_export(p_account uuid, p_contact uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'company', d.legal_name, 'bank_code', c.bank_code, 'evidence', c.evidence,
           'granted_at', c.granted_at, 'revoked_at', c.revoked_at) ORDER BY c.granted_at), '[]'::jsonb)
    FROM public.desk_doc_consents c
    JOIN public.desk_customers d ON d.id = c.customer_id
   WHERE c.account_id = p_account
     AND c.customer_id IN (SELECT l.customer_id FROM public.desk_customer_contacts l
                            WHERE l.account_id = p_account AND l.contact_id = p_contact)
$$;

INSERT INTO public.privacy_extensions (name, export_fn, erase_fn, added_in)
VALUES ('desk_reuse_consents', 'privacy_desk_consents_export', NULL, '231')
ON CONFLICT (name) DO UPDATE SET export_fn = excluded.export_fn, erase_fn = excluded.erase_fn;

-- ---------- 6. Privileges ----------

REVOKE ALL ON FUNCTION
  public.case_document_files_same_customer(), public.desk_doc_consents_guard(),
  public.desk_consent_grant(uuid, uuid, uuid, text, text, timestamptz),
  public.desk_consent_revoke(uuid, uuid, uuid, text, text, timestamptz),
  public.desk_doc_link(uuid, uuid, uuid, uuid, timestamptz),
  public.desk_company_overview(uuid, uuid, uuid),
  public.privacy_desk_consents_export(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.desk_consent_grant(uuid, uuid, uuid, text, text, timestamptz),
  public.desk_consent_revoke(uuid, uuid, uuid, text, text, timestamptz),
  public.desk_doc_link(uuid, uuid, uuid, uuid, timestamptz),
  public.desk_company_overview(uuid, uuid, uuid)
TO service_role;
