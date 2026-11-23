// ============================================================
// Meta's 24-hour service window, as the inbox shows it. Pure.
//
// On the Cloud API (and only there: Whapi and OpenWA drive an ordinary
// WhatsApp account and have no window) free text is allowed only within
// 24 hours of the customer's last message; after that only an approved
// template goes out. The rule itself is Compass's `serviceWindowOpen`
// and `SERVICE_WINDOW_MS` (ten minutes short of Meta's 24 hours, so a
// slow send is never refused for being late), reused here so the inbox
// and the Compass send path agree.
// ============================================================

import {
  SERVICE_WINDOW_MS,
  serviceWindowOpen,
} from '@/lib/compass/meta-template';

export type ServiceWindowState =
  /** Not known yet (still loading, or the read failed): block nothing. */
  | { kind: 'unknown' }
  /** Free text is allowed for `msLeft` more milliseconds. */
  | { kind: 'open'; msLeft: number }
  /**
   * Only a template now. `agoMs` is how long since the customer last
   * wrote; null when they never have.
   */
  | { kind: 'closed'; agoMs: number | null };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Below this much time left the header shows a countdown. */
export const SERVICE_WINDOW_COUNTDOWN_MS = 2 * HOUR;

/**
 * The window for a chat whose customer last wrote at `lastCustomerAt`:
 * `undefined` when that is not known yet, `null` when they never wrote.
 */
export function serviceWindowState(
  lastCustomerAt: string | null | undefined,
  now: number
): ServiceWindowState {
  if (lastCustomerAt === undefined) return { kind: 'unknown' };
  if (lastCustomerAt === null) return { kind: 'closed', agoMs: null };
  const at = Date.parse(lastCustomerAt);
  // A timestamp we cannot read must not lock the composer.
  if (Number.isNaN(at)) return { kind: 'unknown' };
  if (serviceWindowOpen(lastCustomerAt, now)) {
    return { kind: 'open', msLeft: at + SERVICE_WINDOW_MS - now };
  }
  return { kind: 'closed', agoMs: Math.max(0, now - at) };
}

/** What the rule needs of a customer message. */
export interface LastCustomerMessage {
  created_at: string;
  /** The number that carried it; older rows have none. */
  channel_id?: string | null;
  provider?: string | null;
}

/**
 * Is it certain that a reply here goes out on the Cloud API? Only then
 * may the window block anything. The server (`resolveSendChannel`,
 * lib/whatsapp/channels.ts) obeys the pin, then follows the newest
 * customer message's own number, then its provider, then the chat's
 * number, then the route and the sender's allocation. The browser does
 * not load the last two, and `predictSendingNumber` skips the middle
 * ones, so a chat moved to Meta while the customer last wrote on Whapi
 * was blocked though the server would have sent it. Anything short of
 * certain is false.
 *
 * `lastCustomer`: undefined when not known yet, null when the customer
 * never wrote.
 */
export function sendsOverMeta(
  numbers: readonly { id: string; provider: string }[] | null | undefined,
  conversation: {
    personal_owner_id?: string | null;
    channel_id?: string | null;
    send_channel_id?: string | null;
  },
  lastCustomer: LastCustomerMessage | null | undefined
): boolean {
  if (!numbers || conversation.personal_owner_id) return false;
  const isMeta = (id: string | null | undefined) =>
    !!id && numbers.find((n) => n.id === id)?.provider === 'meta';
  if (conversation.send_channel_id) return isMeta(conversation.send_channel_id);
  if (lastCustomer === undefined) return false;
  if (lastCustomer === null) return isMeta(conversation.channel_id);
  if (lastCustomer.channel_id) return isMeta(lastCustomer.channel_id);
  // With no Meta number left the server falls through to another rule.
  return (
    lastCustomer.provider === 'meta' &&
    numbers.some((n) => n.provider === 'meta')
  );
}

/**
 * Whether the last customer message is worth asking for: without a Meta
 * number, in a personal chat, or pinned elsewhere, the answer is known.
 */
export function mayNeedServiceWindow(
  numbers: readonly { id: string; provider: string }[] | null | undefined,
  conversation: {
    personal_owner_id?: string | null;
    send_channel_id?: string | null;
  }
): boolean {
  if (!numbers || conversation.personal_owner_id) return false;
  const pin = conversation.send_channel_id;
  if (pin) return numbers.find((n) => n.id === pin)?.provider === 'meta';
  return numbers.some((n) => n.provider === 'meta');
}

/**
 * The newest customer message of `conversationId` among `messages`, or
 * null. Rows of another chat (a page still showing while the next one
 * loads) are ignored.
 */
export function latestCustomerMessage<
  T extends LastCustomerMessage & {
    conversation_id: string;
    sender_type: string;
  },
>(messages: readonly T[], conversationId: string | null | undefined): T | null {
  if (!conversationId) return null;
  let best: T | null = null;
  let bestAt = -Infinity;
  for (const m of messages) {
    if (m.conversation_id !== conversationId) continue;
    if (m.sender_type !== 'customer') continue;
    const at = Date.parse(m.created_at);
    if (Number.isNaN(at) || at <= bestAt) continue;
    bestAt = at;
    best = m;
  }
  return best;
}

/** When that message came in, or null. */
export function latestCustomerMessageAt(
  messages: readonly (LastCustomerMessage & {
    conversation_id: string;
    sender_type: string;
  })[],
  conversationId: string | null | undefined
): string | null {
  return latestCustomerMessage(messages, conversationId)?.created_at ?? null;
}

/** "26 h ago" up to 48 hours, then "3 days ago". */
export function describeAgo(agoMs: number): {
  unit: 'hours' | 'days';
  count: number;
} {
  const hours = Math.floor(Math.max(0, agoMs) / HOUR);
  if (hours > 48) return { unit: 'days', count: Math.floor(agoMs / DAY) };
  return { unit: 'hours', count: hours };
}

/**
 * The header's countdown, in whole minutes rounded up (it never reads
 * "0 m" while the window is open), or null when there is none to show:
 * not open, or 2 hours or more left.
 */
export function serviceWindowCountdown(
  state: ServiceWindowState | null
): { hours: number; minutes: number } | null {
  if (!state || state.kind !== 'open') return null;
  if (state.msLeft >= SERVICE_WINDOW_COUNTDOWN_MS || state.msLeft <= 0) {
    return null;
  }
  const total = Math.ceil(state.msLeft / MINUTE);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
