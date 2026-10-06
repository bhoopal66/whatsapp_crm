// ============================================================
// The Team activity alert sweep (migration 068's
// team_activity_alert_sweep): bell alerts when a person goes past their
// daily new-chat limit or a Whapi number reaches its own, once per
// person or number per local day. The SQL does the counting, the
// dedup and the notification rows in one transaction; this only calls
// it. The automation cron runs it at most every few minutes.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingFunction } from './db-errors';

export interface AlertSweepSummary {
  alerts: number;
  notifications: number;
}

let missingLogged = false;

/**
 * Run the sweep with the service-role client. Never throws: it rides
 * along on the automation cron, whose own work must not fail for it,
 * and a build deployed ahead of its migration has to keep working.
 * Null when the sweep did not run.
 */
export async function runTeamActivityAlertSweep(
  admin: SupabaseClient
): Promise<AlertSweepSummary | null> {
  try {
    const { data, error } = await admin.rpc('team_activity_alert_sweep');
    if (error) {
      if (isMissingFunction(error)) {
        if (!missingLogged) {
          missingLogged = true;
          console.warn(
            '[team-activity] team_activity_alert_sweep is missing — apply migration 068.'
          );
        }
        return null;
      }
      console.error('[team-activity] alert sweep failed:', error.message);
      return null;
    }
    const o = (data ?? {}) as Record<string, unknown>;
    return {
      alerts: typeof o.alerts === 'number' ? o.alerts : 0,
      notifications: typeof o.notifications === 'number' ? o.notifications : 0,
    };
  } catch (err) {
    console.error(
      '[team-activity] alert sweep failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
