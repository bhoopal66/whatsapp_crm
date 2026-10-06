// ============================================================
// GET /api/whatsapp/health/cron   (migration 065)
//
// Probes every Whapi number's `/health`, flips `whatsapp_config.status`
// when one drops off WhatsApp or comes back, and notifies the account's
// owners and admins on each transition (`lib/whatsapp/channel-health.ts`).
// Meant to be hit every few minutes by the same pinger as the other
// crons — same shared secret and header (`AUTOMATION_CRON_SECRET` in
// `x-cron-secret`). The automation cron also runs this sweep, at most
// every 5 minutes, for installs whose pinger has not been told about
// this path yet.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { runChannelHealthCheck } from '@/lib/whatsapp/channel-health';

export const maxDuration = 60;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
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
    const summary = await runChannelHealthCheck(supabaseAdmin());
    return NextResponse.json(summary);
  } catch (err) {
    // Only the channel list itself can fail the sweep; per-number
    // failures are counted in the summary instead.
    console.error(
      '[health-cron] sweep failed:',
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { error: 'Could not load WhatsApp channels.' },
      { status: 500 }
    );
  }
}
