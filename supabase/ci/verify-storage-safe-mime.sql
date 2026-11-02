-- 164: the private file buckets carry an allowlist that never admits a
-- type a browser runs as a page, and the storage_objects_safe_mime trigger
-- refuses such a type in any storage.objects row of those buckets (the
-- copy route and comma-joined types get past Storage's own check).
-- One statement (the pinned CLI rejects more). Every row it writes is
-- rolled back by the sentinel exception at the end of the inner block.
DO $$
DECLARE
  v_bucket text;
  v_types text[];
  v_bad text[] := ARRAY[
    'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml',
    'application/xml', 'text/javascript', 'application/javascript'
  ];
  v_prefix text := 'verify-164-' || gen_random_uuid()::text || '/';
  v_meta jsonb;
  v_n int := 0;
  v_refused boolean;
  v_id uuid;
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'storage' AND c.relname = 'objects'
       AND t.tgname = 'storage_objects_safe_mime'
       AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION '164: trigger storage_objects_safe_mime is missing on storage.objects';
  END IF;

  BEGIN
    -- Refused: renderable types, comma-joined types (a browser takes the
    -- last), and a file-backend copy that re-types through contentType.
    FOREACH v_meta IN ARRAY ARRAY[
      '{"mimetype": "text/html"}',
      '{"mimetype": "image/svg+xml"}',
      '{"mimetype": "audio/x, text/html"}',
      '{"mimetype": "AUDIO/WEBM, TEXT/HTML"}',
      '{"mimetype": "application/pdf;x=a,text/html"}',
      '{"mimetype": "application/pdf;\n"}',
      '{"mimetype": null}',
      '{"mimetype": "image/png", "contentType": "text/html"}'
    ]::jsonb[] LOOP
      FOREACH v_bucket IN ARRAY ARRAY['chat-files', 'deal-files', 'call-recordings'] LOOP
        v_n := v_n + 1;
        v_refused := false;
        BEGIN
          INSERT INTO storage.objects (bucket_id, name, metadata)
          VALUES (v_bucket, v_prefix || 'bad-' || v_n, v_meta);
        EXCEPTION WHEN invalid_parameter_value THEN
          v_refused := true;
        END;
        IF NOT v_refused THEN
          RAISE EXCEPTION '164: % accepted a row with metadata %', v_bucket, v_meta;
        END IF;
      END LOOP;
    END LOOP;

    -- Accepted: parameters on an allowed type, an exact type, no type yet.
    FOREACH v_meta IN ARRAY ARRAY[
      '{"mimetype": "audio/webm;codecs=opus"}',
      '{"mimetype": "application/pdf", "contentType": "application/pdf"}',
      '{"size": 1}'
    ]::jsonb[] LOOP
      v_n := v_n + 1;
      INSERT INTO storage.objects (bucket_id, name, metadata)
      VALUES ('chat-files', v_prefix || 'ok-' || v_n, v_meta);
    END LOOP;
    INSERT INTO storage.objects (bucket_id, name, metadata)
    VALUES ('chat-files', v_prefix || 'ok-null', NULL)
    RETURNING id INTO v_id;

    -- Re-typing a stored row is refused like a new one.
    UPDATE storage.objects SET metadata = '{"mimetype": "application/pdf"}'
     WHERE id = v_id;
    v_refused := false;
    BEGIN
      UPDATE storage.objects SET metadata = '{"mimetype": "text/html"}'
       WHERE id = v_id;
    EXCEPTION WHEN invalid_parameter_value THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION '164: an UPDATE re-typed a chat-files row as text/html';
    END IF;

    -- Other buckets keep their own rules.
    INSERT INTO storage.objects (bucket_id, name, metadata)
    VALUES ('avatars', v_prefix || 'other', '{"mimetype": "text/html"}');

    RAISE EXCEPTION 'verify-164-rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'verify-164-rollback' THEN
      RAISE;
    END IF;
  END;
END $$;
