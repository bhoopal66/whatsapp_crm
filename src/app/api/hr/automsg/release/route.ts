import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { runHrAutomsgDrain } from '@/lib/hr/automsg/drain';

export const maxDuration = 60;

/**
 * POST /api/hr/automsg/release  (owner/admin)
 *
 * Returns: { reviewed, expired, outcomes }
 *
 * "Run now" on the HR Automated messages screen: one drain pass for the
 * caller's active workspace only, the same pass the automations cron
 * runs. Every guard (kill switch, triggers, consent, quiet hours, cap)
 * still applies inside the drain; this only runs it sooner. The drain
 * never throws and answers null on failure, which is a 502 here.
 */
export async function POST() {
  try {
    const { accountId } = await requireRole('admin');
    const summary = await runHrAutomsgDrain({ accountId });
    if (!summary) {
      return NextResponse.json({ error: 'failed' }, { status: 502 });
    }
    return NextResponse.json(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}
