import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A customer message older than this when it reaches us is a replay,
 * not news: a linked-device gateway reconnecting (OpenWA's nightly
 * update, a phone back online) delivers the whole backlog at once, and
 * ringing for each one buzzed staff once per old message.
 */
export const INBOUND_PUSH_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Whether a newly stored customer message should ring anyone.
 *
 *  * Not on a personal number (migration 190): the person's own phone
 *    already rings for every message to it, so a CRM push was a second
 *    alert for each one (HR's complaint, 2026-11-13).
 *  * Not when the message is older than INBOUND_PUSH_MAX_AGE_MS (a
 *    backlog replay). An unreadable timestamp rings, as before.
 */
export function shouldPushInbound(args: {
  isPersonalNumber: boolean;
  /** The message's own timestamp, epoch seconds as the normalisers give it. */
  messageTimestamp: string | null | undefined;
  nowMs: number;
}): boolean {
  if (args.isPersonalNumber) return false;
  const sec = Number(args.messageTimestamp);
  if (!args.messageTimestamp || !Number.isFinite(sec) || sec <= 0) return true;
  return args.nowMs - sec * 1000 <= INBOUND_PUSH_MAX_AGE_MS;
}

/**
 * Queue the WhatsApp push for one newly stored customer message
 * (push_whatsapp_inbound, migration 109). Call it once per message,
 * after the inbound idempotency boundary: the function de-dupes
 * nothing, so a replay that reached it would push twice. Fail-open: a
 * push is never worth losing or redelivering the message over.
 */
export async function enqueueInboundPush(
  db: SupabaseClient,
  messageRowId: string
): Promise<void> {
  try {
    const { error } = await db.rpc('push_whatsapp_inbound', {
      p_message_id: messageRowId,
    });
    if (error) console.error('[push] inbound push not queued:', error.message);
  } catch (err) {
    console.error(
      '[push] inbound push not queued:',
      err instanceof Error ? err.message : err
    );
  }
}
