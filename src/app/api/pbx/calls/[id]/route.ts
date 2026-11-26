// ============================================================
// PATCH /api/pbx/calls/{callId} — a call's outcome (module 015,
// migrations 089 and 294). `[id]` here is the CRM call id (calls.id).
//   { disposition?: string | null, notes?: string | null,
//     notesSeen?: string | null }
//   → { disposition, notes, notesUpdatedAt }
//   → 409 { error, conflict: true, notes } when the stored note is not
//     the one its writer last saw (`notesSeen`): nothing is written, and
//     `notes` is the stored text. An erased call is a 409 without the
//     flag.
//
// Autosave-friendly: either field may be sent alone, and only what was
// sent is written, so a note never carries an old outcome back over a
// colleague's. pbx_save_call_note decides who may write (the person on
// the call, each person who answered a leg of it, or a team leader and
// up) and reads a call the caller cannot see as 404. A tab from before
// `notesSeen` may write over an empty note or its user's own. The
// conflict's text goes to the caller only: never log it. Nothing is sent
// to the customer. Agent+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  UUID,
  dbFailure,
  fail,
  jsonObject,
  parseOutcome,
} from '@/lib/pbx/calls';

type SavedNote =
  | { conflict: true; notes: string | null }
  | {
      conflict?: undefined;
      disposition: string | null;
      notes: string | null;
      notes_updated_at: string | null;
    };

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    if (!UUID.test(id)) return fail('Call not found', 404);
    const b = await jsonObject(request);
    if (!b) return fail('Invalid JSON body');
    const patch = parseOutcome(b);
    if (typeof patch === 'string') return fail(patch);

    const { notesSeen, ...fields } = patch;
    const { data, error } = await ctx.supabase.rpc('pbx_save_call_note', {
      p_call_id: id,
      p_fields: {
        ...fields,
        ...(notesSeen !== undefined && { notes_seen: notesSeen }),
      },
    });
    if (error) {
      const refused = dbFailure(error);
      if (refused) return refused;
      throw new Error(`pbx_save_call_note failed: ${error.message}`);
    }
    const saved = data as SavedNote;
    if (saved.conflict)
      return NextResponse.json(
        {
          error: 'Someone else changed this note',
          conflict: true,
          notes: saved.notes,
        },
        { status: 409 }
      );
    return NextResponse.json({
      disposition: saved.disposition,
      notes: saved.notes,
      notesUpdatedAt: saved.notes_updated_at,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
