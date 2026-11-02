/**
 * The Content-Type a file may be STORED with in the private file buckets
 * (`chat-files`, `deal-files`, `call-recordings`; migration 164).
 *
 * Storage serves an object with the type its uploader declared, on the
 * app's own origin (`/supabase/…` is proxied there). A file stored as
 * `text/html` or `image/svg+xml` therefore runs script as the app the
 * moment someone opens its link, and can read the Supabase session
 * cookie. So every writer of those buckets passes the declared type
 * through `safeStoredMime`: a type on this list is kept (lower-cased,
 * parameters dropped), anything else is stored as
 * `application/octet-stream`, which a browser downloads instead of
 * rendering. Nothing here may ever admit HTML, XHTML, SVG, XML or
 * JavaScript.
 *
 * Migration 164 sets the same list as each bucket's `allowed_mime_types`
 * (with `audio/*` and `video/*` as wildcards) and refuses any other type
 * in a `storage.objects` row of those buckets with a trigger, which also
 * covers the copy route and comma-joined types that Storage's own check
 * lets through. So a client that skips this function is refused.
 * `safe-mime.test.ts` reads the migration and keeps the lists equal:
 * change one, change both.
 *
 * Parameters are dropped because Storage compares the whole subtype,
 * parameters included: `audio/webm;codecs=opus` does not match an
 * allowlisted `audio/webm` and would be refused.
 */

/** Exact types allowed, besides any `audio/<x>` and `video/<x>`. */
export const SAFE_STORED_MIME_TYPES: readonly string[] = [
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
];

/** Top-level types allowed with any subtype (`audio/*` in SQL). */
export const SAFE_STORED_MIME_WILDCARDS: readonly string[] = ['audio', 'video'];

export const FALLBACK_STORED_MIME = 'application/octet-stream';

const EXACT = new Set(SAFE_STORED_MIME_TYPES);
const WILDCARD_RE = new RegExp(
  `^(?:${SAFE_STORED_MIME_WILDCARDS.join('|')})/[a-z0-9.+-]+$`
);

/** A comma or a control character anywhere makes the whole type unsafe. */
const UNSAFE_CHAR_RE = /[,\p{Cc}]/u;

/** The type to store a file with: allowlisted and bare, else octet-stream. */
export function safeStoredMime(mime: string | null | undefined): string {
  const raw = mime ?? '';
  // A browser takes the last of comma-separated types ('audio/x, text/html'
  // is served as HTML), and Storage's own check stops at the first '/'.
  if (UNSAFE_CHAR_RE.test(raw)) return FALLBACK_STORED_MIME;
  const bare = raw.split(';')[0].trim().toLowerCase();
  if (EXACT.has(bare) || WILDCARD_RE.test(bare)) return bare;
  return FALLBACK_STORED_MIME;
}
