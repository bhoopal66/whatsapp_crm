import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sendRoomInvites } from '@/lib/deal-rooms/invites';
import { dbMessage } from '@/lib/deal-rooms/shared';

/** An approval may send the invite: one gateway round trip. */
export const maxDuration = 60;

/**
 * Approve or reject a person waiting for a team leader (a bank guest an
 * agent listed): `{ approve: boolean }`. `deal_room_approve_participant`
 * runs as the caller and holds every rule (team leader and up, the
 * bank's DSA switch); its 42501 is 403, a refused state 409. An approval
 * then sends the invite on the service role, which does nothing unless
 * the room is open. 200 `{ status: 'invited' | 'rejected', invites }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pid: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { pid } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const approve = (body as { approve?: unknown } | null)?.approve;
    if (typeof approve !== 'boolean') {
      return NextResponse.json(
        { error: 'Send { approve: true | false }', code: 'invalid' },
        { status: 400 }
      );
    }
    const { data, error } = await ctx.supabase.rpc(
      'deal_room_approve_participant',
      { p_participant_id: pid, p_approve: approve }
    );
    if (error) {
      const status =
        error.code === '42501'
          ? 403
          : error.code === '22023'
            ? 409
            : error.code === '22P02'
              ? 404
              : 500;
      if (status === 500) {
        console.error('[deal-rooms] approve failed:', error.message);
        return NextResponse.json(
          { error: 'The decision was not saved', code: 'db_error' },
          { status }
        );
      }
      return NextResponse.json(
        {
          error:
            status === 404 ? 'Participant not found' : dbMessage(error.message),
          code:
            status === 403
              ? 'forbidden'
              : status === 404
                ? 'not_found'
                : 'refused',
        },
        { status }
      );
    }
    let invites = null;
    if (data === 'invited') {
      const admin = supabaseAdmin();
      const { data: p, error: pErr } = await admin
        .from('deal_room_participants')
        .select('room_id')
        .eq('id', pid)
        .maybeSingle();
      if (pErr) console.error('[deal-rooms] room lookup failed:', pErr.message);
      const roomId = (p as { room_id: string } | null)?.room_id;
      if (roomId) {
        try {
          invites = await sendRoomInvites(admin, roomId);
        } catch (err) {
          // Approved either way; the room's invite re-send retries it.
          console.error('[deal-rooms] invite after approval failed:', err);
        }
      }
    }
    return NextResponse.json({ status: data, invites });
  } catch (err) {
    return toErrorResponse(err);
  }
}
