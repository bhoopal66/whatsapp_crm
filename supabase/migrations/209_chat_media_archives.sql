-- ============================================================
-- 209_chat_media_archives.sql — WhatsApp attachments of any safe type.
--
-- chat-media (023/039) is the public bucket every WhatsApp attachment
-- is stored in: the inbound mirror and the composer's staged uploads.
-- 039 allowed images, videos, audio, PDF, Office and plain text only,
-- so a customer's zip (application/x-zip-compressed) was refused by
-- Storage, the mirror returned null and the message kept no file at
-- all: nothing to open or download (2026-11-17/18, two zips from one
-- customer; one octet-stream document on 2026-11-14).
--
-- This sets chat-media's allowed_mime_types to 039's list plus every
-- exact type of 164's vetted list (archives, CSV, RTF, JSON, HEIC,
-- BMP, TIFF, OpenDocument and application/octet-stream). Still EXACT
-- types only: no 'audio/*' / 'video/*' wildcards, because Storage
-- checks a wildcard only up to the first '/' ('audio/x, text/html'
-- passes) and this public bucket has no 164-style trigger. Nothing
-- here is a type a browser renders as a page (HTML, XHTML, SVG, XML,
-- JavaScript): verify-chat-media-types.sql asserts it.
--
-- The app stores any other type as application/octet-stream
-- (chatMediaStoredMime, src/lib/storage/safe-mime.ts), so an unusual
-- attachment is kept as a download. CHAT_MEDIA_MIME_TYPES there equals
-- the array below; safe-mime.test.ts reads this file to keep them equal.
--
-- Re-runnable (a plain UPDATE to a fixed value). Apply in order, once:
-- re-applying 023 or 039 afterwards narrows the list again, so re-apply
-- 209 after either. Objects already stored keep their type.
-- ============================================================

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY[
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
    'application/octet-stream',
    'video/mp4',
    'video/3gpp',
    'video/3gp',
    'video/quicktime',
    'audio/ogg',
    'audio/mpeg',
    'audio/aac',
    'audio/mp4',
    'audio/amr',
    'audio/opus'
   ]::text[]
 WHERE id = 'chat-media';
