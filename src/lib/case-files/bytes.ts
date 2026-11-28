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
 * Never throws. `readDocument` says WHY there are no bytes, because the two
 * answers mean opposite things to a customer: `unreadable` (not a source we
 * read, 4xx, not found, over 100 MiB) is the document's fault and fails its
 * checks; `unavailable` (timeout, network, 5xx, and 408/429, which is how the
 * storage API reports its own database timing out) is ours, and says nothing
 * about the document. `readDocumentBytes` is null for both, for the callers
 * that only need the bytes.
 *
 * Integrity on read (033b): when the row carries its recorded `sha256`, the
 * bytes that came back are hashed and compared with it; a difference is
 * `mismatch` (null from `readDocumentBytes`), logged once with the row id
 * only. A row with no recorded hash (NULL) has nothing to compare against.
 */
import { createHash } from 'node:crypto';

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
  /** The `customer_documents` id: the one thing a mismatch logs. */
  id?: string;
  /** `customer_documents.sha256`: the bytes must hash to it when set. */
  sha256?: string | null;
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

export type DocumentRead =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'unreadable' }
  | { kind: 'unavailable' }
  /** The bytes do not hash to the row's recorded sha256: never use them. */
  | { kind: 'mismatch' };

const UNREADABLE: DocumentRead = { kind: 'unreadable' };
const UNAVAILABLE: DocumentRead = { kind: 'unavailable' };

const transientStatus = (s: number) => s >= 500 || s === 408 || s === 429;

/**
 * A storage-js error. An answer from the storage API carries `status` (and
 * its own code in `statusCode`: a missing object is 400 / '404'); an error
 * with no status at all is a request that got no answer.
 */
function storageFailure(error: unknown): DocumentRead {
  const e = error as { status?: unknown; statusCode?: unknown };
  const codes = [e?.status, e?.statusCode]
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return codes.length === 0 || codes.some(transientStatus)
    ? UNAVAILABLE
    : UNREADABLE;
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

export async function readDocument(
  doc: DocumentBytesSource,
  deps: ReadBytesDeps
): Promise<DocumentRead> {
  const read = await readUnverified(doc, deps);
  if (read.kind !== 'bytes' || !doc.sha256) return read;
  const got = createHash('sha256').update(read.bytes).digest('hex');
  if (got === doc.sha256) return read;
  console.error(`[case-files] sha256 mismatch on read: ${doc.id ?? '-'}`);
  return { kind: 'mismatch' };
}

async function readUnverified(
  doc: DocumentBytesSource,
  deps: ReadBytesDeps
): Promise<DocumentRead> {
  try {
    if (doc.storageBucket === 'case-files') {
      const path = doc.storagePath;
      if (!path || path.startsWith('/') || path.split('/').includes('..'))
        return UNREADABLE;
      const { data, error } = await deps.storage
        .from('case-files')
        .download(path);
      if (error) return storageFailure(error);
      if (!data || data.size > MAX_READ_BYTES) return UNREADABLE;
      return {
        kind: 'bytes',
        bytes: new Uint8Array(await data.arrayBuffer()),
      };
    }
    if (doc.storageBucket) return UNREADABLE;

    const objectPath = doc.mediaUrl ? chatMediaObjectPath(doc.mediaUrl) : null;
    if (!objectPath) return UNREADABLE;
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
      return transientStatus(res.status) ? UNAVAILABLE : UNREADABLE;
    }
    const bytes = await readCapped(res);
    return bytes ? { kind: 'bytes', bytes } : UNREADABLE;
  } catch {
    // A timeout, a refused connection, a body cut off half way.
    return UNAVAILABLE;
  }
}

/** The bytes, or null for any reason, a mismatch included (see `readDocument`). */
export async function readDocumentBytes(
  doc: DocumentBytesSource,
  deps: ReadBytesDeps
): Promise<Uint8Array | null> {
  const read = await readDocument(doc, deps);
  return read.kind === 'bytes' ? read.bytes : null;
}
