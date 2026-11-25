import { NextResponse } from 'next/server';
import {
  assertSalesAccess,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/ai/kb/learn/skills/[id]  (admin+)  `{ status }`
 *
 * Retires a learned skill (it stops shaping drafts, and the learner never
 * adds it again) or restores it, through `kb_learn_skill_set_status`,
 * which checks the caller again in SQL.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, userId } = assertSalesAccess(await requireRole('admin'));
    const limit = checkRateLimit(
      `ai-kb-skill:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    if (!UUID_RE.test(id))
      return NextResponse.json({ error: 'Unknown skill' }, { status: 404 });
    const body = await request.json().catch(() => null);
    const status = body?.status;
    if (status !== 'active' && status !== 'retired')
      return NextResponse.json(
        { error: 'status must be active or retired' },
        { status: 400 }
      );
    const { data, error } = await supabase.rpc('kb_learn_skill_set_status', {
      p_skill: id,
      p_status: status,
    });
    if (error) {
      if (error.code === '42501')
        return NextResponse.json({ error: 'Unknown skill' }, { status: 404 });
      if (error.hint === 'SKILL_CAP')
        return NextResponse.json(
          { error: 'Retire another rule first (24 at most)' },
          { status: 409 }
        );
      console.error('[ai/kb/learn/skills PATCH] error:', error);
      return NextResponse.json(
        { error: 'Failed to save the rule' },
        { status: 500 }
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    return toErrorResponse(err);
  }
}
