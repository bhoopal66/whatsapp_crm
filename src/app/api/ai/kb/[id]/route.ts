import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  isUnusableApprovalError,
  KB_ENTRY_COLUMNS,
  parseKbEntryPatch,
} from '@/lib/kb/requests';

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/ai/kb/[id]  (admin+) — edit one approved-answers row.
 * Version and the approval stamp are trigger-owned (migration 081).
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const parsed = parseKbEntryPatch(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_entries')
      .update(parsed.values)
      .eq('account_id', accountId)
      .eq('id', id)
      .select(KB_ENTRY_COLUMNS)
      .maybeSingle();
    if (error) {
      if (isUnusableApprovalError(error)) {
        return NextResponse.json(
          {
            error:
              "An answer that is empty or still says [TO CONFIRM] can't be approved",
          },
          { status: 400 }
        );
      }
      console.error('[ai/kb/[id] PATCH] error:', error);
      return NextResponse.json(
        { error: 'Failed to update answer' },
        { status: 500 }
      );
    }
    if (!data)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ entry: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/ai/kb/[id]  (admin+)
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await params;
    const { error } = await supabase
      .from('kb_entries')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id);
    if (error) {
      console.error('[ai/kb/[id] DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete answer' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
