import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadTtsKey } from '@/lib/voice-library/server';
import {
  ENTRY_COLUMNS,
  type VoiceLibraryPayload,
} from '@/lib/voice-library/types';

/**
 * GET /api/voice-library  (viewer and up; bank guests never)
 *
 * The workspace's voice-note library: staff-added subjects, every entry
 * (RLS: members of the active account), and whether AI speech can be
 * used, with the reason when not. Never the key itself.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');

    const [subjects, entries, tts] = await Promise.all([
      supabase
        .from('voice_note_subjects')
        .select('id, label, created_by')
        .eq('account_id', accountId)
        .order('label'),
      supabase
        .from('voice_note_entries')
        .select(ENTRY_COLUMNS)
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(1000),
      loadTtsKey(accountId),
    ]);
    if (subjects.error || entries.error) {
      console.error(
        '[voice-library] read failed:',
        (subjects.error ?? entries.error)?.message
      );
      return NextResponse.json(
        { error: 'Could not load the voice-note library.' },
        { status: 500 }
      );
    }

    const payload: VoiceLibraryPayload = {
      subjects: subjects.data ?? [],
      entries: (entries.data ?? []) as VoiceLibraryPayload['entries'],
      tts: tts.ok
        ? { available: true }
        : { available: false, reason: tts.reason },
    };
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
