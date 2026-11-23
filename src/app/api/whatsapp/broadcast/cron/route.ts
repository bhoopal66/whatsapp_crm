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
// `after()`, capped per campaign like a resume pass. A very large
// campaign needs more than one pass, and a pass can stop early (quiet
// hours, the number's daily limit, a logged-out phone) or die with the
// process: leftovers stay 'pending', the campaign stays 'sending', and a
// later tick continues it, at most one per tick, for a week after its
// appointment. So is a campaign the public API created, for a week after
// that: nobody has a tab open on it. The mark of one is a NULL
// `audience_filter`: the wizard always writes it, and
// `create_broadcast_with_recipients`, which only the API calls, never
// does (pinned in `cron-continue.test.ts`). One sent from the wizard has
// no appointment and is finished by the tab or by Resume.
//
// Every tick also replays Meta receipts that no recipient row matched
// when they arrived (migration 066), so a lost 'failed' is still
// counted within a minute.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse, after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  BroadcastError,
  finalizeBroadcastStatus,
  reconcileBroadcastStatuses,
} from '@/lib/whatsapp/broadcast-core';
import {
  mayContinueBroadcast,
  recordContinueRefusal,
  type ContinueCandidate,
} from '@/lib/whatsapp/broadcast-continue';
import { runBroadcastPass } from '@/lib/whatsapp/broadcast-pass';
import {
  claimBroadcastDelivery,
  DELIVERY_LOCK_STALE_MS,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';
import {
  isInQuietHours,
  nextAllowedSendTime,
  parseQuietHours,
} from '@/lib/broadcasts/quiet-hours';
import { serverErrorResponse } from '@/lib/api/server-error';

export const maxDuration = 300;

/** Campaigns started per tick. Each is up to 1 000 sequential sends. */
const MAX_PER_TICK = 5;

/** Unfinished campaigns looked at per tick; the first that may run does. */
const CONTINUE_CANDIDATES = 20;

/** How long after its appointment (API: its creation) one is continued. */
const CONTINUE_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

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
    return serverErrorResponse('GET /api/whatsapp/broadcast/cron', error);
  }
  let started = 0;
  let deferred = 0;
  let skipped = 0;

  for (const row of (due ?? []) as DueRow[]) {
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
    const claimedAt = new Date();
    const token = claimedAt.toISOString();
    const claimed = await claimBroadcastDelivery(
      admin,
      row.account_id,
      row.id,
      claimedAt
    );
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

      after(() => runBroadcastPass(admin, plan, token));
    } catch (err) {
      await releaseBroadcastDelivery(admin, row.id, token).catch(() => {});
      if (err instanceof BroadcastError && err.code === 'nothing_to_resume') {
        // Every recipient already terminal (e.g. all stamped failed for
        // want of a phone) — settle the status so it stops coming due.
        await finalizeBroadcastStatus(admin, row.id).catch(() => {});
        skipped++;
        continue;
      }
      if (
        err instanceof BroadcastError &&
        (err.code === 'quiet_hours' || err.code === 'internal')
      ) {
        // The window began since the check above: the next tick moves
        // the appointment. Or the database did not answer: it stays due.
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

  // Scheduled and API campaigns a capped, stopped or killed pass left
  // unfinished. A new API campaign is left to its request first; that also
  // covers one whose request could not take the delivery lock.
  // Longest untouched first: a campaign that just had its pass goes to
  // the back, and one that may not run yet does not use the tick.
  const nowIso = now.toISOString();
  const stale = new Date(+now - DELIVERY_LOCK_STALE_MS).toISOString();
  const weekAgo = new Date(+now - CONTINUE_WITHIN_MS).toISOString();
  const { data: unfinished, error: unfinishedError } = await admin
    .from('broadcasts')
    .select('id, account_id, quiet_hours, updated_at')
    .eq('status', 'sending')
    .or(
      `and(scheduled_at.lte.${nowIso},scheduled_at.gte.${weekAgo}),` +
        `and(scheduled_at.is.null,audience_filter.is.null,created_at.lte.${stale},created_at.gte.${weekAgo})`
    )
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${stale}`)
    .order('updated_at', { ascending: true })
    .limit(CONTINUE_CANDIDATES);
  if (unfinishedError) {
    console.error(
      '[broadcast-cron] unfinished campaigns:',
      unfinishedError.message
    );
  }

  for (const row of (unfinished ?? []) as UnfinishedRow[]) {
    const outcome = await continueBroadcast(admin, row, now);
    if (outcome === 'started') {
      started++;
      break;
    }
    skipped++;
  }

  return NextResponse.json({ started, deferred, skipped, reconciled });
}

interface UnfinishedRow extends ContinueCandidate {
  quiet_hours: unknown;
}

/** Start the next pass of an unfinished campaign, if it may run now. */
async function continueBroadcast(
  admin: SupabaseClient,
  row: UnfinishedRow,
  now: Date
): Promise<'started' | 'skipped'> {
  const quiet = parseQuietHours(row.quiet_hours);
  if (quiet && isInQuietHours(now, quiet)) return 'skipped';

  const claimedAt = new Date();
  const token = claimedAt.toISOString();
  let claimed = false;
  try {
    if (!(await mayContinueBroadcast(admin, row, now))) return 'skipped';
    claimed = await claimBroadcastDelivery(
      admin,
      row.account_id,
      row.id,
      claimedAt
    );
    if (!claimed) return 'skipped';

    const { plan } = await planBroadcastResume(
      admin,
      row.account_id,
      row.id,
      'pending'
    );
    after(() => runBroadcastPass(admin, plan, token));
    return 'started';
  } catch (err) {
    const code = err instanceof BroadcastError ? err.code : null;
    if (code === 'nothing_to_resume') {
      await finalizeBroadcastStatus(admin, row.id).catch(() => {});
    } else {
      console.error(
        `[broadcast-cron] continuing ${row.id} failed:`,
        err instanceof Error ? err.message : err
      );
      if (claimed && code && code !== 'internal' && code !== 'quiet_hours') {
        await recordContinueRefusal(
          admin,
          row.id,
          (err as BroadcastError).message
        ).catch(() => {});
      }
    }
    if (claimed) {
      await releaseBroadcastDelivery(admin, row.id, token).catch(() => {});
    }
    return 'skipped';
  }
}
