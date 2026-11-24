// ============================================================
// Customer messages still waiting in webhook_inbox (264) for a number.
//
// `whatsapp_config` rows cascade to `webhook_inbox`: a message the gateway
// was already told we received, and which has not been processed yet,
// vanishes with the number when it is removed. Migration 293 has
// `webhook_inbox_waiting(channel)` (service role only) to count them, so
// an interactive removal can ask once more first.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

let loggedReadFailure = false;

/**
 * How many customer messages of these numbers are still waiting.
 * `admin` is the service-role client (or a function that makes it). A failed read, or a function that
 * is not there yet (293 not applied), is logged once and counts as 0: a
 * removal is never blocked by a failed read.
 */
export async function waitingMessages(
  admin: SupabaseClient | (() => SupabaseClient),
  channelIds: string[]
): Promise<number> {
  let total = 0;
  for (const id of channelIds) {
    try {
      // A factory, so a client that cannot even be built (no service
      // key) is the same harmless failed read.
      const client = typeof admin === 'function' ? admin() : admin;
      const { data, error } = await client.rpc('webhook_inbox_waiting', {
        p_channel: id,
      });
      if (error) throw error;
      const n = typeof data === 'number' ? data : Number(data);
      if (Number.isFinite(n) && n > 0) total += n;
    } catch (err) {
      if (!loggedReadFailure) {
        loggedReadFailure = true;
        console.error(
          '[waiting-messages] could not count waiting messages; counted as 0:',
          (err as { code?: unknown; message?: unknown } | null)?.code ??
            (err as { message?: unknown } | null)?.message
        );
      }
    }
  }
  return total;
}

/** The 409 an interactive removal answers while messages still wait. */
export function messagesWaitingResponse(count: number): NextResponse {
  return NextResponse.json(
    {
      error:
        count === 1
          ? '1 customer message from this number has not been processed yet and would be lost. Remove anyway?'
          : `${count} customer messages from this number have not been processed yet and would be lost. Remove anyway?`,
      code: 'messages_waiting',
      count,
    },
    { status: 409 }
  );
}

/** True when the request says to remove the number regardless (`?force=1`). */
export function wantsForce(request: Request): boolean {
  const v = new URL(request.url).searchParams.get('force');
  return v === '1' || v === 'true';
}
