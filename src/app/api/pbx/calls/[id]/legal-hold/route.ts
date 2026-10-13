// ============================================================
// PUT /api/pbx/calls/{callId}/legal-hold — place or lift a legal hold
// on a call's recording (module 015, migration 093).
//   { hold: boolean, reason: string } → { legalHold }
//
// A held recording outlives the retention period and blocks the
// owner's erasure (C-3). pbx_set_recording_hold runs on the caller's
// own session: it re-checks owner/admin, locks the row, refuses audio
// already deleted (409), and writes the change to the append-only
// pbx_audit under the caller's name with the reason. Setting the hold
// it already has changes nothing and writes nothing. Owner/admin
// (canPlaceLegalHold).
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canPlaceLegalHold } from '@/lib/auth/roles';
import { reasonOk } from '@/lib/chat/admin-tools';
import {
  UUID,
  dbFailure,
  fail,
  jsonObject,
  visibleCall,
} from '@/lib/pbx/calls';

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('viewer');
    if (!canPlaceLegalHold(ctx.role))
      return fail('Only an owner or admin can place or lift a legal hold', 403);
    const { id } = await context.params;
    if (!UUID.test(id)) return fail('Call not found', 404);
    const b = await jsonObject(request);
    if (!b) return fail('Invalid JSON body');
    if (typeof b.hold !== 'boolean') return fail('hold must be true or false');
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (!reasonOk(reason))
      return fail('A reason of at least 5 characters is required');

    if (!(await visibleCall(ctx.supabase, id)))
      return fail('Call not found', 404);
    const { data, error } = await ctx.supabase.rpc('pbx_set_recording_hold', {
      p_call_id: id,
      p_hold: b.hold,
      p_reason: reason,
    });
    if (error) {
      const refused = dbFailure(error);
      if (refused) return refused;
      throw new Error(`pbx_set_recording_hold failed: ${error.message}`);
    }
    return NextResponse.json({ legalHold: data === true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
