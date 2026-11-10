/**
 * The bytes of one `customer_documents` row, for the case-file checks.
 *
 * Only two sources are read, both inside this install's own Supabase:
 *   - a storage pair in the private 'case-files' bucket (a staff upload or
 *     case build, migration 180), through the service-role storage client;
 *   - a `media_url` that is a public chat-media object (an inbound file
 *     the mirror copied, `/storage/v1/object/public/chat-media/`). The
 *     public origin may carry a prefix (production's is `.../supabase`)
 *     and changes with the tunnel, so only the object path is kept and it
 *     is fetched from the INTERNAL Supabase URL (`serverSupabaseUrl()`).
 * Anything else is null: the server never fetches an arbitrary URL.
 *
 * Never throws; any failure, and anything over 100 MiB, is null.
 */
import { serverSupabaseUrl } from '@/lib/supabase/urls';

export const MAX_READ_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const CHAT_MEDIA_MARKER = '/storage/v1/object/public/chat-media/';

/** The storage surface used here: supabase-js `admin.storage` fits it. */
export interface CaseFilesStorage {
  from(bucket: string): {
    download(path: string): Promise<{ data: Blob | null; error: unknown }>;
    upload(
      path: string,
      body: Uint8Array | Blob | ArrayBuffer,
      options?: { contentType?: string; upsert?: boolean }
    ): Promise<{ data: unknown; error: unknown }>;
  };
}

export interface ReadBytesDeps {
  storage: CaseFilesStorage;
  fetch?: typeof fetch;
  /** Defaults to `serverSupabaseUrl()`. */
  internalBaseUrl?: string;
}

export interface DocumentBytesSource {
  mediaUrl: string | null;
  storageBucket: string | null;
  storagePath: string | null;
}

/**
 * The object path of a public chat-media URL, or null. Percent-decoded
 * once to reject '..' segments, then sent as it was written.
 */
export function chatMediaObjectPath(mediaUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(mediaUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const at = url.pathname.indexOf(CHAT_MEDIA_MARKER);
  if (at < 0) return null;
  const rest = url.pathname.slice(at + CHAT_MEDIA_MARKER.length);
  if (rest === '') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.split('/').some((s) => s === '..' || s === '.' || s === ''))
    return null;
  return rest;
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_READ_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_READ_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export async function readDocumentBytes(
  doc: DocumentBytesSource,
  deps: ReadBytesDeps
): Promise<Uint8Array | null> {
  try {
    if (doc.storageBucket === 'case-files') {
      const path = doc.storagePath;
      if (!path || path.startsWith('/') || path.split('/').includes('..'))
        return null;
      const { data, error } = await deps.storage
        .from('case-files')
        .download(path);
      if (error || !data || data.size > MAX_READ_BYTES) return null;
      return new Uint8Array(await data.arrayBuffer());
    }
    if (doc.storageBucket) return null;

    const objectPath = doc.mediaUrl ? chatMediaObjectPath(doc.mediaUrl) : null;
    if (!objectPath) return null;
    const base = (deps.internalBaseUrl ?? serverSupabaseUrl()).replace(
      /\/+$/,
      ''
    );
    const doFetch = deps.fetch ?? fetch;
    const res = await doFetch(`${base}${CHAT_MEDIA_MARKER}${objectPath}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    return await readCapped(res);
  } catch {
    return null;
  }
}
