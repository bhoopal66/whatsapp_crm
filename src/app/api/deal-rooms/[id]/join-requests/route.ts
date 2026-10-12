import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  decideJoinRequests,
  parseJoinDecisionBody,
} from '@/lib/deal-rooms/operations';

/** Up to two gateway round trips (approve, reject). */
export const maxDuration = 60;

/**
 * Decide the group's pending join requests (module 014c):
 * `{ approve: string[], reject: string[] }` of Meta join request ids.
 * Managers only (`deal_room_can_manage`, asked as the caller); WhatsApp
 * is then asked on the service role, and only what it accepted is
 * recorded as decided. 200 `{ approved, rejected, failed, skipped }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const { data: canManage, error } = await ctx.supabase.rpc(
      'deal_room_can_manage',
      { p_room: id }
    );
    if (error) console.error('[deal-rooms] can_manage failed:', error.message);
    if (canManage !== true) {
      return NextResponse.json(
        {
          error: 'Only a manager of this deal room can decide join requests',
          code: 'forbidden',
        },
        { status: 403 }
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const parsed = parseJoinDecisionBody(body);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, code: 'invalid' },
        { status: 400 }
      );
    }
    const result = await decideJoinRequests(supabaseAdmin(), {
      roomId: id,
      userId: ctx.userId,
      approve: parsed.approve,
      reject: parsed.reject,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }
    const { approved, rejected, failed, skipped } = result;
    return NextResponse.json({ approved, rejected, failed, skipped });
  } catch (err) {
    return toErrorResponse(err);
  }
}
