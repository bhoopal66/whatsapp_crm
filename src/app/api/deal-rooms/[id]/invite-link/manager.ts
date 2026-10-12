import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import type { Fail } from '@/lib/deal-rooms/operations';

type Ok = { ok: true } & Record<string, unknown>;

/**
 * A deal-room manager action: `deal_room_can_manage` asked as the
 * caller, then `run` on the service role. Errors are `{ error, code }`;
 * nothing is cached (an invite link is a bearer secret).
 */
export async function asManager(
  roomId: string,
  run: (
    admin: ReturnType<typeof supabaseAdmin>,
    userId: string
  ) => Promise<Ok | Fail>
): Promise<NextResponse> {
  try {
    const ctx = await requireRole('agent');
    const { data, error } = await ctx.supabase.rpc('deal_room_can_manage', {
      p_room: roomId,
    });
    if (error) console.error('[deal-rooms] can_manage failed:', error.message);
    if (data !== true) {
      return NextResponse.json(
        {
          error: 'Only a manager of this deal room can do this',
          code: 'forbidden',
        },
        { status: 403 }
      );
    }
    const result = await run(supabaseAdmin(), ctx.userId);
    const headers = { 'Cache-Control': 'no-store' };
    if (!result.ok) {
      const { status, code, error: message, detail } = result as Fail;
      return NextResponse.json(
        { error: message, code, ...detail },
        { status, headers }
      );
    }
    const { ok: _ok, ...body } = result;
    void _ok;
    return NextResponse.json(body, { headers });
  } catch (err) {
    return toErrorResponse(err);
  }
}
