/**
 * File preview while sorting (U5, migration 248): the pure part, shared
 * by the routes and the browser. No I/O and no server imports.
 *
 *   - `previewKind`: how the screen shows a file (an image, a PDF in a
 *     frame, or only an "Open in new tab" link);
 *   - `intakeObjectPath` / `isIntakeObjectPath`: 220's storage path rule
 *     ('intake/<item id>/<sha256>.<ext>'), checked again before signing
 *     so a route never signs any other object;
 *   - the two route URLs the preview component fetches.
 */

export type PreviewKind = 'image' | 'pdf' | 'other';

/** Seconds a signed preview URL works for. */
export const PREVIEW_URL_TTL_SECONDS = 300;

const IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

/**
 * The way to show a file. The MIME type decides; a file name's extension
 * is only a fallback when the MIME type is missing or generic. HEIC,
 * Word and the rest are 'other': the browser cannot show them inline.
 */
export function previewKind(
  mime: string | null | undefined,
  name?: string | null
): PreviewKind {
  const m = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (IMAGE_MIMES.has(m)) return 'image';
  if (m === '' || m === 'application/octet-stream') {
    const n = (name ?? '').trim();
    if (/\.pdf$/i.test(n)) return 'pdf';
    if (IMAGE_EXT.test(n)) return 'image';
  }
  return 'other';
}

/** 220's extension for an accepted intake MIME type, else null. */
export function intakeExtension(mime: string): string | null {
  switch (mime) {
    case 'application/pdf':
      return 'pdf';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    default:
      return null;
  }
}

/** 'intake/<item id>/<sha256>.<ext>', or null for a MIME 220 refuses. */
export function intakeObjectPath(
  itemId: string,
  sha256: string,
  mime: string
): string | null {
  const ext = intakeExtension(mime);
  return ext ? `intake/${itemId}/${sha256}.${ext}` : null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INTAKE_PATH = new RegExp(
  `^intake/(${UUID})/[0-9a-f]{64}\\.(pdf|jpg|png)$`,
  'i'
);

/** Is `path` an intake object, and of this item? */
export function isIntakeObjectPath(path: unknown, itemId: string): boolean {
  if (typeof path !== 'string') return false;
  const m = INTAKE_PATH.exec(path);
  return !!m && m[1].toLowerCase() === itemId.toLowerCase();
}

export type PreviewTarget =
  { type: 'intake'; id: string } | { type: 'tray'; id: string };

/** The route that signs this target's preview URL. */
export function previewRoute(target: PreviewTarget): string {
  const id = encodeURIComponent(target.id);
  return target.type === 'intake'
    ? `/api/desk/intake/${id}/preview`
    : `/api/desk/tray/${id}/preview`;
}

/** What the preview routes answer. */
export interface PreviewLink {
  url: string;
  /** ISO time the URL stops working; null for an already-public object. */
  expiresAt: string | null;
  mime: string | null;
  name: string | null;
  kind: PreviewKind;
}

export type PreviewErrorKey =
  'notFound' | 'notAllowed' | 'notConfigured' | 'generic';

/** Which plain-English message a failed preview call shows. */
export function previewErrorKey(
  status: number | null,
  code: string | null
): PreviewErrorKey {
  if (code === 'NOT_CONFIGURED' || status === 501) return 'notConfigured';
  if (
    code === 'ITEM_NOT_FOUND' ||
    code === 'TRAY_NOT_FOUND' ||
    code === 'FILE_NOT_FOUND' ||
    status === 404
  )
    return 'notFound';
  if (status === 401 || status === 403) return 'notAllowed';
  return 'generic';
}

/** Milliseconds until a link should be fetched again, or null (never). */
export function msUntilExpiry(
  expiresAt: string | null,
  now: number
): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** A route's JSON as a PreviewLink, or null when it is not one. */
export function parsePreviewLink(body: unknown): PreviewLink | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.url !== 'string' || !/^https?:\/\//i.test(b.url)) return null;
  const s = (v: unknown) => (typeof v === 'string' ? v : null);
  const mime = s(b.mime);
  const name = s(b.name);
  return {
    url: b.url,
    expiresAt: s(b.expiresAt),
    mime,
    name,
    kind: previewKind(mime, name),
  };
}
