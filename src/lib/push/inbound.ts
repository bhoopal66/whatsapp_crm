import type { SupabaseClient } from '@supabase/supabase-js';

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
