/**
 * Deal rooms — what the room screens show (module 014c), as pure
 * functions so they are tested without a DOM: a room's sub-line and
 * phase, how a group message is drawn and labelled, its receipts line,
 * what the group composer offers, and the reply-window countdown.
 *
 * Imports from `./reads` are type-only: that module is server code.
 */

import type { RoomMessage, RoomSummary } from './reads';

/** WhatsApp's cap on a group: GROUP_MAX_PARTICIPANTS in meta-groups.ts. */
export const ROOM_MEMBER_MAX = 8;

/**
 * What a room is doing, in the words the lists use. `participantCount`
 * counts joined people with our own number included (it joins when the
 * group is created), so an open room with one member is still waiting
 * for anybody else to join — and WhatsApp refuses group messages until
 * someone has.
 */
export type RoomPhase =
  | 'creating'
  | 'waiting'
  | 'active'
  | 'suspended'
  | 'closing'
  | 'closed'
  | 'failed';

export function roomPhase(status: string, participantCount: number): RoomPhase {
  switch (status) {
    case 'creating':
    case 'suspended':
    case 'closing':
    case 'closed':
    case 'failed':
      return status;
    case 'open':
      return participantCount > 1 ? 'active' : 'waiting';
    default:
      // A status this screen does not know is treated as read-only.
      return 'closed';
  }
}

/**
 * The banner of a room that is not active: its phase, except that a
 * failed room a manager cancelled while it was being created (096)
 * says so rather than that WhatsApp could not create it.
 */
export type RoomBanner = Exclude<RoomPhase, 'active'> | 'cancelled';

export function roomBanner(
  phase: Exclude<RoomPhase, 'active'>,
  cancelledAt: string | null | undefined
): RoomBanner {
  return phase === 'failed' && cancelledAt ? 'cancelled' : phase;
}

/** "<count> of <max> members · <phase>". */
export function roomSubLine(
  room: Pick<RoomSummary, 'status' | 'participantCount'>
): { count: number; max: number; phase: RoomPhase } {
  return {
    count: room.participantCount,
    max: ROOM_MEMBER_MAX,
    phase: roomPhase(room.status, room.participantCount),
  };
}

/** "<contact> · <deal title or subject>". */
export function roomTitle(
  room: Pick<RoomSummary, 'contactName' | 'dealTitle' | 'subject'>
): string {
  return [room.contactName?.trim(), room.dealTitle?.trim() || room.subject]
    .filter(Boolean)
    .join(' · ');
}

/** Everyone a group message reaches: the joined people but our number. */
export const groupAudience = (participantCount: number): number =>
  Math.max(0, participantCount - 1);

// ============================================================
// A group message
// ============================================================

export type RoleTag = 'customer' | 'partner' | 'bank' | null;

export type BubbleContent =
  | { kind: 'text'; text: string }
  | { kind: 'template'; name: string; text: string | null }
  | { kind: 'file'; name: string | null; type: string }
  | { kind: 'unsupported' };

export interface Bubble {
  /** `system` lines are centred; `ours` (staff, the business) sit right. */
  side: 'system' | 'ours' | 'theirs';
  /** The poster without the bank suffix; '' for a system line. */
  name: string;
  tag: RoleTag;
  /** A bank guest's bank, when the message names it. */
  bank: string | null;
  content: BubbleContent;
}

const FILE_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker']);

function contentOf(m: RoomMessage): BubbleContent {
  if (m.type === 'text' || m.type === 'system') {
    return m.body ? { kind: 'text', text: m.body } : { kind: 'unsupported' };
  }
  if (m.type === 'template') {
    return { kind: 'template', name: m.templateName ?? '', text: m.body };
  }
  if (FILE_TYPES.has(m.type)) {
    return { kind: 'file', name: m.fileName, type: m.type };
  }
  return { kind: 'unsupported' };
}

/**
 * How one group message is drawn. A bank guest posting from the CRM is
 * named "<name> · <bank>" by the messages route; that suffix becomes the
 * "Bank · <bank>" tag. Staff and the business sit on our side; everyone
 * else, a bank guest included, on theirs.
 */
export function bubbleOf(m: RoomMessage): Bubble {
  const content = contentOf(m);
  if (m.type === 'system') {
    return { side: 'system', name: '', tag: null, bank: null, content };
  }
  const role = m.senderRole;
  if (role === 'staff' || role === 'business') {
    return { side: 'ours', name: m.senderName, tag: null, bank: null, content };
  }
  if (role === 'bank_guest') {
    const at = m.senderName.lastIndexOf(' · ');
    return at > 0
      ? {
          side: 'theirs',
          name: m.senderName.slice(0, at),
          tag: 'bank',
          bank: m.senderName.slice(at + 3) || null,
          content,
        }
      : {
          side: 'theirs',
          name: m.senderName,
          tag: 'bank',
          bank: null,
          content,
        };
  }
  const tag: RoleTag = role === 'customer' || role === 'partner' ? role : null;
  return { side: 'theirs', name: m.senderName, tag, bank: null, content };
}

