import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUP_MAX_PARTICIPANTS } from '@/lib/whatsapp/meta-groups';

import type { RoomMessage } from './reads';
import {
  GUEST_ROOM_REFRESH_MS,
  ROOM_MEMBER_MAX,
  ROOM_SIGNAL_TABLES,
  bubbleOf,
  groupAudience,
  groupComposerMode,
  roomBanner,
  mergeRoomMessages,
  receiptLine,
  startGuestRefresh,
  roomPhase,
  roomSignalFilter,
  roomSubLine,
  roomTitle,
  templateParamCount,
  windowCountdown,
} from './view';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function msg(over: Partial<RoomMessage>): RoomMessage {
  return {
    id: 'm1',
    direction: 'in',
    type: 'text',
    body: 'Hello',
    templateName: null,
    fileName: null,
    status: null,
    createdAt: '2026-10-12T10:00:00Z',
    senderName: 'Omar',
    senderRole: 'customer',
    deliveredCount: 0,
    readCount: 0,
    ...over,
  };
}

describe('room phase and sub-line', () => {
  it('keeps the member cap equal to the gateway cap', () => {
    expect(ROOM_MEMBER_MAX).toBe(GROUP_MAX_PARTICIPANTS);
  });

  it('calls an open room nobody else joined waiting', () => {
    expect(roomPhase('open', 1)).toBe('waiting');
    expect(roomPhase('open', 0)).toBe('waiting');
    expect(roomPhase('open', 2)).toBe('active');
  });

  it('passes the other statuses through and reads an unknown one as closed', () => {
    for (const s of ['creating', 'suspended', 'closing', 'closed', 'failed']) {
      expect(roomPhase(s, 5)).toBe(s);
    }
    expect(roomPhase('archived', 5)).toBe('closed');
  });

  it('counts members out of the cap', () => {
    expect(roomSubLine({ status: 'open', participantCount: 4 })).toEqual({
      count: 4,
      max: 8,
      phase: 'active',
    });
  });

  it('titles a room by contact and deal, else subject', () => {
    const base = { contactName: 'Al Noor', dealTitle: null, subject: 'Loan' };
    expect(roomTitle(base)).toBe('Al Noor · Loan');
    expect(roomTitle({ ...base, dealTitle: 'Working capital' })).toBe(
      'Al Noor · Working capital'
    );
    expect(roomTitle({ ...base, contactName: null })).toBe('Loan');
  });

  it('counts the audience without our own number', () => {
    expect(groupAudience(4)).toBe(3);
    expect(groupAudience(0)).toBe(0);
  });
});

describe('bubbleOf', () => {
  it('centres a system line', () => {
    const b = bubbleOf(
      msg({ type: 'system', direction: 'out', body: 'Mariam joined' })
    );
    expect(b.side).toBe('system');
    expect(b.content).toEqual({ kind: 'text', text: 'Mariam joined' });
  });

  it('puts staff and the business on our side', () => {
    const staff = msg({
      direction: 'out',
      senderName: 'Sara · Taamul',
      senderRole: 'staff',
    });
    expect(bubbleOf(staff)).toMatchObject({
      side: 'ours',
      name: 'Sara · Taamul',
    });
    expect(bubbleOf({ ...staff, senderRole: 'business' }).side).toBe('ours');
  });

  it('tags the customer and the partner', () => {
    expect(bubbleOf(msg({})).tag).toBe('customer');
    expect(bubbleOf(msg({ senderRole: 'partner' })).tag).toBe('partner');
    expect(bubbleOf(msg({ senderRole: null })).tag).toBeNull();
  });

  it("splits a bank guest's bank off the name, on their side", () => {
    expect(
      bubbleOf(
        msg({
          direction: 'out',
          senderName: 'Mariam · Mashreq',
          senderRole: 'bank_guest',
        })
      )
    ).toMatchObject({
      side: 'theirs',
      name: 'Mariam',
      tag: 'bank',
      bank: 'Mashreq',
    });
    expect(
      bubbleOf(msg({ senderName: 'Mariam', senderRole: 'bank_guest' }))
    ).toMatchObject({ name: 'Mariam', tag: 'bank', bank: null });
  });

  it('draws files as a chip and anything unknown as unsupported', () => {
    expect(
      bubbleOf(msg({ type: 'document', body: null, fileName: 'offer.pdf' }))
        .content
    ).toEqual({ kind: 'file', name: 'offer.pdf', type: 'document' });
    expect(bubbleOf(msg({ type: 'unsupported' })).content).toEqual({
      kind: 'unsupported',
    });
    expect(bubbleOf(msg({ type: 'text', body: null })).content).toEqual({
      kind: 'unsupported',
    });
    expect(
      bubbleOf(msg({ type: 'template', body: null, templateName: 'kyc' }))
        .content
    ).toEqual({ kind: 'template', name: 'kyc', text: null });
  });
});

describe('receiptLine', () => {
  it('counts deliveries and reads under our messages only', () => {
    const ours = msg({
      direction: 'out',
      status: 'delivered',
      senderRole: 'staff',
      deliveredCount: 3,
      readCount: 1,
    });
    expect(receiptLine(ours)).toEqual({
      key: 'reached',
      delivered: 3,
      read: 1,
    });
    expect(receiptLine({ ...ours, status: 'failed' })).toEqual({
      key: 'failed',
    });
    expect(receiptLine({ ...ours, status: 'pending' })).toEqual({
      key: 'sending',
    });
    expect(receiptLine(msg({}))).toBeNull();
    expect(receiptLine({ ...ours, type: 'system' })).toBeNull();
  });
});

