import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/** Newest gaps returned per request — the review is a skim, not a report. */
const GAPS_LIMIT = 100;

/**
 * GET /api/ai/knowledge/gaps  (admin+)
 *
 * Customer questions the retrieval gate refused to answer (migration
 * 052), newest first, for the weekly "what should we add to the
 * knowledge base" review. RLS already restricts the table to admin+;
 * `requireRole` makes the 403 explicit rather than an empty list.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data, error } = await supabase
      .from('ai_knowledge_gaps')
      .select('id, conversation_id, question, best_score, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(GAPS_LIMIT);
    if (error) {
      console.error('[ai/knowledge/gaps GET] error:', error);
      return NextResponse.json(
        { error: 'Failed to load knowledge gaps' },
        { status: 500 }
      );
    }
    return NextResponse.json({ gaps: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/ai/knowledge/gaps  (admin+)
 *
 * Body `{ ids: string[] }` removes the listed rows; `{ all: true }`
 * clears the account's log. Either way it is bookkeeping — the gaps
 * exist so someone can act on them, and "acted on" means delete.
 */
export async function DELETE(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `ai-kb-gaps:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const all = body?.all === true;
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.filter((id: unknown) => typeof id === 'string')
      : [];
    if (!all && ids.length === 0) {
      return NextResponse.json(
        { error: 'Provide `ids` or `all: true`' },
        { status: 400 }
      );
    }

    let query = supabase
      .from('ai_knowledge_gaps')
      .delete()
      .eq('account_id', accountId);
    if (!all) query = query.in('id', ids);
    const { error } = await query;
    if (error) {
      console.error('[ai/knowledge/gaps DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete knowledge gaps' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
