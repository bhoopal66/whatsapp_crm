-- =============================================================================
-- 184 - Case files for Compass: API download, status, case.file_ready webhook
-- =============================================================================
--
-- Requires 181 (case files, case_file_ready), 182 (builds, download audit)
-- and 134 (webhook_enqueue). Nothing changes unless Compass (the submission
-- tracker, an API key holder) calls the new functions through the v1 API or
-- an endpoint subscribes to case.file_ready.
--
-- WHO case_file_downloads.api_key_id (-> api_keys ON DELETE RESTRICT): a
--   download made by an API key. Exactly one of (actor, api_key_id) is set
--   (case_file_downloads_one_who). Keys are revoked, never deleted, so the
--   audit row keeps its reference: deleting a key that has downloaded is
--   refused by the FK itself. The append-only guard of 182 is unchanged.
-- DOWNLOAD case_build_download_record_api(api_key, account, submission_ref,
--   now) -> (download_id, object_path, sha256, version): the case is found
--   through its submission group (submission_groups.submission_ref in that
--   account -> cases.group_id). An unknown ref, a ref of another account,
--   or a key that is not a live key of that account is FILE_NOT_FOUND (no
--   existence oracle); no ready build BUILD_STALE. One audit row with
--   api_key_id, written before the URL is signed; 182's
--   case_file_download_issued flips it.
-- STATUS case_file_status_api(account, submission_ref) -> jsonb
--   { ready, documents: [{docKey, required, status}], build: {version,
--   merged, sha256, builtAt, manifest: [{docKey, renamedName, pages,
--   sha256}]} | null }. A document is 'passed' when it has a passed file
--   with no failed file of a higher version (181's ready rule, so ready
--   means every required document is 'passed'), else 'checking' with a file
--   pending checks, else 'failed' with a failed file, else 'missing'.
--   FILE_NOT_FOUND as above.
-- WEBHOOK case.file_ready { submissionRef, caseId, ready: true } through
--   webhook_enqueue (only when an active endpoint subscribes), when a file
--   turning 'passed' makes the case File ready and it was not before. "Was
--   not before" is a latch, case_file_ready_marks: set when a pass finds the
--   case ready, cleared when any other status change finds it not ready.
--   passed -> superseded is skipped: check_result supersedes the previous
--   pass of a doc_key just before passing the new one, so a re-upload of a
--   ready case is not a second event. A case with no submission group (a
--   lead) is latched but sends nothing: Compass has no ref for it. Fires
--   whether or not the account is managed externally (it tells Compass).
--   Failures are WARNINGs and never fail the check result.
--
-- webhook_endpoints.events is a free text[] (028): no CHECK to extend.
-- 'case.file_ready' joins OUTBOX_EVENTS in src/lib/webhooks/events.ts.
--
-- Re-runnable. Apply as a superuser or BYPASSRLS role (the tables force RLS
-- and the functions write them as their owner).
-- =============================================================================

-- ---------- 0. Refusal scan (before any DDL) ----------

DO $$
BEGIN
  PERFORM set_config('wacrm.m184_refused', '', false);
  IF EXISTS (SELECT 1 FROM public.case_file_downloads d WHERE d.actor IS NULL
               AND NOT (to_jsonb(d) ? 'api_key_id' AND (to_jsonb(d) ->> 'api_key_id') IS NOT NULL)) THEN
    PERFORM set_config('wacrm.m184_refused', 'case_file_downloads has rows with no actor', false);
    PERFORM set_config('default_transaction_read_only', 'on', false);
  END IF;
END $$;

DO $$ BEGIN
  IF current_setting('wacrm.m184_refused', true) <> '' THEN
    RAISE EXCEPTION '184 refused, nothing changed (this session is now read-only; reconnect): %',
      current_setting('wacrm.m184_refused')
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

-- ---------- 1. Who downloaded ----------

ALTER TABLE public.case_file_downloads ADD COLUMN IF NOT EXISTS api_key_id uuid NULL;

