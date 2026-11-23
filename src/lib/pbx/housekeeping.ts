import type { SupabaseClient } from '@supabase/supabase-js';

import { dialDueCallbacks, type CallbacksSummary } from './callbacks';
import {
  dueForRetry,
  LATE_AFTER_MS,
  retryDecision,
  retryStateRow,
  type RetryDecision,
} from './event-retry';
import { checkPbxSilence, type SilenceSummary } from './health';
import { processStoredPbxEvent } from './process';
import {
  fetchPendingRecordings,
  RECORDING_BUCKET,
  type RecordingsSummary,
} from './recordings';
import {
  RECONCILE_INTERVAL_MS,
  reconcileLostCalls,
  type ReconcileSummary,
} from './reconcile-calls';
import {
  onceEvery,
  settleStaleCalls,
  STALE_SWEEP_INTERVAL_MS,
  type StaleCallsSummary,
} from './stale-calls';
import { parseYeastarEvent } from './yeastar/events';

/**
 * The phone system's periodic work (GET /api/pbx/cron, and the
 * automations cron once a minute): the presence keepalive, the outcome
 * reminders, the silence alert (migration 104), recordings, call-backs, retries of failed events,
 * pbx_purge(), the retention period, then the orphaned-audio sweep.
 * `db` is the service role.
 */

/** Retries per failed event; pbx_purge() drops one that used them all. */
export const MAX_EVENT_ATTEMPTS = 3;
/** The whole run stops starting work after this, inside a 60 s route. */
export const PBX_CRON_BUDGET_MS = 45_000;
/**
 * Bells per run for calls left without a mandatory outcome
 * (pbx_outcome_reminders, 097); any beyond wait for the next run.
 */
export const OUTCOME_REMINDER_LIMIT = 200;

type Row = Record<string, unknown>;
const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

interface PendingEvent {
  id: unknown;
  connection_id: string;
  payload: unknown;
  received_at: string;
  error: string | null;
  attempts: number | null;
}

export interface RetrySummary {
  retried: number;
  recovered: number;
  /** Stamped processed without a run: too old, or superseded. */
  skipped: number;
}

/** Parses a pending row and reads the row it would overwrite. */
async function decideRetry(
  db: SupabaseClient,
  row: PendingEvent,
  nowMs: number
): Promise<RetryDecision> {
  const frame = row.payload;
  const parsed =
    typeof frame === 'string' || (typeof frame === 'object' && frame !== null)
      ? parseYeastarEvent(frame)
      : null;
  const event = parsed?.ok ? parsed.event : null;
  const state = retryStateRow(event);
  let stateUpdatedAt: string | null = null;
  if (state) {
    const { data, error } = await db
      .from(state.table)
      .select('updated_at')
      .eq('connection_id', row.connection_id)
      .eq(state.column, state.value)
      .maybeSingle();
    if (error) throw new Error(`${state.table} read failed: ${error.message}`);
    const at = (data as Row | null)?.updated_at;
    stateUpdatedAt = typeof at === 'string' ? at : null;
  }
  return retryDecision({
    event,
    receivedAt: row.received_at,
    stateUpdatedAt,
    nowMs,
  });
}

/**
 * Re-runs stored events never stamped processed: those that failed
 * (`error` set) and those interrupted before their stamp (no error, past
 * INTERRUPTED_AFTER_MS), at most MAX_EVENT_ATTEMPTS times each. Rows
 * under LATE_AFTER_MS old come first, so a backlog of older ones never
 * starves them. A row is claimed by bumping `attempts` from the value
 * read, so overlapping runs never process it twice in one round. What an
 * old event may still do is event-retry.ts's decision.
 */
