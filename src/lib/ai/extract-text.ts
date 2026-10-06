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

export async function extractKnowledgeText(
  name: string,
  type: string,
  bytes: ArrayBuffer
): Promise<string> {
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name);
  let text: string;
  if (isPdf) {
    const { extractText } = await import('unpdf');
    try {
      const result = await extractText(new Uint8Array(bytes), {
        mergePages: true,
      });
      text = result.text;
    } catch (err) {
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
