// ============================================================
// POST /api/pbx/voicemail/[id]/read — mark a message in the caller's
// own box as read (vm/update, vm_status 1). → { ok: true }
//
// Same ownership check as delete (ownVoicemail): 404 for an id the
// caller's own box does not list. Already read is a no-op. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { pbxFailure } from '@/lib/pbx/calls';
import { ownVoicemail } from '../own';

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const own = await ownVoicemail(id);
    if ('refused' in own) return own.refused;
    if (!own.message.read)
      await own.api.markVoicemailRead({ msgId: own.message.msgId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
