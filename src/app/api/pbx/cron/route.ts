import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { pbxServiceDb } from '@/lib/pbx/admin';
import { runPbxCron } from '@/lib/pbx/housekeeping';

// The run stops starting work after 45 s (PBX_CRON_BUDGET_MS).
export const maxDuration = 60;

/**
 * The phone system's periodic work: fetch pending recordings, dial due
 * call-backs, retry failed events, purge. Authenticated like every cron
 * here: `x-cron-secret` must match AUTOMATION_CRON_SECRET. The
 * automations cron also runs it, at most once a minute per process.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '');
  const expectedBuf = Buffer.from(expected);
  if (
    supplied.length !== expectedBuf.length ||
    !timingSafeEqual(supplied, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await runPbxCron({ db: pbxServiceDb() });
  return NextResponse.json(summary);
}
