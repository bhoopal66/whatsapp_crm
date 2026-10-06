// ============================================================
// GET /api/whatsapp/broadcast/cron   (migration 053)
//
// Delivers scheduled campaigns that have come due. Meant to be hit on
// a schedule (Vercel Cron / GitHub Actions / any pinger) — same shared
// secret and header as the automation and flow crons
// (`AUTOMATION_CRON_SECRET` in `x-cron-secret`).
//
// The wizard writes a scheduled campaign exactly as it writes a live
// one — `broadcasts` row + frozen `broadcast_recipients` — but with
// status 'scheduled' and no send loop. This route is that loop, and it
// is deliberately the *resume* machinery from migration 038 rather
// than a third fan-out: claim the delivery lock, plan from the
// recipient rows, `deliverBroadcast`, finalize. Two things are
// specific to scheduling:
//
//   - quiet hours: a campaign due inside its window is pushed to the
//     moment the window ends instead of sent;
//   - the claim doubles as the "who runs it" decision — a campaign
//     picked up by two overlapping cron ticks is delivered once.
//
// Responds after claiming and planning; the fan-out itself runs in
// `after()`, capped per campaign like a resume pass, so a very large
// campaign may need more than one tick — leftovers stay 'pending' and
// the campaign stays 'sending', which the next tick does NOT pick up
// (it only selects 'scheduled'); the detail page's Resume finishes it.
//
// Every tick also replays Meta receipts that no recipient row matched
// when they arrived (migration 066), so a lost 'failed' is still
// counted within a minute.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
  reconcileBroadcastStatuses,
} from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';
import {
  isInQuietHours,
  nextAllowedSendTime,
  parseQuietHours,
} from '@/lib/broadcasts/quiet-hours';

export const maxDuration = 300;

/** Campaigns started per tick. Each is up to 1 000 sequential sends. */
const MAX_PER_TICK = 5;

interface DueRow {
  id: string;
  account_id: string;
  scheduled_at: string;
  quiet_hours: unknown;
}

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

  const admin = supabaseAdmin();
  const now = new Date();

  // Every tick, due campaigns or not: Meta receipts that arrived before
  // their recipient row carried the wamid (migration 066). The end of a
  // delivery pass runs it too, but the last receipts of a pass land
  // after it. Awaited here, never floated — see the after() rule.
  const reconciled = await reconcileBroadcastStatuses();

  const { data: due, error } = await admin
    .from('broadcasts')
    .select('id, account_id, scheduled_at, quiet_hours')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(MAX_PER_TICK);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!due || due.length === 0) {
    return NextResponse.json({
      started: 0,
      deferred: 0,
      skipped: 0,
      reconciled,
    });
  }

  let started = 0;
  let deferred = 0;
  let skipped = 0;

  for (const row of due as DueRow[]) {
    // Quiet hours: don't send, move the appointment.
    const quiet = parseQuietHours(row.quiet_hours);
    if (quiet && isInQuietHours(now, quiet)) {
      const next = nextAllowedSendTime(now, quiet);
      await admin
        .from('broadcasts')
        .update({ scheduled_at: next.toISOString() })
        .eq('id', row.id)
        .eq('status', 'scheduled');
      deferred++;
      continue;
    }

    // Claim BEFORE planning — the same guard as the Resume button. A
    // second tick overlapping this one finds the lock taken and moves on.
    const claimed = await claimBroadcastDelivery(admin, row.account_id, row.id);
    if (!claimed) {
      skipped++;
      continue;
    }

    try {
      const { plan } = await planBroadcastResume(
        admin,
        row.account_id,
        row.id,
        'pending'
      );
      await markBroadcastSending(admin, row.id);
      started++;

      after(async () => {
        try {
          await deliverBroadcast(admin, plan);
        } catch (err) {
          console.error(
            '[broadcast-cron] delivery threw:',
            err instanceof Error ? err.message : err
          );
          await finalizeBroadcastStatus(admin, row.id).catch(() => {});
        } finally {
          await releaseBroadcastDelivery(admin, row.id);
        }
      });
    } catch (err) {
      await releaseBroadcastDelivery(admin, row.id).catch(() => {});
      if (err instanceof BroadcastError && err.code === 'nothing_to_resume') {
        // Every recipient already terminal (e.g. all stamped failed for
        // want of a phone) — settle the status so it stops coming due.
        await finalizeBroadcastStatus(admin, row.id).catch(() => {});
        skipped++;
        continue;
      }
      // Channel / template problems are per-account and won't fix
      // themselves by retrying every minute: mark the campaign failed so
      // it surfaces on the detail page instead of silently re-queuing.
      console.error(
        `[broadcast-cron] planning ${row.id} failed:`,
        err instanceof Error ? err.message : err
      );
      await admin
        .from('broadcasts')
        .update({ status: 'failed', updated_at: now.toISOString() })
        .eq('id', row.id)
        .eq('status', 'scheduled');
      skipped++;
    }
  }

  return NextResponse.json({ started, deferred, skipped, reconciled });
}
