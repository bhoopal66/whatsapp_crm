import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { runJourneyTick } from '@/lib/journeys/host/tick';

export const maxDuration = 60;

/**
 * The journey bot's tick (migration 086): fires due timers and drains
 * outbox items that are due, for accounts with journeys enabled. Hit it
 * on a schedule (every minute is right: quiet-hours sends and the
 * engine's timers are minute-grained); the automation cron also runs
 * it, at most once a minute per process, so an install that pings only
 * that one is covered.
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
    const result = await runJourneyTick({ db: supabaseAdmin() });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error(
      '[journeys-cron] tick failed:',
      err instanceof Error ? err.message : err
    );
    return NextResponse.json({ error: 'journey tick failed' }, { status: 500 });
  }
}
