import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { unlockErrorResponse } from '@/lib/team-activity/unlock-errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/team-activity/unlocks/[id], body { approve, note? } → { status }
 *
 * Who may decide is the SQL function's call (migration 204); this route
 * only carries the caller's answer to it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const body =
      json && typeof json === 'object' && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : {};
    if (typeof body.approve !== 'boolean') {
      return NextResponse.json(
        { error: 'approve must be true or false' },
        { status: 400 }
      );
    }
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== 'string' || body.note.length > 500) {
        return NextResponse.json(
          { error: 'note must be at most 500 characters' },
          { status: 400 }
        );
      }
    }
    const note =
      typeof body.note === 'string' && body.note.trim()
        ? body.note.trim()
        : null;

    const { data, error } = await supabase.rpc('team_activity_decide_unlock', {
      p_id: id,
      p_approve: body.approve,
      p_note: note,
    });
    if (error) {
      const r = unlockErrorResponse(error, 'decide');
      return NextResponse.json(r.body, { status: r.status });
    }
    return NextResponse.json({ status: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
