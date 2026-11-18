-- Regression check for chat-media's allowed types (migration 209).
--
-- Asserts: the public chat-media bucket takes zip archives (a customer's
-- zip was refused and lost before 209), lists only exact types (no
-- wildcard, which Storage checks only up to the first '/'), and lists
-- nothing a browser renders as a page.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several.

DO $verify$
DECLARE
  v_types text[];
  failed  text[] := '{}';
BEGIN
  SELECT allowed_mime_types INTO v_types
    FROM storage.buckets WHERE id = 'chat-media';
  IF v_types IS NULL THEN
    RAISE EXCEPTION 'chat-media types verification: bucket missing or unrestricted';
  END IF;
  IF NOT ('application/zip' = ANY (v_types)
          AND 'application/x-zip-compressed' = ANY (v_types)
          AND 'application/octet-stream' = ANY (v_types)) THEN
    failed := array_append(failed, 'zip / octet-stream not allowed'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_types) t WHERE t !~ '^[a-z]+/[a-z0-9.+-]+$') THEN
    failed := array_append(failed, 'a wildcard or malformed type is listed'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_types) t
              WHERE t ~ '(html|svg|javascript|ecmascript)' OR t ~ '(^|/|\+)xml$') THEN
    failed := array_append(failed, 'a type a browser renders as a page is listed'::text);
  END IF;
  IF NOT ('image/jpeg' = ANY (v_types) AND 'audio/ogg' = ANY (v_types)
          AND 'application/pdf' = ANY (v_types)) THEN
    failed := array_append(failed, '039''s types are missing'::text);
  END IF;
  IF array_length(failed, 1) > 0 THEN
    RAISE EXCEPTION 'chat-media types verification failed: %', array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'chat-media types verification passed (% types)', array_length(v_types, 1);
END
$verify$;
