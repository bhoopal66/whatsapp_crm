// ============================================================
// POST /api/push/test — queue a test notification to the caller's own
// devices and run one dispatch pass so it arrives now, not on the
// next cron tick.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit } from '@/lib/rate-limit';
import { pushConfig } from '@/lib/push/config';
import { dispatchPush } from '@/lib/push/dispatch';
import { testOutcome, type PushTestOutcome } from '@/lib/push/test-outcome';

export async function POST() {
  try {
    const { userId, accountId } = await getCurrentAccount();
    // Each call runs a dispatch pass over the whole queue, so a member
    // (a bank guest too) cannot loop on it.
    const limit = checkRateLimit(`push-test:${userId}`, {
      limit: 3,
      windowMs: 60_000,
    });
    if (!limit.success) {
      const retryAfter = Math.max(
        1,
        Math.ceil((limit.reset - Date.now()) / 1000)
      );
      return NextResponse.json(
        { error: 'Too many test notifications. Try again in a minute.' },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }
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
    // The pass also carries other people's rows: answer for the caller's
    // own test only. Not seen at all: the delivery loop took it first.
    let outcome: PushTestOutcome = data === true ? 'queued' : 'no_device';
    if (data === true) {
      await dispatchPush(admin, {
        onRow: (row, result) => {
          if (row.user_id === userId && row.kind === 'test') {
            outcome = testOutcome(result);
          }
        },
      });
    }
    return NextResponse.json({ outcome });
  } catch (err) {
    return toErrorResponse(err);
  }
}
