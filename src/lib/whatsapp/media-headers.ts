const INLINE_IMAGES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/heic',
  'image/heif',
]);

const INERT_FILES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/zip',
  'application/msword',
  'text/plain',
  'text/csv',
]);

/** Word, Excel and PowerPoint, old and new. */
const OFFICE_FILE =
  /^application\/vnd\.(ms-(excel|powerpoint)|openxmlformats-officedocument\.[a-z]+\.[a-z]+)$/;

/**
 * Response headers for proxied gateway media.
 *
 * The bytes (and their Content-Type) come from whoever sent the
 * WhatsApp message, and this route is same-origin with the dashboard —
 * so an attacker-sent `text/html` or `image/svg+xml` file rendered
 * inline would run script in an authenticated session. Only named inert
 * types are served inline (any `…+xml` is a document, whatever is before
 * the plus); everything else is a download, under its own type only when
 * a file of that type cannot run either: a page that opens the bytes as a
 * blob gives them this origin. `nosniff` stops the browser second-guessing
 * the type, and
 * `private` keeps a shared cache from handing one tenant's media to
 * another (the response is behind a session cookie).
 */
/**
 * The bare raster type of a Content-Type, when it is one a browser may
 * show inline from our origin; null otherwise. SVG is not on the list: it
 * is a document that can carry script.
 */
export function inlineImageType(
  rawType: string | null | undefined
): string | null {
  const type = (rawType ?? '').split(';')[0]!.trim().toLowerCase();
  return INLINE_IMAGES.has(type) ? type : null;
}

export function mediaResponseHeaders(
  rawType: string | null | undefined
): Record<string, string> {
  const type = (rawType || 'application/octet-stream')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const inline =
    INLINE_IMAGES.has(type) || /^(audio|video)\/[a-z0-9.-]+$/.test(type);
  return {
    'Content-Type':
      inline || INERT_FILES.has(type) || OFFICE_FILE.test(type)
        ? type
        : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  };
}