describe('mergeRoomMessages', () => {
  it('keeps one row per id, the newer copy, oldest first', () => {
    const a = msg({ id: 'a', createdAt: '2026-10-12T10:00:00Z' });
    const b = msg({ id: 'b', createdAt: '2026-10-12T11:00:00Z' });
    const b2 = { ...b, readCount: 2 };
    const c = msg({ id: 'c', createdAt: '2026-10-12T09:00:00Z' });
    expect(mergeRoomMessages([a, b], [b2, c])).toEqual([c, a, b2]);
  });
});

describe('groupComposerMode', () => {
  const room = {
    status: 'open',
    participantCount: 3,
    windowUntil: inHours(2),
    now: NOW,
  };

  it('offers free text while the window is open', () => {
    expect(groupComposerMode(room)).toEqual({ mode: 'text' });
  });

  it('offers templates only once the window has closed or never opened', () => {
    expect(groupComposerMode({ ...room, windowUntil: inHours(-1) })).toEqual({
      mode: 'template',
    });
    expect(groupComposerMode({ ...room, windowUntil: null })).toEqual({
      mode: 'template',
    });
    expect(groupComposerMode({ ...room, windowUntil: inHours(0) })).toEqual({
      mode: 'template',
    });
  });

  it('takes nothing in a room that is not open or that nobody joined', () => {
    expect(groupComposerMode({ ...room, participantCount: 1 })).toEqual({
      mode: 'disabled',
      reason: 'waiting',
    });
    for (const status of [
      'creating',
      'suspended',
      'closing',
      'closed',
      'failed',
    ] as const) {
      expect(groupComposerMode({ ...room, status })).toEqual({
        mode: 'disabled',
        reason: status,
      });
    }
  });

  it('says a failed room was cancelled when a manager cancelled it (096)', () => {
    const at = '2026-10-13T08:00:00Z';
    expect(
      groupComposerMode({ ...room, status: 'failed', cancelledAt: at })
    ).toEqual({ mode: 'disabled', reason: 'cancelled' });
    expect(
      groupComposerMode({ ...room, status: 'failed', cancelledAt: null })
    ).toEqual({ mode: 'disabled', reason: 'failed' });
  });
});

describe('roomBanner', () => {
  it('is the phase, except a cancelled failed room', () => {
    expect(roomBanner('failed', '2026-10-13T08:00:00Z')).toBe('cancelled');
    expect(roomBanner('failed', null)).toBe('failed');
    expect(roomBanner('creating', undefined)).toBe('creating');
    // Only a failed room can have been cancelled; the stamp alone says nothing.
    expect(roomBanner('closed', '2026-10-13T08:00:00Z')).toBe('closed');
  });
});

describe('windowCountdown', () => {
  it('counts hours and minutes left, rounded down', () => {
    expect(windowCountdown(inHours(5.21), NOW)).toEqual({
      open: true,
      hours: 5,
      minutes: 12,
    });
  });

  it('is closed at or past the end, or with no window', () => {
    expect(windowCountdown(inHours(0), NOW)).toEqual({ open: false });
    expect(windowCountdown(inHours(-3), NOW)).toEqual({ open: false });
    expect(windowCountdown(null, NOW)).toEqual({ open: false });
  });
});

describe('templateParamCount', () => {
  it('takes the highest placeholder', () => {
    expect(templateParamCount('Hi {{1}}, your {{3}} and {{2}}')).toBe(3);
    expect(templateParamCount('No values')).toBe(0);
    expect(templateParamCount(null)).toBe(0);
  });
});

describe('startGuestRefresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-reads a guest's room every 60 seconds, until stopped", () => {
    const reload = vi.fn();
    const stop = startGuestRefresh(true, reload);
    vi.advanceTimersByTime(GUEST_ROOM_REFRESH_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * GUEST_ROOM_REFRESH_MS);
    expect(reload).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(10 * GUEST_ROOM_REFRESH_MS);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('leaves staff to the realtime signal: no timer at all', () => {
    const reload = vi.fn();
    const stop = startGuestRefresh(false, reload);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * GUEST_ROOM_REFRESH_MS);
    expect(reload).not.toHaveBeenCalled();
    stop();
  });

  it('is 60 seconds', () => {
    expect(GUEST_ROOM_REFRESH_MS).toBe(60_000);
  });
});

describe("the room screen's realtime signal", () => {
  it('re-reads on a join request, which writes only its own table', () => {
    expect(ROOM_SIGNAL_TABLES).toContain('deal_room_join_requests');
    expect(ROOM_SIGNAL_TABLES).toContain('deal_room_participants');
    expect(ROOM_SIGNAL_TABLES).toContain('deal_rooms');
  });

  it('listens only to tables 088 publishes to realtime', () => {
    const sql = readFileSync('supabase/migrations/088_deal_rooms.sql', 'utf8');
    const realtime = sql.slice(
      sql.indexOf('-- ---------- 9. Realtime'),
      sql.indexOf('-- ---------- 10. Privileges')
    );
    expect(realtime).toContain('ALTER PUBLICATION supabase_realtime');
    for (const table of ROOM_SIGNAL_TABLES) {
      expect(realtime).toContain(`'${table}'`);
    }
  });

  it('filters the room by its id and the rest by room_id', () => {
    expect(roomSignalFilter('deal_rooms', 'r1')).toBe('id=eq.r1');
    expect(roomSignalFilter('deal_room_participants', 'r1')).toBe(
      'room_id=eq.r1'
    );
    expect(roomSignalFilter('deal_room_join_requests', 'r1')).toBe(
      'room_id=eq.r1'
    );
  });
});
