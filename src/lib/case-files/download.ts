/**
 * Download URLs for case files and case builds (migration 182).
 *
 * Two sources only, the same two `bytes.ts` reads:
 *   - a 'case-files' storage object: a signed URL, valid 600 s, built by
 *     the service-role client on the internal origin and re-pointed at the
 *     public one (`toPublicSupabaseUrl`);
 *   - a public chat-media object URL: already public, served re-pointed,
 *     with no expiry.
 * Anything else has no URL (null), so the server never hands out an
 * arbitrary link.
 *
 * Order (the audit contract): the route writes the download row first,
 * then produces the URL here, then marks it issued. A signer failure
 * throws, so the row stays `url_issued = false`.
 */
import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

import { chatMediaObjectPath } from './bytes';
import { CASE_FILES_BUCKET } from './intake-file';
import { CaseFilesStoreError, type CustomerDocumentRow } from './store';

export const DOWNLOAD_URL_TTL_SECONDS = 600;

/** The storage surface signing needs: supabase-js `admin.storage` fits it. */
export interface CaseFilesSigner {
  from(bucket: string): {
    createSignedUrl(
      path: string,
      expiresIn: number
    ): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
  };
}

export interface DownloadUrl {
  url: string;
  /** ISO time the URL stops working; null for an already-public object. */
  expiresAt: string | null;
}

/** The storage client when it can sign, else null (501 NOT_CONFIGURED). */
export function signerOf(storage: unknown): CaseFilesSigner | null {
  const s = storage as { from?: unknown } | null | undefined;
  return s && typeof s.from === 'function' ? (s as CaseFilesSigner) : null;
}

/** A relative path inside the bucket, with no '..' segment. */
function safeObjectPath(path: string | null): path is string {
  return !!path && !path.startsWith('/') && !path.split('/').includes('..');
}

/** A signed 'case-files' URL; throws CaseFilesStoreError when signing fails. */
export async function signCaseFilesObject(
  signer: CaseFilesSigner,
  objectPath: string,
  now: Date
): Promise<DownloadUrl> {
  let signed: { data: { signedUrl: string } | null; error: unknown };
  try {
    signed = await signer
      .from(CASE_FILES_BUCKET)
      .createSignedUrl(objectPath, DOWNLOAD_URL_TTL_SECONDS);
  } catch {
    throw new CaseFilesStoreError('storage.createSignedUrl', null);
  }
  if (signed.error || !signed.data?.signedUrl)
    throw new CaseFilesStoreError('storage.createSignedUrl', null);
  return {
    url: toPublicSupabaseUrl(signed.data.signedUrl),
    expiresAt: new Date(
      now.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000
    ).toISOString(),
  };
}

/**
 * The URL of one customer document, or null when its location is neither
 * a 'case-files' object nor a public chat-media object.
 */
export async function documentDownloadUrl(
  doc: Pick<CustomerDocumentRow, 'mediaUrl' | 'storageBucket' | 'storagePath'>,
  signer: CaseFilesSigner,
  now: Date
): Promise<DownloadUrl | null> {
  if (doc.storageBucket === CASE_FILES_BUCKET) {
    if (!safeObjectPath(doc.storagePath)) return null;
    return signCaseFilesObject(signer, doc.storagePath, now);
  }
  if (doc.storageBucket) return null;
  if (!doc.mediaUrl || !chatMediaObjectPath(doc.mediaUrl)) return null;
  return { url: toPublicSupabaseUrl(doc.mediaUrl), expiresAt: null };
}
