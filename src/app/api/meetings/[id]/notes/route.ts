// ============================================================
// /api/meetings/[id]/notes — the shared minutes (176).
// GET  → `{ notes, available }`; `available: false` on a database
//        without 176, so the panel can hide itself.
// PUT  `{ body, expectedVersion }` → `{ version, updated_at, updated_by }`.
// Both run on the caller's client: `meeting_save_notes` is granted to
// `authenticated` only and decides who may write. That includes a
// manager after the meeting closed, so the route does not check status.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { isUuid, NOTES_MAX, parseNotesSave } from '@/lib/meetings/requests';
import {
  isMissingTable,
  jsonError,
  loadMeeting,
  meetingDbErrorResponse,
  migrationRequiredResponse,
  readErrorResponse,
  readJson,
  requireMeetingsUser,
  type Params,
} from '@/lib/meetings/server';

const NOT_FOUND = 'Meeting not found';

const loadNotes = (supabase: SupabaseClient, accountId: string, id: string) =>
  supabase
    .from('meeting_notes')
    .select('body, version, updated_by, updated_at')
    .eq('account_id', accountId)
    .eq('meeting_id', id)
    .maybeSingle();

export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);

    const [loaded, notes] = await Promise.all([
      loadMeeting(supabase, accountId, id),
      loadNotes(supabase, accountId, id),
    ]);
    if (loaded.error) return readErrorResponse(loaded.error);
    if (!loaded.meeting) return jsonError(NOT_FOUND, 404);
    if (isMissingTable(notes.error)) {
      return NextResponse.json({ notes: null, available: false });
    }
    if (notes.error) return readErrorResponse(notes.error);
    return NextResponse.json({ notes: notes.data, available: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireMeetingsUser();
    const { id } = await params;
    if (!isUuid(id)) return jsonError('Invalid meeting id', 400);
    const parsed = parseNotesSave(await readJson(request));
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const { data, error } = await supabase.rpc('meeting_save_notes', {
      p_meeting: id,
      p_body: parsed.values.body,
      p_expected_version: parsed.values.expectedVersion,
    });
    if (!error) return NextResponse.json(data);

    if (error.code === '42501') return jsonError(NOT_FOUND, 404);
    if (error.code === 'P0001' && error.message === 'meeting_closed') {
      return jsonError('meeting_closed', 409);
    }
    if (error.code === '22023') {
      return jsonError(`Notes must be at most ${NOTES_MAX} characters`, 400);
    }
    if (error.code === 'MN001') {
      // Someone saved first: hand back what they saved to reconcile with.
      const current = await loadNotes(supabase, accountId, id);
      if (current.error) return readErrorResponse(current.error);
      return NextResponse.json(
        { error: 'stale', notes: current.data },
        { status: 409 }
      );
    }
    return (
      migrationRequiredResponse(error) ??
      meetingDbErrorResponse(error, 'Failed to save the notes')
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
