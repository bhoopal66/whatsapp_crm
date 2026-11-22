// ============================================================
// The response-time escalation sweep (migration 237's
// response_escalation_sweep): for each workspace with Response times
// switched on, bells for customers waiting past the target (the
// assignee), past twice the target (their team leader, else owners and
// admins) and unassigned chats at the target (owners and admins), each
// once per waiting episode. The SQL does the counting, the dedup and
// the bells in one call; this only calls it. The automations cron runs
// it at most every 5 minutes per process.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResponseSweepSummary {
  accounts: number;
  failed: number;
  chats: number;
  notifications: number;
}

let missingLogged = false;

function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883';
}

function count(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Run the sweep with the service-role client. Never throws (it rides
 * along on the automations cron, whose own work must not fail for it,
 * and a build deployed ahead of its migration has to keep working).
 * Null when the sweep did not run.
 */
export async function runResponseEscalationSweep(
  admin: SupabaseClient
): Promise<ResponseSweepSummary | null> {
  try {
    const { data, error } = await admin.rpc('response_escalation_sweep');
    if (error) {
      if (isMissingFunction(error)) {
        if (!missingLogged) {
          missingLogged = true;
          console.warn(
            '[response-times] response_escalation_sweep is missing — apply migration 237.'
          );
        }
        return null;
      }
      console.error('[response-times] escalation sweep failed:', error.message);
      return null;
    }
    const o =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    return {
      accounts: count(o, 'accounts'),
      failed: count(o, 'failed'),
      chats: count(o, 'chats'),
      notifications: count(o, 'notifications'),
    };
  } catch (err) {
    console.error(
      '[response-times] escalation sweep failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
