/**
 * Team-chat attachment helpers for the file chip, the image viewer and
 * the Files panel. Pure, so they test without a DOM.
 */

/** Which icon a file chip shows. */
export type FileKind =
  | 'pdf'
  | 'spreadsheet'
  | 'document'
  | 'presentation'
  | 'archive'
  | 'text'
  | 'other';

const BY_EXT: Record<string, FileKind> = {
  pdf: 'pdf',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  ods: 'spreadsheet',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  pages: 'document',
  ppt: 'presentation',
  pptx: 'presentation',
  odp: 'presentation',
  key: 'presentation',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  txt: 'text',
  md: 'text',
  log: 'text',
  json: 'text',
  xml: 'text',
};

/**
 * A file's kind from its mime type, else its extension: a browser often
 * uploads an Office file as application/octet-stream, so the name has
 * the last word when the mime says nothing specific.
 */
export function fileKind(mime: string, name: string): FileKind {
  const m = mime.toLowerCase().split(';')[0].trim();
  if (m === 'application/pdf') return 'pdf';
  if (
    m.includes('spreadsheet') ||
    m.includes('excel') ||
    m === 'text/csv' ||
    m === 'text/tab-separated-values'
  )
    return 'spreadsheet';
  if (m.includes('presentation') || m.includes('powerpoint'))
    return 'presentation';
  if (
    m.includes('wordprocessing') ||
    m === 'application/msword' ||
    m === 'application/rtf' ||
    m === 'application/vnd.oasis.opendocument.text'
  )
    return 'document';
  if (
    m === 'application/zip' ||
    m.includes('compressed') ||
    m === 'application/gzip' ||
    m === 'application/x-tar' ||
    m === 'application/vnd.rar' ||
    m === 'application/x-rar'
  )
    return 'archive';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (Object.hasOwn(BY_EXT, ext)) return BY_EXT[ext];
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * PDFs and plain text open in a new tab (the browser shows them); any
 * other file downloads under its own name.
 */
export const opensInTab = (kind: FileKind): boolean =>
  kind === 'pdf' || kind === 'text';

/**
 * The image viewer's next index: `delta` steps from `index` within
 * `count` images, or null at either end (it does not wrap, so the
 * buttons can be disabled honestly).
 */
export function stepIndex(
  index: number,
  count: number,
  delta: number
): number | null {
  const next = index + delta;
  return next < 0 || next >= count ? null : next;
}

/** The viewer's step for a key press: -1, +1, or 0 for any other key. */
export function lightboxKeyDelta(key: string): -1 | 0 | 1 {
  if (key === 'ArrowLeft') return -1;
  if (key === 'ArrowRight') return 1;
  return 0;
}

/** Tabs of the Files panel; each but All is a channelFiles `kind`. */
export const FILE_TABS = ['all', 'image', 'voice', 'video', 'file'] as const;
export type FileTab = (typeof FILE_TABS)[number];

export const tabKind = (
  tab: FileTab
): 'voice' | 'image' | 'video' | 'file' | null => (tab === 'all' ? null : tab);

/**
 * Appends a later page to a list, dropping any attachment already held
 * (pages can overlap: `before` is a message time, and several
 * attachments share one message).
 */
export function appendPage<T extends { id: string }>(
  list: readonly T[],
  page: readonly T[]
): T[] {
  const seen = new Set(list.map((x) => x.id));
  return [...list, ...page.filter((x) => !seen.has(x.id))];
}

/**
 * Where a page of channelFiles is cut and what the next page asks for.
 * `before` is a strict message time, so a message whose attachments
 * straddle the page end would lose its remaining ones: those trailing
 * rows are held back for the next page (unless they are the whole page).
 */
export function pageCut<T extends { createdAt: string }>(
  items: readonly T[],
  hasMore: boolean
): { keep: T[]; before: string | null } {
  if (!hasMore || items.length === 0) return { keep: [...items], before: null };
  const last = items[items.length - 1].createdAt;
  let end = items.length;
  while (end > 0 && items[end - 1].createdAt === last) end--;
  const keep = end === 0 ? [...items] : items.slice(0, end);
  return { keep, before: keep[keep.length - 1].createdAt };
}
