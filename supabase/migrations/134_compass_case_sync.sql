-- ============================================================
-- 134_compass_case_sync.sql — two-way case sync with Taamul Compass
-- (the submission app of 115 / 122).
--
--  * Compass is the master of a SUBMITTED case (group_id NOT NULL):
--    stage, outcome reason, bank, product, amount, documents. The CRM
--    stays the master of a lead (group_id NULL).
--  * cases.external_url (the case in Compass, https only) and
--    cases.external_changed_at (the last applied changed_at from
--    Compass; an older update is stale and ignored).
--  * case_account_settings.managed_externally (per account, written
--    only through case_settings_set, owner/admin). While on, the
--    people-facing case_set_stage, case_set_details,
--    case_outcome_reason_set and case_doc_set_status (received /
--    rejected) refuse a submitted case with MANAGED_EXTERNALLY. Notes,
--    tasks, priority, due date, reassign, bank contacts, document
--    requests and replies stay open; leads are never locked; the API
--    path (case_sync_from_submission) ignores the lock.
--  * case_sync_from_submission(group, changed_at, patch): the v1 PATCH
--    applies Compass's stage / details / outcome reason / documents in
--    one locked call (actor NULL, role 'api'), with 122/130's move
--    rules. case_documents.updated_by and case_outcome_reasons.actor_id
--    become nullable (NULL = the API); every existing writer is
--    unchanged.
--  * webhook_event_outbox: AFTER triggers on case_stage_history, cases
--    (lead insert), submission_groups and contacts enqueue the events
--    case.stage_changed, case.lead_created, submission_group.ready /
--    .failed / .ended and contact.opted_out, only for an account with
--    an active endpoint subscribed to the event (webhook_enqueue). A
--    trigger never raises into the writer (WARNING instead). No invite
--    link or token goes into a payload. webhook_outbox_claim hands rows
--    out at most once; webhook_outbox_purge trims delivered rows.
--  * compass_link_contact_by_phone links Compass's customer rows to a
--    CRM contact by phone, where not yet linked.
--
-- Errors: ERRCODE as the older case_* functions, HINT = the code, and
-- the message starts with the code (case_sync_from_submission raises
-- P0001).
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 122,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '134 must be applied by a superuser or BYPASSRLS role (the case_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. cases: the Compass link ----------

ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS external_url text NULL;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS external_changed_at timestamptz NULL;
ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_external_url_check;
ALTER TABLE public.cases ADD CONSTRAINT cases_external_url_check
  CHECK (external_url IS NULL OR (external_url ~ '^https://[^[:space:]]+$' AND char_length(external_url) <= 2048));

COMMENT ON COLUMN public.cases.external_url IS
  'The case in the submission app (Compass), https only. Written only through case_sync_from_submission. Migration 134.';
COMMENT ON COLUMN public.cases.external_changed_at IS
  'The latest changed_at applied from the submission app; an older update is stale. Migration 134.';

-- NULL = the v1 API (case_sync_from_submission). Existing writers still pass their actor.
ALTER TABLE public.case_documents ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE public.case_outcome_reasons ALTER COLUMN actor_id DROP NOT NULL;

-- ---------- 2. Per-account case settings ----------

CREATE TABLE IF NOT EXISTS public.case_account_settings (
  account_id         uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  managed_externally boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NULL
);

COMMENT ON TABLE public.case_account_settings IS
  'Per-account case settings. managed_externally: submitted cases are edited in Compass only. Written only through case_settings_set. Migration 134.';

ALTER TABLE public.case_account_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_account_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS case_account_settings_select ON public.case_account_settings;
CREATE POLICY case_account_settings_select ON public.case_account_settings FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id));

REVOKE ALL ON public.case_account_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_account_settings TO authenticated, service_role;

-- True when the account's submitted cases are managed in Compass.
CREATE OR REPLACE FUNCTION public.case_managed_externally(p_account uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.managed_externally FROM public.case_account_settings s
                    WHERE s.account_id = p_account), false)
$$;

-- Sets managed_externally for an owner/admin of the account
-- (NOT_ALLOWED otherwise). Returns the stored value.
CREATE OR REPLACE FUNCTION public.case_settings_set(p_actor uuid, p_account uuid, p_managed_externally boolean)
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
  IF p_managed_externally IS NULL THEN
    RAISE EXCEPTION 'SETTING_INVALID: managed_externally must be true or false'
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  INSERT INTO public.case_account_settings AS s (account_id, managed_externally, updated_at, updated_by)
  VALUES (p_account, p_managed_externally, now(), p_actor)
  ON CONFLICT (account_id) DO UPDATE
    SET managed_externally = EXCLUDED.managed_externally, updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by;
  RETURN p_managed_externally;
END;
$$;

-- ---------- 3. The lock: people-facing writers, re-created ----------
--
-- Each is its latest definition (130 / 123) with only the
-- MANAGED_EXTERNALLY check added (marked "134").

-- 130's case_set_stage, plus MANAGED_EXTERNALLY (134).
CREATE OR REPLACE FUNCTION public.case_set_stage(p_case uuid, p_actor uuid, p_to_stage text,
  p_outcome text DEFAULT NULL, p_claim boolean DEFAULT true)
