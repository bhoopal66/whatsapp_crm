// ============================================================
// One delivery pass under the delivery lock.
//
// Shared by every caller that claimed a campaign (Resume, the cron, the
// public API): deliver, keeping the lock alive, then release it. The
// lock's timestamp is its owner's token. A pass that outlived its lock
// (paused for half an hour, then woken) must neither go on sending nor
// clear the lock another pass has taken since.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  deliverBroadcast,
  finalizeBroadcastStatus,
  type BroadcastPlan,
} from '@/lib/whatsapp/broadcast-core';
import {
  refreshBroadcastDelivery,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';

/**
 * @param token The `now.toISOString()` given to `claimBroadcastDelivery`.
 */
export async function runBroadcastPass(
  db: SupabaseClient,
  plan: BroadcastPlan,
  token: string
): Promise<void> {
  let held = token;
  try {
    await deliverBroadcast(db, plan, {
      keepLock: async () => {
        const next = await refreshBroadcastDelivery(db, plan.broadcastId, held);
        if (next) held = next;
        return next !== null;
      },
    });
  } catch (err) {
    console.error(
      `[broadcast-pass] ${plan.broadcastId}: delivery threw:`,
      err instanceof Error ? err.message : err
    );
    // Don't leave it mid-flight — settle whatever did land.
    await finalizeBroadcastStatus(db, plan.broadcastId).catch(() => {});
  } finally {
    await releaseBroadcastDelivery(db, plan.broadcastId, held);
  }
}
