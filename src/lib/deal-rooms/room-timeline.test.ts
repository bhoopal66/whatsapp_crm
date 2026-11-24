import { describe, expect, it } from 'vitest';

import type { MessagePage, RoomMessage } from './reads';
import {
  ROOM_CATCH_UP_PAGES,
  createRoomTimeline,
  timelinePhase,
} from './room-timeline';

const SIZE = 3;
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

/** A group of `count` messages read in pages of SIZE, as the route does. */
function group(count: number) {
  const g = {
    count,
    fail: false,
    reads: 0,
    /** Called before each answer is given. */
    hold: async () => {},
  };
  const page = async (before: string | null): Promise<MessagePage> => {
    g.reads += 1;
    const total = g.count;
    await g.hold();
    if (g.fail) throw new Error('503');
    const all = Array.from({ length: total }, (_, i) => ({
      id: `m${i}`,
      createdAt: at(i),
    })) as RoomMessage[];
    const left = before ? all.filter((m) => m.createdAt < before) : all;
    const messages = left.slice(-SIZE);
    const hasMore = left.length > SIZE;
    return {
      messages,
      hasMore,
      nextBefore: hasMore ? messages[0].createdAt : null,
    };
  };
  return { g, tl: createRoomTimeline(page) };
}

const ids = (tl: { state: () => { messages: RoomMessage[] | null } }) =>
  tl.state().messages?.map((m) => Number(m.id.slice(1)));
const span = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('the room timeline', () => {
  it('a failed first read is neither empty nor loading, and can be retried', async () => {
    const { g, tl } = group(4);
    expect(timelinePhase(tl.state())).toBe('loading');
    g.fail = true;
    expect(await tl.refresh()).toBe(false);
    expect(tl.state().messages).toBeNull();
    expect(timelinePhase(tl.state())).toBe('failed');
    g.fail = false;
    expect(await tl.refresh()).toBe(true);
    expect(timelinePhase(tl.state())).toBe('shown');
    expect(ids(tl)).toEqual([1, 2, 3]);
    expect(tl.state().older).not.toBeNull();
  });

  it('keeps what is held when a later read fails', async () => {
    const { g, tl } = group(2);
    await tl.refresh();
    g.fail = true;
    expect(await tl.refresh()).toBe(false);
    expect(ids(tl)).toEqual([0, 1]);
    expect(timelinePhase(tl.state())).toBe('shown');
  });

  it('asks for one page when it meets what is held, and keeps older pages', async () => {
    const { g, tl } = group(10);
    await tl.refresh();
    await tl.loadOlder();
    g.reads = 0;
    g.count = 11;
    await tl.refresh();
    expect(g.reads).toBe(1);
    expect(ids(tl)).toEqual(span(4, 10));
    await tl.loadOlder();
    expect(ids(tl)).toEqual(span(1, 10));
  });

  it('pages back until it meets what is held: no hole', async () => {
    const { g, tl } = group(10);
    await tl.refresh();
    g.count = 18;
    await tl.refresh();
    expect(ids(tl)).toEqual(span(7, 17));
    await tl.loadOlder();
    expect(ids(tl)).toEqual(span(4, 17));
  });

  it('stops at the bound and starts over from there, older still reachable', async () => {
    const { g, tl } = group(10);
    await tl.refresh();
    g.reads = 0;
    g.count = 100;
    await tl.refresh();
    expect(g.reads).toBe(ROOM_CATCH_UP_PAGES);
    const held = ROOM_CATCH_UP_PAGES * SIZE;
    expect(ids(tl)).toEqual(span(100 - held, 99));
    await tl.loadOlder();
    expect(ids(tl)).toEqual(span(100 - held - SIZE, 99));
  });

  it('keeps what is held when one of those pages fails', async () => {
    const { g, tl } = group(10);
    await tl.refresh();
    g.count = 18;
    g.reads = 0;
    g.hold = async () => void (g.fail = g.reads > 1);
    expect(await tl.refresh()).toBe(false);
    expect(ids(tl)).toEqual([7, 8, 9]);
  });

  it('offers older pages when an empty group filled while away', async () => {
    const { g, tl } = group(0);
    await tl.refresh();
    expect(timelinePhase(tl.state())).toBe('shown');
    g.count = 9;
    await tl.refresh();
    expect(ids(tl)).toEqual([6, 7, 8]);
    await tl.loadOlder();
    expect(ids(tl)).toEqual(span(3, 8));
  });

  it('drops an older page asked for before the list was replaced', async () => {
    const { g, tl } = group(10);
    await tl.refresh();
    let go = () => {};
    g.hold = () => new Promise<void>((r) => (go = r));
    const old = tl.loadOlder();
    g.hold = async () => {};
    g.count = 100;
    await tl.refresh();
    const before = ids(tl);
    go();
    expect(await old).toBe(false);
    expect(ids(tl)).toEqual(before);
  });

  it('ignores an answer older than one that landed', async () => {
    const { g, tl } = group(2);
    let go = () => {};
    g.hold = () => new Promise<void>((r) => (go = r));
    const slow = tl.refresh();
    g.hold = async () => {};
    g.count = 3;
    await tl.refresh();
    go();
    expect(await slow).toBe(true);
    expect(ids(tl)).toEqual([0, 1, 2]);
  });
});
