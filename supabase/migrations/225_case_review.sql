-- ============================================================
-- 225_case_review.sql — the case file reviewer: a draft for a person
-- to approve or reject when a case document passes its checks. Port of
-- package 031 (031a drafts, 031b queue), fitted to this repo.
--
--  * Off by default: case_account_settings.review_enabled and
--    review_send_to_model (owners / admins, case_settings_set_review;
--    the model needs the reviewer on). With the reviewer off nothing is
--    queued and nothing runs.
--  * The reviewer only drafts. It never changes a document, a file, a
--    stage or a task, and never contacts anyone. A draft always holds the
--    deterministic checklist; a model narrative is added only with
--    review_send_to_model on, the workspace's AI key configured, the text
--    redacted, and the AI transfer register (224) allowing the call.
--  * case_review_draft_create (service role): idempotent on input_hash
--    (the same inputs return the pending draft), a new draft supersedes
--    the case's pending one, so at most one is pending (the package's cap
--    of 3 is moot under supersede). A decided draft is final.
--  * Queue: a file becoming 'passed' (181) on a case of a workspace with
--    the reviewer on queues the case, due 60 s later; a later pass
--    pushes it back (debounce). case_review_claim takes up to N due
--    cases (running rows older than 15 minutes are taken back);
--    case_review_finish settles one: done, or after 3 attempts failed.
--    A manual case_doc_set_status queues nothing.
--  * Who: readers of the case (case_can_read) list its drafts; writers
--    (case_can_write) approve or reject one (ALREADY_DECIDED after).
--
-- SECURITY DEFINER, search_path ''; tables force RLS with no grants.
-- Apply after 224 as a superuser or BYPASSRLS role. Re-runnable.
-- verify-case-review.sql; docs/cases.md (Case file reviewer).
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '225 must be applied by a superuser or BYPASSRLS role (the reviewer reads RLS-forced tables)';
  END IF;
END $$;

ALTER TABLE public.case_account_settings ADD COLUMN IF NOT EXISTS review_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.case_account_settings ADD COLUMN IF NOT EXISTS review_send_to_model boolean NOT NULL DEFAULT false;
ALTER TABLE public.case_account_settings DROP CONSTRAINT IF EXISTS case_account_settings_review_model_check;
ALTER TABLE public.case_account_settings ADD CONSTRAINT case_account_settings_review_model_check
  CHECK (NOT review_send_to_model OR review_enabled);

