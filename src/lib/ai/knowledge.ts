import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiConfig } from './types';
import { chunkText } from './chunk';
import { embedTexts, toVectorLiteral } from './embeddings';

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

interface MatchRow {
  id: string;
  content: string;
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string
): Promise<void> {
  const chunks = chunkText(content);

  // Replace, don't append — re-ingest must be idempotent.
  const { error: delErr } = await db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId);
  if (delErr) throw delErr;

  if (chunks.length === 0) return;

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null;
  let embedError: unknown = null;
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks);
    } catch (err) {
      embedError = err;
    }
  }

  const rows = chunks.map((content, i) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: i,
    content,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
  }));

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows);
  if (insErr) throw insErr;

  if (embedError) throw embedError;
}

/**
 * What retrieval found, with enough signal for the auto-reply bot's
 * retrieval gate (migration 052) to decide whether to answer at all.
 */
export interface KnowledgeRetrieval {
  /** Excerpts to ground the reply in, best first. */
  excerpts: string[];
  /**
   * The same excerpts with their chunk id and similarity (null for a
   * lexical-only hit), for the TypeSafe passage filter (063), which
   * screens and logs each one by id.
   */
  passages: RetrievedChunk[];
  /**
   * Best cosine similarity (1 − pgvector distance, so 0–1, higher is
   * closer) among the semantic hits, or null when the semantic path
   * didn't run (no embeddings key, embedding failure, RPC error). The
   * lexical top-up contributes nothing here: `ts_rank` is unnormalised
   * and not comparable across queries.
   */
  bestSimilarity: number | null;
  /** False when the account has no chunks at all (or the count failed),
   *  so callers can tell "nothing relevant" from "nothing to search". */
  hasKnowledgeBase: boolean;
}

export interface RetrievedChunk {
  id: string;
  content: string;
  similarity: number | null;
}

interface SemanticRow extends MatchRow {
  distance: number;
}

const EMPTY: KnowledgeRetrieval = {
  excerpts: [],
  passages: [],
  bestSimilarity: null,
  hasKnowledgeBase: false,
};

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`, with
 * the retrieval score the gate needs.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, RPC error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledgeScored(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5
): Promise<KnowledgeRetrieval> {
  const query = queryText.trim();
  if (!query || k <= 0) return EMPTY;

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    if (error || !count) return EMPTY;
  } catch {
    return EMPTY;
  }

  const picked = new Map<string, RetrievedChunk>(); // id → chunk, preserves order
  let bestSimilarity: number | null = null;

  // Semantic path.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [
        query,
      ]);
      if (queryEmbedding) {
        const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
          p_account_id: accountId,
          p_query_embedding: toVectorLiteral(queryEmbedding),
          p_match_count: k,
        });
        if (!error && Array.isArray(data)) {
          for (const row of data as SemanticRow[]) {
            const sim = similarityFromDistance(row.distance);
            picked.set(row.id, {
              id: row.id,
              content: row.content,
              similarity: sim,
            });
            if (
              sim !== null &&
              (bestSimilarity === null || sim > bestSimilarity)
            ) {
              bestSimilarity = sim;
            }
          }
        }
      }
    } catch (err) {
      console.error(
        '[ai knowledge] semantic retrieval failed, falling back to FTS:',
        err
      );
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
      });
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break;
          if (!picked.has(row.id)) {
            picked.set(row.id, {
              id: row.id,
              content: row.content,
              similarity: null,
            });
          }
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err);
    }
  }

  const passages = Array.from(picked.values()).slice(0, k);
  return {
    excerpts: passages.map((p) => p.content),
    passages,
    bestSimilarity,
    hasKnowledgeBase: true,
  };
}

/**
 * pgvector's `<=>` is cosine *distance* (0 = identical, 2 = opposite);
 * the gate is configured as a similarity so the number an admin types
 * reads naturally ("at least 0.4 alike"). Tolerates the RPC not
 * returning the column (an older migration) by yielding null.
 */
function similarityFromDistance(distance: unknown): number | null {
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return null;
  return Math.max(0, Math.min(1, 1 - distance));
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 * Convenience over {@link retrieveKnowledgeScored} for callers that only
 * ground a prompt (draft route, playground) and never gate on the score.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5
): Promise<string[]> {
  const { excerpts } = await retrieveKnowledgeScored(
    db,
    accountId,
    config,
    queryText,
    k
  );
  return excerpts;
}
