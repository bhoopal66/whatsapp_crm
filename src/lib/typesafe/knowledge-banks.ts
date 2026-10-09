/**
 * Which catalogue banks an account's knowledge base mentions, so the
 * Partner banks setting can suggest the ones the business evidently
 * works with ("mentions First Abu Dhabi Bank (FAB) — in 3 documents").
 * Pure: `GET /api/typesafe/knowledge-banks` reads the chunks.
 */
import { BANKS, detectBanks } from './banks';
import type { KnowledgeBankMention } from './admin-types';
import { bankDisplayName } from './partner-banks-settings';

/** Newest chunks scanned per request. */
export const KNOWLEDGE_BANKS_CHUNK_LIMIT = 2000;

export interface KnowledgeChunk {
  document_id: string;
  content: string;
}

/**
 * Counts, per catalogue bank, the documents whose chunks mention it.
 * A document's chunks are scanned as one text (they were split from
 * it), so each document runs detection once. Most documents first,
 * then by name.
 */
export function knowledgeBankMentions(
  chunks: readonly KnowledgeChunk[]
): KnowledgeBankMention[] {
  const byDocument = new Map<string, string[]>();
  for (const c of chunks) {
    if (typeof c.content !== 'string' || !c.content) continue;
    const parts = byDocument.get(c.document_id);
    if (parts) parts.push(c.content);
    else byDocument.set(c.document_id, [c.content]);
  }

  // The separator stops a name forming across two chunks that were not
  // adjacent ("…First Abu" + "Dhabi Bank…"): detectBanks treats
  // whitespace as one space but a dot as a word of its own.
  const counts = new Map<string, number>();
  for (const parts of byDocument.values())
    for (const hit of detectBanks(parts.join('\n.\n')))
      counts.set(hit.code, (counts.get(hit.code) ?? 0) + 1);

  const out: KnowledgeBankMention[] = [];
  for (const b of BANKS) {
    const documents = counts.get(b.code);
    if (documents)
      out.push({ code: b.code, name: bankDisplayName(b), documents });
  }
  return out.sort(
    (a, b) => b.documents - a.documents || a.name.localeCompare(b.name)
  );
}
