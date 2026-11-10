-- =============================================================================
-- 183 - WhatsApp document intake prompts, database half (ported from the
--       outside package's module 021c, "tap-to-classify")
-- =============================================================================
--
-- OFF BY DEFAULT, AND THIS MIGRATION SENDS NOTHING BY ITSELF. It stores the
-- message wording and the record of prompts a later sender has sent; no
-- trigger, cron or function here talks to WhatsApp. A prompt can be
-- recorded only while BOTH hold:
--   - an admin switched 181's case_account_settings.files_intake_prompts on
--     (default false), and
--   - the account's 'document_classify' wording is approved (below).
--
-- When a customer sends a document into their case's WhatsApp group, the
-- sender (a later job) asks "Reply with the number of the document you
-- just sent: 1 Trade licence, 2 ...", records that prompt here, and turns
-- the customer's bare-number reply into a doc_key here before classifying
-- the file as the system intake (181's case_document_file_classify with a
-- NULL actor).
--
-- WORDING case_intake_templates: one row per (account, kind), kind
--   document_classify | document_rejected | document_received_next; body
--   1..1000 characters. Written only by
--   case_intake_template_set(actor, account, kind, body)  owner/admin; a
--     changed body resets the approval (the same body again is a no-op);
--   case_intake_template_approve(actor, account, kind)    owner only (the
--     package's legal approval); never by the person who last edited the
--     body (SELF_APPROVAL).
--   case_intake_template_get(account, kind) is the body only while
--   approved, else NULL: the sender's one read. Every set and approval lands
--   in the append-only case_intake_template_audit. Members of the account
--   read the wording; only the service role reads the audit.
-- PROMPTS case_intake_prompts: one row per prompt that was SENT; options is
--   the numbered list sent, [{n, doc_key, label}]. At most one OPEN prompt
--   per case (answered_at and superseded_at both NULL); recording a new one
--   supersedes the open one. Rows are never deleted; the only changes are
--   answered_at + answer_doc_key or superseded_at, once.
--   case_intake_prompt_record(case, file, options, now) -> prompt id. The
--     file is an unclassified file of the case that the system intake
--     registered from a customer-sent document (181: registered_by NULL).
--   case_intake_prompt_answer(prompt, n, now) -> the chosen doc_key, once.
--   case_intake_open_prompt(case) -> the open prompt, or no row.
--   All three are the service role's only.
--
-- Refusals (hint): NOT_ALLOWED, TEMPLATE_INVALID, TEMPLATE_NOT_FOUND,
-- SELF_APPROVAL, CASE_NOT_FOUND, INTAKE_OFF, MANAGED_EXTERNALLY, TEMPLATE_NOT_APPROVED,
-- CASE_CLOSED, FILE_NOT_FOUND, FILE_STATE, PROMPT_INVALID, PROMPT_NOT_FOUND,
-- PROMPT_STALE, PROMPT_OPTION.
-- Lock order (181's): the case FOR NO KEY UPDATE, then the prompt, then the
-- file.
--
-- Re-runnable. Apply as a superuser or BYPASSRLS role (the tables force RLS
-- and the functions write them as their owner).
-- =============================================================================

-- ---------- 1. Wording ----------

CREATE TABLE IF NOT EXISTS public.case_intake_templates (
  account_id  uuid NOT NULL REFERENCES public.accounts(id),
  kind        text NOT NULL,
  body        text NOT NULL,
  approved    boolean NOT NULL DEFAULT false,
  approved_by uuid NULL,
  approved_at timestamptz NULL,
  updated_by  uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind),
  CONSTRAINT case_intake_templates_kind_check
    CHECK (kind IN ('document_classify', 'document_rejected', 'document_received_next')),
  -- [[:space:]], not btrim(): btrim strips spaces only.
  CONSTRAINT case_intake_templates_body_check
    CHECK (char_length(body) BETWEEN 1 AND 1000 AND body !~ '^[[:space:]]*$'),
  CONSTRAINT case_intake_templates_approval_check
    CHECK (approved = (approved_by IS NOT NULL) AND approved = (approved_at IS NOT NULL))
);

COMMENT ON TABLE public.case_intake_templates IS
  'Wording of the WhatsApp document intake messages; used only while approved. Written only by case_intake_template_set / _approve. Migration 183.';

CREATE TABLE IF NOT EXISTS public.case_intake_template_audit (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  kind       text NOT NULL,
  action     text NOT NULL,
  body       text NOT NULL,
  actor      uuid NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_intake_template_audit_action_check CHECK (action IN ('set', 'approve'))
);
CREATE INDEX IF NOT EXISTS case_intake_template_audit_account_idx
  ON public.case_intake_template_audit (account_id, kind, at);

COMMENT ON TABLE public.case_intake_template_audit IS
  'Append-only: every intake wording change and approval, with the body it applied to. Migration 183.';

DROP TRIGGER IF EXISTS case_intake_template_audit_append_only ON public.case_intake_template_audit;
CREATE TRIGGER case_intake_template_audit_append_only
  BEFORE UPDATE OR DELETE ON public.case_intake_template_audit
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_intake_template_audit_no_truncate ON public.case_intake_template_audit;
CREATE TRIGGER case_intake_template_audit_no_truncate
  BEFORE TRUNCATE ON public.case_intake_template_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- Owner/admin of p_account. A changed body is stored unapproved; the same
-- body again changes nothing. Returns the stored approved flag.
CREATE OR REPLACE FUNCTION public.case_intake_template_set(p_actor uuid, p_account uuid, p_kind text, p_body text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t public.case_intake_templates%ROWTYPE;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor), '') NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the intake wording of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('document_classify', 'document_rejected', 'document_received_next')
     OR p_body IS NULL OR char_length(p_body) NOT BETWEEN 1 AND 1000 OR p_body ~ '^[[:space:]]*$' THEN
    RAISE EXCEPTION 'TEMPLATE_INVALID: a known kind and a body of 1 to 1000 characters'
      USING ERRCODE = 'check_violation', HINT = 'TEMPLATE_INVALID';
  END IF;
  SELECT * INTO t FROM public.case_intake_templates x
   WHERE x.account_id = p_account AND x.kind = p_kind FOR UPDATE;
  IF FOUND AND t.body = p_body THEN
    RETURN t.approved;
  END IF;
  INSERT INTO public.case_intake_templates AS x (account_id, kind, body, updated_by, updated_at)
  VALUES (p_account, p_kind, p_body, p_actor, now())
  ON CONFLICT (account_id, kind) DO UPDATE
    SET body = EXCLUDED.body, approved = false, approved_by = NULL, approved_at = NULL,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.case_intake_template_audit (account_id, kind, action, body, actor)
  VALUES (p_account, p_kind, 'set', p_body, p_actor);
  RETURN false;
END;
$$;

-- Owner of p_account only, and not the person who last edited the body.
-- Approving an approved row is a no-op. Returns true.
CREATE OR REPLACE FUNCTION public.case_intake_template_approve(p_actor uuid, p_account uuid, p_kind text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t public.case_intake_templates%ROWTYPE;
BEGIN
  IF public.case_account_role(p_account, p_actor) IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_ALLOWED: only an owner may approve the intake wording of %', p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT * INTO t FROM public.case_intake_templates x
   WHERE x.account_id = p_account AND x.kind = p_kind FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEMPLATE_NOT_FOUND: no % wording for %', p_kind, p_account
      USING ERRCODE = 'no_data_found', HINT = 'TEMPLATE_NOT_FOUND';
  END IF;
  IF t.approved THEN
    RETURN true;
  END IF;
  IF t.updated_by = p_actor THEN
    RAISE EXCEPTION 'SELF_APPROVAL: the person who last edited the % wording may not approve it', p_kind
      USING ERRCODE = 'insufficient_privilege', HINT = 'SELF_APPROVAL';
  END IF;
  UPDATE public.case_intake_templates x SET approved = true, approved_by = p_actor, approved_at = now()
   WHERE x.account_id = p_account AND x.kind = p_kind;
  INSERT INTO public.case_intake_template_audit (account_id, kind, action, body, actor)
  VALUES (p_account, p_kind, 'approve', t.body, p_actor);
  RETURN true;
END;
$$;

-- The body to send, only while approved; NULL otherwise.
CREATE OR REPLACE FUNCTION public.case_intake_template_get(p_account uuid, p_kind text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.body FROM public.case_intake_templates t
   WHERE t.account_id = p_account AND t.kind = p_kind AND t.approved
$$;

-- ---------- 2. Prompts ----------

CREATE TABLE IF NOT EXISTS public.case_intake_prompts (
  prompt_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL,
  case_id        uuid NOT NULL,
  file_id        uuid NOT NULL REFERENCES public.case_document_files(id),
  options        jsonb NOT NULL,
  sent_at        timestamptz NOT NULL,
  answered_at    timestamptz NULL,
  answer_doc_key text NULL,
  superseded_at  timestamptz NULL,
  CONSTRAINT case_intake_prompts_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_intake_prompts_options_check
    CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 1 AND 20),
  CONSTRAINT case_intake_prompts_answer_check CHECK ((answered_at IS NULL) = (answer_doc_key IS NULL)),
  CONSTRAINT case_intake_prompts_final_check CHECK (answered_at IS NULL OR superseded_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS case_intake_prompts_one_open
  ON public.case_intake_prompts (case_id) WHERE answered_at IS NULL AND superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS case_intake_prompts_file_idx ON public.case_intake_prompts (file_id);

COMMENT ON TABLE public.case_intake_prompts IS
  'A document classification prompt sent into a case''s WhatsApp group. Never deleted; answered or superseded once. Written only by case_intake_prompt_record / _answer. Migration 183.';

-- Only answered_at + answer_doc_key or superseded_at change, once, from an
-- open prompt; rows are never deleted.
CREATE OR REPLACE FUNCTION public.case_intake_prompts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (NEW.prompt_id, NEW.account_id, NEW.case_id, NEW.file_id, NEW.options, NEW.sent_at)
     IS DISTINCT FROM (OLD.prompt_id, OLD.account_id, OLD.case_id, OLD.file_id, OLD.options, OLD.sent_at)
     OR OLD.answered_at IS NOT NULL OR OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'case_intake_prompts: only an open prompt is answered or superseded, once'
      USING ERRCODE = 'insufficient_privilege', HINT = 'PROMPT_STALE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS case_intake_prompts_guard ON public.case_intake_prompts;
CREATE TRIGGER case_intake_prompts_guard
  BEFORE UPDATE ON public.case_intake_prompts
  FOR EACH ROW EXECUTE FUNCTION public.case_intake_prompts_guard();
DROP TRIGGER IF EXISTS case_intake_prompts_no_delete ON public.case_intake_prompts;
CREATE TRIGGER case_intake_prompts_no_delete
  BEFORE DELETE ON public.case_intake_prompts
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_intake_prompts_no_truncate ON public.case_intake_prompts;
CREATE TRIGGER case_intake_prompts_no_truncate
  BEFORE TRUNCATE ON public.case_intake_prompts
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- Records a prompt that was sent about p_file and supersedes the case's
-- open one. p_options: 1..20 of {n: 1..20, doc_key, label}, n and doc_key
-- unique, every doc_key in the case's file spec.
CREATE OR REPLACE FUNCTION public.case_intake_prompt_record(p_case uuid, p_file uuid, p_options jsonb,
  p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c      public.cases%ROWTYPE;
  f      public.case_document_files%ROWTYPE;
  v_src  text;
  v_now  timestamptz := coalesce(p_now, now());
  v_ok   boolean;
  v_id   uuid;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF NOT (SELECT st.files_intake_prompts FROM public.case_files_settings(c.account_id) st) THEN
    RAISE EXCEPTION 'the WhatsApp document intake is off for this workspace'
      USING ERRCODE = 'check_violation', HINT = 'INTAKE_OFF';
  END IF;
  -- 181's rule: the intake never acts on a case Compass manages.
  IF c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', p_case
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  IF public.case_intake_template_get(c.account_id, 'document_classify') IS NULL THEN
    RAISE EXCEPTION 'the document_classify wording is not approved'
      USING ERRCODE = 'check_violation', HINT = 'TEMPLATE_NOT_APPROVED';
  END IF;
  IF c.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'case % is closed', p_case USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  SELECT * INTO f FROM public.case_document_files x WHERE x.id = p_file FOR UPDATE;
  IF NOT FOUND OR f.case_id <> p_case THEN
    RAISE EXCEPTION 'file % not found in case %', p_file, p_case
      USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;
  SELECT d.source INTO v_src FROM public.customer_documents d WHERE d.id = f.customer_document_id;
  IF f.status <> 'unclassified' OR f.registered_by IS NOT NULL
     OR v_src IS NULL OR v_src NOT IN ('chat', 'submission_group') THEN
    RAISE EXCEPTION 'file % is not an unclassified file the customer sent', p_file
      USING ERRCODE = 'check_violation', HINT = 'FILE_STATE';
  END IF;
  v_ok := p_options IS NOT NULL AND jsonb_typeof(p_options) = 'array'
          AND jsonb_array_length(p_options) BETWEEN 1 AND 20;
  IF v_ok THEN
    SELECT bool_and(jsonb_typeof(o) = 'object'
                    AND jsonb_typeof(o -> 'n') = 'number'
                    -- CASE, not AND: AND does not promise to test the pattern before the cast.
                    AND CASE WHEN (o ->> 'n') ~ '^[0-9]{1,2}$' THEN (o ->> 'n')::int BETWEEN 1 AND 20 ELSE false END
                    AND jsonb_typeof(o -> 'doc_key') = 'string'
                    AND jsonb_typeof(o -> 'label') = 'string'
                    AND (o ->> 'label') !~ '^[[:space:]]*$' AND char_length(o ->> 'label') <= 200
                    AND EXISTS (SELECT 1 FROM public.case_file_spec_rows(p_case) r WHERE r.doc_key = (o ->> 'doc_key')))
           AND count(DISTINCT o ->> 'n') = count(*)
           AND count(DISTINCT o ->> 'doc_key') = count(*)
      INTO v_ok
      FROM jsonb_array_elements(p_options) o;
  END IF;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'options must be 1 to 20 of {n: 1..20, doc_key in the file spec, label}, n and doc_key unique'
      USING ERRCODE = 'check_violation', HINT = 'PROMPT_INVALID';
  END IF;
  UPDATE public.case_intake_prompts p SET superseded_at = v_now
   WHERE p.case_id = p_case AND p.answered_at IS NULL AND p.superseded_at IS NULL;
  INSERT INTO public.case_intake_prompts (account_id, case_id, file_id, options, sent_at)
  VALUES (c.account_id, p_case, p_file, p_options, v_now)
  RETURNING prompt_id INTO v_id;
  RETURN v_id;
END;
$$;

-- Turns the customer's number into the doc_key offered under it and marks
-- the prompt answered, once. Stale once answered, superseded, or once its
-- file is no longer unclassified (staff classified it meanwhile).
CREATE OR REPLACE FUNCTION public.case_intake_prompt_answer(p_prompt uuid, p_n integer, p_now timestamptz DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  p        public.case_intake_prompts%ROWTYPE;
  c        public.cases%ROWTYPE;
  v_case   uuid;
  v_status text;
  v_key    text;
BEGIN
  SELECT x.case_id INTO v_case FROM public.case_intake_prompts x WHERE x.prompt_id = p_prompt;
  IF v_case IS NULL THEN
    RAISE EXCEPTION 'prompt % not found', p_prompt USING ERRCODE = 'no_data_found', HINT = 'PROMPT_NOT_FOUND';
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.id = v_case FOR NO KEY UPDATE;
  SELECT * INTO p FROM public.case_intake_prompts x WHERE x.prompt_id = p_prompt FOR UPDATE;
  -- An answer would classify: refused once Compass manages the case (181).
  IF c.group_id IS NOT NULL AND public.case_managed_externally(c.account_id) THEN
    RAISE EXCEPTION 'MANAGED_EXTERNALLY: case % is managed in the submission app', v_case
      USING ERRCODE = 'object_not_in_prerequisite_state', HINT = 'MANAGED_EXTERNALLY';
  END IF;
  SELECT f.status INTO v_status FROM public.case_document_files f WHERE f.id = p.file_id;
  IF p.answered_at IS NOT NULL OR p.superseded_at IS NOT NULL OR v_status IS DISTINCT FROM 'unclassified' THEN
    RAISE EXCEPTION 'prompt % is no longer open', p_prompt USING ERRCODE = 'check_violation', HINT = 'PROMPT_STALE';
  END IF;
  SELECT o ->> 'doc_key' INTO v_key FROM jsonb_array_elements(p.options) o
   WHERE p_n IS NOT NULL AND (o ->> 'n') = p_n::text;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'option % is not on prompt %', p_n, p_prompt
      USING ERRCODE = 'check_violation', HINT = 'PROMPT_OPTION';
  END IF;
  UPDATE public.case_intake_prompts x SET answered_at = coalesce(p_now, now()), answer_doc_key = v_key
   WHERE x.prompt_id = p_prompt;
  RETURN v_key;
END;
$$;

-- The case's open prompt, or no row.
CREATE OR REPLACE FUNCTION public.case_intake_open_prompt(p_case uuid)
RETURNS SETOF public.case_intake_prompts
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM public.case_intake_prompts p
   WHERE p.case_id = p_case AND p.answered_at IS NULL AND p.superseded_at IS NULL
$$;

-- ---------- 3. RLS ----------

ALTER TABLE public.case_intake_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_intake_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_intake_template_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_intake_template_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_intake_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_intake_prompts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_intake_templates_select ON public.case_intake_templates;
CREATE POLICY case_intake_templates_select ON public.case_intake_templates FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id));

-- ---------- 4. Privileges ----------

REVOKE ALL ON public.case_intake_templates, public.case_intake_template_audit, public.case_intake_prompts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_intake_templates TO authenticated, service_role;
GRANT SELECT ON public.case_intake_template_audit, public.case_intake_prompts TO service_role;

REVOKE ALL ON FUNCTION
  public.case_intake_template_set(uuid, uuid, text, text),
  public.case_intake_template_approve(uuid, uuid, text),
  public.case_intake_template_get(uuid, text),
  public.case_intake_prompts_guard(),
  public.case_intake_prompt_record(uuid, uuid, jsonb, timestamptz),
  public.case_intake_prompt_answer(uuid, integer, timestamptz),
  public.case_intake_open_prompt(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_intake_template_set(uuid, uuid, text, text),
  public.case_intake_template_approve(uuid, uuid, text),
  public.case_intake_template_get(uuid, text),
  public.case_intake_prompt_record(uuid, uuid, jsonb, timestamptz),
  public.case_intake_prompt_answer(uuid, integer, timestamptz),
  public.case_intake_open_prompt(uuid)
  TO service_role;
