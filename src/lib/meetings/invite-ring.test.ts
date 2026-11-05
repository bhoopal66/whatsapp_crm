import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '@/types';

import {
  InviteRinger,
  RING_CHECK_MS,
  RING_MS,
  STARTING_NOW_BODY,
  ringNotes,
  type MeetingRead,
  type RingerContext,
} from './invite-ring';
import type { MeetingDetailData, MeetingSummary } from './schedule';

const ACTIVE = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const MEETING = '00000000-0000-4000-8000-000000000001';
const MEETING_2 = '00000000-0000-4000-8000-000000000002';
const SCHEDULED_BODY = 'Starts 05 Nov 2026 14:00 UTC';

function invite(over: Partial<Notification> = {}): Notification {
  return {
    id: 'row-1',
    account_id: ACTIVE,
    user_id: 'me',
    type: 'meeting_invite',
    actor_user_id: 'host',
    title: 'Weekly sync',
    body: STARTING_NOW_BODY,
    meta: { meeting_id: MEETING },
    created_at: '2026-11-05T12:00:00Z',
    ...over,
  } as Notification;
}

function detail(
  over: Partial<MeetingSummary> = {},
  lockedAt: string | null = null
): MeetingDetailData {
  return {
    meeting: {
      status: 'scheduled',
      presentCount: 1,
      ...over,
    } as MeetingSummary,
    canManage: null,
    chatCount: null,
    lockedAt,
  };
}

const CTX: RingerContext = {
  activeWorkspaceId: ACTIVE,
  pathname: '/inbox',
  heldMeetingId: null,
  busy: false,
};

function setup(ctx: Partial<RingerContext> = {}) {
  const stopTone = vi.fn();
  const startTone = vi.fn(() => stopTone);
  const readMeeting = vi.fn<(id: string) => Promise<MeetingRead>>(async () =>
    detail()
  );
  const ringer = new InviteRinger({ readMeeting, startTone });
  ringer.setContext({ ...CTX, ...ctx });
  return { ringer, readMeeting, startTone, stopTone };
}

