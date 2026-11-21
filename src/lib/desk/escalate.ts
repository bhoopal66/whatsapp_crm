/**
 * Tray escalation (migration 230): a WhatsApp document left in the desk
 * tray past its workspace's delay (default 2 h) becomes one follow-up
 * task, for the item's duty owner (else the workspace owner), through
 * 085's system writer. The task carries no contact or text from the
 * customer, only that a document is waiting; `source_ref
 * desk_tray:<id>` makes a second run a no-op, and the item is marked
 * escalated once. Runs from the automations cron every 5 minutes.
 *
 * Never throws; a failure is only logged.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { createSystemTask } from '@/lib/tasks/system';

import { DeskStore } from './store';

export interface EscalationSummary {
  due: number;
  escalated: number;
  failed: number;
}

export async function runDeskTrayEscalation(
  db: SupabaseClient,
  store: DeskStore = new DeskStore(db),
  createTask: typeof createSystemTask = createSystemTask
): Promise<EscalationSummary | null> {
  let due: Awaited<ReturnType<DeskStore['dueEscalations']>>;
  try {
    due = await store.dueEscalations();
  } catch (err) {
    console.error(
      `[desk] tray escalation read failed: ${err instanceof Error ? err.name : typeof err}`
    );
    return null;
  }
  const summary: EscalationSummary = {
    due: due.length,
    escalated: 0,
    failed: 0,
  };
  for (const item of due) {
    try {
      await createTask(db, {
        accountId: item.accountId,
        kind: 'follow_up',
        source: 'automation',
        sourceRef: `desk_tray:${item.trayId}`,
        title: 'A customer document is waiting in the desk tray',
        note: `Not sorted for ${Math.floor(item.ageMinutes / 60)} h ${item.ageMinutes % 60} min. Open Case desk > Tray to file or dismiss it.`,
        assignedTo: item.assignee,
        meta: { desk_tray_id: item.trayId },
      });
      if (await store.markEscalated(item.trayId)) summary.escalated += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[desk] tray escalation failed: ${err instanceof Error ? err.name : typeof err}`
      );
    }
  }
  return summary;
}

/**
 * Sorting-queue alerts (migration 232): a bank queue's oldest waiting
 * upload past 2 h becomes a follow-up for the second coordinator (else
 * whoever covers), past 4 h for the lead; the no-bank queue goes to the
 * lead. One task per upload and level (`source_ref
 * desk_queue:<item>:<level>`), so a queue that stays old asks again only
 * when it escalates. Never throws.
 */
export async function runDeskQueueAlerts(
  db: SupabaseClient,
  store: DeskStore = new DeskStore(db),
  createTask: typeof createSystemTask = createSystemTask
): Promise<EscalationSummary | null> {
  let due: Awaited<ReturnType<DeskStore['queueAlertsDue']>>;
  try {
    due = await store.queueAlertsDue();
  } catch (err) {
    console.error(
      `[desk] queue alert read failed: ${err instanceof Error ? err.name : typeof err}`
    );
    return null;
  }
  const summary: EscalationSummary = {
    due: due.length,
    escalated: 0,
    failed: 0,
  };
  for (const a of due) {
    const queue = a.bankCode
      ? `the ${a.bankCode} sorting queue`
      : 'the no-bank sorting queue';
    try {
      const r = await createTask(db, {
        accountId: a.accountId,
        kind: 'follow_up',
        source: 'automation',
        sourceRef: `desk_queue:${a.itemId}:${a.level}`,
        title: `Uploads are waiting in ${queue}`,
        note: `${a.waiting} waiting; the oldest for ${Math.floor(a.ageMinutes / 60)} h ${a.ageMinutes % 60} min. Open Case desk > Sorting queue.`,
        assignedTo: a.assignee,
        meta: { desk_queue_bank: a.bankCode, desk_queue_level: a.level },
      });
      if (r.created) summary.escalated += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[desk] queue alert failed: ${err instanceof Error ? err.name : typeof err}`
      );
    }
  }
  return summary;
}
