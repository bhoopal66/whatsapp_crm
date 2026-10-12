// ============================================================
// POST /api/pbx/calls/{callId}/attach — file a call's recording on a
// deal (module 015, migrations 088 and 089). `[id]` is the CRM call id.
//   { dealId } → { fileId }
//
// The call and the deal are each read on the caller's client (404 for
// either one they cannot see). The attach is written to call_access_log
// on the service role first (logRecordingAccess: a recording held until
// the notice is confirmed, erased or never fetched is 409, and nothing
// is filed). Then deal_files gets a REFERENCE row on the service role:
// storage_path NULL, source 'call_recording', ref_type 'call', ref_id
// the call id. No audio is copied; playing it from the deal goes
// through /recording, which checks and logs again. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  UUID,
  fail,
  jsonObject,
  logRecordingAccess,
  recordingFileName,
  visibleCall,
} from '@/lib/pbx/calls';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    if (!UUID.test(id)) return fail('Call not found', 404);
    const b = await jsonObject(request);
    if (!b) return fail('Invalid JSON body');
    if (!(typeof b.dealId === 'string' && UUID.test(b.dealId)))
      return fail('dealId must be an id');
    const dealId = b.dealId;

    const call = await visibleCall(ctx.supabase, id);
    if (!call) return fail('Call not found', 404);
    const deal = await ctx.supabase
      .from('deals')
      .select('id')
      .eq('id', dealId)
      .maybeSingle();
    if (deal.error) throw new Error(`deals read failed: ${deal.error.message}`);
    if (!deal.data) return fail('Deal not found', 404);

    // Named after the contact as the caller sees it, else the number.
    let who = call.remote_number;
    if (call.contact_id) {
      const { data, error } = await ctx.supabase
        .from('contacts')
        .select('name, phone')
        .eq('id', call.contact_id)
        .maybeSingle();
      if (error) throw new Error(`contacts read failed: ${error.message}`);
      const c = data as { name: string | null; phone: string | null } | null;
      who = c?.name?.trim() || c?.phone || who;
    }

    const service = pbxServiceDb();
    const refused = await logRecordingAccess(
      service,
      call,
      ctx.userId,
      'attach'
    );
    if (refused) return refused;

    const { data: file, error } = await service
      .from('deal_files')
      .insert({
        account_id: call.account_id,
        deal_id: dealId,
        storage_path: null,
        name: recordingFileName(call.started_at, who),
        source: 'call_recording',
        ref_type: 'call',
        ref_id: call.id,
        created_by: ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new Error(`deal_files insert failed: ${error.message}`);
    return NextResponse.json({ fileId: (file as { id: string }).id });
  } catch (err) {
    return toErrorResponse(err);
  }
}
