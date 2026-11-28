/**
 * Links to `chat-media` objects (customer WhatsApp attachments, contact
 * pictures, voice notes) once the bucket is private (migration 321).
 *
 * Rows keep the link they were stored with, the public form
 * `…/storage/v1/object/public/chat-media/<path>`, which no longer opens
 * on its own. Two ways to reach the object instead:
 *
 *   - in the app: `chatMediaDisplayUrl()` turns the stored link into
 *     `/api/media/chat/<path>`, a route that checks the signed-in caller
 *     and redirects to a short-lived signed URL;
 *   - for a gateway or a server job: lib/storage/chat-media-sign.ts signs
 *     the path directly.
 *
 * Pure and client-safe: the inbox imports it.
 */

export const CHAT_MEDIA_BUCKET = 'chat-media';
export const CHAT_MEDIA_PROXY_PREFIX = '/api/media/chat/';

const STORED_MARKERS = [
  '/storage/v1/object/public/chat-media/',
  '/storage/v1/object/sign/chat-media/',
  '/storage/v1/object/authenticated/chat-media/',
];

/**
 * A safe object path: `/`-separated segments, none empty, `.` or `..`,
 * no control characters or backslash. Storage names are opaque, so
 * anything else (spaces, Arabic file names) is allowed.
 */
export function isSafeChatMediaPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024)
    return false;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');
}

function decodePath(raw: string): string | null {
  try {
    const decoded = raw
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
    return isSafeChatMediaPath(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * The object path a stored chat-media link (public, signed or
 * authenticated form, on any origin) or an app proxy link names, or null
 * for anything else. Only the URL's path is read: its origin changes with
 * the tunnel and is never trusted.
 */
export function chatMediaObjectPath(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  // The URL parser resolves dot segments, encoded ones too (`%2E%2E`), so
  // `…/chat-media/account-a/%2E%2E/account-b/x` would read as account-b's
  // file. Any dot segment in the raw text refuses the link outright.
  if (/(?:^|\/|\\)(?:\.|%2e){1,2}(?:\/|\\|\?|#|$)/i.test(url)) return null;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://relative.invalid').pathname;
  } catch {
    return null;
  }
  for (const marker of STORED_MARKERS) {
    const at = pathname.indexOf(marker);
    if (at >= 0) return decodePath(pathname.slice(at + marker.length));
  }
  if (pathname.startsWith(CHAT_MEDIA_PROXY_PREFIX))
    return decodePath(pathname.slice(CHAT_MEDIA_PROXY_PREFIX.length));
  return null;
}

/** The app route that serves one chat-media object to a signed-in caller. */
export function chatMediaProxyPath(path: string): string {
  return (
    CHAT_MEDIA_PROXY_PREFIX + path.split('/').map(encodeURIComponent).join('/')
  );
}

/**
 * What a screen puts in `src` / `href`: our own chat-media link becomes
 * the proxy route; any other link (the Meta media proxy, a gateway link, a
 * blob: preview) is returned unchanged.
 */
export function chatMediaDisplayUrl<T extends string | null | undefined>(
  url: T
): T | string {
  const path = chatMediaObjectPath(url);
  return path ? chatMediaProxyPath(path) : url;
}
