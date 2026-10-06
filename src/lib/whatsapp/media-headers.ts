/**
 * Response headers for proxied gateway media.
 *
 * The bytes (and their Content-Type) come from whoever sent the
 * WhatsApp message, and this route is same-origin with the dashboard —
 * so an attacker-sent `text/html` or `image/svg+xml` file rendered
 * inline would run script in an authenticated session. Only inert
 * image/audio/video types are served inline; everything else is a
 * download. `nosniff` stops the browser second-guessing the type, and
 * `private` keeps a shared cache from handing one tenant's media to
 * another (the response is behind a session cookie).
 */
export function mediaResponseHeaders(
  rawType: string | null | undefined
): Record<string, string> {
  const type = (rawType || 'application/octet-stream')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const inline =
    /^(image|audio|video)\/[a-z0-9.+-]+$/.test(type) &&
    type !== 'image/svg+xml';
  return {
    'Content-Type': inline ? type : rawType || 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  };
}
