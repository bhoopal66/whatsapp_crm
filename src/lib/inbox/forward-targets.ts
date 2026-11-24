import type { SupabaseClient } from '@supabase/supabase-js';

import { latinDigits } from '@/lib/contacts/digits';
import {
  isMissingSearchRpc,
  parseSearchHits,
  searchRpcTerm,
} from '@/lib/contacts/fuzzy-search';
import { contactSearchFilter } from '@/lib/contacts/search';

/**
 * The chats a WhatsApp message can be forwarded to: the recent ones, and
 * on a search every chat of the contacts found. RLS narrows both to what
 * the person may open, which is what the route accepts. Both throw when a
 * read fails: "no such chat" must not be said of a list nobody read.
 */

export interface ForwardTarget {
  id: string;
  contactId: string | null;
  name: string;
  phone: string;
}

interface Scope {
  accountId: string;
  /** The chat the message is in, never offered. */
  exclude: string;
  /** Shown for a contact without name and phone. */
  unknown: string;
}

export const FORWARD_RECENT_LIMIT = 200;
/** Contacts, and chats, one search asks for. */
export const FORWARD_SEARCH_LIMIT = 50;

const SELECT = 'id, contact:contacts(id, name, phone)';

function toTargets(data: unknown, unknown: string): ForwardTarget[] {
  return (Array.isArray(data) ? data : []).map((row) => {
    // A to-one embed; supabase-js types it as an array or an object.
    const raw = row.contact as unknown;
    const contact = (Array.isArray(raw) ? raw[0] : raw) as {
      id?: string | null;
      name?: string | null;
      phone?: string | null;
    } | null;
    return {
      id: row.id as string,
      contactId: contact?.id ?? null,
      name: contact?.name || contact?.phone || unknown,
      phone: contact?.phone ?? '',
    };
  });
}

const chats = (sb: SupabaseClient, scope: Scope) =>
  sb
    .from('conversations')
    .select(SELECT)
    .eq('account_id', scope.accountId)
    .neq('id', scope.exclude)
    .order('last_message_at', { ascending: false, nullsFirst: false });

export async function recentForwardTargets(
  sb: SupabaseClient,
  scope: Scope
): Promise<ForwardTarget[]> {
  const { data, error } = await chats(sb, scope).limit(FORWARD_RECENT_LIMIT);
  if (error) throw error;
  return toTargets(data, scope.unknown);
}

/** The contact ids a term finds, best first. */
async function foundContacts(
  sb: SupabaseClient,
  term: string
): Promise<string[]> {
  const rpcTerm = searchRpcTerm(term);
  if (rpcTerm) {
    const { data, error } = await sb.rpc('search_contacts', {
      p_term: rpcTerm,
      p_limit: FORWARD_SEARCH_LIMIT,
    });
    if (!error) return parseSearchHits(data).map((h) => h.contactId);
    if (!isMissingSearchRpc(error)) throw error;
  }
  const or = contactSearchFilter(term);
  if (!or) return [];
  const { data, error } = await sb
    .from('contacts')
    .select('id')
    .or(or)
    .limit(FORWARD_SEARCH_LIMIT);
  if (error) throw error;
  return (data ?? []).map((r) => r.id as string);
}

export async function searchForwardTargets(
  sb: SupabaseClient,
  scope: Scope,
  term: string
): Promise<ForwardTarget[]> {
  const ids = await foundContacts(sb, term);
  if (ids.length === 0) return [];
  const { data, error } = await chats(sb, scope)
    .in('contact_id', ids)
    .limit(FORWARD_SEARCH_LIMIT);
  if (error) throw error;
  const rank = new Map(ids.map((id, i) => [id, i]));
  const at = (t: ForwardTarget) =>
    rank.get(t.contactId ?? '') ?? Number.POSITIVE_INFINITY;
  // Stable: two chats of one contact keep the newer first.
  return toTargets(data, scope.unknown).sort((a, b) => at(a) - at(b));
}

/** The targets a typed term matches, by name or digits of the phone. */
export function matchForwardTargets(
  targets: readonly ForwardTarget[],
  search: string
): ForwardTarget[] {
  const q = search.trim().toLowerCase();
  if (!q) return [...targets];
  const digits = latinDigits(q).replace(/\D/g, '');
  return targets.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (digits.length > 0 && c.phone.replace(/\D/g, '').includes(digits))
  );
}

/** Both lists, each chat once. */
export function mergeForwardTargets(
  recent: readonly ForwardTarget[],
  found: readonly ForwardTarget[]
): ForwardTarget[] {
  const seen = new Set<string>();
  return [...recent, ...found].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
