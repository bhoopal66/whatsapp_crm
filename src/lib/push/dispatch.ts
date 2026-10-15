import type { SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';

import { pushConfig, type PushConfig } from './config';
import { ttlFor, urgencyFor } from './kinds';
import { buildPayload } from './payload';
import { decideQuietHours, type QuietPrefs } from './quiet-hours';

/**
 * Drain the push outbox (migration 109) once: claim up to `limit` rows
 * (push_claim), send each to every device of its person with web-push,
 * settle it (push_settle).
 *
 * - A device the push service calls gone (404/410) is deleted; any other
 *   failure counts against it, and it is deleted at 10 in a row.
 * - A row reaches the person if any device took it. If none did and
 *   some failure was not "gone", it is settled failed and push_claim
 *   retries it after its 2-minute lease (5 tries in all).
 * - Quiet hours (quiet-hours.ts): a held row is put back with its
 *   claim set to fall due when the window ends and its attempt
 *   refunded, so holding never uses up tries and never blocks the
 *   queue head. A row with nothing to do (push switched off since it
 *   was queued, no device left, too old after quiet hours) is closed
 *   as skipped: sent_at stamped, the reason in last_error.
 *
 * Never throws; with no VAPID keys it does nothing at all.
 */
export interface DispatchSummary {
  claimed: number;
  sent: number;
  held: number;
  skipped: number;
  failed: number;
}

interface OutboxRow {
  id: number;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string;
  tag: string | null;
  created_at: string;
  attempts: number;
}

interface Subscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
}

interface Prefs extends QuietPrefs {
  user_id: string;
  enabled: boolean;
  kinds: Record<string, unknown> | null;
}

/** Consecutive failures after which a device is dropped. */
export const MAX_DEVICE_FAILURES = 10;
const CLAIM_LEASE_MS = 2 * 60_000;

export async function dispatchPush(
  admin: SupabaseClient,
  { limit = 50 }: { limit?: number } = {}
): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    claimed: 0,
    sent: 0,
    held: 0,
    skipped: 0,
    failed: 0,
  };
  const config = pushConfig();
  if (!config) return summary;
  try {
    const { data, error } = await admin.rpc('push_claim', { p_limit: limit });
    if (error) {
      console.error('[push] claim failed:', error.message);
      return summary;
    }
    const rows = (data ?? []) as OutboxRow[];
    summary.claimed = rows.length;
    if (rows.length === 0) return summary;

    const users = [...new Set(rows.map((r) => r.user_id))];
    const [subsRes, prefsRes] = await Promise.all([
      admin
        .from('push_subscriptions')
        .select('id, user_id, endpoint, p256dh, auth, failure_count')
        .in('user_id', users),
      admin
        .from('push_preferences')
        .select('user_id, enabled, kinds, quiet_start, quiet_end, time_zone')
        .in('user_id', users),
    ]);
    if (subsRes.error || prefsRes.error) {
      const msg = (subsRes.error ?? prefsRes.error)!.message;
      console.error('[push] could not load devices or preferences:', msg);
      for (const row of rows) await settle(admin, row.id, false, msg);
      summary.failed += rows.length;
      return summary;
    }
    const subs = (subsRes.data ?? []) as Subscription[];
    const prefsByUser = new Map(
      ((prefsRes.data ?? []) as Prefs[]).map((p) => [p.user_id, p])
    );
    // Devices dropped in this pass, so a later row skips them.
    const gone = new Set<string>();

    for (const row of rows) {
      try {
        const outcome = await deliverRow(
          admin,
          config,
          row,
          subs.filter((s) => s.user_id === row.user_id && !gone.has(s.id)),
          prefsByUser.get(row.user_id) ?? null,
          gone
        );
        summary[outcome] += 1;
      } catch (err) {
        console.error(
          '[push] row',
          row.id,
          'failed:',
          err instanceof Error ? err.message : err
        );
        summary.failed += 1;
      }
    }
  } catch (err) {
    console.error(
      '[push] dispatch failed:',
      err instanceof Error ? err.message : err
    );
  }
  return summary;
}

async function deliverRow(
  admin: SupabaseClient,
  config: PushConfig,
  row: OutboxRow,
  devices: Subscription[],
  prefs: Prefs | null,
  gone: Set<string>
): Promise<'sent' | 'held' | 'skipped' | 'failed'> {
  if (prefs && (!prefs.enabled || prefs.kinds?.[row.kind] === false)) {
    await skip(admin, row.id, 'push switched off');
    return 'skipped';
  }
  const now = new Date();
  const decision = decideQuietHours({
    kind: row.kind,
    createdAt: new Date(row.created_at),
    prefs,
    now,
  });
  if (decision.action === 'skip') {
    await skip(admin, row.id, decision.reason);
    return 'skipped';
  }
  if (decision.action === 'hold') {
    // push_claim takes a row whose claim is over 2 minutes old: date the
    // claim so it lapses as the window ends, and refund the attempt.
    const { error } = await admin
      .from('push_outbox')
      .update({
        claimed_at: new Date(
          decision.until.getTime() - CLAIM_LEASE_MS
        ).toISOString(),
        attempts: Math.max(0, row.attempts - 1),
      })
      .eq('id', row.id)
      .is('sent_at', null);
    if (error) console.error('[push] hold failed:', row.id, error.message);
    return 'held';
  }
  if (devices.length === 0) {
    await skip(admin, row.id, 'no device');
    return 'skipped';
  }

  const payload = buildPayload(row);
  const options = {
    TTL: ttlFor(row.kind),
    urgency: urgencyFor(row.kind),
    vapidDetails: {
      subject: config.subject,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
    },
  } as const;
  let delivered = false;
  let lastError: string | null = null;
  for (const device of devices) {
    try {
      await webpush.sendNotification(
        {
          endpoint: device.endpoint,
          keys: { p256dh: device.p256dh, auth: device.auth },
        },
        payload,
        options
      );
      delivered = true;
      await admin
        .from('push_subscriptions')
        .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
        .eq('id', device.id);
      device.failure_count = 0;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        gone.add(device.id);
        await admin.from('push_subscriptions').delete().eq('id', device.id);
        continue;
      }
      lastError = `${status ?? 'error'}: ${err instanceof Error ? err.message : String(err)}`;
      device.failure_count += 1;
      if (device.failure_count >= MAX_DEVICE_FAILURES) {
        gone.add(device.id);
        await admin.from('push_subscriptions').delete().eq('id', device.id);
      } else {
        await admin
          .from('push_subscriptions')
          .update({ failure_count: device.failure_count })
          .eq('id', device.id);
      }
    }
  }
  if (delivered) {
    await settle(admin, row.id, true, null);
    return 'sent';
  }
  if (lastError === null) {
    await skip(admin, row.id, 'no device (every subscription expired)');
    return 'skipped';
  }
  await settle(admin, row.id, false, lastError);
  return 'failed';
}

async function settle(
  admin: SupabaseClient,
  id: number,
  ok: boolean,
  error: string | null
): Promise<void> {
  const { error: err } = await admin.rpc('push_settle', {
    p_id: id,
    p_ok: ok,
    p_error: error,
  });
  if (err) console.error('[push] settle failed:', id, err.message);
}

async function skip(
  admin: SupabaseClient,
  id: number,
  reason: string
): Promise<void> {
  const { error } = await admin
    .from('push_outbox')
    .update({
      sent_at: new Date().toISOString(),
      last_error: `skipped: ${reason}`,
    })
    .eq('id', id)
    .is('sent_at', null);
  if (error) console.error('[push] skip failed:', id, error.message);
}