RETURNS TABLE (moved boolean, from_stage text, to_stage text, outcome text, end_group boolean, claim_token timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c         public.cases%ROWTYPE;
  v_role    text;
  v_final   boolean;
  v_outcome text;
  v_claim   boolean;
  v_token   timestamptz;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT public.case_rule_can_write(v_role) THEN
    RAISE EXCEPTION 'case %: % may not change the stage', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  -- 134: a submitted case of an account managed in Compass is edited there.
  IF c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', p_case
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  IF c.bank_code IS NOT NULL THEN
    -- Holds off case_bank_stages_set until this move commits.
    PERFORM 1 FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = c.bank_code FOR SHARE;
  END IF;
  IF p_to_stage IS NULL OR NOT (p_to_stage = ANY (public.case_stages_for_bank(c.account_id, c.bank_code))) THEN
    RAISE EXCEPTION 'stage % is not configured for bank %', p_to_stage, coalesce(c.bank_code, '(default)')
      USING ERRCODE = 'check_violation', HINT = 'STAGE_NOT_CONFIGURED';
  END IF;
  IF p_outcome IS NOT NULL AND p_outcome NOT IN ('Approved', 'Declined', 'Withdrawn') THEN
    RAISE EXCEPTION 'outcome % is not an outcome', p_outcome USING ERRCODE = 'check_violation', HINT = 'OUTCOME_INVALID';
  END IF;
  IF p_outcome IS NOT NULL AND p_outcome <> p_to_stage THEN
    RAISE EXCEPTION 'outcome % requires stage %', p_outcome, p_outcome
      USING ERRCODE = 'check_violation', HINT = 'OUTCOME_STAGE_MISMATCH';
  END IF;
  IF p_to_stage = c.stage THEN
    RETURN QUERY SELECT false, c.stage, c.stage, c.outcome, false, NULL::timestamptz;
    RETURN;
  END IF;
  IF c.stage = 'Closed' THEN
    RAISE EXCEPTION 'case % is closed', p_case USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  IF c.stage IN ('Approved', 'Declined', 'Withdrawn') AND p_to_stage <> 'Closed' THEN
    RAISE EXCEPTION 'case % is at final stage %', p_case, c.stage USING ERRCODE = 'check_violation', HINT = 'FINAL_STAGE';
  END IF;
  -- 130: pre-submission stages move freely among themselves and are
  -- never re-entered once submitted; a lead leaves them only to
  -- Withdrawn (the submission is attached by case_open), and a Withdrawn
  -- lead may then go to Closed, as a Withdrawn submission case may.
  IF public.case_stage_is_presub(p_to_stage) AND NOT public.case_stage_is_presub(c.stage) THEN
    RAISE EXCEPTION 'case %: pre-submission stage % cannot be re-entered after submission', p_case, p_to_stage
      USING ERRCODE = 'check_violation', HINT = 'PRESUB_REENTRY';
  END IF;
  IF c.group_id IS NULL AND NOT public.case_stage_is_presub(p_to_stage) AND p_to_stage <> 'Withdrawn'
     AND NOT (c.stage = 'Withdrawn' AND p_to_stage = 'Closed') THEN
    RAISE EXCEPTION 'case %: stage % needs a submission', p_case, p_to_stage
      USING ERRCODE = 'check_violation', HINT = 'SUBMISSION_REQUIRED';
  END IF;
  v_final := p_to_stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed');
  v_outcome := CASE WHEN p_to_stage IN ('Approved', 'Declined', 'Withdrawn') THEN p_to_stage ELSE c.outcome END;
  v_claim := v_final AND coalesce(p_claim, true) AND c.group_end_claimed_at IS NULL AND c.group_ended_at IS NULL
             AND c.group_id IS NOT NULL;  -- 130: a lead has no group to end
  v_token := CASE WHEN v_claim THEN now() END;
  UPDATE public.cases x
     SET stage = p_to_stage,
         outcome = v_outcome,
         closed_at = CASE WHEN v_final THEN coalesce(x.closed_at, now()) ELSE NULL END,
         group_end_claimed_at = CASE WHEN v_claim THEN v_token ELSE x.group_end_claimed_at END
   WHERE x.id = p_case;
  INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
  VALUES (p_case, c.account_id, c.stage, p_to_stage, v_outcome, p_actor, v_role);
  RETURN QUERY SELECT true, c.stage, p_to_stage, v_outcome, v_claim, v_token;
END;
$$;

-- 130's case_set_details, plus MANAGED_EXTERNALLY (134).
CREATE OR REPLACE FUNCTION public.case_set_details(p_case uuid, p_actor uuid, p_bank_code text,
  p_product text, p_amount numeric)
RETURNS text[]
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c         public.cases%ROWTYPE;
  v_role    text;
  v_changed text[] := '{}';
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  v_role := public.case_role(p_case, p_actor);
  IF NOT public.case_rule_can_write(v_role) THEN
    RAISE EXCEPTION 'case %: % may not change its details', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  -- 134: a submitted case of an account managed in Compass is edited there.
  IF c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', p_case
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  IF p_bank_code IS NOT NULL AND p_bank_code IS DISTINCT FROM c.bank_code THEN
    PERFORM 1 FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = p_bank_code FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
        USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
    END IF;
    IF NOT (c.stage = ANY (public.case_stages_for_bank(c.account_id, p_bank_code))) THEN
      RAISE EXCEPTION 'case %: stage % is not in bank %''s list', p_case, c.stage, p_bank_code
        USING ERRCODE = 'check_violation', HINT = 'STAGE_NOT_IN_LIST';
    END IF;
    -- 130: an open lead may not move onto a taken triple. Without this an
    -- open lead there was a bare 23505 (cases_one_open_lead) and an open
    -- submission case went unnoticed (case_open_lead's CASE_EXISTS).
    IF c.group_id IS NULL AND c.closed_at IS NULL AND c.contact_id IS NOT NULL THEN
      PERFORM public.case_lead_lock(c.account_id, c.contact_id, p_bank_code);
      IF EXISTS (SELECT 1 FROM public.cases x
                  WHERE x.account_id = c.account_id AND x.contact_id = c.contact_id AND x.bank_code = p_bank_code
                    AND x.closed_at IS NULL AND x.id <> p_case) THEN
        RAISE EXCEPTION 'case %: an open lead or case already exists for this contact and bank %', p_case, p_bank_code
          USING ERRCODE = 'check_violation', HINT = 'LEAD_INVALID';
      END IF;
    END IF;
    UPDATE public.cases SET bank_code = p_bank_code WHERE id = p_case;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (p_case, c.account_id, 'bank_code', c.bank_code, p_bank_code, p_actor, v_role);
    v_changed := v_changed || 'bank_code'::text;
  END IF;
  IF p_product IS NOT NULL AND p_product IS DISTINCT FROM c.product THEN
    UPDATE public.cases SET product = p_product WHERE id = p_case;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (p_case, c.account_id, 'product', c.product, p_product, p_actor, v_role);
    v_changed := v_changed || 'product'::text;
  END IF;
  IF p_amount IS NOT NULL AND round(p_amount, 2) IS DISTINCT FROM c.amount THEN
    UPDATE public.cases SET amount = p_amount WHERE id = p_case;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (p_case, c.account_id, 'amount', c.amount::text, round(p_amount, 2)::text, p_actor, v_role);
    v_changed := v_changed || 'amount'::text;
  END IF;
  RETURN v_changed;
END;
$$;

-- 130's case_outcome_reason_set, plus MANAGED_EXTERNALLY (134).
CREATE OR REPLACE FUNCTION public.case_outcome_reason_set(p_actor uuid, p_case uuid, p_code text, p_text text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  v_role text;
  v_text text;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR UPDATE;
  -- An unknown case and a case the actor may not write answer alike, so the
  -- error is no oracle for which case ids exist.
  IF FOUND THEN
    v_role := public.case_role(p_case, p_actor);
  END IF;
  IF NOT FOUND OR NOT coalesce(public.case_rule_can_write(v_role), false) THEN
    RAISE EXCEPTION 'case %: % may not set the outcome reason', p_case, p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  -- 134: a submitted case of an account managed in Compass is edited there.
  IF c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', p_case
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  IF p_code IS NULL OR p_code NOT IN ('INCOMPLETE_DOCS', 'CREDIT_POLICY', 'INCOME_INSUFFICIENT', 'KYC_AML',
                                      'CUSTOMER_WITHDREW', 'OTHER', 'NO_RESPONSE') THEN
    RAISE EXCEPTION 'reason % is not a reason code', p_code USING ERRCODE = 'check_violation', HINT = 'REASON_INVALID';
  END IF;
  v_text := CASE WHEN p_text ~ '^[[:space:]]*$' THEN NULL ELSE p_text END;
  IF char_length(v_text) > 500 THEN
    RAISE EXCEPTION 'reason text over 500 characters' USING ERRCODE = 'check_violation', HINT = 'REASON_TEXT_TOO_LONG';
  END IF;
  IF c.outcome IS NULL OR c.outcome NOT IN ('Declined', 'Withdrawn') THEN
    RAISE EXCEPTION 'case %: outcome % takes no reason', p_case, coalesce(c.outcome, '(none)')
      USING ERRCODE = 'check_violation', HINT = 'OUTCOME_NOT_DECLINED';
  END IF;
  IF p_code = 'NO_RESPONSE' AND c.outcome <> 'Withdrawn' THEN
    RAISE EXCEPTION 'case %: NO_RESPONSE is a Withdrawn reason only', p_case
      USING ERRCODE = 'check_violation', HINT = 'OUTCOME_REASON';
  END IF;
  INSERT INTO public.case_outcome_reasons (case_id, account_id, reason_code, reason_text, outcome, actor_id, actor_role)
  VALUES (p_case, c.account_id, p_code, v_text, c.outcome, p_actor, v_role)
  ON CONFLICT (case_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case %: reason already set', p_case USING ERRCODE = 'unique_violation', HINT = 'REASON_ALREADY_SET';
  END IF;
END;
$$;

-- 123's case_doc_set_status, plus MANAGED_EXTERNALLY (134) for received /
-- rejected; a 'requested' status stays open.
CREATE OR REPLACE FUNCTION public.case_doc_set_status(p_case uuid, p_actor uuid, p_doc_key text, p_status text,
  p_file_ref text DEFAULT NULL, p_now timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c     public.cases%ROWTYPE;
  v_now timestamptz := coalesce(p_now, now());
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  IF p_status IS NULL OR p_status NOT IN ('requested', 'received', 'rejected') THEN
    RAISE EXCEPTION 'document status % is not requested, received or rejected', p_status
      USING ERRCODE = 'check_violation', HINT = 'STATUS_INVALID';
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  -- 134: a submitted case of an account managed in Compass is edited there.
  IF c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) AND p_status IN ('received', 'rejected') THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', p_case
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.case_doc_requirements r
                  WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
                    AND lower(btrim(r.product)) = lower(btrim(c.product)) AND r.doc_key = p_doc_key) THEN
    RAISE EXCEPTION 'document % is not required for bank % / %', p_doc_key, coalesce(c.bank_code, '(none)'),
      coalesce(c.product, '(none)') USING ERRCODE = 'check_violation', HINT = 'DOC_NOT_REQUIRED';
  END IF;
  IF p_file_ref IS NOT NULL AND p_file_ref !~ '^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'file reference is not an id' USING ERRCODE = 'check_violation', HINT = 'FILE_REF_INVALID';
  END IF;
  IF p_status = 'received' AND p_file_ref IS NULL THEN
    RAISE EXCEPTION 'a received document needs its file reference'
      USING ERRCODE = 'check_violation', HINT = 'FILE_REF_REQUIRED';
  END IF;
  INSERT INTO public.case_documents AS d (case_id, account_id, doc_key, status, file_ref, updated_by, updated_at)
  VALUES (p_case, c.account_id, p_doc_key, p_status, p_file_ref, p_actor, v_now)
  ON CONFLICT ON CONSTRAINT case_documents_pkey DO UPDATE
    SET status = EXCLUDED.status, file_ref = EXCLUDED.file_ref,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  RETURN p_status;
END;
$$;

-- ---------- 4. The API path: case_sync_from_submission ----------

-- Applies the submission app's view of the case of p_group, as the v1
-- API (actor NULL, role 'api'), ignoring the managed_externally lock.
-- p_patch keys, all optional: stage, outcome_code, outcome_text, bank,
-- product, amount, external_url, documents [{key, status, file_ref?,
-- received_at?}].
--  * No case: {applied:false, reason:'no_case'}. p_changed_at older
--    than external_changed_at: {applied:false, reason:'stale'}, nothing
--    written.
--  * bank / product / amount overwrite (one case_detail_log row each).
--    An unknown bank is added to case_banks (as case_open does). The
--    stage the case ends at (the patch's, else the current one) must be
--    in the new bank's list (STAGE_NOT_IN_BANK).
--  * stage: in the bank's list (UNKNOWN_STAGE), never pre-submission
--    (PRESUB_REENTRY), from Closed nothing (CASE_CLOSED), from an
--    outcome only Closed (FINAL_STAGE). A final stage sets closed_at and
--    the outcome as case_apply_submission_status does (no claim; the
--    route ends the group). Same stage: no-op.
--  * outcome_code / outcome_text: once, 127/130's rules; a refusal is
--    reported in rejected, never raised.
--  * documents: a requirement of (bank, product) or a row already on
--    the case; received defaults file_ref to 'external'; refusals go to
--    rejected [{key, error}]. Same status and file: no-op.
-- Returns {applied:true, stage, outcome, final, rejected, changes};
-- final = the case moved to a final stage in this call.
CREATE OR REPLACE FUNCTION public.case_sync_from_submission(p_group uuid, p_changed_at timestamptz, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c          public.cases%ROWTYPE;
  v_patch    jsonb := coalesce(p_patch, '{}'::jsonb);
  v_bank     text;
  v_product  text;
  v_amount   numeric;
  v_url      text;
  v_stage    text;
  v_target   text;
  v_final    boolean := false;
  v_outcome  text;
  v_code     text;
  v_text     text;
  v_changes  text[] := '{}';
  v_rejected jsonb := '[]'::jsonb;
  d          jsonb;
  v_key      text;
  v_status   text;
  v_file     text;
  v_at       timestamptz;
  v_old      public.case_documents%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.group_id = p_group FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_case');
  END IF;
  IF p_changed_at IS NOT NULL AND c.external_changed_at IS NOT NULL AND p_changed_at < c.external_changed_at THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'stale');
  END IF;
  IF p_changed_at IN ('infinity'::timestamptz, '-infinity'::timestamptz) THEN
    RAISE EXCEPTION 'CHANGED_AT_INVALID: changed_at % is not a date', p_changed_at
      USING ERRCODE = 'P0001', HINT = 'CHANGED_AT_INVALID';
  END IF;

  -- Validate every scalar before the first write.
  v_bank := nullif(v_patch->>'bank', '');
  IF v_bank IS NOT NULL AND v_bank !~ '^[A-Z0-9_]{2,32}$' THEN
    RAISE EXCEPTION 'BANK_INVALID: bank % is not a bank code', v_bank USING ERRCODE = 'P0001', HINT = 'BANK_INVALID';
  END IF;
  v_product := v_patch->>'product';
  IF v_product IS NOT NULL AND (v_product ~ '^[[:space:]]*$' OR char_length(v_product) > 200) THEN
    RAISE EXCEPTION 'PRODUCT_INVALID: product must be 1-200 characters' USING ERRCODE = 'P0001', HINT = 'PRODUCT_INVALID';
  END IF;
  IF v_patch ? 'amount' AND jsonb_typeof(v_patch->'amount') <> 'null' THEN
    BEGIN
      v_amount := (v_patch->>'amount')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_amount := NULL;
    END;
    IF v_amount IS NULL OR v_amount < 0 OR v_amount = 'NaN'::numeric OR round(v_amount, 2) >= 1e16 THEN
      RAISE EXCEPTION 'AMOUNT_INVALID: amount % is not an amount', v_patch->>'amount'
        USING ERRCODE = 'P0001', HINT = 'AMOUNT_INVALID';
    END IF;
  END IF;
  v_url := v_patch->>'external_url';
  IF v_url IS NOT NULL AND (v_url !~ '^https://[^[:space:]]+$' OR char_length(v_url) > 2048) THEN
    RAISE EXCEPTION 'EXTERNAL_URL_INVALID: external_url must be an https URL of at most 2048 characters'
      USING ERRCODE = 'P0001', HINT = 'EXTERNAL_URL_INVALID';
  END IF;
  v_stage := v_patch->>'stage';

  -- Details. The stage the case will be at decides the bank check.
  IF v_bank IS NOT NULL AND v_bank IS DISTINCT FROM c.bank_code THEN
    INSERT INTO public.case_banks (account_id, code, name) VALUES (c.account_id, v_bank, v_bank)
    ON CONFLICT ON CONSTRAINT case_banks_pkey DO NOTHING;
    PERFORM 1 FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = v_bank FOR SHARE;
    v_target := coalesce(v_stage, c.stage);
    IF NOT (v_target = ANY (public.case_stages_for_bank(c.account_id, v_bank))) THEN
      RAISE EXCEPTION 'STAGE_NOT_IN_BANK: stage % is not in bank %''s list', v_target, v_bank
        USING ERRCODE = 'P0001', HINT = 'STAGE_NOT_IN_BANK';
    END IF;
    UPDATE public.cases SET bank_code = v_bank WHERE id = c.id;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (c.id, c.account_id, 'bank_code', c.bank_code, v_bank, NULL, 'api');
    v_changes := v_changes || 'bank_code'::text;
    c.bank_code := v_bank;
  ELSIF c.bank_code IS NOT NULL THEN
    PERFORM 1 FROM public.case_banks b WHERE b.account_id = c.account_id AND b.code = c.bank_code FOR SHARE;
  END IF;
  IF v_product IS NOT NULL AND v_product IS DISTINCT FROM c.product THEN
    UPDATE public.cases SET product = v_product WHERE id = c.id;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (c.id, c.account_id, 'product', c.product, v_product, NULL, 'api');
    v_changes := v_changes || 'product'::text;
    c.product := v_product;
  END IF;
  IF v_amount IS NOT NULL AND round(v_amount, 2) IS DISTINCT FROM c.amount THEN
    UPDATE public.cases SET amount = v_amount WHERE id = c.id;
    INSERT INTO public.case_detail_log (case_id, account_id, field, from_value, to_value, actor_id, actor_role)
    VALUES (c.id, c.account_id, 'amount', c.amount::text, round(v_amount, 2)::text, NULL, 'api');
    v_changes := v_changes || 'amount'::text;
  END IF;
  IF v_url IS NOT NULL AND v_url IS DISTINCT FROM c.external_url THEN
    UPDATE public.cases SET external_url = v_url WHERE id = c.id;
    v_changes := v_changes || 'external_url'::text;
  END IF;

  -- Stage (122/130's move rules, the API's actor).
  IF v_stage IS NOT NULL AND v_stage IS DISTINCT FROM c.stage THEN
    IF NOT (v_stage = ANY (public.case_stages_for_bank(c.account_id, c.bank_code))) THEN
      RAISE EXCEPTION 'UNKNOWN_STAGE: stage % is not configured for bank %', v_stage, coalesce(c.bank_code, '(default)')
        USING ERRCODE = 'P0001', HINT = 'UNKNOWN_STAGE';
    END IF;
    IF public.case_stage_is_presub(v_stage) THEN
      RAISE EXCEPTION 'PRESUB_REENTRY: pre-submission stage % cannot be re-entered after submission', v_stage
        USING ERRCODE = 'P0001', HINT = 'PRESUB_REENTRY';
    END IF;
    IF c.stage = 'Closed' THEN
      RAISE EXCEPTION 'CASE_CLOSED: case % is closed', c.id USING ERRCODE = 'P0001', HINT = 'CASE_CLOSED';
    END IF;
    IF c.stage IN ('Approved', 'Declined', 'Withdrawn') AND v_stage <> 'Closed' THEN
      RAISE EXCEPTION 'FINAL_STAGE: case % is at final stage %', c.id, c.stage
        USING ERRCODE = 'P0001', HINT = 'FINAL_STAGE';
    END IF;
    v_final := v_stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed');
    v_outcome := CASE WHEN v_stage IN ('Approved', 'Declined', 'Withdrawn') THEN v_stage ELSE c.outcome END;
    UPDATE public.cases x
       SET stage = v_stage,
           outcome = v_outcome,
           closed_at = CASE WHEN v_final THEN coalesce(x.closed_at, now()) ELSE NULL END,
           group_ended_at = CASE WHEN v_final THEN coalesce(x.group_ended_at,
             (SELECT g.ended_at FROM public.submission_groups g
               WHERE g.id = c.group_id AND g.status = 'ENDED')) ELSE x.group_ended_at END
     WHERE x.id = c.id;
    INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
    VALUES (c.id, c.account_id, c.stage, v_stage, v_outcome, NULL, 'api');
    v_changes := v_changes || 'stage'::text;
    c.stage := v_stage;
    c.outcome := v_outcome;
  END IF;

  -- Outcome reason: once, 127/130's rules; refusals are reported.
  v_code := v_patch->>'outcome_code';
  IF v_code IS NOT NULL THEN
    v_text := CASE WHEN v_patch->>'outcome_text' ~ '^[[:space:]]*$' THEN NULL ELSE v_patch->>'outcome_text' END;
    IF v_code NOT IN ('INCOMPLETE_DOCS', 'CREDIT_POLICY', 'INCOME_INSUFFICIENT', 'KYC_AML',
                      'CUSTOMER_WITHDREW', 'OTHER', 'NO_RESPONSE') THEN
      v_rejected := v_rejected || jsonb_build_object('key', 'outcome_reason', 'error', 'REASON_INVALID');
    ELSIF char_length(v_text) > 500 THEN
      v_rejected := v_rejected || jsonb_build_object('key', 'outcome_reason', 'error', 'REASON_TEXT_TOO_LONG');
    ELSIF c.outcome IS NULL OR c.outcome NOT IN ('Declined', 'Withdrawn') THEN
      v_rejected := v_rejected || jsonb_build_object('key', 'outcome_reason', 'error', 'OUTCOME_NOT_DECLINED');
    ELSIF v_code = 'NO_RESPONSE' AND c.outcome <> 'Withdrawn' THEN
      v_rejected := v_rejected || jsonb_build_object('key', 'outcome_reason', 'error', 'OUTCOME_REASON');
    ELSE
      INSERT INTO public.case_outcome_reasons (case_id, account_id, reason_code, reason_text, outcome, actor_id, actor_role)
      VALUES (c.id, c.account_id, v_code, v_text, c.outcome, NULL, 'api')
      ON CONFLICT (case_id) DO NOTHING;
      IF FOUND THEN
        v_changes := v_changes || 'outcome_reason'::text;
      ELSE
        v_rejected := v_rejected || jsonb_build_object('key', 'outcome_reason', 'error', 'REASON_ALREADY_SET');
      END IF;
    END IF;
  END IF;

  -- Documents.
  IF jsonb_typeof(v_patch->'documents') = 'array' THEN
    FOR d IN SELECT x FROM jsonb_array_elements(v_patch->'documents') x LOOP
      v_key := CASE WHEN jsonb_typeof(d) = 'object' THEN d->>'key' END;
      v_status := CASE WHEN jsonb_typeof(d) = 'object' THEN d->>'status' END;
      v_file := CASE WHEN jsonb_typeof(d) = 'object' THEN nullif(d->>'file_ref', '') END;
      IF v_key IS NULL OR v_key !~ '^[a-z0-9_]{1,64}$' THEN
        v_rejected := v_rejected || jsonb_build_object('key', v_key, 'error', 'DOC_KEY_INVALID');
        CONTINUE;
      END IF;
      IF v_status IS NULL OR v_status NOT IN ('requested', 'received', 'rejected') THEN
        v_rejected := v_rejected || jsonb_build_object('key', v_key, 'error', 'STATUS_INVALID');
        CONTINUE;
      END IF;
      SELECT * INTO v_old FROM public.case_documents o WHERE o.case_id = c.id AND o.doc_key = v_key;
      IF NOT FOUND AND NOT EXISTS (
           SELECT 1 FROM public.case_doc_requirements r
            WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
              AND lower(btrim(r.product)) = lower(btrim(c.product)) AND r.doc_key = v_key) THEN
        v_rejected := v_rejected || jsonb_build_object('key', v_key, 'error', 'DOC_NOT_REQUIRED');
        CONTINUE;
      END IF;
      IF v_status = 'received' THEN
        v_file := coalesce(v_file, 'external');
      ELSE
        v_file := NULL;
      END IF;
      IF v_file IS NOT NULL AND v_file !~ '^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$' THEN
        v_rejected := v_rejected || jsonb_build_object('key', v_key, 'error', 'FILE_REF_INVALID');
        CONTINUE;
      END IF;
      v_at := NULL;
      IF d ? 'received_at' AND jsonb_typeof(d->'received_at') = 'string' THEN
        BEGIN
          v_at := (d->>'received_at')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
          v_at := NULL;
        END;
        IF v_at IS NULL OR v_at IN ('infinity'::timestamptz, '-infinity'::timestamptz) THEN
          v_rejected := v_rejected || jsonb_build_object('key', v_key, 'error', 'RECEIVED_AT_INVALID');
          CONTINUE;
        END IF;
      END IF;
      IF v_old.case_id IS NOT NULL AND v_old.status = v_status AND v_old.file_ref IS NOT DISTINCT FROM v_file THEN
        CONTINUE;  -- same status: no-op
      END IF;
      INSERT INTO public.case_documents AS o (case_id, account_id, doc_key, status, file_ref, updated_by, updated_at)
      VALUES (c.id, c.account_id, v_key, v_status, v_file, NULL, coalesce(v_at, now()))
      ON CONFLICT ON CONSTRAINT case_documents_pkey DO UPDATE
        SET status = EXCLUDED.status, file_ref = EXCLUDED.file_ref,
            updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
      v_changes := v_changes || ('document:' || v_key);
    END LOOP;
  END IF;

  IF p_changed_at IS NOT NULL THEN
    UPDATE public.cases x SET external_changed_at = greatest(x.external_changed_at, p_changed_at) WHERE x.id = c.id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'stage', c.stage, 'outcome', c.outcome, 'final', v_final,
                            'rejected', v_rejected, 'changes', to_jsonb(v_changes));
END;
$$;

-- ---------- 5. Webhook outbox ----------

CREATE TABLE IF NOT EXISTS public.webhook_event_outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz NULL,
  attempts     integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS webhook_event_outbox_pending_idx ON public.webhook_event_outbox (id)
  WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS webhook_event_outbox_delivered_idx ON public.webhook_event_outbox (delivered_at)
  WHERE delivered_at IS NOT NULL;

COMMENT ON TABLE public.webhook_event_outbox IS
  'Outbound webhook events raised by SQL triggers, drained by the app (webhook_outbox_claim, at most once). Service role only. Migration 134.';

ALTER TABLE public.webhook_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_event_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_event_outbox FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.webhook_event_outbox_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.webhook_event_outbox TO service_role;

-- Queues p_event for p_account only when an active endpoint of the
-- account subscribes to it. Adds account_id and occurred_at to the
-- payload. True if a row was queued.
CREATE OR REPLACE FUNCTION public.webhook_enqueue(p_account uuid, p_event text, p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_account IS NULL OR p_event IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.webhook_endpoints e
        WHERE e.account_id = p_account AND e.is_active AND e.events @> ARRAY[p_event]) THEN
    RETURN false;
  END IF;
  INSERT INTO public.webhook_event_outbox (account_id, event, payload)
  VALUES (p_account, p_event,
          coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('account_id', p_account, 'occurred_at', now()));
  RETURN true;
END;
$$;

-- case.stage_changed (every case_stage_history row).
CREATE OR REPLACE FUNCTION public.webhook_on_case_stage_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    PERFORM public.webhook_enqueue(NEW.account_id, 'case.stage_changed', jsonb_build_object(
      'case_id', NEW.case_id,
      'submission_id', (SELECT g.submission_ref FROM public.cases c JOIN public.submission_groups g ON g.id = c.group_id
                         WHERE c.id = NEW.case_id),
      'from_stage', NEW.from_stage,
      'to_stage', NEW.to_stage,
      'outcome', NEW.outcome,
      'source', CASE WHEN NEW.actor_role = 'api' THEN 'compass' ELSE 'crm' END,
      'changed_at', NEW.changed_at));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook case.stage_changed for case % not queued: % (%)', NEW.case_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_stage_history_webhook ON public.case_stage_history;
CREATE TRIGGER case_stage_history_webhook
  AFTER INSERT ON public.case_stage_history
  FOR EACH ROW EXECUTE FUNCTION public.webhook_on_case_stage_history();

-- case.lead_created (a case inserted with no group).
CREATE OR REPLACE FUNCTION public.webhook_on_case_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    IF NEW.group_id IS NULL THEN
      PERFORM public.webhook_enqueue(NEW.account_id, 'case.lead_created', jsonb_build_object(
        'case_id', NEW.id,
        'contact_id', NEW.contact_id,
        'bank', NEW.bank_code,
        'product', NEW.product,
        'amount', NEW.amount,
        'agent_email', (SELECT u.email FROM auth.users u WHERE u.id = NEW.agent_id),
        'created_at', NEW.opened_at));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook case.lead_created for case % not queued: % (%)', NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cases_lead_webhook ON public.cases;
CREATE TRIGGER cases_lead_webhook
  AFTER INSERT ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.webhook_on_case_lead();

-- submission_group.ready / .failed / .ended. Never the invite link.
CREATE OR REPLACE FUNCTION public.webhook_on_submission_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    IF OLD.wa_group_id IS NULL AND NEW.wa_group_id IS NOT NULL THEN
      PERFORM public.webhook_enqueue(NEW.account_id, 'submission_group.ready', jsonb_build_object(
        'submission_id', NEW.submission_ref,
        'group_id', NEW.id,
        'case_id', (SELECT c.id FROM public.cases c WHERE c.group_id = NEW.id),
        'invite_link_present', NEW.invite_link IS NOT NULL));
    END IF;
    IF NEW.wa_group_id IS NULL AND NEW.wa_create_error IS NOT NULL
       AND NEW.wa_create_error IS DISTINCT FROM OLD.wa_create_error THEN
      PERFORM public.webhook_enqueue(NEW.account_id, 'submission_group.failed', jsonb_build_object(
        'submission_id', NEW.submission_ref,
        'error', NEW.wa_create_error,
        'retrying', true));
    END IF;
    IF NEW.status = 'ENDED' AND OLD.status IS DISTINCT FROM 'ENDED' THEN
      PERFORM public.webhook_enqueue(NEW.account_id, 'submission_group.ended', jsonb_build_object(
        'submission_id', NEW.submission_ref,
        'end_reason', NEW.end_reason,
        'ended_at', NEW.ended_at));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook submission_group event for group % not queued: % (%)', NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS submission_groups_webhook ON public.submission_groups;
CREATE TRIGGER submission_groups_webhook
  AFTER UPDATE ON public.submission_groups
  FOR EACH ROW EXECUTE FUNCTION public.webhook_on_submission_group();

-- contact.opted_out (opted_out_at NULL -> a value).
CREATE OR REPLACE FUNCTION public.webhook_on_contact_opt_out()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    IF OLD.opted_out_at IS NULL AND NEW.opted_out_at IS NOT NULL THEN
      PERFORM public.webhook_enqueue(NEW.account_id, 'contact.opted_out', jsonb_build_object(
        'contact_id', NEW.id,
        'phone', NEW.phone,
        'opted_out_at', NEW.opted_out_at,
        'compass_id', (SELECT cc.compass_id FROM public.compass_contacts cc
                        WHERE cc.account_id = NEW.account_id AND cc.contact_id = NEW.id
                        ORDER BY cc.created_at, cc.id LIMIT 1)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook contact.opted_out for contact % not queued: % (%)', NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS contacts_opt_out_webhook ON public.contacts;
CREATE TRIGGER contacts_opt_out_webhook
  AFTER UPDATE OF opted_out_at ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.webhook_on_contact_opt_out();

-- Hands out up to p_limit undelivered rows, oldest first, and marks
-- them delivered in the same statement (at most once, as
-- dispatchWebhookEvent): a claimed row is never handed out again.
CREATE OR REPLACE FUNCTION public.webhook_outbox_claim(p_limit int)
RETURNS SETOF public.webhook_event_outbox
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
    WITH picked AS (
      SELECT o.id FROM public.webhook_event_outbox o
       WHERE o.delivered_at IS NULL
       ORDER BY o.id
       LIMIT greatest(coalesce(p_limit, 100), 0)
       FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE public.webhook_event_outbox o
         SET attempts = o.attempts + 1, delivered_at = now()
        FROM picked
       WHERE o.id = picked.id
      RETURNING o.*
    )
    SELECT * FROM claimed ORDER BY claimed.id;
END;
$$;

-- Deletes delivered rows older than 7 days. Returns how many.
CREATE OR REPLACE FUNCTION public.webhook_outbox_purge()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.webhook_event_outbox o
   WHERE o.delivered_at IS NOT NULL AND o.delivered_at < now() - interval '7 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ---------- 6. Compass customers: link by phone ----------

-- Links p_account's Compass customer rows whose phone digits equal
-- p_phone_digits and that have no contact yet to p_contact (a contact
-- of the same account). Returns how many rows it linked.
CREATE OR REPLACE FUNCTION public.compass_link_contact_by_phone(p_account uuid, p_contact uuid, p_phone_digits text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_digits text := nullif(regexp_replace(coalesce(p_phone_digits, ''), '\D', '', 'g'), '');
  v_n      integer;
BEGIN
  IF v_digits IS NULL OR NOT EXISTS (SELECT 1 FROM public.contacts k
                                      WHERE k.id = p_contact AND k.account_id = p_account) THEN
    RETURN 0;
  END IF;
  UPDATE public.compass_contacts cc SET contact_id = p_contact
   WHERE cc.account_id = p_account AND cc.contact_id IS NULL AND cc.phone_normalized = v_digits;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ---------- 7. Privileges ----------

REVOKE ALL ON FUNCTION
  public.case_managed_externally(uuid),
  public.case_settings_set(uuid, uuid, boolean),
  public.case_sync_from_submission(uuid, timestamptz, jsonb),
  public.webhook_enqueue(uuid, text, jsonb),
  public.webhook_on_case_stage_history(),
  public.webhook_on_case_lead(),
  public.webhook_on_submission_group(),
  public.webhook_on_contact_opt_out(),
  public.webhook_outbox_claim(int),
  public.webhook_outbox_purge(),
  public.compass_link_contact_by_phone(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_managed_externally(uuid),
  public.case_settings_set(uuid, uuid, boolean),
  public.case_sync_from_submission(uuid, timestamptz, jsonb),
  public.webhook_outbox_claim(int),
  public.webhook_outbox_purge(),
  public.compass_link_contact_by_phone(uuid, uuid, text)
  TO service_role;

RESET lock_timeout;
