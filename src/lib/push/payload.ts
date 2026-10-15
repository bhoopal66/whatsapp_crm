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
    url: row.url.startsWith('/') ? row.url : '/notifications',
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
