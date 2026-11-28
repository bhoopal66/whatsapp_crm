-- ============================================================
-- 321_chat_media_private.sql — customer attachments are no longer public
--
-- chat-media holds every WhatsApp attachment customers send (IDs, trade
-- licences, bank statements), the files staff send, contact pictures and
-- voice notes. It was a public bucket because the WhatsApp gateways
-- download a file we send by its link, so anyone who ever held an
-- object's link (a removed agent, a forwarded screenshot, a proxy log)
-- could open it without signing in, forever.
--
-- From this migration the bucket is private, and every reader gets a
-- short-lived signed link instead (the app, build of the same date):
--   - a gateway, a link signed for 6 hours at the moment of sending
--     (lib/storage/chat-media-sign.ts, from lib/whatsapp/provider.ts and
--     lib/whatsapp/groups.ts);
--   - a person in the app, /api/media/chat/<path>, which checks the
--     caller is staff of the object's workspace and redirects to a link
--     signed for 5 minutes;
--   - the public API, links signed for 1 hour in its answers;
--   - the NAS copier, the object read with the service key.
-- Stored rows keep their links; nothing is rewritten.
--
-- Apply WITH OR AFTER the build of the same date: the previous build
-- hands gateways and browsers the stored public link, which stops
-- opening here. The storage.objects policies (083, 283) are unchanged:
-- a signed-in person still reads directly only what they uploaded.
-- 023 and 039 keep an existing bucket's public flag when re-applied, so
-- they no longer undo this file.
--
-- Re-runnable. Asserted by supabase/ci/verify-chat-media-private.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION '321: storage.buckets is missing (not a Supabase database?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION '321: apply 023_chat_media.sql first';
  END IF;
END $$;

UPDATE storage.buckets SET public = false WHERE id = 'chat-media' AND public;
