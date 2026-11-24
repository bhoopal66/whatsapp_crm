-- ============================================================
-- 297_case_doc_request_once.sql — a document request goes out once
--
-- Two people pressing "Request documents" on a case within a minute sent
-- the customer the same WhatsApp request twice: case_doc_request_begin
-- (123) locks the case for its own statement only, and the documents are
-- marked after the send. The send now CLAIMS the request at begin: a row
-- in case_doc_requests, written under the case lock, and a second claim
-- within 10 minutes is refused (HINT REQUESTED_RECENTLY, DETAIL who and
-- when) unless the person says to send again (p_force). A send that
-- certainly did not go out releases its claim; one whose outcome is
-- unknown keeps it.
--
-- Only p_claim refuses and claims: the macro preview (186) and a build
-- from before 297 call with two arguments and are answered as before.
-- Such a build claims nothing, so case_doc_mark_requested records its
-- request after the send.
--
-- Replaces 123's case_doc_request_begin(uuid, uuid), dropped because two
-- overloads are ambiguous to PostgREST, and restates
-- case_doc_mark_requested (123). Re-running 123 undoes both: re-run this
-- file after it.
-- Re-runnable.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. The requests ----------

CREATE TABLE IF NOT EXISTS public.case_doc_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_doc_requests_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS case_doc_requests_case_idx
  ON public.case_doc_requests (case_id, requested_at DESC);
COMMENT ON TABLE public.case_doc_requests IS
  'Each missing-documents request of a case: claimed before the send, so a second one within 10 minutes is refused. Written by case_doc_request_begin, case_doc_mark_requested and case_doc_request_release alone. Migration 297.';

ALTER TABLE public.case_doc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_doc_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_doc_requests_select ON public.case_doc_requests;
CREATE POLICY case_doc_requests_select ON public.case_doc_requests FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

REVOKE ALL ON public.case_doc_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_doc_requests TO authenticated, service_role;

-- ---------- 2. Begin: what to ask for, and the claim ----------

-- One block, so one transaction: created by itself, a function is
-- EXECUTE for anon and authenticated until its REVOKE, and a call of the
-- old build between the DROP and the CREATE would find nothing.
DO $do$ BEGIN
DROP FUNCTION IF EXISTS public.case_doc_request_begin(uuid, uuid);

-- As 123's, plus request_id: the claim, NULL without p_claim and when
-- nothing is missing.
CREATE OR REPLACE FUNCTION public.case_doc_request_begin(p_case uuid, p_actor uuid,
  p_force boolean DEFAULT false, p_claim boolean DEFAULT false)
RETURNS TABLE (account_id uuid, group_id uuid, submission_ref text, bank_name text,
               doc_keys text[], doc_labels text[], request_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  c      public.cases%ROWTYPE;
  v_last public.case_doc_requests%ROWTYPE;
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  account_id := c.account_id;
  group_id := c.group_id;
  submission_ref := (SELECT g.submission_ref FROM public.submission_groups g WHERE g.id = c.group_id);
  bank_name := (SELECT coalesce(nullif(b.name, ''), b.code) FROM public.case_banks b
                 WHERE b.account_id = c.account_id AND b.code = c.bank_code);
  SELECT coalesce(array_agg(r.doc_key ORDER BY r.position, r.doc_key), '{}'::text[]),
         coalesce(array_agg(r.label ORDER BY r.position, r.doc_key), '{}'::text[])
    INTO doc_keys, doc_labels
    FROM public.case_doc_requirements r
   WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
     AND lower(btrim(r.product)) = lower(btrim(c.product))
     AND NOT EXISTS (SELECT 1 FROM public.case_documents d
                      WHERE d.case_id = c.id AND d.doc_key = r.doc_key AND d.status = 'received');

  IF p_claim IS TRUE AND cardinality(doc_keys) > 0 THEN
    IF p_force IS NOT TRUE THEN
      SELECT * INTO v_last FROM public.case_doc_requests q
       WHERE q.case_id = p_case AND q.requested_at > now() - interval '10 minutes'
       ORDER BY q.requested_at DESC LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'case %: its documents were requested less than 10 minutes ago', p_case
          USING ERRCODE = 'check_violation', HINT = 'REQUESTED_RECENTLY',
                DETAIL = jsonb_build_object('by', v_last.requested_by, 'at', v_last.requested_at)::text;
      END IF;
    END IF;
    INSERT INTO public.case_doc_requests AS q (case_id, account_id, requested_by)
    VALUES (p_case, c.account_id, p_actor)
    RETURNING q.id INTO request_id;
  END IF;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.case_doc_request_begin(uuid, uuid, boolean, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.case_doc_request_begin(uuid, uuid, boolean, boolean) TO service_role;
END $do$;

-- ---------- 3. Mark: as 123, and the request of a build without a claim ----------

CREATE OR REPLACE FUNCTION public.case_doc_mark_requested(p_case uuid, p_actor uuid, p_doc_keys text[],
  p_now timestamptz DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c   public.cases%ROWTYPE;
  v_n integer;
BEGIN
  PERFORM public.case_tools_lock_for_write(p_case, p_actor);
  SELECT * INTO c FROM public.cases x WHERE x.id = p_case;
  INSERT INTO public.case_documents AS d (case_id, account_id, doc_key, status, file_ref, updated_by, updated_at)
  SELECT p_case, c.account_id, r.doc_key, 'requested', NULL, p_actor, coalesce(p_now, now())
    FROM public.case_doc_requirements r
   WHERE r.account_id = c.account_id AND r.bank_code = c.bank_code
     AND lower(btrim(r.product)) = lower(btrim(c.product)) AND r.doc_key = ANY (p_doc_keys)
  ON CONFLICT ON CONSTRAINT case_documents_pkey DO UPDATE
    SET status = 'requested', file_ref = NULL, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
    WHERE d.status <> 'received';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.case_doc_requests (case_id, account_id, requested_by)
  SELECT p_case, c.account_id, p_actor
   WHERE NOT EXISTS (SELECT 1 FROM public.case_doc_requests q
                      WHERE q.case_id = p_case AND q.requested_by = p_actor
                        AND q.requested_at > now() - interval '10 minutes');
  RETURN v_n;
END;
$$;

-- ---------- 4. Release: the send did not go out ----------

-- Deletes the actor's own claim on that case; true when it was there.
-- Asks no write right: someone taken off the case during their own send
-- must still be able to take the claim back.
DO $do$ BEGIN
CREATE OR REPLACE FUNCTION public.case_doc_request_release(p_case uuid, p_actor uuid, p_request uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.case_doc_requests q
   WHERE q.id = p_request AND q.case_id = p_case AND q.requested_by = p_actor;
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.case_doc_request_release(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.case_doc_request_release(uuid, uuid, uuid) TO service_role;
END $do$;

-- ---------- 5. Privileges ----------

-- Replaced in place, so it kept 123's; said again for a re-run.
REVOKE ALL ON FUNCTION public.case_doc_mark_requested(uuid, uuid, text[], timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.case_doc_mark_requested(uuid, uuid, text[], timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