-- A constraint left by an earlier draft with another ON DELETE is replaced.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_file_downloads_api_key_fkey'
               AND conrelid = 'public.case_file_downloads'::regclass AND confdeltype <> 'r') THEN
    ALTER TABLE public.case_file_downloads DROP CONSTRAINT case_file_downloads_api_key_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_file_downloads_api_key_fkey'
                   AND conrelid = 'public.case_file_downloads'::regclass) THEN
    ALTER TABLE public.case_file_downloads ADD CONSTRAINT case_file_downloads_api_key_fkey
      FOREIGN KEY (api_key_id) REFERENCES public.api_keys (id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE public.case_file_downloads DROP CONSTRAINT IF EXISTS case_file_downloads_one_who;
ALTER TABLE public.case_file_downloads ADD CONSTRAINT case_file_downloads_one_who
  CHECK ((actor IS NULL) <> (api_key_id IS NULL));

CREATE INDEX IF NOT EXISTS case_file_downloads_api_key_idx
  ON public.case_file_downloads (api_key_id) WHERE api_key_id IS NOT NULL;

COMMENT ON COLUMN public.case_file_downloads.api_key_id IS
  'The API key that downloaded (Compass); exactly one of actor and api_key_id is set. Migration 184.';

-- ---------- 2. The case of a submission ref ----------

-- The case of p_submission_ref in p_account, or NULL. Not executable by any
-- API role.
CREATE OR REPLACE FUNCTION public.case_by_submission_ref(p_account uuid, p_submission_ref text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id
    FROM public.submission_groups g
    JOIN public.cases c ON c.group_id = g.id AND c.account_id = g.account_id
   WHERE g.account_id = p_account AND g.submission_ref = p_submission_ref
$$;

-- ---------- 3. API download ----------

CREATE OR REPLACE FUNCTION public.case_build_download_record_api(p_api_key uuid, p_account uuid,
  p_submission_ref text, p_now timestamptz)
RETURNS TABLE (download_id uuid, object_path text, sha256 text, version integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now  timestamptz := coalesce(p_now, now());
  v_case uuid;
  b      public.case_file_builds%ROWTYPE;
  v_id   uuid;
BEGIN
  v_case := public.case_by_submission_ref(p_account, p_submission_ref);
  IF v_case IS NULL OR p_api_key IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.api_keys k
                     WHERE k.id = p_api_key AND k.account_id = p_account AND k.revoked_at IS NULL
                       AND (k.expires_at IS NULL OR k.expires_at > v_now)) THEN
    RAISE EXCEPTION 'case file % not found', p_submission_ref USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;
  SELECT * INTO b FROM public.case_file_builds x WHERE x.case_id = v_case AND x.status = 'ready';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case file % has no current build', p_submission_ref
      USING ERRCODE = 'check_violation', HINT = 'BUILD_STALE';
  END IF;
  INSERT INTO public.case_file_downloads (account_id, case_id, actor, api_key_id, build_id, at)
  VALUES (b.account_id, b.case_id, NULL, p_api_key, b.build_id, v_now)
  RETURNING case_file_downloads.id INTO v_id;
  RETURN QUERY SELECT v_id, b.object_path, b.sha256, b.version;
END;
$$;

-- ---------- 4. API status ----------

CREATE OR REPLACE FUNCTION public.case_file_status_api(p_account uuid, p_submission_ref text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_case  uuid;
  v_docs  jsonb;
  v_build jsonb;
BEGIN
  v_case := public.case_by_submission_ref(p_account, p_submission_ref);
  IF v_case IS NULL THEN
    RAISE EXCEPTION 'case file % not found', p_submission_ref USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'docKey', r.doc_key,
           'required', r.required,
           'status', CASE
             WHEN EXISTS (SELECT 1 FROM public.case_document_files f
                           WHERE f.case_id = v_case AND f.doc_key = r.doc_key AND f.status = 'passed'
                             AND NOT EXISTS (SELECT 1 FROM public.case_document_files g
                                              WHERE g.case_id = f.case_id AND g.doc_key = f.doc_key
                                                AND g.status = 'failed' AND g.version > f.version))
               THEN 'passed'
             WHEN EXISTS (SELECT 1 FROM public.case_document_files f
                           WHERE f.case_id = v_case AND f.doc_key = r.doc_key AND f.status = 'pending_checks')
               THEN 'checking'
             WHEN EXISTS (SELECT 1 FROM public.case_document_files f
                           WHERE f.case_id = v_case AND f.doc_key = r.doc_key AND f.status = 'failed')
               THEN 'failed'
             ELSE 'missing' END)
         ORDER BY r.position, r.doc_key), '[]'::jsonb)
    INTO v_docs
    FROM public.case_file_spec_rows(v_case) r;

  SELECT jsonb_build_object(
           'version', b.version,
           'merged', b.merged,
           'sha256', b.sha256,
           'builtAt', b.built_at,
           'manifest', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                 'docKey', e ->> 'doc_key',
                                 'renamedName', e ->> 'renamed_name',
                                 'pages', e -> 'pages',
                                 'sha256', e ->> 'sha256')
                               ORDER BY (e ->> 'position')::int, t.ord), '[]'::jsonb)
                          FROM jsonb_array_elements(b.manifest) WITH ORDINALITY AS t(e, ord)))
    INTO v_build
    FROM public.case_file_builds b
   WHERE b.case_id = v_case AND b.status = 'ready';

  RETURN jsonb_build_object('ready', public.case_file_ready(v_case), 'documents', v_docs,
                            'build', coalesce(v_build, 'null'::jsonb));
