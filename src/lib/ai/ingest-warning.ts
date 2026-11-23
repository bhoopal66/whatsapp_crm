import { AiError } from './types';

/** The document's chunks could not be written: no search finds it now. */
export class KnowledgeIndexError extends Error {
  constructor(detail: string) {
    super(`The document is not indexed (${detail})`);
    this.name = 'KnowledgeIndexError';
  }
}

/** What a knowledge route tells the admin when `ingestDocument` threw. */
export function ingestWarning(
  saved: 'Saved' | 'Updated',
  err: unknown
): string {
  if (err instanceof KnowledgeIndexError) {
    return `${saved}, but the document is not indexed, so the AI cannot find it. Use Reindex to retry.`;
  }
  const message = err instanceof AiError ? err.message : 'indexing failed';
  return `${saved}, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`;
}
