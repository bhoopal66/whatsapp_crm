// ============================================================
// POST /api/push/unsubscribe — forget this browser. RLS confines the
// delete to the caller's own rows; an unknown endpoint is a no-op.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

export async function POST(request: Request) {
  try {
    const { supabase, userId } = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      endpoint?: unknown;
    } | null;
    const endpoint = body?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2048) {
      return NextResponse.json(
        { error: 'endpoint is required' },
        { status: 400 }
      );
    }
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('endpoint', endpoint);
    if (error) {
      console.error('[push/unsubscribe] delete failed:', error);
      return NextResponse.json(
        { error: 'Failed to remove subscription' },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
