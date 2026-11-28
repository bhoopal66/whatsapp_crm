-- Regression check for migration 321: chat-media is private, and
-- re-applying the bucket's older upserts (023, 039) keeps it private.
-- ONE statement on purpose (the pinned CLI rejects several); the re-apply
-- is replayed here as the same upsert, rolled back by a sentinel.

DO $verify$
DECLARE
  n INT := 0;
  failed TEXT[] := '{}';
BEGIN
  IF (SELECT public FROM storage.buckets WHERE id = 'chat-media') IS DISTINCT FROM false THEN
    failed := failed || 'chat-media is public'::text; END IF; n := n + 1;

  BEGIN
    -- 023/039's upsert as it now reads: an existing bucket keeps its flag.
    INSERT INTO storage.buckets (id, name, public) VALUES ('chat-media', 'chat-media', TRUE)
    ON CONFLICT (id) DO UPDATE SET public = storage.buckets.public;
    IF (SELECT public FROM storage.buckets WHERE id = 'chat-media') IS DISTINCT FROM false THEN
      failed := failed || 're-applying the upsert opened the bucket'::text; END IF; n := n + 1;
    RAISE EXCEPTION 'CMP_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'CMP_ROLLBACK' THEN RAISE; END IF;
  END;

  -- The other buckets are as they were: avatars and flow-media public
  -- (no customer files), the private ones private.
  IF (SELECT public FROM storage.buckets WHERE id = 'flow-media') IS DISTINCT FROM true THEN
    failed := failed || 'flow-media changed'::text; END IF; n := n + 1;
  IF EXISTS (SELECT 1 FROM storage.buckets
              WHERE id IN ('chat-files', 'deal-files', 'call-recordings', 'case-files') AND public) THEN
    failed := failed || 'a private bucket is public'::text; END IF; n := n + 1;

  IF n <> 4 THEN RAISE EXCEPTION 'verify-chat-media-private: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-chat-media-private: % failed: %', cardinality(failed), array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-chat-media-private: % checks passed', n;
END $verify$;
