/**
 * Where "Create template" in the broadcast wizard sends people, and how
 * Settings finds its way back. The `from` query value is untrusted: only a
 * same-origin path under /broadcasts is honoured, so the link cannot be
 * turned into an open redirect.
 */
export const NEW_BROADCAST_PATH = '/broadcasts/new';

export function templatesSettingsHref(from: string = NEW_BROADCAST_PATH) {
  return `/settings?tab=templates&from=${encodeURIComponent(from)}`;
}

export function safeBroadcastReturnPath(raw: string | null | undefined) {
  if (!raw || typeof raw !== 'string') return null;
  if (!raw.startsWith('/broadcasts')) return null;
  // `//host`, `/\host` and anything with a scheme or control character.
  if (/[\\\u0000-\u001f]/.test(raw) || raw.includes('//')) return null;
  const rest = raw.slice('/broadcasts'.length);
  if (rest !== '' && !/^[/?#]/.test(rest)) return null;
  return raw;
}