END;
$$;

-- ---------- 5. case.file_ready ----------

CREATE TABLE IF NOT EXISTS public.case_file_ready_marks (
  case_id    uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  marked_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_file_ready_marks_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.case_file_ready_marks IS
  'A case last seen File ready by the case.file_ready latch; the event is queued only when a pass inserts the row. Migration 184.';

CREATE OR REPLACE FUNCTION public.case_document_files_ready_webhook_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_ref     text;
  v_marked  uuid;
BEGIN
  BEGIN
    IF public.case_file_ready(NEW.case_id) THEN
      IF NEW.status = 'passed' THEN
        INSERT INTO public.case_file_ready_marks (case_id, account_id)
        VALUES (NEW.case_id, NEW.account_id)
        ON CONFLICT (case_id) DO NOTHING
        RETURNING case_file_ready_marks.case_id INTO v_marked;
        IF v_marked IS NOT NULL THEN
          SELECT c.account_id, g.submission_ref INTO v_account, v_ref
            FROM public.cases c LEFT JOIN public.submission_groups g ON g.id = c.group_id
           WHERE c.id = NEW.case_id;
          IF v_ref IS NOT NULL THEN
            PERFORM public.webhook_enqueue(v_account, 'case.file_ready', jsonb_build_object(
              'submissionRef', v_ref, 'caseId', NEW.case_id, 'ready', true));
          END IF;
        END IF;
      END IF;
    ELSE
      DELETE FROM public.case_file_ready_marks m WHERE m.case_id = NEW.case_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook case.file_ready for case % not queued: % (%)', NEW.case_id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_document_files_ready_webhook ON public.case_document_files;
CREATE TRIGGER case_document_files_ready_webhook
  AFTER UPDATE OF status ON public.case_document_files
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status
                     AND NOT (OLD.status = 'passed' AND NEW.status = 'superseded'))
  EXECUTE FUNCTION public.case_document_files_ready_webhook_hook();

-- Cases already File ready are latched, so the first re-upload after this
-- migration is not reported as a new File ready.
INSERT INTO public.case_file_ready_marks (case_id, account_id)
SELECT c.id, c.account_id
  FROM public.cases c
 WHERE EXISTS (SELECT 1 FROM public.case_document_files f WHERE f.case_id = c.id AND f.status = 'passed')
   AND public.case_file_ready(c.id)
ON CONFLICT (case_id) DO NOTHING;

-- ---------- 6. Row level security and privileges ----------

ALTER TABLE public.case_file_ready_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_ready_marks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.case_file_ready_marks FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.case_by_submission_ref(uuid, text),
  public.case_build_download_record_api(uuid, uuid, text, timestamptz),
  public.case_file_status_api(uuid, text),
  public.case_document_files_ready_webhook_hook()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_build_download_record_api(uuid, uuid, text, timestamptz),
  public.case_file_status_api(uuid, text)
  TO service_role;
