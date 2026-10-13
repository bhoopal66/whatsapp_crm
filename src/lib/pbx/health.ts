import type { SupabaseClient } from '@supabase/supabase-js';

import { PBX_SILENCE_MINUTES } from './admin-ui';
import { CALLBACK_HOURS, inCallbackHours } from './callbacks';

/**
 * The silence alert (migration 104, docs/yeastar.md): when no PBX event
 * has arrived for PBX_SILENCE_MINUTES in working hours, the owners and
 * admins of the connection's workspace get one `pbx_connection_silent`
 * bell, and one `pbx_connection_restored` once events resume. The PBX
 * cron runs it every pass; `pbx_connection_silence()` re-checks the
 * state in the same statement that rings, so a second pass, or an
 * overlapping one, rings nothing.
 */

export type SilenceAction = 'alert' | 'restore' | null;

export interface SilenceState {
  lastEventAt: string | null;
  silenceAlertedAt: string | null;
}

/**
 * What one connection needs now. Pure.
 *
 * - `restore`: an alert went out and an event arrived after it, at any
 *   hour, so the next silence can ring again.
 * - `alert`: no alert out, the latest event at least `quietMinutes`
 *   old, that whole quiet stretch inside working hours (the call-backs'
 *   09:00–20:00 Dubai window), and the latest event itself inside today's
 *   working hours: a link that was delivering today and stopped. Webhook
 *   delivery has no heartbeat, so silence before the first event of the
 *   day cannot tell a broken link from a call centre that opens late or
 *   is closed; that would ring every such morning. A connection that
 *   never had an event stays silent too.
 */
export function silenceAction(
  conn: SilenceState,
  now: number,
  quietMinutes: number = PBX_SILENCE_MINUTES
): SilenceAction {
  const last = conn.lastEventAt ? Date.parse(conn.lastEventAt) : NaN;
  if (Number.isNaN(last)) return null;
  if (conn.silenceAlertedAt) {
    const alerted = Date.parse(conn.silenceAlertedAt);
    return !Number.isNaN(alerted) && last > alerted ? 'restore' : null;
  }
  const quietSince = now - quietMinutes * 60_000;
  if (last > quietSince) return null;
  if (last < dubaiWorkdayStart(now)) return null;
  return inCallbackHours(now) && inCallbackHours(quietSince) ? 'alert' : null;
}

const HOUR_MS = 3_600_000;
/** Dubai is UTC+4 all year (no daylight saving). */
const DUBAI_OFFSET_MS = 4 * HOUR_MS;

/** The start of working hours (09:00 Dubai) on `ms`'s Dubai date. */
export function dubaiWorkdayStart(ms: number): number {
  const day = 24 * HOUR_MS;
  const midnight =
    Math.floor((ms + DUBAI_OFFSET_MS) / day) * day - DUBAI_OFFSET_MS;
  return midnight + CALLBACK_HOURS.start * HOUR_MS;
}

export interface SilenceSummary {
  /** pbx_connection_silent bells rung. */
  alerted: number;
  /** pbx_connection_restored bells rung. */
  restored: number;
}

/**
 * The cron step: every connection that ever had an event, decided by
 * `silenceAction`, moved by `pbx_connection_silence()`. A failed
 * connection does not stop the others; the step then throws, so the
 * cron records it.
 */
export async function checkPbxSilence(input: {
  db: SupabaseClient;
  now?: () => number;
}): Promise<SilenceSummary> {
  const { db, now = Date.now } = input;
  const { data, error } = await db
    .from('pbx_connections')
    .select('id, last_event_at, silence_alerted_at')
    .not('last_event_at', 'is', null);
  if (error) throw new Error(`pbx_connections read failed: ${error.message}`);
  const summary: SilenceSummary = { alerted: 0, restored: 0 };
  const failures: string[] = [];
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const action = silenceAction(
      {
        lastEventAt:
          typeof row.last_event_at === 'string' ? row.last_event_at : null,
        silenceAlertedAt:
          typeof row.silence_alerted_at === 'string'
            ? row.silence_alerted_at
            : null,
      },
      now()
    );
    if (!action) continue;
    const rung = await db.rpc('pbx_connection_silence', {
      p_connection_id: row.id,
      p_silent: action === 'alert',
      p_quiet_minutes: PBX_SILENCE_MINUTES,
    });
    if (rung.error) {
      failures.push(`${String(row.id)}: ${rung.error.message}`);
      continue;
    }
    summary[action === 'alert' ? 'alerted' : 'restored'] += Number(
      rung.data ?? 0
    );
  }
  if (failures.length) {
    throw new Error(`pbx_connection_silence failed: ${failures.join('; ')}`);
  }
  return summary;
}
