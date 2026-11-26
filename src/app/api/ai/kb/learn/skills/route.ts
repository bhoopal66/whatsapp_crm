import { NextResponse } from 'next/server';
import {
  assertSalesAccess,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { parseSkillList } from '@/lib/kb/skills-view';

/**
 * GET /api/ai/kb/learn/skills  (admin+)
 *
 * The skill library the learner built from admins' reviews (migration
 * 318), active first. Read through RLS (admin+ only). A failed read
 * is a 500 with a generic message, never an empty list: the screen shows
 * an error with Retry, and the switch only mounts the list once the
 * migration is known to be applied.
 */
export async function GET() {
  try {
    const { supabase, accountId } = assertSalesAccess(
      await requireRole('admin')
    );
    const { data, error } = await supabase
      .from('kb_learn_skills')
      .select(
        'id, kind, category, title, principle, when_to_apply, status, evidence_count, created_at'
      )
      .eq('account_id', accountId)
      .order('status', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      console.error('[ai/kb/learn/skills GET] error:', error);
      return NextResponse.json(
        { error: 'Failed to load what it has learned' },
        { status: 500 }
      );
    }
    return NextResponse.json({ skills: parseSkillList(data) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
