/**
 * The JSON the service worker receives. Push services cap a payload at
 * about 4 KB after encryption overhead; we keep the plaintext to 3 KB,
 * trimming the body first, then the title.
 */
export const MAX_PAYLOAD_BYTES = 3072;

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string | null;
  kind: string;
  ts: number;
}

const CHECK_ORIGIN = 'https://push.invalid';

/**
 * A same-origin path, else '/notifications'. '//host' and '/\\host' are
 * protocol-relative (the URL parser reads a backslash as a slash), so a
 * leading '/' alone is not enough; public/sw.js applies the same rule.
 */
export function safePushUrl(url: string): string {
  if (!url.startsWith('/') || url[1] === '/' || url[1] === '\\') {
    return '/notifications';
  }
  try {
    return new URL(url, CHECK_ORIGIN).origin === CHECK_ORIGIN
      ? url
      : '/notifications';
  } catch {
    return '/notifications';
  }
}

export function buildPayload(row: {
  title: string;
  body: string | null;
  url: string;
  tag: string | null;
  kind: string;
  created_at: string;
}): string {
  const p: PushPayload = {
    title: row.title,
    body: row.body ?? '',
    url: safePushUrl(row.url),
    tag: row.tag,
    kind: row.kind,
    ts: new Date(row.created_at).getTime(),
  };
  const size = () => Buffer.byteLength(JSON.stringify(p), 'utf8');
  while (size() > MAX_PAYLOAD_BYTES && p.body.length > 0) {
    p.body = Array.from(p.body).slice(0, -32).join('');
  }
  while (size() > MAX_PAYLOAD_BYTES && p.title.length > 1) {
    p.title = Array.from(p.title).slice(0, -32).join('') || 'Notification';
  }
  if (size() > MAX_PAYLOAD_BYTES) {
    p.url = '/notifications';
    p.tag = null;
  }
  return JSON.stringify(p);
}
