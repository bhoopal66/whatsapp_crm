/**
 * A person who left (deactivated or removed) takes their personal number
 * (migration 190) with them: the disconnect they could have done
 * themselves, done for them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { disconnectOpenWANumber } from './openwa-number';
import { waitingMessages } from './waiting-messages';

/**
 * Disconnect `userId`'s personal numbers of `accountId`. Never throws.
 * False when something may still be linked: the gateway could not be
 * cleaned up (the row is gone, so its callbacks name no number here), or
 * the row could not be removed. Such a row is marked so it records
 * nothing even if the person is reactivated: without its webhook secret
 * no callback verifies, and `disconnected` pauses its import. Company
 * numbers they connected are not theirs and are left alone.
 *
 * `db` is the service role; the caller has authorised the departure.
 */
export async function disconnectPersonalNumbersOf(
  db: SupabaseClient,
  accountId: string,
  userId: string
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('whatsapp_config')
      .select('id, phone_number_id')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .eq('provider', 'openwa')
      .eq('is_personal', true);
    if (error) throw error;
    let clean = true;
    for (const row of (data ?? []) as Array<{
      id: string;
      phone_number_id: string | null;
    }>) {
      if (await disconnectOne(db, accountId, row)) continue;
      clean = false;
      console.error(
        `[personal-number] number ${row.id} of user ${userId} in account ${accountId} was not fully disconnected`
      );
    }
    return clean;
  } catch (err) {
    console.error(
      `[personal-number] could not read the numbers of user ${userId} in account ${accountId}:`,
      (err as { code?: unknown } | null)?.code
    );
    return false;
  }
}

async function disconnectOne(
  db: SupabaseClient,
  accountId: string,
  row: { id: string; phone_number_id: string | null }
): Promise<boolean> {
  try {
    // Access is cut at once whatever waits: the count is only logged.
    const waiting = await waitingMessages(db, [row.id]);
    if (waiting > 0) {
      console.warn(
        `[personal-number] number ${row.id} in account ${accountId} removed with ${waiting} customer messages not yet processed`
      );
    }
    const res = await disconnectOpenWANumber(db, accountId, row, {
      force: true,
    });
    if (res.ok) {
      const body = (await res.json()) as { gatewayCleanup?: string };
      return body.gatewayCleanup === 'complete';
    }
  } catch (err) {
    console.error(
      `[personal-number] disconnect of ${row.id} threw:`,
      (err as { name?: unknown } | null)?.name
    );
  }
  const { error } = await db
    .from('whatsapp_config')
    .update({ status: 'disconnected', verify_token: null })
    .eq('account_id', accountId)
    .eq('id', row.id);
  if (error) {
    console.error(
      `[personal-number] could not mark number ${row.id}:`,
      error.code
    );
  }
  return false;
}
