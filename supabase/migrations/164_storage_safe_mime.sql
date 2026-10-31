-- ============================================================
-- 164_storage_safe_mime.sql — the private file buckets accept only
-- file types a browser will not run as a page.
--
-- Storage serves each object with the Content-Type its uploader
-- declared, and the self-hosted install serves Storage on the app's own
-- origin (/supabase/…). chat-files (087), deal-files (088) and
-- call-recordings (089) had no allowed_mime_types, so a member could
-- upload x.html as text/html (or an image/svg+xml), post its signed
-- link, and run script as the app in whoever opened it: that reads the
-- Supabase session cookie. A WhatsApp group participant could do the
-- same through a document sent into a deal room.
--
-- Storage enforces allowed_mime_types on upload only, so this closes
-- new uploads; an object stored before it keeps its old type. The app
-- normalises every type it stores (src/lib/storage/safe-mime.ts:
-- lower-cased, parameters dropped, anything off the list stored as
-- application/octet-stream), so no legitimate upload is refused. The
-- list below equals SAFE_STORED_MIME_TYPES plus audio/* and video/*
-- (SAFE_STORED_MIME_WILDCARDS); safe-mime.test.ts reads this file to
-- keep them equal. It must never admit HTML, XHTML, SVG, XML or
-- JavaScript (verify-storage-safe-mime.sql).
--
-- Re-runnable: plain UPDATEs to a fixed value. chat-media (023/039),
-- avatars (008) and flow-media (016) already carry allowlists without
-- any of those types and are left alone.
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
