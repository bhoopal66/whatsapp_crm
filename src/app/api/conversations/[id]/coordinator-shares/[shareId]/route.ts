// DELETE /api/conversations/[id]/coordinator-shares/[shareId]
//
// Revokes a share (migration 130, revoke_conversation_share). Answers
// { revoked: boolean }. The share must belong to the chat in the path:
// it is looked up through the caller's RLS client first, so a share of
// another chat, or one the caller cannot see, answers 404.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUuid, mapCoordinatorError } from '@/lib/coordinators/errors';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; shareId: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id, shareId } = await context.params;
    if (!isUuid(id) || !isUuid(shareId)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const { data: share, error: lookupErr } = await supabase
      .from('conversation_coordinator_shares')
      .select('id')
      .eq('id', shareId)
      .eq('conversation_id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (lookupErr) {
      console.error('[coordinator-shares] lookup:', lookupErr);
      return NextResponse.json(
        { error: 'Failed to revoke the share' },
        { status: 500 }
      );
    }
    if (!share) {
      return NextResponse.json({ error: 'Share not found' }, { status: 404 });
    }

    const { data, error } = await supabase.rpc('revoke_conversation_share', {
      p_share_id: shareId,
    });
    if (error) {
      const mapped = mapCoordinatorError(error);
      if (mapped.status >= 500) {
        console.error('[coordinator-shares] revoke failed:', error.code);
      }
      return NextResponse.json(
        { error: mapped.error },
        { status: mapped.status }
      );
    }
    return NextResponse.json({ revoked: data === true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
