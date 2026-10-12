import type { SupabaseClient } from '@supabase/supabase-js';

import { dialDueCallbacks, type CallbacksSummary } from './callbacks';
import { processStoredPbxEvent } from './process';
import { fetchPendingRecordings, type RecordingsSummary } from './recordings';

/**
 * The phone system's periodic work (GET /api/pbx/cron, and the
 * automations cron once a minute): recordings, call-backs, retries of
 * failed events, then pbx_purge(). `db` is the service role.
 */

/** Retries per failed event; pbx_purge() drops one that used them all. */
export const MAX_EVENT_ATTEMPTS = 3;
/** The whole run stops starting work after this, inside a 60 s route. */
export const PBX_CRON_BUDGET_MS = 45_000;

type Row = Record<string, unknown>;
const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export interface RetrySummary {
  retried: number;
  recovered: number;
}

/**
 * Re-runs stored events whose processing failed (`processed_at` NULL,
 * `error` set), at most MAX_EVENT_ATTEMPTS times each. A row is claimed
 * by bumping `attempts` from the value read, so overlapping runs never
 * process it twice in one round.
 */
export async function retryFailedPbxEvents(input: {
  db: SupabaseClient;
  limit?: number;
  deadline?: number;
  now?: () => number;
}): Promise<RetrySummary> {
  const { db, limit = 50, deadline, now = Date.now } = input;
  const { data, error } = await db
    .from('pbx_events_raw')
    .select('id, connection_id, payload, received_at, attempts')
    .is('processed_at', null)
    .not('error', 'is', null)
    .lt('attempts', MAX_EVENT_ATTEMPTS)
    .order('received_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`pbx_events_raw read failed: ${error.message}`);
  const summary: RetrySummary = { retried: 0, recovered: 0 };
  for (const row of (data ?? []) as Row[]) {
    if (deadline !== undefined && now() >= deadline) break;
    const attempts = Number(row.attempts ?? 0);
    const claim = await db
      .from('pbx_events_raw')
      .update({ attempts: attempts + 1 })
      .eq('id', row.id)
      .eq('attempts', attempts)
      .is('processed_at', null)
      .select('id');
    if (claim.error) {
      throw new Error(`pbx_events_raw claim failed: ${claim.error.message}`);
    }
    if (!((claim.data ?? []) as unknown[]).length) continue;
    summary.retried++;
    const out = await processStoredPbxEvent({
      db,
      connectionId: String(row.connection_id),
      rawId: row.id,
      frame: row.payload,
      receivedAt: String(row.received_at),
    });
    if (!out.error) summary.recovered++;
  }
  return summary;
}

export interface PbxCronSummary {
  recordings?: RecordingsSummary;
  callbacks?: CallbacksSummary;
  retries?: RetrySummary;
  purge?: unknown;
  /** Steps not started because the budget ran out. */
  outOfTime: string[];
  errors: Record<string, string>;
}

/**
 * Each step runs only while the budget lasts, and a failing step is
 * recorded without stopping the ones after it.
 */
export async function runPbxCron(input: {
  db: SupabaseClient;
  now?: () => number;
  budgetMs?: number;
}): Promise<PbxCronSummary> {
  const { db, now = Date.now, budgetMs = PBX_CRON_BUDGET_MS } = input;
  const deadline = now() + budgetMs;
  const summary: PbxCronSummary = { outOfTime: [], errors: {} };
  const steps: [string, () => Promise<void>][] = [
    [
      'recordings',
      async () => {
        summary.recordings = await fetchPendingRecordings({
          db,
          now,
          deadline,
        });
      },
    ],
    [
      'callbacks',
      async () => {
        summary.callbacks = await dialDueCallbacks({ db, now, deadline });
      },
    ],
    [
      'retries',
      async () => {
        summary.retries = await retryFailedPbxEvents({ db, now, deadline });
      },
    ],
    [
      'purge',
      async () => {
        const { data, error } = await db.rpc('pbx_purge');
        if (error) throw new Error(error.message);
        summary.purge = data;
      },
    ],
  ];
  for (const [name, step] of steps) {
    if (now() >= deadline) {
      summary.outOfTime.push(name);
      continue;
    }
    try {
      await step();
    } catch (err) {
      summary.errors[name] = message(err);
      console.error(`[pbx-cron] ${name} failed:`, message(err));
    }
  }
  return summary;
}
