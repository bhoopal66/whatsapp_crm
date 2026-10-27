/**
 * The linked CRM contact's own name per contact id. Since 141 a case's
 * `contactName` is the customer the submission tracker sent (the
 * company), so the inbox adds the contact's own name beside it (often
 * the person who chats on WhatsApp).
 *
 * Service-role client: the caller has already decided which cases the
 * reader may see, and the read is confined to `accountId`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { CaseStoreError } from './store';

export async function contactNames(
  db: SupabaseClient,
  accountId: string,
  contactIds: readonly (string | null)[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [
    ...new Set(contactIds.filter((id): id is string => id !== null)),
  ];
  if (ids.length === 0) return out;

  const { data, error } = await db
    .from('contacts')
    .select('id, name')
    .eq('account_id', accountId)
    .in('id', ids);
  if (error) throw new CaseStoreError('contacts', error.code ?? null);
  for (const r of (data ?? []) as Record<string, unknown>[])
    if (typeof r.name === 'string' && r.name.trim() !== '')
      out.set(String(r.id), r.name);
  return out;
}
