// ============================================================
// What the incoming-call card and the in-call panel show of a call's
// customer (module 015). Client-safe: it takes the client it reads with.
//
// A person may be rung for a customer their own reads cannot see
// (can_view_contact: another RM's customer). Read through their RLS, the
// contact came back empty and the card said "No owner" and "Calls OK" —
// for a do-not-contact customer too. So for a live call the card asks
// GET /api/pbx/calls/facts, which answers a ringing or answering party
// with the full facts when their own reads see the contact, and
// otherwise only what taking the call needs (`hidden`): the name, the
// owner and the consent flags, never the free-text do-not-contact
// reason ("Do not contact" alone). Without that route (no live call, or it
// refused), a hidden contact shows nothing, with consent unknown.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { clip, type ConsentFields, type HeldFacts } from './call-ui';

export interface CallFacts extends ConsentFields {
  /** Only name, owner and consent: the person cannot see this contact. */
  hidden: boolean;
  /** False when nothing about consent could be read. */
  consentKnown: boolean;
  /** A read failed: what is missing here may exist. */
  incomplete: boolean;
  name: string | null;
  company: string | null;
  phone: string | null;
  ownerId: string | null;
  ownerName: string | null;
  conversationId: string | null;
  deal: string | null;
  last: { at: string; text: string } | null;
}

export const CONSENT_COLUMNS =
  'do_not_contact_at, do_not_contact_reason, marketing_opt_in_at, opted_out_at';
/** The hidden read's: the flags without the free-text reason. */
export const HIDDEN_CONSENT_COLUMNS =
  'do_not_contact_at, marketing_opt_in_at, opted_out_at';

const EMPTY = {
  company: null,
  phone: null,
  ownerName: null,
  conversationId: null,
  deal: null,
  last: null,
} as const;

/** A contact the person's own read hides, with nothing else known. */
export const UNKNOWN_FACTS: CallFacts = {
  ...EMPTY,
  hidden: true,
  consentKnown: false,
  incomplete: false,
  name: null,
  ownerId: null,
};

const text = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

function consentOf(row: Record<string, unknown>): ConsentFields {
  return {
    do_not_contact_at: text(row.do_not_contact_at),
    do_not_contact_reason: text(row.do_not_contact_reason),
    marketing_opt_in_at: text(row.marketing_opt_in_at),
    opted_out_at: text(row.opted_out_at),
  };
}

/** The hidden answer: the contact's name, its owner and consent flags, no more. */
export function hiddenFacts(
  row: Record<string, unknown>,
  ownerName: string | null
): CallFacts {
  return {
    ...EMPTY,
    ...consentOf(row),
    do_not_contact_reason: null,
    hidden: true,
    consentKnown: true,
    incomplete: false,
    name: text(row.name),
    ownerId: text(row.user_id),
    ownerName,
  };
}

/**
 * The full facts as `sb`'s own RLS shows them (deal, chat and last
 * message included), or null when it does not show the contact. A deal,
 * chat or message read that fails is `incomplete`, not "none".
 */
