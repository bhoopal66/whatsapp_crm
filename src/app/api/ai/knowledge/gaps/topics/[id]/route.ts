import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Topic ids change on every recompute, so a stale id is the usual 42501. */
const CHANGED_ERROR = 'That topic has changed — reload';
const BAD_STATUS_ERROR = "status must be 'open' or 'dismissed'";

/**
 * PATCH /api/ai/knowledge/gaps/topics/[id]  (admin+)
 *
 * Body `{ status: 'open' | 'dismissed' }`, through
 * `kb_gap_topic_set_status` on the caller's RLS client (migration 152),
 * the only writer of a topic's status. A missing and a foreign topic
 * are the same 42501 there; both read as "changed" here, because a
 * recompute replacing every id is by far the likelier cause.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `kb-gap-topic:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: CHANGED_ERROR }, { status: 404 });
    }
    const body = await request.json().catch(() => null);
    const status = body?.status;
    if (status !== 'open' && status !== 'dismissed') {
      return NextResponse.json({ error: BAD_STATUS_ERROR }, { status: 400 });
    }

    const { error } = await supabase.rpc('kb_gap_topic_set_status', {
      p_topic: id,
      p_status: status,
    });
    if (error) {
      if (error.code === '42501') {
        return NextResponse.json({ error: CHANGED_ERROR }, { status: 404 });
      }
      if (error.code === '22023') {
        return NextResponse.json({ error: BAD_STATUS_ERROR }, { status: 400 });
      }
      console.error('[ai/knowledge/gaps/topics/[id] PATCH] error:', error);
      return NextResponse.json(
        { error: 'Failed to update topic' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true, status });
  } catch (err) {
    return toErrorResponse(err);
  }
}
