// The inbox's "New chat" button: from a typed number to either an
// open chat or a first message. Pure, so the dialog stays thin and the
// rules are tested here; the dialog gathers each fact (on the caller's
// RLS client) and asks again until the answer is not a lookup.
//
//   validate → find a visible contact → (insert one) → its visible
//   chats → open one, else compose the first message.
//
// A unique violation on insert (migration 022's index) with nothing
// visible means the number is a colleague's contact the caller cannot
// see (migration 043): refused, as the contact form refuses it, and
// the hidden contact is never named or linked.

import { normalizeKey } from '@/lib/contacts/dedupe';
import type { PhoneToSave } from '@/lib/contacts/phone-validation';

export interface NewChatContact {
  id: string;
  phone: string | null;
}

/** A conversation of the contact as RLS hands it to the caller. */
export interface NewChatConversation {
  id: string;
  /** Migration 191: NULL is the company chat, else whose personal chat. */
  personal_owner_id: string | null;
}

export type NewChatInsert =
  | { kind: 'created'; id: string }
  /** The unique index refused it; `visible` is the re-lookup after. */
  | { kind: 'unique-violation'; visible: NewChatContact | null }
  | { kind: 'error'; message: string };

export interface NewChatFacts {
  phone: PhoneToSave;
  /** undefined: not looked up yet; null: none the caller can see. */
  visibleContact?: NewChatContact | null;
  /** undefined: not tried yet. */
  insert?: NewChatInsert;
  /** The resolved contact's visible chats; undefined: not read yet. */
  conversations?: readonly NewChatConversation[];
  userId: string;
  /** The caller has a connected personal number (migration 191). */
  hasPersonalNumber: boolean;
}

export type NewChatStep =
  | { kind: 'invalid-phone'; message: string }
  | { kind: 'find-contact'; phone: string }
  | { kind: 'insert-contact'; phone: string }
  | { kind: 'hidden-conflict' }
  | { kind: 'failed'; message: string }
  | { kind: 'find-conversations'; contact: NewChatContact }
  | { kind: 'open-conversation'; conversationId: string }
  | { kind: 'compose'; contact: NewChatContact };

/** The next thing to do, given what is known so far. */
export function decideNewChat(facts: NewChatFacts): NewChatStep {
  const { phone } = facts;
  if (!phone.ok) return { kind: 'invalid-phone', message: phone.error };

  // `findExistingContact` also returns a near match (a row saved
  // without its country code, same last 8 digits), which the contact
  // form only warns about. Here it would send the first message
  // to someone else, so only the exact number counts as found.
  const target = normalizeKey(phone.phone);
  const exact = (c: NewChatContact | null | undefined) =>
    c && c.phone !== null && normalizeKey(c.phone) === target ? c : null;

  let contact: NewChatContact | null = null;
  if (facts.visibleContact === undefined) {
    return { kind: 'find-contact', phone: phone.phone };
  }
  const found = exact(facts.visibleContact);
  if (found) {
    contact = found;
  } else {
    const insert = facts.insert;
    if (!insert) return { kind: 'insert-contact', phone: phone.phone };
    if (insert.kind === 'error') {
      return { kind: 'failed', message: insert.message };
    }
    if (insert.kind === 'unique-violation') {
      const visible = exact(insert.visible);
      if (!visible) return { kind: 'hidden-conflict' };
      contact = visible;
    } else {
      contact = { id: insert.id, phone: phone.phone };
    }
  }

  if (facts.conversations === undefined) {
    return { kind: 'find-conversations', contact };
  }
  const open = pickConversationToOpen(
    facts.conversations,
    facts.userId,
    facts.hasPersonalNumber
  );
  return open
    ? { kind: 'open-conversation', conversationId: open }
    : { kind: 'compose', contact };
}

/**
 * The chat to open: the caller's own personal chat when they have a
 * personal number connected, else the company chat, else their own
 * personal chat. Someone else's personal chat (visible to a leader or
 * admin) is never the one opened: the caller would be writing in a
 * colleague's personal thread. Null: nothing to open, compose instead.
 */
export function pickConversationToOpen(
  rows: readonly NewChatConversation[],
  userId: string,
  hasPersonalNumber: boolean
): string | null {
  const own = rows.find((r) => r.personal_owner_id === userId) ?? null;
  const company = rows.find((r) => r.personal_owner_id === null) ?? null;
  const pick = hasPersonalNumber ? (own ?? company) : (company ?? own);
  return pick?.id ?? null;
}
