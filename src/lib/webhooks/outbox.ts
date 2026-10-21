// ============================================================
// Outbound webhook outbox (migration 134).
//
// SQL triggers enqueue events into `webhook_event_outbox` (only for an
// account with an active endpoint subscribed to the event). The
// automations cron drains it: `webhook_outbox_claim` hands each row
// out once and marks it delivered in the same statement, so delivery
// is at-most-once like dispatchWebhookEvent; each row is then signed
// and POSTed through deliver.ts (deliverSigned), which never throws.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { deliverSigned } from '@/lib/webhooks/deliver';
import { isWebhookEvent } from '@/lib/webhooks/events';

/** Most rows one drain pass claims in total. */
export const OUTBOX_CLAIM_LIMIT = 200;
/**
 * Rows per claim. A claim marks its rows delivered at once, so a claim
 * is a debt: a slow receiver costs up to 5 s a row, and rows claimed
 * but never sent when the runtime kills the callback are lost. Small
 * claims, delivered in parallel, keep that debt inside the budget.
 */
export const OUTBOX_BATCH_SIZE = 10;
/** No new claim starts after this long. */
export const OUTBOX_DEADLINE_MS = 30_000;

interface OutboxRow {
  id: number | string;
  account_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface OutboxDrainResult {
  claimed: number;
  delivered: number;
  failed: number;
  /** True when the deadline stopped the drain with the cap not reached. */
  stoppedEarly: boolean;
}

async function deliverRow(
  db: SupabaseClient,
  row: OutboxRow
): Promise<boolean> {
  if (!isWebhookEvent(row.event)) {
    console.warn('[webhooks] outbox row with unknown event:', row.id);
    return false;
  }
  const payload = row.payload ?? {};
  const occurredAt =
    typeof payload.occurred_at === 'string'
      ? payload.occurred_at
      : row.created_at;
  await deliverSigned(db, row.account_id, row.event, {
    id: randomUUID(),
    event: row.event,
    occurred_at: occurredAt,
    account_id: row.account_id,
    data: payload,
  });
  return true;
}

/**
 * Drains the outbox in small claims against a deadline: claim up to
 * OUTBOX_BATCH_SIZE rows, deliver them in parallel, repeat until a
 * claim comes back short, OUTBOX_CLAIM_LIMIT rows are claimed, or the
 * deadline passes (rows not yet claimed wait for the next run). A claim
 * failure throws (the cron logs it); a delivery failure does not.
 */
export async function drainWebhookOutbox(
  db: SupabaseClient,
  opts: { deadlineMs?: number; now?: () => number } = {}
): Promise<OutboxDrainResult> {
  const now = opts.now ?? Date.now;
  const deadlineMs = opts.deadlineMs ?? OUTBOX_DEADLINE_MS;
  const start = now();
  const result: OutboxDrainResult = {
    claimed: 0,
    delivered: 0,
    failed: 0,
    stoppedEarly: false,
  };
  while (result.claimed < OUTBOX_CLAIM_LIMIT) {
    if (now() - start >= deadlineMs) {
      result.stoppedEarly = true;
      break;
    }
    const size = Math.min(
      OUTBOX_BATCH_SIZE,
      OUTBOX_CLAIM_LIMIT - result.claimed
    );
    const { data, error } = await db.rpc('webhook_outbox_claim', {
      p_limit: size,
    });
    if (error) throw new Error(`webhook_outbox_claim failed: ${error.message}`);
    const rows = (Array.isArray(data) ? data : []) as OutboxRow[];
    result.claimed += rows.length;
    const settled = await Promise.allSettled(
      rows.map((row) => deliverRow(db, row))
    );
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) result.delivered += 1;
      else result.failed += 1;
    }
    if (rows.length < size) break;
  }
  return result;
}

/** Deletes delivered rows older than 7 days; returns how many. Throws on failure. */
export async function purgeWebhookOutbox(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('webhook_outbox_purge');
  if (error) throw new Error(`webhook_outbox_purge failed: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}
