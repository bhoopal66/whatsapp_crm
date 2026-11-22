import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/coordinators/errors';
import { removeVoiceAudio } from '@/lib/voice-library/server';

/**
 * DELETE /api/voice-library/entries/[id]  (agent and up)
 *
 * The author deletes their own entry, an admin anyone's: 242's DELETE
 * policy decides, through the caller's client. The audio object goes
 * after the row (a leftover object is only space; a row without its
 * audio would send a dead link).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { data: existing, error: readErr } = await supabase
      .from('voice_note_entries')
      .select('id, storage_path')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (readErr) {
      console.error('[voice-library] entry read failed:', readErr.message);
      return NextResponse.json(
        { error: 'Could not delete the voice note.' },
        { status: 500 }
      );
    }
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { data: deleted, error } = await supabase
      .from('voice_note_entries')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id');
    if (error) {
      console.error('[voice-library] entry delete failed:', error.message);
      return NextResponse.json(
        { error: 'Could not delete the voice note.' },
        { status: 500 }
      );
    }
    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        { error: 'Only the person who added it or an admin can delete it.' },
        { status: 403 }
      );
    }
    if (existing.storage_path) {
      await removeVoiceAudio(supabase, existing.storage_path);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
