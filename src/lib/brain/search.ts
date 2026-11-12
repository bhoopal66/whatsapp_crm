/**
 * Ported from wacrm module 022a (second brain): hybrid search. The query is
 * redacted (the same rules as ingest) and embedded; brain_search_candidates
 * returns the role-visible, live, unmarked candidates with their cosine
 * similarity and keyword rank; each is scored
 *   score = COSINE_WEIGHT * cosine + KEYWORD_WEIGHT * kwRank   (both in [0, 1])
 * and hits at or above minScore are returned best first, at most `limit`.
 * Every search writes one brain_audit row with sha256(redacted query) and the
 * hit count - never the query text. Forgotten items are never candidates.
 * Server-only (node:crypto).
 */
import { createHash } from 'node:crypto';

import type {
  BrainFilters,
  BrainHit,
  BrainStore,
  Embedder,
  VectorIndex,
} from './ports';
import { brainRedact } from './redact';
import { tokens } from './embed';

export const COSINE_WEIGHT = 0.7;
export const KEYWORD_WEIGHT = 0.3;
export const SNIPPET_MAX = 240;

export interface SearchDeps {
  store: BrainStore;
  index: VectorIndex;
  embedder: Embedder;
}
export interface SearchInput {
  actorId: string;
  accountId: string;
  query: string;
  filters?: BrainFilters;
  /** Default 10, at most 50. */
  limit?: number;
  /** Default 0.15. */
  minScore?: number;
}

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

/** <= SNIPPET_MAX chars of text around the first query token found (else its start). */
export function snippet(text: string, queryTokens: readonly string[]): string {
  if (text.length <= SNIPPET_MAX) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of queryTokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start =
    at < 0 ? 0 : Math.max(0, Math.min(at - 60, text.length - SNIPPET_MAX));
  return text.slice(start, start + SNIPPET_MAX);
}

export async function searchBrain(
  deps: SearchDeps,
  input: SearchInput
): Promise<BrainHit[]> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 50);
  const minScore = input.minScore ?? 0.15;
  const red = brainRedact(input.query);
  const query = red.ok ? red.text : '';
  let hits: BrainHit[] = [];
  if (query.trim() !== '') {
    const [vector = []] = await deps.embedder.embed([query]);
    const cands = await deps.index.candidates({
      actorId: input.actorId,
      accountId: input.accountId,
      queryText: query,
      vector,
      model: deps.embedder.model,
      filters: input.filters,
      limit: limit * 5,
    });
    const qt = tokens(query);
    hits = cands
      .map((c) => ({
        c,
        score:
          COSINE_WEIGHT * Math.max(c.cosine, 0) + KEYWORD_WEIGHT * c.kwRank,
      }))
      .filter((x) => x.score >= minScore && x.c.text !== '')
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.c.createdAt.getTime() - a.c.createdAt.getTime() ||
          (a.c.itemId < b.c.itemId ? -1 : 1)
      )
      .slice(0, limit)
      .map(({ c, score }) => ({
        itemId: c.itemId,
        snippet: snippet(c.text, qt),
        sourceKind: c.sourceKind,
        caseId: c.caseId,
        score,
        aiGenerated: c.aiGenerated,
        citation: { kind: c.sourceKind, id: c.sourceId },
      }));
  }
  await deps.store.audit(
    input.accountId,
    input.actorId,
    sha256Hex(query),
    hits.length
  );
  return hits;
}
