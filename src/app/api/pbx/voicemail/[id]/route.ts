// ============================================================
// DELETE /api/pbx/voicemail/[id] — delete a message from the caller's
// own box (vm/delete). → { ok: true }
//
// The id is acted on only once the caller's own extension's vm/get
// lists it (ownVoicemail); any other id is a 404. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { pbxFailure } from '@/lib/pbx/calls';
import { ownVoicemail } from './own';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const own = await ownVoicemail(id);
    if ('refused' in own) return own.refused;
    await own.api.deleteVoicemail({ msgId: own.message.msgId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return pbxFailure(err) ?? toErrorResponse(err);
  }
}
