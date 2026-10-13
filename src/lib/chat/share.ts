/**
 * "Share to team chat" from the inbox: who gets the action and which
 * channels the dialog offers. The database has the last word
 * (chat_post_message checks the sharer can view the conversation and
 * that it belongs to the channel's workspace); this only keeps the
 * picker to channels a post can land in.
 */
import { normalizeDigits } from './search-view';
import type {
  ChannelWithMembership,
  ChatTagRef,
  SharedCallCard,
  SharedCard,
  SharedSnapshot,
} from './types';

/**
 * Who is offered Share: bank guests have no inbox to share from, and a
 * viewer's role is read-only on customer data. (Viewers can still post
 * in Team chat; the database decides who may share.)
 */
export function canShareToTeamChat(role: string | null | undefined): boolean {
  return !!role && role !== 'viewer' && role !== 'bank_guest';
}

/**
 * Who is offered Share on a call (103): as for a conversation, and never
 * for an erased call, which has nothing left to show.
 */
export function canShareCall(
  role: string | null | undefined,
  recordingState: string | null | undefined
): boolean {
  return canShareToTeamChat(role) && recordingState !== 'erased';
}

export interface ShareTarget {
  id: string;
  kind: 'team' | 'private' | 'deal_room';
  name: string;
  /** Posting in a team channel you are not in joins it. */
  joined: boolean;
}

/**
 * Open team channels (posting joins them) and the private channels the
 * viewer belongs to, whose name contains `query`; joined ones first,
 * then by name. DMs are left out, and deal rooms unless `dealRooms`
 * (a call card may go to the Team notes of a room the viewer is in).
 */
export function shareTargets(
  channels: readonly ChannelWithMembership[],
  query = '',
  { dealRooms = false }: { dealRooms?: boolean } = {}
): ShareTarget[] {
  const q = normalizeDigits(query.trim()).toLowerCase().replace(/^#/, '');
  return channels
    .filter(
      (c) =>
        !c.archivedAt &&
        !!c.name &&
        (c.kind === 'team' ||
          ((c.kind === 'private' || (dealRooms && c.kind === 'deal_room')) &&
            !!c.membership))
    )
    .map((c) => ({
      id: c.id,
      kind: c.kind as ShareTarget['kind'],
      name: c.name as string,
      joined: !!c.membership,
    }))
    .filter((c) => !q || normalizeDigits(c.name).toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.joined) - Number(a.joined) || a.name.localeCompare(b.name)
    );
}

/** What a shared conversation card shows. */
export type SharedCardView =
  | { access: false }
  | {
      access: true;
      conversationId: string;
      /** Null: the card falls back to "Customer". */
      name: string | null;
      owner: string | null;
      /** Masked phone · company. */
      details: string;
      lastMessages: SharedSnapshot['lastMessages'];
      tag: ChatTagRef | null;
    };

/**
 * The database sends a card's snapshot only to someone who may open the
 * conversation now; everyone else learns only that a card is there.
 * Rendering keys off `canOpen` alone, so a card without access never
 * shows a customer field, whatever the row carried.
 */
export function sharedCardView(card: SharedCard): SharedCardView {
  if (!card.canOpen || !card.conversationId) return { access: false };
  const s = card.snapshot;
  return {
    access: true,
    conversationId: card.conversationId,
    name: s.contactName,
    owner: s.owner,
    details: [s.phone, s.company].filter(Boolean).join(' · '),
    lastMessages: s.lastMessages.slice(-2),
    tag: card.chatTag,
  };
}

/** What a call card shows (103). */
export type SharedCallCardView =
  | { access: false }
  | { access: true; erased: true }
  | {
      access: true;
      erased: false;
      direction: NonNullable<SharedCallCard['direction']>;
      startedAt: string | null;
      talkSeconds: number;
      outcome: string | null;
      notes: string | null;
      agentName: string | null;
      /** The customer page, when the call has a customer. */
      contactId: string | null;
      /** The customer's name, else the masked number; null: "Unknown caller". */
      who: string | null;
    };

/**
 * Keys off `canOpen` and `erased` alone, so a card without access, or
 * of an erased call, never shows a call field, whatever the row carried.
 */
export function sharedCallCardView(card: SharedCallCard): SharedCallCardView {
  if (!card.canOpen) return { access: false };
  if (card.erased || !card.direction) return { access: true, erased: true };
  return {
    access: true,
    erased: false,
    direction: card.direction,
    startedAt: card.startedAt,
    talkSeconds: card.talkSeconds ?? 0,
    outcome: card.outcome,
    notes: card.notes,
    agentName: card.agentName,
    contactId: card.contactId,
    who: card.contactName?.trim() || card.phone || null,
  };
}
