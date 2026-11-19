/**
 * Group attachments are uploaded by the browser into the public `chat-media`
 * bucket under `account-<id>/groups/` (`buildMediaPath(…, 'groups')`), and the
 * route is handed back the public URL plus the object path. Before the
 * gateway fetches that URL, the server checks it names an object of the
 * caller's own account in that folder, and then sends a link it REBUILT from
 * the configured public origin: the gateway never fetches a caller-chosen
 * host, and one workspace cannot send another's files.
 */
import { publicSupabaseUrl } from '@/lib/supabase/urls';

const PUBLIC_PREFIX = '/storage/v1/object/public/chat-media/';
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The chat-media object path of `url` when it is an https URL, with no query
 * or fragment, of an object under `account-<accountId>/groups/`, and `path`
 * names that same object; else null. The URL's origin is not trusted, only
 * its path: the caller sends `ownGroupMediaLink(path)`, never `url`.
 */
export function parseOwnGroupMedia(
  url: unknown,
  path: unknown,
  accountId: string
): string | null {
  if (typeof url !== 'string' || typeof path !== 'string') return null;
  // Judge the raw text too: `new URL` resolves `..`, decodes nothing but
  // reads `\` as `/`, and drops an empty `?` / `#`. Plain characters only
  // (no `%`, `\`, `@`, `?`, `#`), and no dot segment anywhere.
  if (!/^[A-Za-z0-9._~:/-]+$/.test(url) || /\/\.{1,2}(\/|$)/.test(url))
    return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  const at = parsed.pathname.indexOf(PUBLIC_PREFIX);
  if (at < 0) return null;
  const objectPath = parsed.pathname.slice(at + PUBLIC_PREFIX.length);
  const segments = objectPath.split('/');
  if (segments.length < 3) return null;
  if (segments[0] !== `account-${accountId}` || segments[1] !== 'groups')
    return null;
  if (!segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..'))
    return null;
  if (path !== objectPath) return null;
  return objectPath;
}

/** The public link the gateway is sent for a checked object path. */
export function ownGroupMediaLink(objectPath: string): string {
  return `${publicSupabaseUrl().replace(/\/+$/, '')}${PUBLIC_PREFIX}${objectPath}`;
}
