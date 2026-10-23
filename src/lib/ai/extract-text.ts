import type { getDocumentProxy } from 'unpdf';
import { AiError } from './types';

/**
 * Turn an uploaded knowledge-base file into plain text for `chunkText`.
 *
 * PDFs go through `unpdf` (pdf.js packaged for Node/serverless, no
 * native deps). Everything else accepted here is already text. A
 * scanned PDF — images of pages, no text layer — extracts to nothing;
 * that is reported rather than silently saving an empty document,
 * because an empty document is indistinguishable from "the bot never
 * read it" once someone is debugging an unanswered question.
 */

/** 10 MB — well above any FAQ or product sheet, small enough to hold in memory. */
export const MAX_KNOWLEDGE_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * A 10 MB PDF can still hold far more than 10 MB of work: content
 * streams are compressed, and pdf.js parses on the request's own thread.
 * So a PDF is read page by page within these limits:
 *
 * - `maxPages`: a longer document is refused before any page is read.
 * - `maxChars`: text past it is refused rather than cut off, because a
 *   truncated manual would answer from its first half without anyone
 *   knowing the rest was never read. Split the file instead.
 * - `timeoutMs`: wall clock for the whole read. A race cannot stop a
 *   page pdf.js is already parsing, so the deadline is checked between
 *   steps and the document is destroyed, which ends the rest.
 */
export interface PdfLimits {
  maxPages: number;
  maxChars: number;
  timeoutMs: number;
}

export const PDF_LIMITS: Readonly<PdfLimits> = {
  maxPages: 500,
  maxChars: 2_000_000,
  timeoutMs: 20_000,
};

const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json)$/i;

export function isSupportedKnowledgeFile(name: string, type: string): boolean {
  return (
    type === 'application/pdf' ||
    /\.pdf$/i.test(name) ||
    TEXT_TYPES.has(type) ||
    TEXT_EXTENSIONS.test(name)
  );
}

/** `work`, or a `pdf_timeout` error once `deadline` (epoch ms) passes. */
export function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AiError(
            'Reading the PDF took too long. Split it into smaller files, or paste the text instead.',
            { code: 'pdf_timeout', status: 400 }
          )
        ),
      Math.max(0, deadline - Date.now())
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Every page's text, as unpdf's `extractText` joins it, within `limits`. */
async function extractPdfText(
  bytes: Uint8Array,
  limits: PdfLimits
): Promise<string> {
  const unpdf = await import('unpdf');
  const deadline = Date.now() + limits.timeoutMs;
  const loading = unpdf.getDocumentProxy(bytes);
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await beforeDeadline(loading, deadline);
  } catch (err) {
    // A document that finishes loading after the deadline is still freed.
    void loading.then((late) => late.loadingTask.destroy()).catch(() => {});
    throw err;
  }
  try {
    if (pdf.numPages > limits.maxPages) {
      throw new AiError(
        `The PDF has ${pdf.numPages} pages; the limit is ${limits.maxPages}. Split it into smaller files.`,
        { code: 'pdf_too_long', status: 413 }
      );
    }
    const pages: string[] = [];
    let chars = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await beforeDeadline(pdf.getPage(n), deadline);
      const content = await beforeDeadline(page.getTextContent(), deadline);
      const text = content.items
        .map((item) =>
          'str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''
        )
        .join('');
      chars += text.length + 1;
      if (chars > limits.maxChars) {
        throw new AiError(
          `The PDF holds more than ${limits.maxChars} characters of text. Split it into smaller files.`,
          { code: 'pdf_too_long', status: 413 }
        );
      }
      pages.push(text);
    }
    // unpdf's own merge (`normalizeMergedText`), so the text is what
    // `extractText(…, { mergePages: true })` returned before.
    return pages
      .join('\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  } finally {
    void pdf.loadingTask.destroy().catch(() => {});
  }
}

/** `limits` overrides PDF_LIMITS (tests lower them). */
export async function extractKnowledgeText(
  name: string,
  type: string,
  bytes: ArrayBuffer,
  limits?: Partial<PdfLimits>
): Promise<string> {
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name);
  let text: string;
  if (isPdf) {
    try {
      text = await extractPdfText(new Uint8Array(bytes), {
        ...PDF_LIMITS,
        ...limits,
      });
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError(
        `Could not read the PDF: ${err instanceof Error ? err.message : 'unknown error'}`,
        { code: 'pdf_unreadable', status: 400 }
      );
    }
  } else {
    text = new TextDecoder('utf-8').decode(bytes);
  }

  // Collapse the whitespace pdf.js leaves between text runs while
  // keeping paragraph breaks, which the chunker splits on.
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) {
    throw new AiError(
      isPdf
        ? 'The PDF has no selectable text — it looks like a scanned image. Paste the text instead.'
        : 'The file is empty.',
      { code: 'no_text', status: 400 }
    );
  }
  return cleaned;
}

/** "Bank account packages.pdf" → "Bank account packages". */
export function titleFromFilename(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || name
  );
}
