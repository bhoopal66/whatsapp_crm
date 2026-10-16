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
