import { createFailedSendStore } from '@/lib/inbox/failed-send-store';

import type { WhatsappGroupMessageRow } from './types';

/**
 * Group sends whose outcome nobody knows. A send that timed out, or that
 * the gateway answered with a 5xx, may already be in the group, so it is
 * never offered again: the words must not go back into the composer and
 * there is no Retry. The bubble stays, marked, with Copy and Discard,
 * until the message itself turns up in the log. Memory only, like the
 * inbox's unsent replies.
 */

/** The route's code for "WhatsApp may hold it" (messages/route.ts). */
export const SEND_UNCONFIRMED = 'send_unconfirmed';

/**
 * The 5xx answers the route gives before the gateway was reached, or
 * after a certain refusal of it (a disconnected number).
 */
const NOT_SENT_CODES = new Set<unknown>([
  'unavailable',
  'channel_disconnected',
  'channel_lookup_failed',
  'channel_credentials_unreadable',
]);

/**
 * What is certain about a refused send. Every 4xx but 408 is a refusal:
 * the route's own come before the gateway, and a proxy's means the
 * request never reached the app. Any other answer (our `send_unconfirmed`,
 * a proxy's 502/504 page, a 500 that may have been thrown after the
 * gateway accepted) leaves it open.
 */
export function groupSendAnswerKind(
  status: number,
  code: unknown
): 'refused' | 'maybe' {
  if (code === SEND_UNCONFIRMED) return 'maybe';
  if (status >= 400 && status < 500 && status !== 408) return 'refused';
  return NOT_SENT_CODES.has(code) ? 'refused' : 'maybe';
}

type MessageRow = Pick<
  WhatsappGroupMessageRow,
  | 'id'
  | 'direction'
  | 'sender_wa_id'
  | 'sender_name'
  | 'type'
  | 'body'
  | 'status'
  | 'created_at'
> &
  Partial<WhatsappGroupMessageRow>;

export interface UnconfirmedSend {
  groupId: string;
  /** The optimistic bubble, as it was shown. */
  message: MessageRow;
  /** The rows on screen when it was sent: none of them is this message. */
  knownIds: ReadonlySet<string>;
}

/** How far this device's clock may run ahead of the server's. */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * The sends whose message is in the log after all: an outgoing row of
 * this person's, or of nobody's (the echo of a send the route could not
 * attribute), not there before the send, with the same words. Each row
 * settles one send.
 */
export function arrivedUnconfirmed(
  rows: readonly UnconfirmedSend[],
  groupId: string,
  messages: readonly MessageRow[],
  viewerId: string | null
): UnconfirmedSend[] {
  const used = new Set<string>();
  return rows.filter((r) => {
    if (r.groupId !== groupId) return false;
    const after = Date.parse(r.message.created_at) - CLOCK_SKEW_MS;
    const row = messages.find(
      (m) =>
        m.direction === 'out' &&
        m.status !== 'pending' &&
        !used.has(m.id) &&
        !r.knownIds.has(m.id) &&
        (!m.sender_user_id || m.sender_user_id === viewerId) &&
        m.type === r.message.type &&
        (m.body ?? '').trim() === (r.message.body ?? '').trim() &&
        Date.parse(m.created_at) >= after
    );
    if (row) used.add(row.id);
    return !!row;
  });
}

export const unconfirmedSends = createFailedSendStore<UnconfirmedSend>();