export type ReceiptLine =
  | { key: 'sending' }
  | { key: 'failed' }
  | { key: 'reached'; delivered: number; read: number };

/** "Delivered to N · Read by M" under our own messages; null otherwise. */
export function receiptLine(m: RoomMessage): ReceiptLine | null {
  if (m.direction !== 'out' || m.type === 'system') return null;
  if (m.status === 'failed') return { key: 'failed' };
  if (m.status === 'pending') return { key: 'sending' };
  return { key: 'reached', delivered: m.deliveredCount, read: m.readCount };
}

/**
 * Pages and live refreshes merged: one row per id (the newer copy wins,
 * so receipts move forward), oldest first.
 */
export function mergeRoomMessages(
  held: readonly RoomMessage[],
  incoming: readonly RoomMessage[]
): RoomMessage[] {
  const byId = new Map(held.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// ============================================================
// The group composer
// ============================================================

export type ComposerDisabledReason = RoomBanner;

export type GroupComposerMode =
  | { mode: 'text' }
  /** The 24-hour window is closed: approved templates only. */
  | { mode: 'template' }
  | { mode: 'disabled'; reason: ComposerDisabledReason };

/** The group's 24-hour window: open while `window_until` is ahead. */
export function windowIsOpen(windowUntil: string | null, now: number): boolean {
  const until = windowUntil ? Date.parse(windowUntil) : NaN;
  return Number.isFinite(until) && until > now;
}

/**
 * What the group composer offers, in the order the messages route
 * refuses: a room that is not open (or that nobody has joined yet) takes
 * nothing; free text needs the window open; outside it, templates only.
 * Computed from `windowUntil` and the clock rather than the detail's
 * `windowOpen`, which goes stale while the screen stays open.
 */
export function groupComposerMode(room: {
  status: string;
  participantCount: number;
  windowUntil: string | null;
  cancelledAt?: string | null;
  now: number;
}): GroupComposerMode {
  const phase = roomPhase(room.status, room.participantCount);
  if (phase !== 'active') {
    return { mode: 'disabled', reason: roomBanner(phase, room.cancelledAt) };
  }
  return windowIsOpen(room.windowUntil, room.now)
    ? { mode: 'text' }
    : { mode: 'template' };
}

/** Time left in the reply window, rounded down to the minute. */
export function windowCountdown(
  windowUntil: string | null,
  now: number
): { open: false } | { open: true; hours: number; minutes: number } {
  if (!windowUntil || !windowIsOpen(windowUntil, now)) return { open: false };
  const left = Math.floor((Date.parse(windowUntil) - now) / 60_000);
  return { open: true, hours: Math.floor(left / 60), minutes: left % 60 };
}

/** How many `{{n}}` values a template body takes: its highest n. */
export function templateParamCount(body: string | null | undefined): number {
  let max = 0;
  for (const match of (body ?? '').matchAll(/\{\{(\d+)\}\}/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * The tables whose changes make a staff room screen re-read the room.
 * Each must be in the `supabase_realtime` publication (088), and the
 * viewer must be able to read the row, since realtime replays RLS per
 * subscriber. A join request writes only `deal_room_join_requests`, so
 * without it a manager saw a pending request only after a reload.
 */
export const ROOM_SIGNAL_TABLES: readonly string[] = [
  'deal_rooms',
  'deal_room_participants',
  'deal_room_join_requests',
];

/** The realtime filter for one of those tables, on one room. */
export function roomSignalFilter(table: string, roomId: string): string {
  return table === 'deal_rooms' ? `id=eq.${roomId}` : `room_id=eq.${roomId}`;
}

/** How often a bank guest's room screens re-read, in ms. */
export const GUEST_ROOM_REFRESH_MS = 60_000;

/**
 * A bank guest cannot read `deal_rooms` (staff-only; they read
 * `deal_room_guest_rooms`), so the realtime signal on it never reaches
 * them and a room that closed or was suspended would stay as it was until
 * a reload. Re-reads on a timer for a guest, and does nothing for staff,
 * whom the signal serves. Returns the stop function.
 */
export function startGuestRefresh(
  guest: boolean,
  reload: () => void
): () => void {
  if (!guest) return () => {};
  const id = setInterval(reload, GUEST_ROOM_REFRESH_MS);
  return () => clearInterval(id);
}
