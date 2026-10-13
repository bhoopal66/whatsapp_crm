// ============================================================
// GET /api/pbx/calls/wrap-up — the caller's call still in its wrap-up
// (module 015 §7.3, migration 097), for the call layer to re-open after
// a reload: { call: WrapUpCall | null, mandatory: boolean }.
//
// The caller's own calls only (calls.user_id, the person on the call),
// read on their own client in their active workspace, with no outcome,
// that ended less than WRAPUP_MS ago or, where outcomes are mandatory,
// less than WRAPUP_OWED_MS (a reload must not dismiss an owed outcome);
// pickWrapUp chooses the newest. `leftMs` is counted on this server's
// clock, so the browser's own clock cannot stretch or cut the
// countdown, and `mandatory` comes with it so the panel never times a
// recovered wrap-up against a setting it has not loaded yet. Agent+, as
// recording the outcome is (pbx_set_disposition).
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  WRAPUP_MS,
  WRAPUP_OWED_MS,
  pickWrapUp,
  wrapUpLeftMs,
  type WrapUpCall,
  type WrapUpRow,
} from '@/lib/pbx/call-ui';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const now = Date.now();
    const settings = await ctx.supabase
      .from('pbx_settings')
      .select('mandatory_disposition')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (settings.error)
      throw new Error(`pbx_settings read failed: ${settings.error.message}`);
    const mandatory =
      (settings.data as { mandatory_disposition: boolean } | null)
        ?.mandatory_disposition === true;
    const { data, error } = await ctx.supabase
      .from('calls')
      .select(
        'connection_id, pbx_call_id, direction, contact_id, remote_number, answered_at, ended_at, disposition, erased_at'
      )
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .is('disposition', null)
      .gte(
        'ended_at',
        new Date(now - (mandatory ? WRAPUP_OWED_MS : WRAPUP_MS)).toISOString()
      )
      .order('ended_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(`calls read failed: ${error.message}`);
    const r = pickWrapUp((data ?? []) as WrapUpRow[], now, mandatory);
    const call: WrapUpCall | null =
      r && r.connection_id && r.ended_at
        ? {
            connectionId: r.connection_id,
            pbxCallId: r.pbx_call_id,
            direction: r.direction,
            contactId: r.contact_id,
            remoteNumber: r.remote_number,
            leftMs: wrapUpLeftMs(Date.parse(r.ended_at), now),
          }
        : null;
    return NextResponse.json({ call, mandatory });
  } catch (err) {
    return toErrorResponse(err);
  }
}
