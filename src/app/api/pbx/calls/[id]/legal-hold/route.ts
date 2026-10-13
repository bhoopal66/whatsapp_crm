// ============================================================
// PUT /api/pbx/calls/{callId}/legal-hold — place or lift a legal hold
// on a call's recording (module 015, migration 093).
//   { hold: boolean, reason: string, confirmDelete?: true } → { legalHold }
//
// A held recording outlives the retention period and blocks the
// owner's erasure (C-3). pbx_set_recording_hold runs on the caller's
// own session: it re-checks owner/admin, locks the row, refuses audio
// already deleted, and writes the change to the append-only pbx_audit
// under the caller's name with the reason. Setting the hold it already
// has changes nothing and writes nothing. Owner/admin
// (canPlaceLegalHold).
//
// A refusal over audio that is gone is a 409 with the recording
// route's `code`, so the player shows what happened: 'expired' when the
// retention period deleted it (only 093's run marks a recording row
// deleted), 'erased' or 'not_stored' by the call's state when there is
// no recording row. Any other call with no row is a 404.
//
// Lifting the hold of a recording whose call is already past the
// workspace's retention period deletes it on the next cron run, so that
// is refused (409, code 'past_retention', retentionDays) until the
// request says confirmDelete: the screen shows the warning first. The
// age is the retention run's (pastRetention, the SQL rule's mirror).
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
  recordingRefused,
  visibleCall,
} from '@/lib/pbx/calls';
import { pastRetention } from '@/lib/pbx/recordings';

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

    const call = await visibleCall(ctx.supabase, id);
    if (!call) return fail('Call not found', 404);
    if (!b.hold && b.confirmDelete !== true) {
      const s = await ctx.supabase
        .from('pbx_settings')
        .select('retention_days')
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (s.error)
        throw new Error(`pbx_settings read failed: ${s.error.message}`);
      const days = (s.data as { retention_days?: unknown } | null)
        ?.retention_days;
      if (typeof days === 'number' && pastRetention(call, days, Date.now()))
        return fail(
          'This call is older than the retention period: lifting the hold deletes its recording',
          409,
          { code: 'past_retention', retentionDays: days }
        );
    }
    const { data, error } = await ctx.supabase.rpc('pbx_set_recording_hold', {
      p_call_id: id,
      p_hold: b.hold,
      p_reason: reason,
    });
    if (error) {
      if (error.code === '55000')
        return recordingRefused(call.recording_state, true);
      if (
        error.code === 'P0002' &&
        (call.recording_state === 'erased' ||
          call.recording_state === 'not_stored')
      )
        return recordingRefused(call.recording_state);
      const refused = dbFailure(error);
      if (refused) return refused;
      throw new Error(`pbx_set_recording_hold failed: ${error.message}`);
    }
    return NextResponse.json({ legalHold: data === true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
