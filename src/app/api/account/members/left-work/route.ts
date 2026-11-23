// GET /api/account/members/left-work — every deactivated member of the
// workspace who still holds chats, tasks, deals or customers (migration
// 266, members_left_work), and the live API keys whose maker is gone, no
// longer an admin or unknown (`keys`; null when not readable). Nothing is
// revoked here. Admin+, decided again by the RPC.

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  keysOfLeavers,
  listLiveKeys,
  type KeyMaker,
} from '@/lib/api-keys/made-by';
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
    return NextResponse.json({
      members: parseLeftWork(data),
      keys: await leaverKeys(ctx),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function leaverKeys(ctx: {
  supabase: SupabaseClient;
  accountId: string;
}) {
  const live = await listLiveKeys(ctx.supabase, ctx.accountId);
  if (!live || live.length === 0) return live;
  const { data, error } = await ctx.supabase
    .from('profiles')
    .select('user_id, account_role, deactivated_at')
    .eq('account_id', ctx.accountId);
  if (error || !Array.isArray(data)) return null;
  return keysOfLeavers(live, data as KeyMaker[]);
}
