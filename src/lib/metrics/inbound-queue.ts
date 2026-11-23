/**
 * The durable inbound WhatsApp queue in numbers (migration 264), for GET
 * /api/metrics. Like the outbox's: the read never throws and gives up
 * after `timeoutMs`, and a failed one renders only
 * `wacrm_inbound_queue_stats_up 0`.
 *
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  inboundQueueStats,
  type InboundQueueStats,
} from '@/lib/whatsapp/webhook-inbox';
import { OUTBOX_STATS_TIMEOUT_MS } from './outbox';
import type { Registry } from './registry';

export async function readInboundQueueStats(
  db: Pick<SupabaseClient, 'rpc'>,
  timeoutMs = OUTBOX_STATS_TIMEOUT_MS
): Promise<InboundQueueStats | null> {
  try {
    return await Promise.race([
      inboundQueueStats(db),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs)
      ),
    ]);
  } catch {
    return null;
  }
}

/** Sets the gauges for this scrape; `null` renders only stats_up 0. */
export function collectInboundQueue(
  registry: Registry,
  stats: InboundQueueStats | null
): void {
  const up = registry.gauge(
    'wacrm_inbound_queue_stats_up',
    '1 when the inbound WhatsApp queue could be read for this scrape, else 0.'
  );
  const pending = registry.gauge(
    'wacrm_inbound_queue_pending',
    'Inbound WhatsApp events recorded and not processed yet.'
  );
  const dead = registry.gauge(
    'wacrm_inbound_queue_dead',
    'Inbound WhatsApp events given up on after every retry.'
  );
  const oldest = registry.gauge(
    'wacrm_inbound_queue_oldest_pending_age_seconds',
    'Age of the oldest unprocessed inbound WhatsApp event, in seconds (0 when none).'
  );
  pending.reset();
  dead.reset();
  oldest.reset();
  up.set({}, stats ? 1 : 0);
  if (!stats) return;
  pending.set({}, stats.pending);
  dead.set({}, stats.dead);
  oldest.set({}, stats.oldestPendingAgeSeconds);
}
