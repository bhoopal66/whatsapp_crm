/**
 * The customer document copies to the NAS in numbers (migration 316,
 * `customer_documents_stats()`), for GET /api/metrics: a copy that finally
 * failed tells nobody else. Same rules as outbox.ts: never throws, gives up
 * after `timeoutMs`, and on failure only `_stats_up 0` is rendered.
 *
 * Server-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { OUTBOX_STATS_TIMEOUT_MS } from './outbox';
import type { Registry } from './registry';

export interface CustomerDocumentStats {
  failed: number;
  oldestPendingAgeSeconds: number | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseCustomerDocumentStats(
  data: unknown
): CustomerDocumentStats | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  const failed = num(o.failed);
  if (failed === null) return null;
  return {
    failed,
    oldestPendingAgeSeconds: num(o.oldest_pending_age_seconds),
  };
}

export async function readCustomerDocumentStats(
  db: SupabaseClient,
  timeoutMs = OUTBOX_STATS_TIMEOUT_MS
): Promise<CustomerDocumentStats | null> {
  try {
    const call = db
      .rpc('customer_documents_stats')
      .abortSignal(AbortSignal.timeout(timeoutMs));
    const res = await Promise.race([
      call,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs + 500)
      ),
    ]);
    if (!res || res.error) return null;
    return parseCustomerDocumentStats(res.data);
  } catch {
    return null;
  }
}

/** Sets the gauges for this scrape; `null` renders only stats_up 0. */
export function collectCustomerDocuments(
  registry: Registry,
  stats: CustomerDocumentStats | null
): void {
  const up = registry.gauge(
    'wacrm_customer_documents_stats_up',
    '1 when the customer document copies could be read for this scrape, else 0.'
  );
  const failed = registry.gauge(
    'wacrm_customer_documents_failed',
    'Customer documents whose copy to the NAS failed for good.'
  );
  const oldest = registry.gauge(
    'wacrm_customer_documents_oldest_pending_age_seconds',
    'Age of the oldest customer document waiting for its copy, in seconds (0 when none).'
  );
  failed.reset();
  oldest.reset();
  up.set({}, stats ? 1 : 0);
  if (!stats) return;
  failed.set({}, stats.failed);
  oldest.set({}, stats.oldestPendingAgeSeconds ?? 0);
}
