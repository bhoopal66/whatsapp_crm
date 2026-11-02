-- ============================================================
-- 164_storage_safe_mime.sql — the private file buckets store only
-- file types a browser will not run as a page.
--
-- Storage serves each object with the Content-Type it was stored with,
-- and the self-hosted install serves Storage on the app's own origin
-- (/supabase/…). chat-files (087), deal-files (088) and call-recordings
-- (089) had no allowed_mime_types, so a member could upload x.html as
-- text/html (or an image/svg+xml), post its signed link, and run script
-- as the app in whoever opened it: that reads the Supabase session
-- cookie. A WhatsApp group participant could do the same through a
-- document sent into a deal room.
--
-- Two layers, because Storage's own check has two holes:
--
-- 1. allowed_mime_types (the UPDATE below). Storage checks it on upload
--    only, and only up to the first '/': 'audio/x, text/html' passes as
--    audio/*, and a browser takes the last of comma-separated types, so
--    it is served as HTML. The copy route (POST /object/copy) never
--    checks it and merges the caller's metadata into the copy:
--    {"copyMetadata": false, "metadata": {"mimetype": "text/html"}}
--    (the type the S3 backend serves) or {"contentType": "text/html"}
--    (the type the file backend serves) re-types any object the caller
--    may read into one they may write.
-- 2. The storage_objects_safe_mime trigger. Every Storage route writes
--    the storage.objects row with metadata that carries the stored type:
--    first under the caller's role (Storage's RLS probe, before any
--    bytes are written), then as the superuser once they are, and the
--    trigger fires on both. An object with no row is never served. For
--    these three buckets the trigger refuses a row whose
--    metadata.mimetype or metadata.contentType is not a string, contains
--    a comma or a control character, or whose type (before any ';',
--    trimmed, lower-cased) is neither on the list below nor audio/<x> or
--    video/<x>. That refuses the comma types and a copy that sets a bad
--    type. It cannot refuse a copy that keeps the source file's type:
--    the file backend serves the type stored on disk with the file
--    (an extended attribute), which a copy inherits unless the caller
--    sets contentType, so a copy that sets only a safe mimetype passes
--    here and is served as its source (an old HTML object, or a public
--    bucket's 'image/png/,application/xhtml+xml'). The nginx headers in
--    docs/security.md are required for that reason. A row
--    with no metadata, or without either key, passes. An UPDATE that
--    keeps the bucket, the version and the type (Storage touching the
--    owner or last_accessed_at) is not re-checked, so an old object
--    stays readable.
--
-- Objects stored before this keep their old type: nothing here rewrites
-- them. The required nginx headers on /supabase/storage/ cover those
-- (docs/security.md, "Required nginx headers on storage").
--
-- The app normalises every type it stores (src/lib/storage/safe-mime.ts:
-- lower-cased, parameters dropped; a comma, a control character or
-- anything off the list is stored as application/octet-stream), so no
-- legitimate upload is refused. The bucket list below equals
-- SAFE_STORED_MIME_TYPES plus audio/* and video/*
-- (SAFE_STORED_MIME_WILDCARDS), and the trigger's list equals
-- SAFE_STORED_MIME_TYPES; safe-mime.test.ts reads this file to keep all
-- three equal. They must never admit HTML, XHTML, SVG, XML or JavaScript
-- (verify-storage-safe-mime.sql).
--
-- Apply as a role that may create triggers on storage.objects (its
-- owner, supabase_admin, or postgres, which Supabase grants ALL on it).
--
-- Re-runnable: a plain UPDATE to a fixed value, CREATE OR REPLACE
-- FUNCTION, DROP TRIGGER IF EXISTS + CREATE TRIGGER. chat-media
-- (023/039), avatars (008) and flow-media (016) already carry allowlists
-- without any of those types and are left alone.
-- ============================================================

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY[
     'audio/*',
     'video/*',
     'image/png',
     'image/jpeg',
     'image/gif',
     'image/webp',
     'image/heic',
     'image/heif',
     'image/bmp',
     'image/tiff',
     'application/pdf',
     'text/plain',
     'text/csv',
     'application/json',
     'application/rtf',
     'application/zip',
     'application/x-zip-compressed',
     'application/x-7z-compressed',
     'application/vnd.rar',
     'application/x-rar-compressed',
     'application/gzip',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/vnd.oasis.opendocument.text',
     'application/vnd.oasis.opendocument.spreadsheet',
     'application/vnd.oasis.opendocument.presentation',
     'application/octet-stream'
   ]::text[]
 WHERE id IN ('chat-files', 'deal-files', 'call-recordings');

CREATE OR REPLACE FUNCTION public.storage_objects_safe_mime_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_key text;
  v_raw jsonb;
  v_type text;
  v_bare text;
BEGIN
  IF NEW.metadata IS NULL OR jsonb_typeof(NEW.metadata) <> 'object' THEN
    RETURN NEW;
  END IF;
  -- mimetype is the type the S3 backend serves, contentType the one the
  -- file backend's copy writes; check whichever the row carries.
  FOREACH v_key IN ARRAY ARRAY['mimetype', 'contentType'] LOOP
    CONTINUE WHEN NOT (NEW.metadata ? v_key);
    v_raw := NEW.metadata -> v_key;
    IF TG_OP = 'UPDATE'
       AND NEW.bucket_id IS NOT DISTINCT FROM OLD.bucket_id
       AND NEW.version IS NOT DISTINCT FROM OLD.version
       AND v_raw IS NOT DISTINCT FROM (OLD.metadata -> v_key) THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(v_raw) <> 'string' THEN
      RAISE EXCEPTION 'storage: metadata.% must be a string in bucket %',
        v_key, NEW.bucket_id
        USING ERRCODE = '22023';
    END IF;
    v_type := v_raw #>> '{}';
    v_bare := lower(btrim(split_part(v_type, ';', 1)));
    IF strpos(v_type, ',') > 0
       OR v_type ~ '[[:cntrl:]]'
       OR NOT (
         v_bare ~ '^(audio|video)/[a-z0-9.+-]+$'
         OR v_bare = ANY (ARRAY[
           'image/png',
           'image/jpeg',
           'image/gif',
           'image/webp',
           'image/heic',
           'image/heif',
           'image/bmp',
           'image/tiff',
           'application/pdf',
           'text/plain',
           'text/csv',
           'application/json',
           'application/rtf',
           'application/zip',
           'application/x-zip-compressed',
           'application/x-7z-compressed',
           'application/vnd.rar',
           'application/x-rar-compressed',
           'application/gzip',
           'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/vnd.ms-excel',
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           'application/vnd.ms-powerpoint',
           'application/vnd.openxmlformats-officedocument.presentationml.presentation',
           'application/vnd.oasis.opendocument.text',
           'application/vnd.oasis.opendocument.spreadsheet',
           'application/vnd.oasis.opendocument.presentation',
           'application/octet-stream'
         ]::text[])
       ) THEN
      RAISE EXCEPTION 'storage: file type "%" is not allowed in bucket %',
        left(v_type, 200), NEW.bucket_id
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- A trigger function cannot be called directly and firing it needs no
-- EXECUTE grant, so nobody needs one.
REVOKE ALL ON FUNCTION public.storage_objects_safe_mime_guard()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS storage_objects_safe_mime ON storage.objects;
CREATE TRIGGER storage_objects_safe_mime
  BEFORE INSERT OR UPDATE ON storage.objects
  FOR EACH ROW
  WHEN (NEW.bucket_id IN ('chat-files', 'deal-files', 'call-recordings'))
  EXECUTE FUNCTION public.storage_objects_safe_mime_guard();
