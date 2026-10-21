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

/** Rows claimed per drain pass. */
export const OUTBOX_CLAIM_LIMIT = 200;

interface OutboxRow {
  id: number | string;
  account_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/**
 * One pass: claim up to OUTBOX_CLAIM_LIMIT rows and deliver each, in
 * order. Returns how many were delivered (handed to the endpoints). A
 * claim failure throws (the cron logs it); a delivery failure does not.
 */
export async function drainWebhookOutbox(
  db: SupabaseClient
): Promise<{ claimed: number; delivered: number }> {
  const { data, error } = await db.rpc('webhook_outbox_claim', {
    p_limit: OUTBOX_CLAIM_LIMIT,
  });
  if (error) throw new Error(`webhook_outbox_claim failed: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as OutboxRow[];
  let delivered = 0;
  for (const row of rows) {
    if (!isWebhookEvent(row.event)) {
      console.warn('[webhooks] outbox row with unknown event:', row.id);
      continue;
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
    delivered += 1;
  }
  return { claimed: rows.length, delivered };
}

/** Deletes delivered rows older than 7 days; returns how many. Throws on failure. */
export async function purgeWebhookOutbox(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('webhook_outbox_purge');
  if (error) throw new Error(`webhook_outbox_purge failed: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}
