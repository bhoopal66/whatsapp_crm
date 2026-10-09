import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import type { KnowledgeBanksResponse } from '@/lib/typesafe/admin-types';
import {
  KNOWLEDGE_BANKS_CHUNK_LIMIT,
  knowledgeBankMentions,
  type KnowledgeChunk,
} from '@/lib/typesafe/knowledge-banks';

/**
 * GET /api/typesafe/knowledge-banks (admin+) → KnowledgeBanksResponse
 *
 * The catalogue banks the account's knowledge base mentions, counted in
 * documents, so Settings → AI safety checks → Partner banks can offer
 * the ones the business evidently works with. Bounded: the newest
 * KNOWLEDGE_BANKS_CHUNK_LIMIT chunks.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data, error } = await supabase
      .from('ai_knowledge_chunks')
      .select('document_id, content')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(KNOWLEDGE_BANKS_CHUNK_LIMIT);
    if (error) {
      console.error('[typesafe/knowledge-banks GET] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to read the knowledge base' },
        { status: 500 }
      );
    }
    const body: KnowledgeBanksResponse = {
      banks: knowledgeBankMentions((data ?? []) as KnowledgeChunk[]),
    };
    return NextResponse.json(body);
  } catch (err) {
    return toErrorResponse(err);
  }
}
