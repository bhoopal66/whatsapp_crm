/**
 * The text of a passed case file, for the reviewer's model narrative
 * (package 031b). Text layer only, no OCR: a scan, an image, an
 * encrypted or over-long file, or a file that cannot be read in time is
 * `unreadable` with a reason, and the draft says it needs a person.
 * The text is used for one model call and never stored.
 */
import { extractPdfPages } from '@/lib/ai/extract-text';

export const REVIEW_PDF_LIMITS = {
  maxPages: 30,
  maxChars: 400_000,
  timeoutMs: 10_000,
} as const;
export const REVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** Below this many characters per page a PDF is taken for a scan. */
export const MIN_CHARS_PER_PAGE = 40;
/** The most text one file contributes. */
export const REVIEW_TEXT_CAP = 60_000;

export type Unreadable =
  'image' | 'too_large' | 'scanned' | 'timeout' | 'unreadable';

export type Extracted =
  { ok: true; text: string } | { ok: false; reason: Unreadable };

export async function extractReviewText(
  bytes: Uint8Array,
  mime: string | null
): Promise<Extracted> {
  if (mime !== 'application/pdf') return { ok: false, reason: 'image' };
  if (bytes.byteLength > REVIEW_MAX_BYTES)
    return { ok: false, reason: 'too_large' };
  let pages: string[];
  try {
    pages = await extractPdfPages(bytes, REVIEW_PDF_LIMITS);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'pdf_too_long') return { ok: false, reason: 'too_large' };
    if (code === 'pdf_timeout') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'unreadable' };
  }
  const text = pages
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
  if (
    pages.length === 0 ||
    text.replace(/\s/g, '').length / pages.length < MIN_CHARS_PER_PAGE
  )
    return { ok: false, reason: 'scanned' };
  return { ok: true, text: text.slice(0, REVIEW_TEXT_CAP) };
}
