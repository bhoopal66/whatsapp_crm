-- =============================================================================
-- 182 - Case file builds and download audit (ported from the outside
--       package's modules 021b, 021d and 021e)
-- =============================================================================
--
-- Requires 181 (case_document_files, case_file_spec_rows, case_file_ready).
--
-- BUILDS case_file_builds: one row per assembly of a File-ready case's
--   passed documents into one PDF stored in the 'case-files' bucket (180).
--   version counts 1, 2, ... per case. merged = the spec's merged flag at
--   build time: a merged build's PDF is the cover/index plus every document
--   (object_path 'cases/<case_id>/bundle-<sha256>.pdf'); a separate build's
--   PDF is the cover/index only ('cases/<case_id>/index-<sha256>.pdf').
--   sha256 is that one PDF's. The path is content-addressed, so two builders
--   never write one object with different bytes.
--   manifest: [{position, doc_key, file_id, renamed_name, sha256, pages}] in
--   spec position order, one entry per REQUIRED spec document, each the
--   case's current passed file. sha256 is the file's bytes as hashed by the
--   builder: no file row stores a hash, so it is the one manifest field the
--   record cannot re-derive (it must be 64 hex characters); every other
--   field must equal the current passed files exactly.
--   Append-only: the only change is status 'ready' -> 'superseded'; never
--   deleted. At most one 'ready' build per case.
-- WRITE (service role, which asserts the actor; NULL actor = the assembly
--   job, recorded as built_system 'system:files'):
--   case_file_build_gate -> the next version (no lock, no write);
--   case_file_build_reserve -> (version, reservation_id), BEFORE any bytes
--     are stored: locks the case, runs the gate, allocates a version above
--     every recorded build and every live reservation of the case, live
--     for 10 minutes;
--   case_file_build_record -> (build_id, version): consumes the
--     reservation, supersedes the previous ready build. Refused BUILD_INVALID
--     when the manifest is not the current passed files, the merged flag not
--     the spec's, the path not the one for the sha256, or the reservation
--     unknown, of another case or actor, used, expired, or not newer than a
--     recorded build (a concurrent builder that lost the race).
--   Who builds: case_role coordinator, team_lead, admin, super_admin, or
--   the NULL actor; anyone else NOT_ALLOWED. Open case (CASE_CLOSED) and
--   case_file_ready (FILE_NOT_READY).
-- READ case_file_build_current -> the ready build, or no row; anyone who
--   can read the case (case_can_read, else NOT_ALLOWED) and the NULL actor.
-- STALE when a file stops being 'passed' (a newer pass superseded it, or it
--   was reclassified), every ready build whose manifest lists it becomes
--   'superseded' (trigger), so a stale PDF is never current.
-- DOWNLOADS case_file_downloads: one audit row per download of a file or of
--   the ready build, written before the signed URL is minted
--   (url_issued false); case_file_download_issued flips it once the URL
--   exists, so a signer failure leaves false. Append-only except that one
--   flip. A caller who cannot read the case gets FILE_NOT_FOUND (no
--   existence oracle); a case with no ready build BUILD_STALE.
--
-- Lock order (181's): the case FOR NO KEY UPDATE, then file / build /
-- reservation rows.
--
-- Refusals (hint): NOT_ALLOWED, CASE_NOT_FOUND, CASE_CLOSED, FILE_NOT_READY,
-- BUILD_INVALID, BUILD_STALE, FILE_NOT_FOUND.
--
-- Re-runnable. Apply as a superuser or BYPASSRLS role (the tables force RLS
-- and the functions write them as their owner).
-- =============================================================================

-- ---------- 1. Builds ----------

CREATE TABLE IF NOT EXISTS public.case_file_builds (
  build_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL,
  case_id      uuid NOT NULL,
  version      integer NOT NULL,
  built_at     timestamptz NOT NULL DEFAULT now(),
  built_by     uuid NULL,
  built_system text NULL,
  merged       boolean NOT NULL,
  manifest     jsonb NOT NULL,
  object_path  text NOT NULL,
  sha256       text NOT NULL,
  status       text NOT NULL DEFAULT 'ready',
  CONSTRAINT case_file_builds_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_file_builds_version UNIQUE (case_id, version),
  CONSTRAINT case_file_builds_version_check CHECK (version > 0),
  CONSTRAINT case_file_builds_system_check CHECK (built_system IS NULL OR built_system IN ('system:files')),
  CONSTRAINT case_file_builds_one_builder CHECK ((built_by IS NULL) <> (built_system IS NULL)),
  CONSTRAINT case_file_builds_manifest_check
    CHECK (jsonb_typeof(manifest) = 'array' AND jsonb_array_length(manifest) > 0),
  CONSTRAINT case_file_builds_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT case_file_builds_path_check
    CHECK (object_path = 'cases/' || case_id::text || CASE WHEN merged THEN '/bundle-' ELSE '/index-' END
                         || sha256 || '.pdf'),
  CONSTRAINT case_file_builds_status_check CHECK (status IN ('ready', 'superseded'))
);
CREATE UNIQUE INDEX IF NOT EXISTS case_file_builds_one_ready
  ON public.case_file_builds (case_id) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS case_file_builds_manifest_idx
  ON public.case_file_builds USING gin (manifest jsonb_path_ops);

COMMENT ON TABLE public.case_file_builds IS
  'One assembly of a File-ready case into one PDF in the case-files bucket. Append-only except ready -> superseded; at most one ready per case. Written only through case_file_build_record. Migration 182.';

CREATE OR REPLACE FUNCTION public.case_file_builds_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
     OR NOT (OLD.status = 'ready' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'case_file_builds: only ready -> superseded changes'
      USING ERRCODE = 'insufficient_privilege', HINT = 'BUILD_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS case_file_builds_guard ON public.case_file_builds;
CREATE TRIGGER case_file_builds_guard
  BEFORE UPDATE ON public.case_file_builds
  FOR EACH ROW EXECUTE FUNCTION public.case_file_builds_guard();
DROP TRIGGER IF EXISTS case_file_builds_no_delete ON public.case_file_builds;
CREATE TRIGGER case_file_builds_no_delete
  BEFORE DELETE ON public.case_file_builds
  FOR EACH ROW EXECUTE FUNCTION public.case_append_only();
DROP TRIGGER IF EXISTS case_file_builds_no_truncate ON public.case_file_builds;
CREATE TRIGGER case_file_builds_no_truncate
  BEFORE TRUNCATE ON public.case_file_builds
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- ---------- 2. Version reservations ----------

CREATE TABLE IF NOT EXISTS public.case_file_build_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL,
  case_id        uuid NOT NULL,
  actor          uuid NULL,
  version        integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz NULL,
  CONSTRAINT case_file_build_reservations_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_file_build_reservations_version_check CHECK (version > 0),
  CONSTRAINT case_file_build_reservations_ttl_check CHECK (expires_at = created_at + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS case_file_build_reservations_case_idx
  ON public.case_file_build_reservations (case_id, version);

COMMENT ON TABLE public.case_file_build_reservations IS
  'A build version reserved before the builder stores any bytes, live for 10 minutes, consumed by case_file_build_record. NULL actor = the assembly job. Migration 182.';

-- ---------- 3. Gate -> next version (no lock, no write) ----------

CREATE OR REPLACE FUNCTION public.case_file_build_gate(p_actor uuid, p_case uuid)
RETURNS integer
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
  IF p_actor IS NOT NULL
     AND NOT coalesce(public.case_role(p_case, p_actor) IN ('coordinator', 'team_lead', 'admin', 'super_admin'), false) THEN
    RAISE EXCEPTION 'only the coordinator, the team lead, an admin or the owner may build the case file'
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF c.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'case % is closed', p_case USING ERRCODE = 'check_violation', HINT = 'CASE_CLOSED';
  END IF;
  IF NOT public.case_file_ready(p_case) THEN
    RAISE EXCEPTION 'case % is not File ready', p_case USING ERRCODE = 'check_violation', HINT = 'FILE_NOT_READY';
  END IF;
  RETURN (SELECT coalesce(max(b.version), 0) + 1 FROM public.case_file_builds b WHERE b.case_id = p_case);
END;
$$;

-- ---------- 4. Reserve (locks the case) ----------

CREATE OR REPLACE FUNCTION public.case_file_build_reserve(p_actor uuid, p_case uuid, p_now timestamptz)
RETURNS TABLE (version integer, reservation_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_account uuid;
  v_version integer;
  v_id uuid;
BEGIN
  SELECT x.account_id INTO v_account FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  PERFORM public.case_file_build_gate(p_actor, p_case);
  SELECT greatest(
           coalesce((SELECT max(b.version) FROM public.case_file_builds b WHERE b.case_id = p_case), 0),
           coalesce((SELECT max(r.version) FROM public.case_file_build_reservations r
                      WHERE r.case_id = p_case AND r.used_at IS NULL AND r.expires_at > v_now), 0)) + 1
    INTO v_version;
  INSERT INTO public.case_file_build_reservations (account_id, case_id, actor, version, created_at, expires_at)
  VALUES (v_account, p_case, p_actor, v_version, v_now, v_now + interval '10 minutes')
  RETURNING case_file_build_reservations.reservation_id INTO v_id;
  RETURN QUERY SELECT v_version, v_id;
END;
$$;

-- ---------- 5. Record ----------

CREATE OR REPLACE FUNCTION public.case_file_build_record(p_actor uuid, p_case uuid, p_reservation uuid,
  p_manifest jsonb, p_merged boolean, p_object_path text, p_sha256 text, p_now timestamptz)
RETURNS TABLE (build_id uuid, version integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := coalesce(p_now, now());
  v_account uuid;
  v_spec_merged boolean;
  v_expected jsonb;
  v_given jsonb;
  v_shape_ok boolean;
  v_path text;
  v_id uuid;
  rs public.case_file_build_reservations%ROWTYPE;
BEGIN
  SELECT x.account_id INTO v_account FROM public.cases x WHERE x.id = p_case FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  PERFORM public.case_file_build_gate(p_actor, p_case);

  SELECT * INTO rs FROM public.case_file_build_reservations r WHERE r.reservation_id = p_reservation FOR UPDATE;
  IF NOT FOUND OR rs.case_id IS DISTINCT FROM p_case OR rs.actor IS DISTINCT FROM p_actor
     OR rs.used_at IS NOT NULL OR rs.expires_at <= v_now
     OR EXISTS (SELECT 1 FROM public.case_file_builds b WHERE b.case_id = p_case AND b.version >= rs.version) THEN
    RAISE EXCEPTION 'build reservation % is not a live reservation of case % for this actor', p_reservation, p_case
      USING ERRCODE = 'check_violation', HINT = 'BUILD_INVALID';
  END IF;

  SELECT coalesce(bool_or(r.merged), false) INTO v_spec_merged FROM public.case_file_spec_rows(p_case) r;
  -- The manifest the current passed files give, without the builder's sha256.
  SELECT coalesce(jsonb_agg(jsonb_build_object('position', r.position, 'doc_key', r.doc_key,
                                               'file_id', f.id::text, 'renamed_name', f.renamed_name,
                                               'pages', f.pages)
                            ORDER BY r.position, r.doc_key), '[]'::jsonb)
    INTO v_expected
    FROM public.case_file_spec_rows(p_case) r
    JOIN public.case_document_files f ON f.case_id = p_case AND f.doc_key = r.doc_key AND f.status = 'passed'
   WHERE r.required;
  IF jsonb_typeof(p_manifest) = 'array' THEN
    SELECT coalesce(bool_and(jsonb_typeof(t.e) = 'object'
                             AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(t.e) k)
                                 = ARRAY['doc_key', 'file_id', 'pages', 'position', 'renamed_name', 'sha256']
                             AND jsonb_typeof(t.e -> 'sha256') = 'string'
                             AND (t.e ->> 'sha256') ~ '^[0-9a-f]{64}$'), false),
           coalesce(jsonb_agg(t.e - 'sha256' ORDER BY t.ord), '[]'::jsonb)
      INTO v_shape_ok, v_given
      FROM jsonb_array_elements(p_manifest) WITH ORDINALITY AS t(e, ord);
  ELSE
    v_shape_ok := false;
  END IF;

  -- (Computed apart: a CASE ... THEN inside an IF condition ends the condition.)
  v_path := 'cases/' || p_case::text || (CASE WHEN p_merged THEN '/bundle-' ELSE '/index-' END) || p_sha256 || '.pdf';
  IF NOT v_shape_ok OR v_given IS DISTINCT FROM v_expected
     OR p_merged IS NULL OR p_merged IS DISTINCT FROM v_spec_merged
     OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
     OR p_object_path IS DISTINCT FROM v_path THEN
    RAISE EXCEPTION 'build of case % does not match its current passed files, spec or content-addressed path', p_case
      USING ERRCODE = 'check_violation', HINT = 'BUILD_INVALID';
  END IF;

  UPDATE public.case_file_build_reservations r SET used_at = v_now WHERE r.reservation_id = rs.reservation_id;
  UPDATE public.case_file_builds b SET status = 'superseded' WHERE b.case_id = p_case AND b.status = 'ready';
  INSERT INTO public.case_file_builds (account_id, case_id, version, built_at, built_by, built_system, merged,
                                       manifest, object_path, sha256)
  VALUES (v_account, p_case, rs.version, v_now, p_actor,
          CASE WHEN p_actor IS NULL THEN 'system:files' END,
          p_merged, p_manifest, p_object_path, p_sha256)
  RETURNING case_file_builds.build_id INTO v_id;
  RETURN QUERY SELECT v_id, rs.version;
END;
$$;

-- ---------- 6. Current ----------

CREATE OR REPLACE FUNCTION public.case_file_build_current(p_actor uuid, p_case uuid)
RETURNS SETOF public.case_file_builds
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cases x WHERE x.id = p_case) THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'CASE_NOT_FOUND';
  END IF;
  IF p_actor IS NOT NULL AND NOT coalesce(public.case_can_read(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'case % is not readable', p_case USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN QUERY SELECT b.* FROM public.case_file_builds b WHERE b.case_id = p_case AND b.status = 'ready';
END;
$$;

-- ---------- 7. Stale builds ----------

CREATE OR REPLACE FUNCTION public.case_file_builds_stale_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.case_file_builds b SET status = 'superseded'
   WHERE b.case_id = NEW.case_id AND b.status = 'ready'
     AND b.manifest @> jsonb_build_array(jsonb_build_object('file_id', OLD.id::text));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS case_file_builds_stale ON public.case_document_files;
CREATE TRIGGER case_file_builds_stale
  AFTER UPDATE OF status ON public.case_document_files
  FOR EACH ROW WHEN (OLD.status = 'passed' AND NEW.status <> 'passed')
  EXECUTE FUNCTION public.case_file_builds_stale_hook();

-- ---------- 8. Download audit ----------

CREATE TABLE IF NOT EXISTS public.case_file_downloads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  case_id    uuid NOT NULL,
  actor      uuid NULL,
  file_id    uuid NULL REFERENCES public.case_document_files (id),
  build_id   uuid NULL REFERENCES public.case_file_builds (build_id),
  url_issued boolean NOT NULL DEFAULT false,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_file_downloads_case_fkey FOREIGN KEY (case_id, account_id)
    REFERENCES public.cases (id, account_id),
  CONSTRAINT case_file_downloads_one_target CHECK ((file_id IS NULL) <> (build_id IS NULL))
);
CREATE INDEX IF NOT EXISTS case_file_downloads_case_idx ON public.case_file_downloads (case_id, at);
CREATE INDEX IF NOT EXISTS case_file_downloads_file_idx ON public.case_file_downloads (file_id);
CREATE INDEX IF NOT EXISTS case_file_downloads_build_idx ON public.case_file_downloads (build_id);

COMMENT ON TABLE public.case_file_downloads IS
  'One audit row per case file or build download, written before the signed URL; url_issued flips false -> true once it exists. Append-only otherwise. Migration 182.';

CREATE OR REPLACE FUNCTION public.case_file_downloads_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT OLD.url_issued AND NEW.url_issued
     AND (to_jsonb(NEW) - 'url_issued') = (to_jsonb(OLD) - 'url_issued') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'case_file_downloads is append-only (% refused; only url_issued false -> true)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS case_file_downloads_append_only ON public.case_file_downloads;
CREATE TRIGGER case_file_downloads_append_only
  BEFORE UPDATE OR DELETE ON public.case_file_downloads
  FOR EACH ROW EXECUTE FUNCTION public.case_file_downloads_guard();
DROP TRIGGER IF EXISTS case_file_downloads_no_truncate ON public.case_file_downloads;
CREATE TRIGGER case_file_downloads_no_truncate
  BEFORE TRUNCATE ON public.case_file_downloads
  FOR EACH STATEMENT EXECUTE FUNCTION public.case_append_only();

-- A file of a case the actor can read: one audit row, and the customer
-- document whose object the server signs. Anything else FILE_NOT_FOUND.
CREATE OR REPLACE FUNCTION public.case_file_download_record(p_actor uuid, p_file uuid, p_now timestamptz)
RETURNS TABLE (download_id uuid, customer_document_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  f public.case_document_files%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO f FROM public.case_document_files x WHERE x.id = p_file;
  IF NOT FOUND OR p_actor IS NULL OR NOT coalesce(public.case_can_read(f.case_id, p_actor), false) THEN
    RAISE EXCEPTION 'file % not found', p_file USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;
  INSERT INTO public.case_file_downloads (account_id, case_id, actor, file_id, at)
  VALUES (f.account_id, f.case_id, p_actor, f.id, coalesce(p_now, now()))
  RETURNING case_file_downloads.id INTO v_id;
  RETURN QUERY SELECT v_id, f.customer_document_id;
END;
$$;

-- The case's ready build: one audit row and its object path, sha256 and
-- version. FILE_NOT_FOUND unless readable; BUILD_STALE with no ready build.
CREATE OR REPLACE FUNCTION public.case_build_download_record(p_actor uuid, p_case uuid, p_now timestamptz)
RETURNS TABLE (download_id uuid, object_path text, sha256 text, version integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  b public.case_file_builds%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.cases x WHERE x.id = p_case)
     OR NOT coalesce(public.case_can_read(p_case, p_actor), false) THEN
    RAISE EXCEPTION 'case % not found', p_case USING ERRCODE = 'no_data_found', HINT = 'FILE_NOT_FOUND';
  END IF;
  SELECT * INTO b FROM public.case_file_builds x WHERE x.case_id = p_case AND x.status = 'ready';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % has no current build', p_case USING ERRCODE = 'check_violation', HINT = 'BUILD_STALE';
  END IF;
  INSERT INTO public.case_file_downloads (account_id, case_id, actor, build_id, at)
  VALUES (b.account_id, b.case_id, p_actor, b.build_id, coalesce(p_now, now()))
  RETURNING case_file_downloads.id INTO v_id;
  RETURN QUERY SELECT v_id, b.object_path, b.sha256, b.version;
END;
$$;

-- Marks a download's signed URL issued (the only permitted update).
CREATE OR REPLACE FUNCTION public.case_file_download_issued(p_download_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.case_file_downloads d SET url_issued = true WHERE d.id = p_download_id AND NOT d.url_issued
$$;

-- ---------- 9. Row level security ----------

ALTER TABLE public.case_file_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_builds FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_build_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_build_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_downloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_file_downloads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_file_builds_select ON public.case_file_builds;
CREATE POLICY case_file_builds_select ON public.case_file_builds FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.case_rls_can_read(case_id));

-- ---------- 10. Privileges ----------

-- Builds are readable by the case's readers; reservations and the download
-- audit by the service role only.
REVOKE ALL ON public.case_file_builds, public.case_file_build_reservations, public.case_file_downloads
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_file_builds TO authenticated, service_role;
GRANT SELECT ON public.case_file_build_reservations, public.case_file_downloads TO service_role;

REVOKE ALL ON FUNCTION
  public.case_file_builds_guard(),
  public.case_file_builds_stale_hook(),
  public.case_file_downloads_guard(),
  public.case_file_build_gate(uuid, uuid),
  public.case_file_build_reserve(uuid, uuid, timestamptz),
  public.case_file_build_record(uuid, uuid, uuid, jsonb, boolean, text, text, timestamptz),
  public.case_file_build_current(uuid, uuid),
  public.case_file_download_record(uuid, uuid, timestamptz),
  public.case_build_download_record(uuid, uuid, timestamptz),
  public.case_file_download_issued(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_file_build_gate(uuid, uuid),
  public.case_file_build_reserve(uuid, uuid, timestamptz),
  public.case_file_build_record(uuid, uuid, uuid, jsonb, boolean, text, text, timestamptz),
  public.case_file_build_current(uuid, uuid),
  public.case_file_download_record(uuid, uuid, timestamptz),
  public.case_build_download_record(uuid, uuid, timestamptz),
  public.case_file_download_issued(uuid)
  TO service_role;
