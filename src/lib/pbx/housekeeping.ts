import type { SupabaseClient } from '@supabase/supabase-js';

import { dialDueCallbacks, type CallbacksSummary } from './callbacks';
import { processStoredPbxEvent } from './process';
import {
  fetchPendingRecordings,
  RECORDING_BUCKET,
  type RecordingsSummary,
} from './recordings';

/**
 * The phone system's periodic work (GET /api/pbx/cron, and the
 * automations cron once a minute): recordings, call-backs, retries of
 * failed events, pbx_purge(), then the orphaned-audio sweep. `db` is the
 * service role.
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

/** A fetch uploads before it writes the row: younger audio is left alone. */
export const ORPHAN_GRACE = '1 hour';
/** Orphans listed per run; removed ORPHAN_BATCH at a time. */
export const ORPHAN_LIMIT = 500;
const ORPHAN_BATCH = 100;

export interface OrphanSweepSummary {
  /** Unreferenced objects past the grace window, listed this run. */
  found: number;
  deleted: number;
  /** Left for the next run by a failed remove. */
  failed: number;
  /** The last remove error. */
  error?: string;
}

/**
 * C-3's backstop. Audio in call-recordings that no recording row names
 * (an erasure whose route died before its delete, an owner calling the
 * RPC directly, a fetch that finished after its call was erased) is
 * picked by pbx_orphan_recordings() and removed through the storage
 * API: deleting the storage.objects row alone would leave the bytes.
 */
export async function sweepOrphanRecordings(input: {
  db: SupabaseClient;
  deadline?: number;
  now?: () => number;
}): Promise<OrphanSweepSummary> {
  const { db, deadline, now = Date.now } = input;
  const { data, error } = await db.rpc('pbx_orphan_recordings', {
    p_older_than: ORPHAN_GRACE,
    p_limit: ORPHAN_LIMIT,
  });
  if (error) throw new Error(`pbx_orphan_recordings failed: ${error.message}`);
  const names = ((data ?? []) as unknown[]).filter(
    (n): n is string => typeof n === 'string'
  );
  const summary: OrphanSweepSummary = {
    found: names.length,
    deleted: 0,
    failed: 0,
  };
  const storage = db.storage.from(RECORDING_BUCKET);
  for (let i = 0; i < names.length; i += ORPHAN_BATCH) {
    if (deadline !== undefined && now() >= deadline) break;
    const batch = names.slice(i, i + ORPHAN_BATCH);
    const result = await storage.remove(batch);
    if (result.error) {
      summary.failed += batch.length;
      summary.error = result.error.message;
    } else {
      summary.deleted += result.data?.length ?? 0;
    }
  }
  return summary;
}

export interface PbxCronSummary {
  recordings?: RecordingsSummary;
  callbacks?: CallbacksSummary;
  retries?: RetrySummary;
  purge?: unknown;
  orphans?: OrphanSweepSummary;
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
    [
      'orphans',
      async () => {
        const swept = await sweepOrphanRecordings({ db, now, deadline });
        summary.orphans = swept;
        if (swept.error) {
          throw new Error(
            `${swept.failed} orphaned recording(s) not removed: ${swept.error}`
          );
        }
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
