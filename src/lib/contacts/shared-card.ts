import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from './dedupe';

/**
 * Saving a contact card the customer shared. The number is unique in the
 * account but a contact is only readable by the people it belongs to, so
 * "not found" is not "not saved": the insert's 23505 is what says a
 * colleague already has it.
 */

export type CardLookup = { ok: true; id: string | null } | { ok: false };

/** The contact the viewer can see on this normalised number, if any.
 *  A failed read is `ok: false`, never "nobody has it". */
export async function findCardContact(
  supabase: SupabaseClient,
  accountId: string,
  phone: string
): Promise<CardLookup> {
  const { data, error } = await supabase
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone_normalized', phone)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('Failed to look up a shared contact:', error);
    return { ok: false };
  }
  return { ok: true, id: (data?.id as string | undefined) ?? null };
}

export type SaveCardResult =
  | { kind: 'created' | 'existing'; id: string }
  /** The number is a contact the viewer may not see. */
  | { kind: 'colleague' }
  | { kind: 'lookupFailed' }
  | { kind: 'failed' };

export async function saveCardContact(
  supabase: SupabaseClient,
  card: {
    accountId: string;
    userId: string;
    /** Digits, as `phone_normalized` holds them. */
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
  }
): Promise<SaveCardResult> {
  const before = await findCardContact(supabase, card.accountId, card.phone);
  if (!before.ok) return { kind: 'lookupFailed' };
  if (before.id) return { kind: 'existing', id: before.id };

  const { data, error } = await supabase
    .from('contacts')
    .insert({
      user_id: card.userId,
      account_id: card.accountId,
      name: card.name,
      phone: card.phone,
      email: card.email,
      company: card.company,
    })
    .select('id')
    .single();
  if (!error) return { kind: 'created', id: data.id as string };
  if (isUniqueViolation(error)) {
    // Lost a race to a save the viewer CAN see (a second tab), or a
    // colleague's customer, which they cannot.
    const after = await findCardContact(supabase, card.accountId, card.phone);
    if (!after.ok) return { kind: 'lookupFailed' };
    return after.id
      ? { kind: 'existing', id: after.id }
      : { kind: 'colleague' };
  }
  console.error('Failed to save a shared contact:', error);
  return { kind: 'failed' };
}