export async function loadVisibleFacts(
  sb: SupabaseClient,
  contactId: string
): Promise<CallFacts | null> {
  const [c, d, conv] = await Promise.all([
    sb
      .from('contacts')
      .select(`name, company, phone, user_id, ${CONSENT_COLUMNS}`)
      .eq('id', contactId)
      .maybeSingle(),
    sb
      .from('deals')
      .select('title, stage:pipeline_stages(name)')
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1),
    sb
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId)
      .is('personal_owner_id', null)
      .limit(1),
  ]);
  if (c.error) throw new Error(`contacts read failed: ${c.error.message}`);
  const row = c.data as Record<string, unknown> | null;
  if (!row) return null;
  const deal = (d.data?.[0] ?? null) as {
    title: string;
    stage: { name: string } | null;
  } | null;
  const convId = (conv.data?.[0] as { id: string } | undefined)?.id ?? null;
  let last: CallFacts['last'] = null;
  let incomplete = Boolean(d.error || conv.error);
  if (convId) {
    const m = await sb
      .from('messages')
      .select('content_text, content_type, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (m.error) incomplete = true;
    const msg = m.data?.[0] as
      | {
          content_text: string | null;
          content_type: string;
          created_at: string;
        }
      | undefined;
    if (msg)
      last = {
        at: msg.created_at,
        text: clip(msg.content_text || `[${msg.content_type}]`, 40),
      };
  }
  return {
    ...consentOf(row),
    hidden: false,
    consentKnown: true,
    incomplete,
    name: text(row.name),
    company: text(row.company),
    phone: text(row.phone),
    ownerId: text(row.user_id),
    ownerName: null,
    conversationId: convId,
    deal: deal
      ? [deal.title, deal.stage?.name].filter(Boolean).join(' · ')
      : null,
    last,
  };
}

/** The facts route's answer, field by field; null when it is not one. */
export function parseCallFacts(body: unknown): CallFacts | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.hidden !== 'boolean') return null;
  const last = b.last as Record<string, unknown> | null | undefined;
  const facts: CallFacts = {
    ...consentOf(b),
    hidden: b.hidden,
    consentKnown: b.consentKnown === true,
    incomplete: b.incomplete === true,
    name: text(b.name),
    company: text(b.company),
    phone: text(b.phone),
    ownerId: text(b.ownerId),
    ownerName: text(b.ownerName),
    conversationId: text(b.conversationId),
    deal: text(b.deal),
    last:
      last && text(last.at) && typeof last.text === 'string'
        ? { at: last.at as string, text: last.text }
        : null,
  };
  // A hidden answer never carries more than name, owner and consent flags.
  return facts.hidden
    ? {
        ...facts,
        ...EMPTY,
        ownerName: facts.ownerName,
        do_not_contact_reason: null,
      }
    : facts;
}

/**
 * A call's facts for the card and the panel: the facts route for a live
 * call of mine (a contact my own reads hide still shows its name, owner
 * and consent); otherwise, or when the route refuses, my own reads, where
 * a hidden contact shows nothing and its consent as unknown. The route
 * answers from the live row, which goes with the call, so once the call
 * has ended it is not asked: it could only refuse. A read that failed is
 * `incomplete`, for a Retry. Never throws.
 */
export async function loadCallFacts(
  sb: SupabaseClient,
  contactId: string,
  live: { connectionId: string; pbxCallId: string; ended: boolean } | null
): Promise<CallFacts> {
  let failed = false;
  if (live && !live.ended) {
    const res = await fetch(
      `/api/pbx/calls/facts?${new URLSearchParams({
        connectionId: live.connectionId,
        pbxCallId: live.pbxCallId,
        contactId,
      })}`
    ).catch(() => null);
    const facts = res?.ok
      ? parseCallFacts(await res.json().catch(() => null))
      : null;
    if (facts) return facts;
    failed = !res || res.status >= 500;
  }
  try {
    const own = await loadVisibleFacts(sb, contactId);
    return own ?? { ...UNKNOWN_FACTS, incomplete: failed };
  } catch {
    return { ...UNKNOWN_FACTS, incomplete: true };
  }
}

const worth = (f: CallFacts) => (f.consentKnown ? (f.incomplete ? 1 : 2) : 0);

/**
 * What to hold once `next` was loaded: it, unless the facts held for the
 * same contact on the same call say more. A read after the call ended, or
 * one that failed, must not take away what the person was already shown.
 */
export function keepFacts(
  held: HeldFacts<CallFacts> | null,
  next: HeldFacts<CallFacts>
): HeldFacts<CallFacts> {
  return held &&
    held.contactId === next.contactId &&
    held.callKey === next.callKey &&
    worth(held.facts) > worth(next.facts)
    ? held
    : next;
}
