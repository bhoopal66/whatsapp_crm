/**
 * Files that reach the team-chat composer without the file picker: a
 * paste (a screenshot on the clipboard) or a drag-and-drop. Pure, so the
 * rules are tested without a DOM; the composer hands in the event's
 * DataTransfer.
 */

/** The parts of a DataTransfer (drag or clipboard) these rules read. */
export interface TransferLike<F> {
  readonly types?: ArrayLike<string> | null;
  readonly files?: ArrayLike<F> | null;
  readonly items?: ArrayLike<{
    readonly kind: string;
    getAsFile(): F | null;
  }> | null;
  getData?(format: string): string;
}

/**
 * Whether a drag carries files. During dragenter/dragover the browser
 * hides the files themselves, so only `types` can tell; a drag of
 * selected text or a link carries none and is left to the browser.
 */
export function carriesFiles(
  dt: Pick<TransferLike<unknown>, 'types'> | null | undefined
): boolean {
  return !!dt?.types && Array.from(dt.types).includes('Files');
}

/**
 * The files of a drop or a paste. `files` when the browser filled it;
 * otherwise the file items (some browsers put a pasted image only there).
 */
export function transferFiles<F>(dt: TransferLike<F> | null | undefined): F[] {
  if (!dt) return [];
  const files = Array.from(dt.files ?? []);
  if (files.length) return files;
  return Array.from(dt.items ?? []).flatMap((item) => {
    if (item.kind !== 'file') return [];
    const f = item.getAsFile();
    return f ? [f] : [];
  });
}

/**
 * What a paste does: the files it carries are attached, and the browser's
 * own paste is cancelled only when there is no text to paste with them,
 * so text (also text copied alongside an image) lands in the input as
 * before and a paste with no files is left alone entirely.
 */
export function pastePlan<F>(dt: TransferLike<F> | null | undefined): {
  files: F[];
  preventDefault: boolean;
} {
  const files = transferFiles(dt);
  if (!files.length) return { files, preventDefault: false };
  const text = dt?.getData?.('text/plain') ?? '';
  return { files, preventDefault: text === '' };
}

/**
 * The window sees a dragenter and a dragleave for every element the
 * pointer crosses, so "files are over the page" is a depth count that a
 * drop (or the drag ending) resets.
 */
export function nextDragDepth(
  depth: number,
  event: 'enter' | 'leave' | 'drop'
): number {
  if (event === 'enter') return depth + 1;
  if (event === 'leave') return Math.max(0, depth - 1);
  return 0;
}

/** Image types a browser shows in an <img> from an object URL. */
const PREVIEWABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

/** Whether a picked file's chip gets a thumbnail (others keep the icon). */
export function isPreviewableImage(mime: string | null | undefined): boolean {
  return !!mime && PREVIEWABLE.has(mime.toLowerCase());
}
