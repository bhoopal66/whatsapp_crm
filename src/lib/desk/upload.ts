/**
 * The bytes of a desk upload (migration 220). Refused (type, size, magic
 * bytes) before anything is written, then stored in the private
 * 'case-files' bucket at 'intake/<item id>/<sha256>.<ext>', the path the
 * intake_items CHECK requires. Filing records that object as the
 * uploader's staff_upload document in the case contact's folder (180),
 * so the NAS worker copies it like any other case file.
 *
 * A refused or replayed submit leaves its object behind (the item id is
 * new each time); see docs/case-desk.md.
 */
import {
  CASE_FILE_MIME,
  magicMatches,
  normalizeMime,
  sanitizeOriginalName,
  sha256Hex,
  type CaseFileMime,
} from '@/lib/case-files/checks';
import type { CaseFilesStorage } from '@/lib/case-files/bytes';
import {
  CASE_FILES_BUCKET,
  isAlreadyExists,
  MAX_UPLOAD_BYTES,
} from '@/lib/case-files/intake-file';

import { DeskRefusedError, DeskStoreError, type ItemFile } from './store';

export { MAX_UPLOAD_BYTES };

const EXT: Readonly<Record<CaseFileMime, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export function intakePath(itemId: string, sha256: string, mime: CaseFileMime) {
  return `intake/${itemId}/${sha256}.${EXT[mime]}`;
}

/** Checks the file and returns its metadata; FILE_INVALID when refused. */
export function prepareIntakeFile(
  itemId: string,
  file: { bytes: Uint8Array; mime: string; originalName: string }
): ItemFile & { mime: CaseFileMime } {
  const mime = normalizeMime(file.mime);
  if (!(CASE_FILE_MIME as readonly string[]).includes(mime))
    throw new DeskRefusedError('FILE_INVALID');
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_UPLOAD_BYTES)
    throw new DeskRefusedError('FILE_INVALID');
  // The declared type is only a claim: the bytes must agree.
  if (!magicMatches(file.bytes, mime))
    throw new DeskRefusedError('FILE_INVALID');
  const sha256 = sha256Hex(file.bytes);
  const m = mime as CaseFileMime;
  return {
    storagePath: intakePath(itemId, sha256, m),
    originalName: sanitizeOriginalName(file.originalName) || 'upload',
    mime: m,
    sizeBytes: file.bytes.byteLength,
    sha256,
  };
}

export async function storeIntakeFile(
  storage: CaseFilesStorage,
  meta: ItemFile,
  bytes: Uint8Array
): Promise<void> {
  let stored: { error: unknown };
  try {
    stored = await storage
      .from(CASE_FILES_BUCKET)
      .upload(meta.storagePath, bytes, {
        contentType: meta.mime,
        upsert: false,
      });
  } catch {
    throw new DeskStoreError('storage.upload', null);
  }
  if (stored.error && !isAlreadyExists(stored.error))
    throw new DeskStoreError('storage.upload', null);
}
