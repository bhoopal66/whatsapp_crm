import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { reconcileCreatingRooms } from '@/lib/deal-rooms/reconcile';

export const maxDuration = 60;

/**
 * The deal-room reconcile (module 014c, migration 088): rooms still
 * `creating` 2 minutes after they were created, because their
 * `group_create` webhook was lost or could not be matched, are matched
 * to their WhatsApp group by subject, asked for once more, or failed
 * after 10 minutes (`lib/deal-rooms/reconcile.ts`). Hit it every minute
 * or two; the automation cron also runs it, at most every 2 minutes per
 * process, so an install that pings only that one is covered.
 *
 * Auth: `AUTOMATION_CRON_SECRET` in `x-cron-secret`, like the other
 * cron endpoints.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  // Constant-time compare; the length pre-check is required by
  // timingSafeEqual and leaks only the length.
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await reconcileCreatingRooms(supabaseAdmin());
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error(
      '[deal-rooms-cron] reconcile failed:',
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { error: 'deal room reconcile failed' },
      { status: 500 }
    );
  }
}
