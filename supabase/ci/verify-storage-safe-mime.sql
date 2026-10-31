-- 164: the private file buckets carry an allowlist that never admits a
-- type a browser runs as a page. One statement (the pinned CLI rejects more).
DO $$
DECLARE
  v_bucket text;
  v_types text[];
  v_bad text[] := ARRAY[
    'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml',
    'application/xml', 'text/javascript', 'application/javascript'
  ];
BEGIN
  FOREACH v_bucket IN ARRAY ARRAY['chat-files', 'deal-files', 'call-recordings'] LOOP
    SELECT allowed_mime_types INTO v_types FROM storage.buckets WHERE id = v_bucket;
    IF NOT FOUND THEN
      RAISE EXCEPTION '164: bucket % is missing', v_bucket;
    END IF;
    IF v_types IS NULL OR cardinality(v_types) = 0 THEN
      RAISE EXCEPTION '164: bucket % has no allowed_mime_types', v_bucket;
    END IF;
    IF v_types && v_bad THEN
      RAISE EXCEPTION '164: bucket % allows a renderable type: %', v_bucket,
        ARRAY(SELECT unnest(v_types) INTERSECT SELECT unnest(v_bad));
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_types) t
                WHERE t ~* '(html|svg|xml|javascript|ecmascript)' AND t !~* 'openxmlformats') THEN
      RAISE EXCEPTION '164: bucket % allows a markup or script type', v_bucket;
    END IF;
  END LOOP;
END $$;
