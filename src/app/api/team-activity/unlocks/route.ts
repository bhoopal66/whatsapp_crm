import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  UNLOCKS_UNAVAILABLE_MESSAGE,
  isMissingObject,
} from '@/lib/team-activity/db-errors';
import { unlockErrorResponse } from '@/lib/team-activity/unlock-errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/team-activity/unlocks → { unlocks }
 *
 * Unlock requests (migration 204), newest 200, as the caller's RLS
 * shows them. An approved one past its expiry reads as `expired`.
 */
export async function GET() {
  try {
    const { supabase } = await requireRole('agent');

    const { data, error } = await supabase
      .from('team_activity_unlocks')
      .select(
        'id, block_id, requester_id, conversation_id, rule, reason, status, decided_by, decided_at, decision_note, expires_at, used_at, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      if (isMissingObject(error)) {
        return NextResponse.json(
          { error: UNLOCKS_UNAVAILABLE_MESSAGE },
          { status: 503 }
        );
      }
      console.error('[team-activity/unlocks] read failed:', error.message);
      return NextResponse.json(
        { error: 'Failed to load unlock requests' },
        { status: 500 }
      );
    }

    const now = Date.now();
    const unlocks = (data ?? []).map((u: Record<string, unknown>) => {
      const expires =
        typeof u.expires_at === 'string' ? Date.parse(u.expires_at) : NaN;
      return u.status === 'approved' &&
        Number.isFinite(expires) &&
        expires < now
        ? { ...u, status: 'expired' }
        : u;
    });
    return NextResponse.json({ unlocks });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/team-activity/unlocks, body { blockId, reason } → { id }
 */
export async function POST(request: Request) {
  try {
    const { supabase } = await requireRole('agent');

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
    const blockId = body.blockId;
    if (typeof blockId !== 'string' || !UUID_RE.test(blockId)) {
      return NextResponse.json(
        { error: 'blockId must be a valid id' },
        { status: 400 }
      );
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500) {
      return NextResponse.json(
        { error: 'reason must be between 5 and 500 characters' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase.rpc('team_activity_request_unlock', {
      p_block_id: blockId,
      p_reason: reason,
    });
    if (error) {
      const r = unlockErrorResponse(error, 'request');
      return NextResponse.json(r.body, { status: r.status });
    }
    return NextResponse.json({ id: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
