import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { addRoomPeople, parseAddPeopleBody } from '@/lib/deal-rooms/people';

/**
 * Add people to a deal room's channel, as the caller (migrations 088,
 * 096): `{ staff: [user ids] }` (a manager of the room; staff of the
 * workspace) or `{ guest: user id }` (a team leader or admin who manages
 * it; a bank guest login whose bank has an approved officer in the room
 * and may join groups). 200 `{ added }`; a refusal is `{ error, code }`
 * (`not_manager`, `not_leader`, `room_closed`, `not_staff`, `not_guest`,
 * `no_bank_participant` / `bank_guests_off` with `bank`).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const input = parseAddPeopleBody(body);
    if (typeof input === 'string') {
      return NextResponse.json(
        { error: input, code: 'invalid' },
        { status: 400 }
      );
    }
    const result = await addRoomPeople(ctx.supabase, id, input);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code, ...result.detail },
        { status: result.status }
      );
    }
    return NextResponse.json({ added: result.added });
  } catch (err) {
    return toErrorResponse(err);
  }
}
