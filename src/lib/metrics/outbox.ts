/**
 * The HR automated-message queue in numbers (migration 228,
 * `hr_automsg_outbox_stats()`), for GET /api/metrics (package 033g).
 *
 * `readOutboxStats` never throws and gives up after `timeoutMs`: a slow
 * or missing database must not hold up a scrape. On failure the route
 * renders only `wacrm_outbox_stats_up 0`, so an alert can fire on that.
 *
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Registry } from './registry';

export interface OutboxStats {
  rows: { status: string; channel: string; count: number }[];
  held: { reason: string; channel: string; count: number }[];
  oldestQueuedAgeSeconds: number | null;
  terminalFailed: number;
}

export const OUTBOX_STATS_TIMEOUT_MS = 2_000;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Parses the jsonb; anything malformed is dropped rather than guessed. */
export function parseOutboxStats(data: unknown): OutboxStats | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  const list = (v: unknown, key: 'status' | 'reason') =>
    Array.isArray(v)
      ? v.flatMap((e) => {
          if (typeof e !== 'object' || e === null) return [];
          const r = e as Record<string, unknown>;
          const k = str(r[key]);
          const channel = str(r.channel);
          const count = num(r.count);
          return k && channel && count !== null
            ? [{ [key]: k, channel, count } as never]
            : [];
        })
      : [];
  const terminal = num(o.terminal_failed);
  if (!Array.isArray(o.rows) || terminal === null) return null;
  return {
    rows: list(o.rows, 'status'),
    held: list(o.held, 'reason'),
    oldestQueuedAgeSeconds: num(o.oldest_queued_age_seconds),
    terminalFailed: terminal,
  };
}

export async function readOutboxStats(
  db: SupabaseClient,
  timeoutMs = OUTBOX_STATS_TIMEOUT_MS
): Promise<OutboxStats | null> {
  try {
    const call = db
      .rpc('hr_automsg_outbox_stats')
      .abortSignal(AbortSignal.timeout(timeoutMs));
    // The abort covers the request; the race also covers waiting for it.
    const res = await Promise.race([
      call,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs + 500)
      ),
    ]);
    if (!res || res.error) return null;
    return parseOutboxStats(res.data);
  } catch {
    return null;
  }
}

/** Sets the outbox gauges for this scrape; `null` renders only stats_up 0. */
export function collectOutbox(
  registry: Registry,
  stats: OutboxStats | null
): void {
  const up = registry.gauge(
    'wacrm_outbox_stats_up',
    '1 when the HR automated-message queue could be read for this scrape, else 0.'
  );
  const rows = registry.gauge(
    'wacrm_outbox_rows',
    'HR automated messages by status and channel.',
    ['state', 'channel']
  );
  const held = registry.gauge(
    'wacrm_outbox_held_rows',
    'Held HR automated messages by hold reason and channel.',
    ['reason', 'channel']
  );
  const oldest = registry.gauge(
    'wacrm_outbox_oldest_queued_age_seconds',
    'Age of the oldest queued HR automated message, in seconds (0 when none).'
  );
  const terminal = registry.gauge(
    'wacrm_outbox_terminal_failed',
    'HR automated messages failed for good (no retry will pick them up).'
  );
  rows.reset();
  held.reset();
  oldest.reset();
  terminal.reset();
  up.set({}, stats ? 1 : 0);
  if (!stats) return;
  for (const r of stats.rows)
    rows.set({ state: r.status, channel: r.channel }, r.count);
  for (const h of stats.held)
    held.set({ reason: h.reason, channel: h.channel }, h.count);
  oldest.set({}, stats.oldestQueuedAgeSeconds ?? 0);
  terminal.set({}, stats.terminalFailed);
}
