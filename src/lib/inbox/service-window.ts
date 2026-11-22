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

/**
 * The newest customer message of `conversationId` among `messages`, or
 * null. Rows of another chat (a page still showing while the next one
 * loads) are ignored.
 */
export function latestCustomerMessageAt(
  messages: readonly {
    conversation_id: string;
    sender_type: string;
    created_at: string;
  }[],
  conversationId: string | null | undefined
): string | null {
  if (!conversationId) return null;
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const m of messages) {
    if (m.conversation_id !== conversationId) continue;
    if (m.sender_type !== 'customer') continue;
    const at = Date.parse(m.created_at);
    if (Number.isNaN(at) || at <= bestAt) continue;
    bestAt = at;
    best = m.created_at;
  }
  return best;
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
