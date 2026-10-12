import { NextResponse } from 'next/server';

import {
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { createDealRoom, parseCreateBody } from '@/lib/deal-rooms/create';
import { listRooms } from '@/lib/deal-rooms/reads';
import { createClient } from '@/lib/supabase/server';
import { ChannelError } from '@/lib/whatsapp/channels';

/** Asking Meta for the group is a gateway round trip. */
export const maxDuration = 60;

/**
 * Create a deal room (module 014c, migration 088). `deal_room_create`
 * runs as the caller and holds every rule; the group is then asked of
 * Meta with the service role and confirmed later by the `group_create`
 * webhook (or the reconcile), so success is 201 with status `creating`.
 * A room Meta refused is returned with `status: 'failed'` and its id.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Expected a JSON body' },
        { status: 400 }
      );
    }
    const parsed = parseCreateBody(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const result = await createDealRoom({
      userDb: ctx.supabase,
      adminDb: supabaseAdmin(),
      accountId: ctx.accountId,
      input: parsed.value,
    });
    if (!result.ok) {
      return NextResponse.json(
        result.roomId
          ? { error: result.error, roomId: result.roomId, status: 'failed' }
          : { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(
      {
        roomId: result.roomId,
        channelId: result.channelId,
        status: result.status,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof ChannelError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}

/**
 * The deal rooms the caller can see, newest first (at most 500):
 * `{ rooms: [{ id, channelId, subject, status, participantCount,
 * windowUntil, dealTitle, contactName, createdAt }] }`. Guest-capable:
 * the session is checked here and the read runs as the caller, so RLS
 * (`deal_room_access`) picks the rooms; a deal or contact RLS hides
 * from the caller comes back null.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) throw new UnauthorizedError();
    const rooms = await listRooms(supabase);
    return NextResponse.json(
      { rooms },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
