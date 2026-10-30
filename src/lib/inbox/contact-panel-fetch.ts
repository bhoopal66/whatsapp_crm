import { createClient } from '@/lib/supabase/client';
import { prefetchSession, type SessionKey } from '@/lib/session-cache';
import type { ContactNote, Deal } from '@/types';

// The contact panel's reads (keys and rules: `contact-panel.ts`).
// They throw on a failed read, so `prefetchSession` keeps what was
// cached instead of storing an empty list over it.

export async function fetchPanelDeals(contactId: string): Promise<Deal[]> {
  const { data, error } = await createClient()
    .from('deals')
    .select('*, stage:pipeline_stages(*)')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Deal[];
}

export async function fetchPanelNotes(
  contactId: string
): Promise<ContactNote[]> {
  const { data, error } = await createClient()
    .from('contact_notes')
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ContactNote[];
}

/**
 * Start a chat's deals and notes on the click, beside its full row. The
 * panel's own queries join these rather than repeating them.
 */
export function prefetchContactPanel(
  keys: { deals: SessionKey | null; notes: SessionKey | null },
  contactId: string
): void {
  if (keys.deals) {
    prefetchSession(keys.deals, () => fetchPanelDeals(contactId)).catch(
      () => {}
    );
  }
  if (keys.notes) {
    prefetchSession(keys.notes, () => fetchPanelNotes(contactId)).catch(
      () => {}
    );
  }
}
