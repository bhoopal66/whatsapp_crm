// GET /api/account/members/left-work — every deactivated member of the
// workspace who still holds chats, tasks, deals or customers (migration
// 266, members_left_work). Admin+, decided again by the RPC.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseLeftWork } from '@/lib/auth/member-handover';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await ctx.supabase.rpc('members_left_work');
    if (error) {
      if (error.code === '42501') {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      console.error('[left work] unexpected RPC error:', error);
      return NextResponse.json(
        { error: 'Failed to load the work people left' },
        { status: 500 }
      );
    }
    return NextResponse.json({ members: parseLeftWork(data) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
