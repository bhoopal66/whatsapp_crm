// ============================================================
// The Inbox contact panel, kept in the session cache
// (`lib/session-cache.ts`) per conversation, so a revisited chat shows
// its panel at once while a fresh copy loads. Pure: the reads live in
// `contact-panel-fetch.ts`.
//
// Three entries per chat, all under `inbox:panel:<conversationId>`:
// the full row (written by the open's own read and kept equal to what
// is on screen, so a tag or AI change made here is never shown undone
// on a revisit) and the contact's deals and notes. Deals and notes name
// the contact too, so a chat whose contact changed never shows another
// customer's.
//
// Deals and notes start on the click, from the list row's `contact.id`,
// in the same wave as the full row: they used to wait for it, a second
// round trip (~0.5 s behind the tunnel).
// ============================================================

import { sessionKey, type SessionKey } from '@/lib/session-cache';
import type {
  ConversationListContact,
  ConversationListItem,
} from '@/lib/inbox/conversations';
import type { Contact, ContactNote, Conversation } from '@/types';

export type PanelPart = 'deals' | 'notes';

/** The cached full row of one conversation, as the panel last saw it. */
export function panelRowKey(
  accountId: string | null | undefined,
  userId: string | null | undefined,
  conversationId: string | null | undefined
): SessionKey | null {
  if (!conversationId) return null;
  return sessionKey(accountId, userId, `inbox:panel:${conversationId}`);
}

/** One conversation's cached deals or notes, for the contact it names. */
export function panelPartKey(
  accountId: string | null | undefined,
  userId: string | null | undefined,
  conversationId: string | null | undefined,
  part: PanelPart,
  contactId: string | null | undefined
): SessionKey | null {
  if (!conversationId || !contactId) return null;
  return sessionKey(
    accountId,
    userId,
    `inbox:panel:${conversationId}:${part}:${contactId}`
  );
}

/**
 * The contact as the panel can show it: always the list row's columns
 * (name, number, photo, company), the rest once the full row is known.
 */
export type PanelContact = ConversationListContact & Partial<Contact>;

export interface PanelSource {
  /** The full contact is known (not just the list row's columns). */
  complete: boolean;
  contact: PanelContact | null;
  /** The full row for the Smart insights figures; null until known. */
  conversation: Conversation | null;
}

/**
 * What the panel shows for the open chat: the live full row once it has
 * landed; before that the cached full row of the same chat (a revisit,
 * revalidated by the open's read); before that the list row's contact,
 * so the panel is never an empty box while the full row is in flight.
 */
export function panelSource(state: {
  open: ConversationListItem | Conversation | null;
  full: Conversation | null;
  cached: Conversation | undefined;
}): PanelSource {
  const { open, full, cached } = state;
  if (!open) return { complete: false, contact: null, conversation: null };
  if (full && full.id === open.id && full.contact) {
    return { complete: true, contact: full.contact, conversation: full };
  }
  if (cached && cached.id === open.id && cached.contact) {
    return { complete: true, contact: cached.contact, conversation: cached };
  }
  return {
    complete: false,
    contact: open.contact ?? null,
    conversation: full && full.id === open.id ? full : null,
  };
}

/**
 * A note this panel just added, put at the top of the cached notes; a
 * note already there (a refresh beat the insert's answer) is not doubled.
 */
export function prependNote(
  notes: readonly ContactNote[],
  note: ContactNote
): ContactNote[] {
  return [note, ...notes.filter((n) => n.id !== note.id)];
}
