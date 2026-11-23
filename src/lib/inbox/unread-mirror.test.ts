import { describe, expect, it } from 'vitest';

import {
  emptyUnreadMirror,
  unreadMirrorReducer,
  unreadRose,
  type UnreadMirrorAction,
  type UnreadMirrorRow,
} from './unread-mirror';

const row = (id: string, unread_count: number): UnreadMirrorRow => ({
  id,
  unread_count,
});
const run = (...actions: UnreadMirrorAction<UnreadMirrorRow>[]) =>
  actions.reduce(unreadMirrorReducer, emptyUnreadMirror());
const held = (s: ReturnType<typeof run>) =>
  [...s.rows].map(([id, r]) => `${id}:${r.unread_count}`).sort();

describe('unreadMirrorReducer', () => {
  it('replaces the mirror, so a chat the viewer lost drops out', () => {
    const s = run(
      { type: 'readStarted', seq: 1 },
      { type: 'readLanded', seq: 1, rows: [row('a', 1), row('lost', 4)] },
      { type: 'readStarted', seq: 2 },
      { type: 'readLanded', seq: 2, rows: [row('a', 2)] }
    );
    expect(held(s)).toEqual(['a:2']);
  });

  it('lets an event during a read win over its answer', () => {
    const s = run(
      { type: 'readStarted', seq: 1 },
      { type: 'change', id: 'read', row: row('read', 0) },
      { type: 'change', id: 'gone', row: null },
      { type: 'change', id: 'new', row: row('new', 1) },
      {
        type: 'readLanded',
        seq: 1,
        rows: [row('read', 3), row('gone', 2), row('b', 5)],
      }
    );
    expect(held(s)).toEqual(['b:5', 'new:1']);
  });

  it('holds no event from before the read against it', () => {
    const s = run(
      { type: 'change', id: 'a', row: row('a', 1) },
      { type: 'readStarted', seq: 1 },
      { type: 'readLanded', seq: 1, rows: [] }
    );
    expect(held(s)).toEqual([]);
  });

  it('ignores the answer of a read a newer one took over from', () => {
    const s = run(
      { type: 'readStarted', seq: 1 },
      { type: 'readStarted', seq: 2 },
      { type: 'readLanded', seq: 1, rows: [row('old', 1)] }
    );
    expect(held(s)).toEqual([]);
    expect(s.read?.seq).toBe(2);
  });
});

describe('unreadRose', () => {
  it('compares with what is held, a chat not held being at 0', () => {
    const s = run({ type: 'change', id: 'a', row: row('a', 2) });
    expect(unreadRose(s, row('a', 3))).toBe(true);
    expect(unreadRose(s, row('a', 2))).toBe(false);
    expect(unreadRose(s, row('b', 1))).toBe(true);
    expect(unreadRose(s, row('b', 0))).toBe(false);
  });
});