CREATE TABLE IF NOT EXISTS public.case_review_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL,
  case_id           uuid NOT NULL,
  body              jsonb NOT NULL,
  narrative_source  text NOT NULL,
  input_hash        text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  decided_by        uuid NULL,
  decided_at        timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_review_drafts_case_fkey FOREIGN KEY (case_id, account_id) REFERENCES public.cases (id, account_id),
  CONSTRAINT case_review_drafts_source_check CHECK (narrative_source IN ('model', 'deterministic')),
  CONSTRAINT case_review_drafts_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT case_review_drafts_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  CONSTRAINT case_review_drafts_body_check CHECK (jsonb_typeof(body) = 'object'
    AND jsonb_typeof(body -> 'checklist') = 'array' AND jsonb_typeof(body -> 'flags') = 'array'
    AND jsonb_typeof(body -> 'narrative') = 'string'),
  CONSTRAINT case_review_drafts_decided_check
    CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS case_review_drafts_one_pending ON public.case_review_drafts (case_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS case_review_drafts_case_idx ON public.case_review_drafts (case_id, created_at DESC);
COMMENT ON TABLE public.case_review_drafts IS
  'The case file reviewer''s drafts: a checklist and narrative for a person to approve or reject. Never acted on automatically. Migration 225.';

CREATE TABLE IF NOT EXISTS public.case_review_queue (
  case_id    uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  due_at     timestamptz NOT NULL,
  state      text NOT NULL DEFAULT 'queued',
  attempts   integer NOT NULL DEFAULT 0,
  claimed_at timestamptz NULL,
  last_error text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_review_queue_case_fkey FOREIGN KEY (case_id, account_id) REFERENCES public.cases (id, account_id),
  CONSTRAINT case_review_queue_state_check CHECK (state IN ('queued', 'running', 'done', 'failed')),
  CONSTRAINT case_review_queue_error_check CHECK (last_error IS NULL OR char_length(last_error) <= 200)
);
CREATE INDEX IF NOT EXISTS case_review_queue_due_idx ON public.case_review_queue (due_at) WHERE state IN ('queued', 'running');
COMMENT ON TABLE public.case_review_queue IS
  'Cases waiting for the reviewer (one row per case, debounced). Migration 225.';

ALTER TABLE public.case_review_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_review_drafts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.case_review_drafts FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.case_review_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_review_queue FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.case_review_queue FROM PUBLIC, anon, authenticated, service_role;

-- ---------- settings ----------

CREATE OR REPLACE FUNCTION public.case_review_settings(p_account uuid)
RETURNS TABLE (review_enabled boolean, review_send_to_model boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(s.review_enabled, false), coalesce(s.review_send_to_model, false)
    FROM (SELECT 1) one LEFT JOIN public.case_account_settings s ON s.account_id = p_account
$$;

CREATE OR REPLACE FUNCTION public.case_settings_set_review(p_actor uuid, p_account uuid, p_enabled boolean,
  p_send_to_model boolean)
RETURNS TABLE (review_enabled boolean, review_send_to_model boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor), '') NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the case settings of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_enabled IS NULL OR p_send_to_model IS NULL OR (p_send_to_model AND NOT p_enabled) THEN
    RAISE EXCEPTION 'SETTING_INVALID: the model needs the reviewer on'
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  INSERT INTO public.case_account_settings AS s (account_id, review_enabled, review_send_to_model, updated_at, updated_by)
  VALUES (p_account, p_enabled, p_send_to_model, now(), p_actor)
  ON CONFLICT (account_id) DO UPDATE
    SET review_enabled = EXCLUDED.review_enabled, review_send_to_model = EXCLUDED.review_send_to_model,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  RETURN QUERY SELECT * FROM public.case_review_settings(p_account);
END;
$$;

-- ---------- queue ----------

CREATE OR REPLACE FUNCTION public.case_review_enqueue(p_case uuid, p_delay interval DEFAULT interval '60 seconds')
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT c.account_id INTO v_account FROM public.cases c WHERE c.id = p_case AND c.closed_at IS NULL;
  IF v_account IS NULL OR NOT (SELECT s.review_enabled FROM public.case_review_settings(v_account) s) THEN
    RETURN;
  END IF;
  INSERT INTO public.case_review_queue AS q (case_id, account_id, due_at)
  VALUES (p_case, v_account, now() + p_delay)
  ON CONFLICT (case_id) DO UPDATE
    -- Debounce: a later pass pushes the due time back; a running review
    -- is left alone and re-queued when it finishes.
    SET due_at = CASE WHEN q.state = 'running' THEN q.due_at ELSE EXCLUDED.due_at END,
        state = CASE WHEN q.state = 'running' THEN q.state ELSE 'queued' END,
        attempts = CASE WHEN q.state = 'running' THEN q.attempts ELSE 0 END,
        last_error = CASE WHEN q.state = 'running' THEN q.last_error ELSE NULL END,
        updated_at = now();
END;
$$;

-- A file becoming 'passed' queues its case. Never fails the file write.
CREATE OR REPLACE FUNCTION public.case_review_on_file_passed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'passed' AND OLD.status IS DISTINCT FROM 'passed' THEN
    BEGIN
      PERFORM public.case_review_enqueue(NEW.case_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'case_review_on_file_passed: % (%)', SQLERRM, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS case_review_on_file_passed ON public.case_document_files;
CREATE TRIGGER case_review_on_file_passed AFTER UPDATE OF status ON public.case_document_files
  FOR EACH ROW EXECUTE FUNCTION public.case_review_on_file_passed();

CREATE OR REPLACE FUNCTION public.case_review_claim(p_limit integer DEFAULT 20)
RETURNS TABLE (case_id uuid, account_id uuid, attempts integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT q.case_id FROM public.case_review_queue q
     WHERE (q.state = 'queued' AND q.due_at <= now())
        OR (q.state = 'running' AND q.claimed_at < now() - interval '15 minutes')
     ORDER BY q.due_at
     LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
     FOR UPDATE SKIP LOCKED)
  UPDATE public.case_review_queue q
     SET state = 'running', claimed_at = now(), attempts = q.attempts + 1, updated_at = now()
    FROM due WHERE q.case_id = due.case_id
  RETURNING q.case_id, q.account_id, q.attempts;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_review_finish(p_case uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.case_review_queue q
     SET state = CASE WHEN p_ok THEN 'done' WHEN q.attempts >= 3 THEN 'failed' ELSE 'queued' END,
         due_at = CASE WHEN p_ok OR q.attempts >= 3 THEN q.due_at ELSE now() + interval '5 minutes' END,
         claimed_at = NULL, last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 200) END, updated_at = now()
   WHERE q.case_id = p_case AND q.state = 'running'
$$;

-- ---------- drafts ----------

CREATE OR REPLACE FUNCTION public.case_review_draft_create(p_case uuid, p_body jsonb, p_source text, p_input_hash text)
RETURNS TABLE (draft_id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  c    public.cases%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  SELECT d.id INTO v_id FROM public.case_review_drafts d
   WHERE d.case_id = p_case AND d.status = 'pending' AND d.input_hash = p_input_hash;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;
  UPDATE public.case_review_drafts d SET status = 'superseded' WHERE d.case_id = p_case AND d.status = 'pending';
  INSERT INTO public.case_review_drafts (account_id, case_id, body, narrative_source, input_hash)
  VALUES (c.account_id, p_case, p_body, p_source, p_input_hash)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, true;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_review_drafts_list(p_actor uuid, p_case uuid)
RETURNS TABLE (id uuid, status text, narrative_source text, body jsonb, created_at timestamptz,
  decided_by uuid, decided_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF NOT coalesce(public.case_can_read(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  RETURN QUERY
  SELECT d.id, d.status, d.narrative_source, d.body, d.created_at, d.decided_by, d.decided_at
    FROM public.case_review_drafts d
   WHERE d.case_id = p_case
   ORDER BY d.created_at DESC
   LIMIT 20;
END;
$$;

CREATE OR REPLACE FUNCTION public.case_review_draft_decide(p_actor uuid, p_case uuid, p_draft uuid, p_approve boolean)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  d public.case_review_drafts%ROWTYPE;
BEGIN
  IF NOT coalesce(public.case_can_read(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF NOT coalesce(public.case_can_write(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not decide drafts of %', p_actor, p_case
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'approve must be true or false' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  SELECT * INTO d FROM public.case_review_drafts x WHERE x.id = p_draft AND x.case_id = p_case FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft % not found', p_draft USING ERRCODE = 'no_data_found', HINT = 'DRAFT_NOT_FOUND';
  END IF;
  IF d.status <> 'pending' THEN
    RAISE EXCEPTION 'draft % is %', p_draft, d.status USING ERRCODE = 'check_violation', HINT = 'ALREADY_DECIDED';
  END IF;
  UPDATE public.case_review_drafts x
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_by = p_actor, decided_at = now()
   WHERE x.id = p_draft;
  RETURN CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
END;
$$;

REVOKE ALL ON FUNCTION public.case_review_settings(uuid), public.case_settings_set_review(uuid, uuid, boolean, boolean),
  public.case_review_enqueue(uuid, interval), public.case_review_on_file_passed(),
  public.case_review_claim(integer), public.case_review_finish(uuid, boolean, text),
  public.case_review_draft_create(uuid, jsonb, text, text), public.case_review_drafts_list(uuid, uuid),
  public.case_review_draft_decide(uuid, uuid, uuid, boolean)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.case_review_settings(uuid), public.case_settings_set_review(uuid, uuid, boolean, boolean),
  public.case_review_claim(integer), public.case_review_finish(uuid, boolean, text),
  public.case_review_draft_create(uuid, jsonb, text, text), public.case_review_drafts_list(uuid, uuid),
  public.case_review_draft_decide(uuid, uuid, uuid, boolean)
TO service_role;
