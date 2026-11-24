import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isMissingSearchRpc,
  parseSearchHits,
  rankByHits,
  searchRpcTerm,
} from '@/lib/contacts/fuzzy-search';
import { contactSearchFilter } from '@/lib/contacts/search';

/** Shortest query the bar sends. */
export const COMMAND_SEARCH_MIN_CHARS = 2;
export const COMMAND_SEARCH_DEBOUNCE_MS = 250;
export const COMMAND_SEARCH_LIMIT = 8;

export interface ContactResult {
  id: string;
  name: string | null;
  phone: string | null;
  /** The chat to open in the inbox, when the person can see one. */
  conversationId: string | null;
  closeMatch: boolean;
}

/** Whether a typed query is long enough to search for. */
export function isSearchable(query: string): boolean {
  return query.trim().length >= COMMAND_SEARCH_MIN_CHARS;
}

/** Where a contact's row goes. */
export function contactHref(id: string): string {
  return `/contacts/${encodeURIComponent(id)}`;
}

/** Where a contact's chat goes (the inbox's `?c=` deep link). */
export function chatHref(conversationId: string): string {
  return `/inbox?c=${encodeURIComponent(conversationId)}`;
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
}

function rows(data: unknown): ContactRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((r) => {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') return [];
    return [
      {
        id: r.id as string,
        name: typeof r.name === 'string' ? r.name : null,
        phone: typeof r.phone === 'string' ? r.phone : null,
      },
    ];
  });
}

/**
 * Contacts matching `query`, as the caller's RLS shows them: the
 * close-match RPC (migration 193), else the plain ilike filter when the
 * RPC is missing. `isCurrent` is asked after each round trip so a
 * superseded search stops early and returns null. Throws when the
 * contacts could not be read: that is not "nobody".
 */
export async function searchContactsForBar(
  supabase: SupabaseClient,
  query: string,
  isCurrent: () => boolean,
  withChats: boolean
): Promise<ContactResult[] | null> {
  let found: (ContactRow & { closeMatch: boolean })[] | null = null;

  const term = searchRpcTerm(query);
  if (term) {
    const rpc = await supabase.rpc('search_contacts', {
      p_term: term,
      p_limit: COMMAND_SEARCH_LIMIT,
    });
    if (!isCurrent()) return null;
    if (rpc.error && !isMissingSearchRpc(rpc.error)) throw rpc.error;
    if (!rpc.error) {
      const hits = parseSearchHits(rpc.data);
      if (hits.length) {
        const res = await supabase
          .from('contacts')
          .select('id, name, phone')
          .in(
            'id',
            hits.map((h) => h.contactId)
          );
        if (!isCurrent()) return null;
        if (res.error) throw res.error;
        found = rankByHits(rows(res.data), hits);
      } else {
        found = [];
      }
    }
  }
  if (!found) {
    let q = supabase
      .from('contacts')
      .select('id, name, phone')
      .order('name')
      .limit(COMMAND_SEARCH_LIMIT);
    const or = contactSearchFilter(query);
    if (or) q = q.or(or);
    const res = await q;
    if (!isCurrent()) return null;
    if (res.error) throw res.error;
    found = rows(res.data).map((r) => ({ ...r, closeMatch: false }));
  }

  const chats = new Map<string, string>();
  if (withChats && found.length) {
    const res = await supabase
      .from('conversations')
      .select('id, contact_id')
      .in(
        'contact_id',
        found.map((f) => f.id)
      )
      // The company chat only: a personal chat is the owner's own.
      .is('personal_owner_id', null)
      .order('last_message_at', { ascending: false, nullsFirst: false });
    if (!isCurrent()) return null;
    if (Array.isArray(res.data)) {
      for (const c of res.data) {
        // Newest first: keep the first chat seen per contact.
        if (
          typeof c.id === 'string' &&
          typeof c.contact_id === 'string' &&
          !chats.has(c.contact_id)
        )
          chats.set(c.contact_id, c.id);
      }
    }
  }
  return found.map((f) => ({
    ...f,
    conversationId: chats.get(f.id) ?? null,
  }));
}
