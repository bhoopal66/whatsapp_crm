/**
 * HR automated messages: the cron side. Rows are enqueued in SQL
 * (migration 203); every pass here settles the stuck ones, expires the
 * stale ones, then hands the due rows to `processDue`. Both functions
 * never throw: a failure is logged once and the next pass picks the work
 * up (the claim in the engine keeps an overlapping run from double-sending).
 */
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { processDue } from './engine';
import { createHrSendPort } from './send';
import { PgAutoMsgStore } from './store';

export interface HrAutomsgDrainSummary {
  reviewed: number;
  expired: number;
  outcomes: Record<string, number>;
}

const DEFAULT_LIMIT = 100;

export async function runHrAutomsgDrain(
  opts: { now?: Date; accountId?: string; limit?: number } = {}
): Promise<HrAutomsgDrainSummary | null> {
  try {
    const db = supabaseAdmin();
    const store = new PgAutoMsgStore(db);
    const now = opts.now ?? new Date();
    const reviewed = await store.reviewStuck(now);
    const expired = await store.expire(now);
    const rows = await store.due(opts.limit ?? DEFAULT_LIMIT, opts.accountId);
    const counts = await processDue(rows, {
      store,
      sender: createHrSendPort(db),
      clock: { now: () => opts.now ?? new Date() },
    });
    const outcomes: Record<string, number> = {};
    for (const [k, v] of Object.entries(counts)) outcomes[k] = v ?? 0;
    return { reviewed, expired, outcomes };
  } catch (err) {
    console.error(
      '[hr-automsg] drain failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Enqueue the due nudges; the count of rows queued, null on failure. */
export async function runHrAutomsgNudges(
  now: Date = new Date()
): Promise<number | null> {
  try {
    return await new PgAutoMsgStore(supabaseAdmin()).enqueueNudges(now);
  } catch (err) {
    console.error(
      '[hr-automsg] nudges failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
