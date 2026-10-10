import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  isKbEntryId,
  isUnusableApprovalError,
  KB_ENTRY_COLUMNS,
  parseKbEntryPatch,
} from '@/lib/kb/requests';

type Params = { params: Promise<{ id: string }> };

/** The 409 a dialog opened on an older version of the row gets. */
const STALE_ERROR =
  'This answer changed since you opened it. Reload and review it again.';

/**
 * PATCH /api/ai/kb/[id]  (admin+) — edit one approved-answers row.
 * Version and the approval stamp are trigger-owned (migration 081).
 *
 * The body carries the `version` the dialog displayed, and the update
 * applies only while the row still has it: approving in a dialog
 * opened before someone else changed the answer (or its status,
 * audience or hand-off, which all bump version) is a 409, never an
 * approval of text the approver did not see.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!isKbEntryId(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }
    const parsed = parseKbEntryPatch(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('kb_entries')
      .update(parsed.values)
      .eq('account_id', accountId)
      .eq('id', id)
      .eq('version', parsed.version)
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
    if (data) return NextResponse.json({ entry: data });

    // Nothing updated: the row is gone (or another account's), or its
    // version moved on since the dialog read it.
    const { data: current, error: readError } = await supabase
      .from('kb_entries')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (readError) {
      console.error('[ai/kb/[id] PATCH] re-read error:', readError);
      return NextResponse.json(
        { error: 'Failed to update answer' },
        { status: 500 }
      );
    }
    if (!current) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ error: STALE_ERROR }, { status: 409 });
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
    if (!isKbEntryId(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }
    const { data, error } = await supabase
      .from('kb_entries')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id');
    if (error) {
      console.error('[ai/kb/[id] DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete answer' },
        { status: 500 }
      );
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
