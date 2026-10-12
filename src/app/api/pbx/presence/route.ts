// ============================================================
// GET /api/pbx/presence — who is free to take a call (module 015,
// migration 089).
//   → { [userId]: { state, extension, updatedAt } }
//
// state is available | on_call | away | dnd | off_work | offline
// (presenceView): a row the processor has not touched for ten minutes
// is offline, whatever it last said. The active workspace's rows, read
// on the caller's client; a bank guest is refused by the role check
// (403). Viewer+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { presenceByUser, type PresenceRow } from '@/lib/pbx/calls';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    const { data, error } = await ctx.supabase
      .from('pbx_presence')
      .select('user_id, extension, presence, call_state, updated_at')
      .eq('account_id', ctx.accountId);
    if (error) throw new Error(`pbx_presence read failed: ${error.message}`);
    return NextResponse.json(
      presenceByUser((data ?? []) as PresenceRow[], Date.now())
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