/** A read that answers only when told to. */
function heldRead() {
  let answer: (read: MeetingRead) => void = () => {};
  const promise = new Promise<MeetingRead>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InviteRinger', () => {
  it('R1: an instant invite rings at once, before any read answers', () => {
    const { ringer, readMeeting, startTone } = setup();
    readMeeting.mockReturnValue(new Promise(() => {}));
    const row = invite();
    ringer.handle({ event: 'INSERT', row });
    expect(ringer.getSnapshot()).toBe(row);
    expect(startTone).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another type', { type: 'meeting_reminder' }],
    ['a meeting id that is no UUID', { meta: { meeting_id: 'nope' } }],
    ['no meeting id', { meta: {} }],
    ['a read row', { read_at: '2026-11-05T12:00:01Z' }],
  ])('R2: ignores %s', async (_name, over) => {
    const { ringer, readMeeting, startTone } = setup();
    ringer.handle({
      event: 'INSERT',
      row: invite(over as Partial<Notification>),
    });
    await settle();
    expect(ringer.getSnapshot()).toBeNull();
    expect(startTone).not.toHaveBeenCalled();
    expect(readMeeting).not.toHaveBeenCalled();
  });

  it('R3: a scheduled invite rings once someone is in the meeting', async () => {
    const { ringer, readMeeting, startTone } = setup();
    const held = heldRead();
    readMeeting.mockReturnValueOnce(held.promise);
    const row = invite({ body: SCHEDULED_BODY });
    ringer.handle({ event: 'INSERT', row });
    expect(ringer.getSnapshot()).toBeNull();
    expect(readMeeting).toHaveBeenCalledWith(MEETING);
    held.answer(detail());
    await settle();
    expect(ringer.getSnapshot()).toBe(row);
    expect(startTone).toHaveBeenCalledTimes(1);
  });

  it.each<[string, MeetingRead]>([
    ['nobody is present', detail({ presentCount: 0 })],
    ['it is gone', 'gone'],
    ['the read failed', null],
    ['it ended', detail({ status: 'ended' })],
    ['it was cancelled', detail({ status: 'cancelled' })],
    ['it is locked', detail({}, '2026-11-05T12:00:00Z')],
  ])('R3: a scheduled invite stays silent when %s', async (_name, read) => {
    const { ringer, readMeeting, startTone } = setup();
    readMeeting.mockResolvedValue(read);
    ringer.handle({ event: 'INSERT', row: invite({ body: SCHEDULED_BODY }) });
    await settle();
    expect(ringer.getSnapshot()).toBeNull();
    expect(startTone).not.toHaveBeenCalled();
  });

  it('R3: a scheduled invite read since it arrived never rings', async () => {
    const { ringer, readMeeting } = setup();
    const held = heldRead();
    readMeeting.mockReturnValueOnce(held.promise);
    const row = invite({ body: SCHEDULED_BODY });
    ringer.handle({ event: 'INSERT', row });
    ringer.handle({
      event: 'UPDATE',
      row: { ...row, read_at: '2026-11-05T12:00:01Z' },
    });
    held.answer(detail());
    await settle();
    expect(ringer.getSnapshot()).toBeNull();
  });

  it('R3: a slow older invite does not take over from a newer one', async () => {
    const { ringer, readMeeting } = setup();
    const held = heldRead();
    readMeeting.mockReturnValueOnce(held.promise);
    ringer.handle({
      event: 'INSERT',
      row: invite({ id: 'older', body: SCHEDULED_BODY }),
    });
    const newer = invite({ id: 'newer', meta: { meeting_id: MEETING_2 } });
    ringer.handle({ event: 'INSERT', row: newer });
    held.answer(detail());
    await settle();
    expect(ringer.getSnapshot()).toBe(newer);
  });

  it('R4: another workspace rings instantly and never reads', async () => {
    const { ringer, readMeeting, startTone } = setup();
    const row = invite({ account_id: OTHER });
    ringer.handle({ event: 'INSERT', row });
    await vi.advanceTimersByTimeAsync(RING_CHECK_MS * 3);
    expect(ringer.getSnapshot()).toBe(row);
    expect(startTone).toHaveBeenCalledTimes(1);
    expect(readMeeting).not.toHaveBeenCalled();
  });

  it('R4: a scheduled invite of another workspace is ignored unread', async () => {
    const { ringer, readMeeting } = setup();
    ringer.handle({
      event: 'INSERT',
      row: invite({ account_id: OTHER, body: SCHEDULED_BODY }),
    });
    await settle();
    expect(ringer.getSnapshot()).toBeNull();
    expect(readMeeting).not.toHaveBeenCalled();
  });

  it('R4: an unknown active workspace counts as the same one', async () => {
    const { ringer, readMeeting } = setup({ activeWorkspaceId: null });
    ringer.handle({ event: 'INSERT', row: invite({ account_id: OTHER }) });
    await settle();
    expect(readMeeting).toHaveBeenCalledWith(MEETING);
  });

  it.each<[string, Partial<RingerContext>]>([
    ['holding the meeting', { heldMeetingId: MEETING }],
    ['on its room page', { pathname: `/meetings/${MEETING}/room` }],
  ])('R5: no ring when already there, %s', (_name, ctx) => {
    const { ringer, startTone } = setup(ctx);
    ringer.handle({ event: 'INSERT', row: invite() });
    expect(ringer.getSnapshot()).toBeNull();
    expect(startTone).not.toHaveBeenCalled();
  });

  it('R5: arriving at the meeting while it rings stops it', () => {
    const { ringer, stopTone } = setup();
    ringer.handle({ event: 'INSERT', row: invite() });
    ringer.setContext({ ...CTX, pathname: `/meetings/${MEETING}/room` });
    expect(ringer.getSnapshot()).toBeNull();
    expect(stopTone).toHaveBeenCalledTimes(1);
  });

  it('R5: a scheduled invite answered after arriving does not ring', async () => {
    const { ringer, readMeeting } = setup();
    const held = heldRead();
    readMeeting.mockReturnValueOnce(held.promise);
    ringer.handle({ event: 'INSERT', row: invite({ body: SCHEDULED_BODY }) });
    ringer.setContext({ ...CTX, heldMeetingId: MEETING });
    held.answer(detail());
    await settle();
    expect(ringer.getSnapshot()).toBeNull();
  });

  it('R6: busy shows the card without the tone', () => {
    const { ringer, startTone } = setup({ busy: true });
    const row = invite();
    ringer.handle({ event: 'INSERT', row });
    expect(ringer.getSnapshot()).toBe(row);
    expect(startTone).not.toHaveBeenCalled();
  });

  it('R6: busy mid-ring stops the tone only, and back restarts it', () => {
    const { ringer, startTone, stopTone } = setup();
    const row = invite();
    ringer.handle({ event: 'INSERT', row });
    ringer.setContext({ ...CTX, busy: true });
    expect(stopTone).toHaveBeenCalledTimes(1);
    expect(ringer.getSnapshot()).toBe(row);
    ringer.setContext({ ...CTX, busy: false });
    expect(startTone).toHaveBeenCalledTimes(2);
    expect(ringer.getSnapshot()).toBe(row);
  });

  it('setContext stays quiet when nothing changed', () => {
    const { ringer, startTone } = setup();
    const heard = vi.fn();
    ringer.handle({ event: 'INSERT', row: invite() });
    ringer.subscribe(heard);
    ringer.setContext({ ...CTX });
    ringer.setContext({ ...CTX, pathname: '/contacts' });
    expect(heard).not.toHaveBeenCalled();
    expect(startTone).toHaveBeenCalledTimes(1);
  });

  it('R7: rings for RING_MS, then stops and leaves the row alone', async () => {
    const { ringer, stopTone } = setup();
    const heard = vi.fn();
    ringer.subscribe(heard);
    ringer.handle({ event: 'INSERT', row: invite() });
    await vi.advanceTimersByTimeAsync(RING_MS - 1);
    expect(ringer.getSnapshot()).not.toBeNull();
    expect(stopTone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ringer.getSnapshot()).toBeNull();
    expect(stopTone).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('R8: checks at once and then every RING_CHECK_MS', async () => {
    const { ringer, readMeeting } = setup();
    ringer.handle({ event: 'INSERT', row: invite() });
    expect(readMeeting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RING_CHECK_MS);
    expect(readMeeting).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RING_CHECK_MS);
    expect(readMeeting).toHaveBeenCalledTimes(3);
  });

  it.each<[string, MeetingRead]>([
    ['is gone', 'gone'],
    ['ended', detail({ status: 'ended' })],
    ['was cancelled', detail({ status: 'cancelled' })],
    ['is locked', detail({}, '2026-11-05T12:00:00Z')],
  ])('R8: stops when the meeting %s', async (_name, read) => {
    const { ringer, readMeeting, stopTone } = setup();
    readMeeting.mockResolvedValue(read);
    ringer.handle({ event: 'INSERT', row: invite() });
    await settle();
    expect(ringer.getSnapshot()).toBeNull();
    expect(stopTone).toHaveBeenCalledTimes(1);
  });

  it('R8: a failed read keeps ringing', async () => {
    const { ringer, readMeeting } = setup();
    readMeeting.mockResolvedValue(null);
    const row = invite();
    ringer.handle({ event: 'INSERT', row });
    await vi.advanceTimersByTimeAsync(RING_CHECK_MS * 2);
    expect(ringer.getSnapshot()).toBe(row);
  });

  it('R8: a late answer for a closed invite changes nothing', async () => {
    const { ringer, readMeeting, stopTone } = setup();
    const held = heldRead();
    readMeeting.mockReturnValueOnce(held.promise);
    ringer.handle({ event: 'INSERT', row: invite() });
    ringer.close();
    const heard = vi.fn();
    ringer.subscribe(heard);
    held.answer('gone');
    await settle();
    expect(heard).not.toHaveBeenCalled();
    expect(stopTone).toHaveBeenCalledTimes(1);
  });

  it('R8: a late answer for a replaced invite changes nothing', async () => {
    const { ringer, readMeeting } = setup();
    const held = heldRead();
    readMeeting.mockReturnValueOnce(held.promise);
    ringer.handle({ event: 'INSERT', row: invite() });
    const newer = invite({ id: 'row-2', meta: { meeting_id: MEETING_2 } });
    ringer.handle({ event: 'INSERT', row: newer });
    held.answer('gone');
    await settle();
    expect(ringer.getSnapshot()).toBe(newer);
  });

  it('R9: an UPDATE setting read_at on the ringing row stops it', () => {
    const { ringer, stopTone } = setup();
    const row = invite();
    ringer.handle({ event: 'INSERT', row });
    ringer.handle({
      event: 'UPDATE',
      row: { ...row, read_at: '2026-11-05T12:00:01Z' },
    });
    expect(ringer.getSnapshot()).toBeNull();
    expect(stopTone).toHaveBeenCalledTimes(1);
  });

  it('R9: an UPDATE of another row, or with no read_at, does nothing', () => {
    const { ringer, stopTone } = setup();
    const row = invite();
    ringer.handle({ event: 'INSERT', row });
    ringer.handle({
      event: 'UPDATE',
      row: { ...row, id: 'row-2', read_at: '2026-11-05T12:00:01Z' },
    });
    ringer.handle({ event: 'UPDATE', row: { ...row } });
    expect(ringer.getSnapshot()).toBe(row);
    expect(stopTone).not.toHaveBeenCalled();
  });

  it('R9: a DELETE of the ringing id stops it; another id does not', () => {
    const { ringer } = setup();
    const row = invite();
    ringer.handle({ event: 'INSERT', row });
    ringer.handle({ event: 'DELETE', row: { id: 'row-2' } });
    expect(ringer.getSnapshot()).toBe(row);
    ringer.handle({ event: 'DELETE', row: { id: row.id } });
    expect(ringer.getSnapshot()).toBeNull();
  });

  it('R10: a newer invite replaces the ring and restarts the clock', async () => {
    const { ringer, startTone, stopTone } = setup();
    ringer.handle({ event: 'INSERT', row: invite() });
    await vi.advanceTimersByTimeAsync(RING_MS - 1_000);
    const newer = invite({ id: 'row-2', meta: { meeting_id: MEETING_2 } });
    ringer.handle({ event: 'INSERT', row: newer });
    expect(ringer.getSnapshot()).toBe(newer);
    expect(stopTone).toHaveBeenCalledTimes(1);
    expect(startTone).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RING_MS - 1);
    expect(ringer.getSnapshot()).toBe(newer);
    await vi.advanceTimersByTimeAsync(1);
    expect(ringer.getSnapshot()).toBeNull();
  });

  it('R11: close stops the tone and leaves no timer', () => {
    const { ringer, stopTone } = setup();
    ringer.handle({ event: 'INSERT', row: invite() });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ringer.close();
    expect(stopTone).toHaveBeenCalledTimes(1);
    expect(ringer.getSnapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('R11: stays usable after close, as a strict-mode re-run needs', () => {
    const { ringer, startTone } = setup();
    ringer.close();
    const row = invite();
    ringer.handle({ event: 'INSERT', row });
    expect(ringer.getSnapshot()).toBe(row);
    expect(startTone).toHaveBeenCalledTimes(1);
  });

  it('R11: close drops a scheduled invite still being read', async () => {
    const { ringer, readMeeting } = setup();
    const held = heldRead();
    readMeeting.mockReturnValueOnce(held.promise);
    ringer.handle({ event: 'INSERT', row: invite({ body: SCHEDULED_BODY }) });
    ringer.close();
    held.answer(detail());
    await settle();
    expect(ringer.getSnapshot()).toBeNull();
  });
});

describe('ringNotes', () => {
  it('R12: is finite and ends by RING_MS', () => {
    const notes = ringNotes();
    expect(notes.length).toBeGreaterThan(0);
    const last = notes[notes.length - 1];
    expect(last.atMs + last.ms).toBeLessThanOrEqual(RING_MS);
    expect(notes.every((n) => n.atMs + n.ms <= RING_MS)).toBe(true);
  });

  it('R12: is two notes repeating every 2,200 ms', () => {
    expect(ringNotes().slice(0, 3)).toEqual([
      { atMs: 0, hz: 880, ms: 180 },
      { atMs: 180, hz: 1175, ms: 260 },
      { atMs: 2_200, hz: 880, ms: 180 },
    ]);
  });
});

describe('the body the ring matches', () => {
  it("R13: is the one migration 106's trigger writes", () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/106_meetings.sql'),
      'utf8'
    );
    expect(sql).toContain(`ELSE '${STARTING_NOW_BODY}' END`);
  });
});
