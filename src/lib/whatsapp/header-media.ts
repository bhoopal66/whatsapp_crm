import { MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';

/**
 * What a template's media header may be, per kind — shared by the
 * template editor and the broadcast wizard so both offer the same
 * upload and reject the same files.
 *
 * The MIME lists are the intersection of what WhatsApp accepts for a
 * template header and what the `chat-media` bucket allows (migration
 * 039): a file that passes here will upload. Sizes follow Meta's
 * header limits (image 5 MB, video 16 MB) — Whapi is looser but a
 * template row serves both numbers, so the stricter bound wins.
 */
export type MediaHeaderKind = 'image' | 'video' | 'document';

export const HEADER_MEDIA_MIME: Record<MediaHeaderKind, readonly string[]> = {
  image: ['image/jpeg', 'image/png'],
  video: ['video/mp4', 'video/3gpp'],
  document: ['application/pdf'],
};

/** Value for an `<input type="file" accept>` for the given kind. */
export function headerMediaAccept(kind: MediaHeaderKind): string {
  return HEADER_MEDIA_MIME[kind].join(',');
}

export function isMediaHeaderKind(value: unknown): value is MediaHeaderKind {
  return value === 'image' || value === 'video' || value === 'document';
}

export type HeaderMediaFileError =
  | { kind: 'type'; allowed: readonly string[] }
  | { kind: 'size'; maxBytes: number; bytes: number };

/**
 * Check a picked file against the header kind before uploading. Pure —
 * the callers turn the error into a toast in their own language.
 */
export function validateHeaderMediaFile(
  kind: MediaHeaderKind,
  file: { type: string; size: number }
): HeaderMediaFileError | null {
  const allowed = HEADER_MEDIA_MIME[kind];
  if (!allowed.includes(file.type)) return { kind: 'type', allowed };
  const maxBytes = MEDIA_MAX_BYTES_BY_KIND[kind];
  if (file.size > maxBytes) return { kind: 'size', maxBytes, bytes: file.size };
  return null;
}

/** Megabytes with one decimal, for the size toasts. */
export function toMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
