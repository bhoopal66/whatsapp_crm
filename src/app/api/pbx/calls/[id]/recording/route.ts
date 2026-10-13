// ============================================================
// POST /api/pbx/calls/{callId}/recording — a link to play or download a
// call's recording (module 015, migration 089). `[id]` is the CRM call
// id (calls.id).
//   { action: 'play' | 'download' } → { url, expiresAt }
//
// Recordings are customer data, so each step gates the next:
//  1. the call is read on the caller's client: one they cannot see is
//     404, and nothing below runs (no log row, no path, no link);
//  2. download is for a team leader and up (403);
//  3. the access is written to call_access_log on the service role
//     (logRecordingAccess). The log's guard refuses a recording that is
//     not playable — held until the English/Arabic notice is confirmed,
//     erased, or never fetched — so that is a 409 and nothing is signed;
//  4. only then is the object's path read and a link signed, on the
//     service role (the bucket has no client policy), valid for five
//     minutes, on the public Supabase origin, and never cached.
// Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { roleRank } from '@/lib/auth/roles';
import { pbxServiceDb } from '@/lib/pbx/admin';
import {
  RANK_LEADER,
  RECORDINGS_BUCKET,
  RECORDING_LINK_SECONDS,
  UUID,
  fail,
  jsonObject,
  logRecordingAccess,
  recordingRefused,
  visibleCall,
} from '@/lib/pbx/calls';
import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

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
    if (b.action !== 'play' && b.action !== 'download')
      return fail("action must be 'play' or 'download'");
    const action = b.action;

    const call = await visibleCall(ctx.supabase, id);
    if (!call) return fail('Call not found', 404);
    if (action === 'download' && roleRank(ctx.role) < RANK_LEADER)
      return fail('Only a team leader or above can download a recording', 403);

    const service = pbxServiceDb();
    const refused = await logRecordingAccess(service, call, ctx.userId, action);
    if (refused) return refused;

    const { data, error } = await service
      .from('call_recordings')
      .select('storage_path, erased_at')
      .eq('call_id', call.id)
      .eq('account_id', call.account_id)
      .maybeSingle();
    if (error) throw new Error(`call_recordings read failed: ${error.message}`);
    const row = data as {
      storage_path: string;
      erased_at: string | null;
    } | null;
    // Logged as playable a moment ago: an erasure since removes the row,
    // and the retention period (093) marks it before deleting the audio,
    // so a row marked since the log is no link either.
    if (!row) return recordingRefused('erased');
    if (row.erased_at) return recordingRefused('fetched', true);
    const path = row.storage_path;

    const signedAt = Date.now();
    const { data: signed, error: signError } = await service.storage
      .from(RECORDINGS_BUCKET)
      .createSignedUrl(
        path,
        RECORDING_LINK_SECONDS,
        action === 'download' ? { download: true } : undefined
      );
    if (signError || !signed?.signedUrl)
      throw new Error(
        `recording link failed: ${signError?.message ?? 'no link'}`
      );
    return NextResponse.json(
      {
        url: toPublicSupabaseUrl(signed.signedUrl),
        expiresAt: new Date(
          signedAt + RECORDING_LINK_SECONDS * 1000
        ).toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
