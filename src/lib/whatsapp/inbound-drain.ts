/**
 * The automations cron's half of the durable queue (migration 264): run
 * the events a webhook left behind, ring for the dead ones, purge.
 *
 * Logs counts and error codes only, never customer text.
 */

import { processInboundEvent } from './inbound-events';
import {
  claimInboundEvents,
  notifyDeadInboundEvents,
  purgeInboundEvents,
  settleInboundEvent,
} from './webhook-inbox';

export const DRAIN_MAX_EVENTS = 50;
export const DRAIN_BUDGET_MS = 40_000;

const reason = (err: unknown) =>
  err instanceof Error ? err.message : 'unknown error';

/**
 * One row claimed at a time, so a killed tick holds one lease and not a
 * batch of them. Throws when the claim does; what is settled stays so.
 */
export async function drainInboundEvents(
  now: () => number = Date.now
): Promise<{ processed: number }> {
  const deadline = now() + DRAIN_BUDGET_MS;
  let processed = 0;
  while (processed < DRAIN_MAX_EVENTS && now() < deadline) {
    const [event] = await claimInboundEvents(1);
    if (!event) break;
    const outcome = await processInboundEvent(event, {
      attempt: event.attempt,
    });
    await settleInboundEvent(event.id, event.attempt, outcome);
    processed++;
  }
  return { processed };
}

/** Drain, then bells, then purge; one failing never stops the next. */
export async function runInboundQueueTick(): Promise<void> {
  try {
    const { processed } = await drainInboundEvents();
    if (processed > 0) {
      console.log(`[inbound-drain] retried ${processed} inbound event(s)`);
    }
  } catch (err) {
    console.error('[inbound-drain] drain failed:', reason(err));
  }
  try {
    for (const { accountId, events } of await notifyDeadInboundEvents()) {
      console.error(
        `[inbound-drain] ${events} inbound event(s) given up on account ${accountId}`
      );
    }
  } catch (err) {
    console.error('[inbound-drain] dead-event bells failed:', reason(err));
  }
  try {
    await purgeInboundEvents();
  } catch (err) {
    console.error('[inbound-drain] purge failed:', reason(err));
  }
}
