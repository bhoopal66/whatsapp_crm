// ============================================================
// PATCH /api/pbx/calls/{callId} — a call's outcome (module 015,
// migration 089). `[id]` here is the CRM call id (calls.id).
//   { disposition?: string | null, notes?: string | null }
//   → { disposition, notes, notesUpdatedAt }
//
// Autosave-friendly: either field may be sent alone. pbx_set_disposition
// writes both, so the omitted one is re-sent with its current value,
// read first on the caller's client (a call they cannot see is 404).
// Two saves of different fields racing each other can still undo one
// another: a client sends its saves one at a time. The function decides
// who may write (the person on the call, or a team leader and up) and
// refuses an erased call (409). Nothing is sent to the customer.
// Agent+.
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

interface OutcomeRow {
  disposition: string | null;
  notes: string | null;
  notes_updated_at?: string | null;
}

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

    const read = async (cols: string) => {
      const { data, error } = await ctx.supabase
        .from('calls')
        .select(cols)
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`calls read failed: ${error.message}`);
      return data as OutcomeRow | null;
    };
    const current = await read('disposition, notes');
    if (!current) return fail('Call not found', 404);

    const { error } = await ctx.supabase.rpc('pbx_set_disposition', {
      p_call_id: id,
      p_disposition:
        'disposition' in patch ? patch.disposition : current.disposition,
      p_notes: 'notes' in patch ? patch.notes : current.notes,
    });
    if (error) {
      const refused = dbFailure(error);
      if (refused) return refused;
      throw new Error(`pbx_set_disposition failed: ${error.message}`);
    }
    const saved = await read('disposition, notes, notes_updated_at');
    return NextResponse.json({
      disposition: saved?.disposition ?? null,
      notes: saved?.notes ?? null,
      notesUpdatedAt: saved?.notes_updated_at ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
