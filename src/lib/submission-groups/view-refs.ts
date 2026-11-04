/**
 * Server-side lookups behind the Submission Groups read routes: contact,
 * number and staff names for groups the caller has already been shown.
 * They run on the service role (an agent's RLS may hide the contact or the
 * number row) and every query is pinned to the caller's account.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SubmissionGroup } from './store';
import {
  toChannelRef,
  toContactRef,
  type ChannelRef,
  type ContactRef,
} from './views';

/** How many contacts a name search may widen the list to. */
export const SEARCH_CONTACT_MAX = 200;

const unique = (ids: (string | null)[]): string[] => [
  ...new Set(ids.filter((x): x is string => x !== null)),
];

export async function loadRefs(
  admin: SupabaseClient,
  accountId: string,
  groups: readonly SubmissionGroup[]
): Promise<{
  contacts: Map<string, ContactRef>;
  channels: Map<string, ChannelRef>;
}> {
  const contactIds = unique(groups.map((g) => g.contactId));
  const channelIds = unique(groups.map((g) => g.channelId));
  const [contacts, channels] = await Promise.all([
    contactIds.length
      ? admin
          .from('contacts')
          .select('id, name, phone')
          .eq('account_id', accountId)
          .in('id', contactIds)
      : { data: [], error: null },
    channelIds.length
      ? admin
          .from('whatsapp_config')
          .select('id, label, waba_id')
          .eq('account_id', accountId)
          .in('id', channelIds)
      : { data: [], error: null },
  ]);
  if (contacts.error) throw new Error(`contacts: ${contacts.error.message}`);
  if (channels.error)
    throw new Error(`whatsapp_config: ${channels.error.message}`);
  const rows = (d: unknown) => (d ?? []) as Record<string, unknown>[];
  return {
    contacts: new Map(
      rows(contacts.data).map((r) => [String(r.id), toContactRef(r)])
    ),
    channels: new Map(
      rows(channels.data).map((r) => [String(r.id), toChannelRef(r)])
    ),
  };
}

/**
 * The caller's unread count per ACTIVE group (migration 173). Unlike the
 * lookups here it takes the caller's RLS client: `sg_unread_by_group`
 * answers for `auth.uid()`, which the service role does not have. A count
 * is a decoration on the row, so any failure (the migration not applied
 * yet included) is an empty map, never a failed list.
 */
export async function loadUnread(
  rlsClient: SupabaseClient
): Promise<Map<string, number>> {
  try {
    const { data, error } = await rlsClient.rpc('sg_unread_by_group');
    if (error) throw error;
    return new Map(
      ((data ?? []) as Record<string, unknown>[]).map((r) => [
        String(r.group_id),
        Number(r.unread),
      ])
    );
  } catch {
    return new Map();
  }
}

/**
 * Of these groups, the ones whose case's agent `userId` leads (173). The
 * function is granted to the service role only. A label is a decoration on
 * the row, so an error (the migration not applied yet included) counts as
 * not led, never a failed list.
 */
export async function loadLedGroups(
  admin: SupabaseClient,
  userId: string,
  groupIds: readonly string[]
): Promise<Set<string>> {
  const led = await Promise.all(
    groupIds.map(async (id) => {
      try {
        const { data, error } = await admin.rpc('sg_leads_group_agent', {
          p_group: id,
          p_user: userId,
        });
        return !error && data === true;
      } catch {
        return false;
      }
    })
  );
  return new Set(groupIds.filter((_, i) => led[i]));
}

/** Staff full names in this account (one profile per workspace). */
export async function loadNames(
  admin: SupabaseClient,
  accountId: string,
  userIds: readonly (string | null)[]
): Promise<Map<string, string | null>> {
  const ids = unique([...userIds]);
  if (!ids.length) return new Map();
  const { data, error } = await admin
    .from('profiles')
    .select('user_id, full_name')
    .eq('account_id', accountId)
    .in('user_id', ids);
  if (error) throw new Error(`profiles: ${error.message}`);
  return new Map(
    ((data ?? []) as Record<string, unknown>[]).map((r) => [
      String(r.user_id),
      typeof r.full_name === 'string' ? r.full_name.trim() || null : null,
    ])
  );
}

/** Ids of this account's contacts whose name contains the (sanitised) term. */
export async function matchingContactIds(
  admin: SupabaseClient,
  accountId: string,
  term: string
): Promise<string[]> {
  const { data, error } = await admin
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', `%${term}%`)
    .limit(SEARCH_CONTACT_MAX);
  if (error) throw new Error(`contacts: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => String(r.id));
}

/**
 * The banks the caller holds (`coordinator_banks`) and, for the given
 * groups, each one's case bank. Service role, pinned to the account. The
 * case query is skipped without a held bank.
 */
export async function loadBankHolding(
  admin: SupabaseClient,
  accountId: string,
  userId: string,
  groupIds: readonly string[]
): Promise<{ held: Set<string>; bankByGroup: Map<string, string> }> {
  const held = new Set<string>();
  const bankByGroup = new Map<string, string>();
  const mine = await admin
    .from('coordinator_banks')
    .select('bank_code')
    .eq('account_id', accountId)
    .eq('user_id', userId);
  if (mine.error) throw new Error(`coordinator_banks: ${mine.error.message}`);
  for (const r of (mine.data ?? []) as Record<string, unknown>[])
    held.add(String(r.bank_code));
  if (!held.size || !groupIds.length) return { held, bankByGroup };
  const cases = await admin
    .from('cases')
    .select('group_id, bank_code')
    .eq('account_id', accountId)
    .in('group_id', [...groupIds]);
  if (cases.error) throw new Error(`cases: ${cases.error.message}`);
  for (const r of (cases.data ?? []) as Record<string, unknown>[])
    if (r.group_id && r.bank_code)
      bankByGroup.set(String(r.group_id), String(r.bank_code));
  return { held, bankByGroup };
}