export async function retryFailedPbxEvents(input: {
  db: SupabaseClient;
  limit?: number;
  deadline?: number;
  now?: () => number;
}): Promise<RetrySummary> {
  const { db, limit = 50, deadline, now = Date.now } = input;
  const nowMs = now();
  const cutoff = new Date(nowMs - LATE_AFTER_MS).toISOString();
  const read = async (age: 'gte' | 'lt', max: number) => {
    const { data, error } = await db
      .from('pbx_events_raw')
      .select('id, connection_id, payload, received_at, error, attempts')
      .is('processed_at', null)
      .lt('attempts', MAX_EVENT_ATTEMPTS)
      [age]('received_at', cutoff)
      .order('received_at', { ascending: true })
      .limit(max);
    if (error) throw new Error(`pbx_events_raw read failed: ${error.message}`);
    return (data ?? []) as PendingEvent[];
  };
  const rows = (await read('gte', limit)).filter((r) => dueForRetry(r, nowMs));
  if (rows.length < limit) {
    rows.push(...(await read('lt', limit - rows.length)));
  }
  const summary: RetrySummary = { retried: 0, recovered: 0, skipped: 0 };
  for (const row of rows) {
    if (deadline !== undefined && now() >= deadline) break;
    // Judged before the claim: a failed read spends no attempt.
    const decision = await decideRetry(db, row, now());
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
    if (!decision.run) {
      const stamp = await db
        .from('pbx_events_raw')
        .update({
          processed_at: new Date(now()).toISOString(),
          error: decision.reason,
        })
        .eq('id', row.id)
        .is('processed_at', null);
      if (stamp.error) {
        throw new Error(`pbx_events_raw stamp failed: ${stamp.error.message}`);
      }
      summary.skipped++;
      continue;
    }
    summary.retried++;
    const out = await processStoredPbxEvent({
      db,
      connectionId: row.connection_id,
      rawId: row.id,
      frame: row.payload,
      receivedAt: row.received_at,
      late: decision.late,
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

/** Recordings marked expired per pbx_expire_recordings() call. */
export const RETENTION_BATCH = 200;
/** Calls per run: a backlog (a period just shortened) drains over runs. */
export const RETENTION_ROUNDS = 5;

export interface RetentionSummary {
  /** Recordings past their workspace's period, marked erased this run. */
  expired: number;
  /** Their audio removed from call-recordings. */
  deleted: number;
  /** Left in storage by a failed remove, for the orphan sweep. */
  failed: number;
  /** The last remove error. */
  error?: string;
}

/**
 * pbx_settings.retention_days (migration 093), once an admin confirmed
 * it (retention_confirmed_at). pbx_expire_recordings() picks the
 * recordings of calls older than the workspace's period, by the later
 * of the PBX's start time and the CRM's first record of the call
 * (pbx_recording_age_from), not under legal hold, marks them erased
 * (the row's erased_at: from that commit nothing can play them) and
 * returns their paths; the audio is removed here. Row first, audio
 * second, as the C-3 erasure does: a remove that fails leaves
 * unplayable audio, never a playable row without audio, and the orphan
 * sweep that runs next takes an erased row's object. A round is one bounded batch, started
 * only before the deadline; a failed remove ends the run, so a storage
 * outage does not mark more rows than it can clear.
 */
export async function expireRecordings(input: {
  db: SupabaseClient;
  deadline?: number;
  now?: () => number;
}): Promise<RetentionSummary> {
  const { db, deadline, now = Date.now } = input;
  const summary: RetentionSummary = { expired: 0, deleted: 0, failed: 0 };
  const storage = db.storage.from(RECORDING_BUCKET);
  for (let round = 0; round < RETENTION_ROUNDS; round++) {
    if (deadline !== undefined && now() >= deadline) break;
    const { data, error } = await db.rpc('pbx_expire_recordings', {
      p_limit: RETENTION_BATCH,
    });
    if (error)
      throw new Error(`pbx_expire_recordings failed: ${error.message}`);
    const paths = ((data ?? []) as unknown[]).filter(
      (p): p is string => typeof p === 'string'
    );
    summary.expired += paths.length;
    for (let i = 0; i < paths.length; i += ORPHAN_BATCH) {
      const batch = paths.slice(i, i + ORPHAN_BATCH);
      const result = await storage.remove(batch);
      if (result.error) {
        summary.failed += paths.length - i;
        summary.error = result.error.message;
        return summary;
      }
      summary.deleted += result.data?.length ?? 0;
    }
    if (paths.length < RETENTION_BATCH) break;
  }
  return summary;
}

export interface PbxCronSummary {
  /** pbx_presence rows on a live call refreshed (migration 101). */
  presence?: number;
  /** call_outcome_due bells rung (097). */
  outcomeReminders?: number;
  /** Silence alert bells rung (104). */
  silence?: SilenceSummary;
  recordings?: RecordingsSummary;
  callbacks?: CallbacksSummary;
  retries?: RetrySummary;
  purge?: unknown;
  retention?: RetentionSummary;
  orphans?: OrphanSweepSummary;
  /** Live calls whose end never arrived, settled from CDR (stale-calls.ts). */
  staleCalls?: StaleCallsSummary;
  /** Calls whose events were lost, found in the CDR (reconcile-calls.ts). */
  reconcile?: ReconcileSummary;
  /** Steps not started because the budget ran out. */
  outOfTime: string[];
  errors: Record<string, string>;
}

/**
 * Each step runs only while the budget lasts, and a failing step is
 * recorded without stopping the ones after it.
 */
/**
 * Per process, shared by both callers of runPbxCron: a CDR read is a PBX
 * API call, not worth making every minute for calls hours old.
 */
const staleCallsDue = onceEvery(STALE_SWEEP_INTERVAL_MS);
const reconcileDue = onceEvery(RECONCILE_INTERVAL_MS);

export async function runPbxCron(input: {
  db: SupabaseClient;
  now?: () => number;
  budgetMs?: number;
  /** Tests: the stale-call step's gate. */
  staleCallsDue?: (nowMs: number) => boolean;
  /** Tests: the lost-call step's gate. */
  reconcileDue?: (nowMs: number) => boolean;
}): Promise<PbxCronSummary> {
  const { db, now = Date.now, budgetMs = PBX_CRON_BUDGET_MS } = input;
  const staleDue = input.staleCallsDue ?? staleCallsDue;
  const lostDue = input.reconcileDue ?? reconcileDue;
  const deadline = now() + budgetMs;
  const summary: PbxCronSummary = { outOfTime: [], errors: {} };
  const steps: [string, () => Promise<void>][] = [
    [
      // First, being quick and on a clock: Yeastar reports a call state
      // only when it changes, and the browser lets one lapse after
      // PRESENCE_STALE_MS, so a call longer than that is refreshed here
      // while it is live (call_live_select hides other people's calls
      // from an agent's browser).
      'presence',
      async () => {
        const { data, error } = await db.rpc('pbx_presence_keepalive');
        if (error) throw new Error(error.message);
        summary.presence = Number(data ?? 0);
      },
    ],
    // Then, ahead of recordings: one quick statement, and a reminder is
    // only useful on time, which a slow recordings download must not eat
    // into.
    [
      'outcomes',
      async () => {
        const { data, error } = await db.rpc('pbx_outcome_reminders', {
          p_limit: OUTCOME_REMINDER_LIMIT,
        });
        if (error) throw new Error(error.message);
        summary.outcomeReminders = Number(data ?? 0);
      },
    ],
    // The silence alert, as quick and as time-bound.
    [
      'silence',
      async () => {
        summary.silence = await checkPbxSilence({ db, now });
      },
    ],
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
    // After the retries (a failed end there may settle a call first), and
    // gated inside the step: one skipped for the budget is not consumed.
    [
      'staleCalls',
      async () => {
        if (!staleDue(now())) return;
        const settled = await settleStaleCalls({ db, now, deadline });
        summary.staleCalls = settled;
        const failed = Object.entries(settled.errors);
        if (failed.length) {
          throw new Error(failed.map(([id, e]) => `${id}: ${e}`).join('; '));
        }
      },
    ],
    // After the retries and the stale calls, which own the calls the CRM
    // has heard of. Gated inside the step, as above.
    [
      'reconcile',
      async () => {
        if (!lostDue(now())) return;
        const found = await reconcileLostCalls({ db, now, deadline });
        summary.reconcile = found;
        const failed = Object.entries(found.errors);
        if (failed.length) {
          throw new Error(failed.map(([id, e]) => `${id}: ${e}`).join('; '));
        }
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
      'retention',
      async () => {
        const expired = await expireRecordings({ db, now, deadline });
        summary.retention = expired;
        if (expired.error) {
          throw new Error(
            `${expired.failed} expired recording(s) not removed: ${expired.error}`
          );
        }
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
