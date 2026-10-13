// ============================================================
// GET /api/pbx/calls/wrap-up — the caller's calls still in their
// wrap-up (module 015 §7.3, migration 097), for the call layer to
// re-open after a reload: { calls: WrapUpCall[], mandatory: boolean },
// newest end first.
//
// The caller's own calls only (calls.user_id, the person on the call),
// read on their own client in their active workspace: answered, with a
// customer (not internal), not erased, with a PBX and no outcome, that
// ended after wrapUpCutoff: under WRAPUP_MS ago or, where outcomes are
// mandatory, under WRAPUP_OWED_MS ago and after they were made mandatory
// (pbx_settings.mandatory_disposition_since), as the reminder sweep
// counts them. Every filter is in the query, ahead of the limit, so
// calls that do not qualify cannot crowd out one that does. `leftMs` is
// counted on this server's clock, so the browser's own clock cannot
// stretch or cut the countdown, and `mandatory` comes with it so the
// panel never times a recovered wrap-up against a setting it has not
// loaded yet. Agent+, as recording the outcome is (pbx_set_disposition).
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  pickWrapUps,
  wrapUpCutoff,
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
      .select('mandatory_disposition, mandatory_disposition_since')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (settings.error)
      throw new Error(`pbx_settings read failed: ${settings.error.message}`);
    const s = settings.data as {
      mandatory_disposition: boolean;
      mandatory_disposition_since: string | null;
    } | null;
    const mandatory = s?.mandatory_disposition === true;
    // Mandatory with no switch-on time recorded owes nothing from before.
    const since = mandatory
      ? Date.parse(s?.mandatory_disposition_since ?? '') || now
      : null;
    const { data, error } = await ctx.supabase
      .from('calls')
      .select(
        'connection_id, pbx_call_id, direction, contact_id, remote_number, answered_at, ended_at, disposition, erased_at'
      )
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .is('disposition', null)
      .not('answered_at', 'is', null)
      .neq('direction', 'internal')
      .is('erased_at', null)
      .not('connection_id', 'is', null)
      .gt('ended_at', new Date(wrapUpCutoff(now, since)).toISOString())
      .order('ended_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(`calls read failed: ${error.message}`);
    const calls: WrapUpCall[] = pickWrapUps(
      (data ?? []) as WrapUpRow[],
      now,
      since
    ).map((r) => ({
      connectionId: r.connection_id as string,
      pbxCallId: r.pbx_call_id,
      direction: r.direction,
      contactId: r.contact_id,
      remoteNumber: r.remote_number,
      leftMs: wrapUpLeftMs(Date.parse(r.ended_at as string), now),
    }));
    return NextResponse.json({ calls, mandatory });
  } catch (err) {
    return toErrorResponse(err);
  }
}
