/**
 * Whether a personal number (migration 190) still belongs to someone who
 * works here. A deactivated or removed person's number must record
 * nothing: their messages are private, admins can read what is filed,
 * and they can no longer sign in to disconnect it.
 *
 * Asked before anything of a delivery is stored, so the answer is one
 * indexed read, kept for as long as the `whatsapp_config` row in hand.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { InboundEventKind } from './webhook-inbox';

/** Throws when the profile cannot be read: unknown is neither yes nor no. */
export async function isLiveMember(
  db: SupabaseClient,
  accountId: string,
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await db
    .from('profiles')
    .select('id')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .is('deactivated_at', null)
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

interface ConfigRow {
  account_id: string;
  user_id?: string | null;
  is_personal?: boolean | null;
}

const answers = new WeakMap<object, boolean>();

/**
 * True for every company number, whoever connected it, and for a personal
 * number whose owner is a live member. Remembered per row object, so a
 * delivery's events share one read; a failed read is not remembered.
 */
export async function mayRecordFor(
  db: SupabaseClient,
  config: ConfigRow
): Promise<boolean> {
  if (config.is_personal !== true) return true;
  const known = answers.get(config);
  if (known !== undefined) return known;
  const live = await isLiveMember(db, config.account_id, config.user_id);
  answers.set(config, live);
  return live;
}

const logged = new Set<string>();

/** Once per number and kind per process; never a number or a text. */
export function logPersonalDrop(
  configId: string,
  kind: InboundEventKind
): void {
  const key = `${configId}:${kind}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.warn(
    `[personal-number] ${kind} events of number ${configId} are dropped: its owner is no longer an active member`
  );
}
