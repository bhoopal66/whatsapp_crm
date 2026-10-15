// ============================================================
// POST /api/push/test — queue a test notification to the caller's own
// devices and run one dispatch pass so it arrives now, not on the
// next cron tick.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { pushConfig } from '@/lib/push/config';
import { dispatchPush } from '@/lib/push/dispatch';

export async function POST() {
  try {
    const { userId, accountId } = await getCurrentAccount();
    if (!pushConfig()) {
      return NextResponse.json(
        { error: 'push_not_configured' },
        { status: 503 }
      );
    }
    const admin = supabaseAdmin();
    const { data, error } = await admin.rpc('push_enqueue', {
      p_user: userId,
      p_account: accountId,
      p_kind: 'test',
      p_title: 'Test notification',
      p_body: 'Push notifications are working on this device.',
      p_url: '/settings?tab=notifications',
      p_tag: 'test',
    });
    if (error) {
      console.error('[push/test] enqueue failed:', error);
      return NextResponse.json(
        { error: 'Failed to queue test notification' },
        { status: 500 }
      );
    }
    const summary = await dispatchPush(admin);
    return NextResponse.json({ queued: data === true, sent: summary.sent });
  } catch (err) {
    return toErrorResponse(err);
  }
}
