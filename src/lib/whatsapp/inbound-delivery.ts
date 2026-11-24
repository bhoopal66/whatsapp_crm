/**
 * The webhook routes' half of the durable queue (migration 264): one
 * authenticated delivery's recorded events, run one by one inside
 * `after()`. What is left (a retry, a killed process) the automations
 * cron drains.
 */

import {
  confirmAccepted,
  releaseAccepted,
  type ScreenCtx,
  type ScreenDecision,
} from '@/lib/edge';
import { processInboundEvent, type InboundConfigRow } from './inbound-events';
import {
  settleInboundEvent,
  type InboundEvent,
  type RecordedEvent,
} from './webhook-inbox';

/** A screened event with what the route needs to run it. */
export interface DeliveredEvent extends InboundEvent {
  /** The authenticated `whatsapp_config` row. */
  config: InboundConfigRow;
  /** Over the sender's limit it holds no claim (screening released it). */
  decision: ScreenDecision;
}

/**
 * Process, settle, and only then confirm the event's replay claim. Never
 * throws: one failing event must not stop the next.
 *
 * A claim is confirmed only when the event is done, since a confirmed key
 * swallows redeliveries for 24 hours. Otherwise it is given back, so a
 * redelivery takes the row over at once instead of answering 503 until the
 * lease lapses. A `busy` event is another worker's: its claim lapses.
 */
export async function runDeliveredEvents(
  ctx: ScreenCtx,
  events: readonly RecordedEvent<DeliveredEvent>[],
  later: Promise<unknown>[]
): Promise<void> {
  for (const { event, id, attempt, state } of events) {
    try {
      if (state === 'busy') continue;
      if (state === 'done') {
        await confirmAccepted(ctx, [event.decision]);
        continue;
      }
      const started = later.length;
      const outcome = await processInboundEvent(event, {
        config: event.config,
        later,
        attempt,
      });
      // Awaited only after every event: an early rejection must not count
      // as unhandled meanwhile.
      for (const work of later.slice(started)) work.catch(() => {});
      const settled = await settleInboundEvent(id, attempt, outcome);
      if (settled === 'done') await confirmAccepted(ctx, [event.decision]);
      else await releaseAccepted(ctx, [event.decision]);
    } catch (error) {
      console.error(
        `[inbound-delivery] ${event.provider} ${event.kind} on ${event.channel} threw`,
        (error as { name?: unknown } | null)?.name
      );
    }
  }
}

/** Background work of a delivery's messages; a rejection is only logged. */
export async function awaitLater(
  later: readonly Promise<unknown>[]
): Promise<void> {
  for (const result of await Promise.allSettled(later)) {
    if (result.status === 'rejected') {
      console.error('[inbound-delivery] background work failed', result.reason);
    }
  }
}
