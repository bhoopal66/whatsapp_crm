import { describe, expect, it } from 'vitest';

import {
  TYPING_SEND_INTERVAL_MS,
  TYPING_TTL_MS,
  activeTypers,
  shouldSendTyping,
  typingLabel,
} from '../typing';
import type { TypingRow } from '../types';

const NOW = Date.parse('2026-10-30T10:00:10Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (
  userId: string,
  ms: number,
  thread: string | null = null,
  channelId = 'c1'
): TypingRow => ({
  channelId,
  accountId: 'w',
  userId,
  threadRootId: thread,
  at: ago(ms),
  stopped: false,
});
const o = { channelId: 'c1', threadRootId: null, selfId: 'me', now: NOW };

describe('activeTypers', () => {
  it('orders most recent first and excludes self', () => {
    expect(
      activeTypers([row('a', 4000), row('me', 100), row('b', 500)], o)
    ).toEqual(['b', 'a']);
  });

  it('drops rows older than the TTL, keeps the boundary', () => {
    expect(
      activeTypers(
        [row('old', TYPING_TTL_MS + 1), row('edge', TYPING_TTL_MS)],
        o
      )
    ).toEqual(['edge']);
  });

  it('matches thread scope exactly', () => {
    const rows = [row('main', 100), row('th', 100, 't1')];
    expect(activeTypers(rows, o)).toEqual(['main']);
    expect(activeTypers(rows, { ...o, threadRootId: 't1' })).toEqual(['th']);
    expect(activeTypers(rows, { ...o, threadRootId: 't2' })).toEqual([]);
  });

  it('ignores a stopped row, however fresh', () => {
    const stopped = { ...row('s', 0), stopped: true };
    expect(activeTypers([stopped, row('a', 100)], o)).toEqual(['a']);
  });

  it('ignores other channels and unparseable times', () => {
    const bad = { ...row('x', 0), at: 'nope' };
    expect(activeTypers([row('a', 0, null, 'c2'), bad], o)).toEqual([]);
  });
});

describe('shouldSendTyping', () => {
  it('sends first, then at most once per interval', () => {
    expect(shouldSendTyping(null, 1000)).toBe(true);
    expect(shouldSendTyping(1000, 1000 + TYPING_SEND_INTERVAL_MS - 1)).toBe(
      false
    );
    expect(shouldSendTyping(1000, 1000 + TYPING_SEND_INTERVAL_MS)).toBe(true);
  });
});

describe('typingLabel', () => {
  it('picks the key and the first two names', () => {
    expect(typingLabel(['a'])).toEqual({ key: 'one', names: ['a'] });
    expect(typingLabel(['a', 'b'])).toEqual({ key: 'two', names: ['a', 'b'] });
    expect(typingLabel(['a', 'b', 'c', 'd'])).toEqual({
      key: 'many',
      names: ['a', 'b'],
    });
  });
});

describe('activeTypers dedupe', () => {
  it('lists a user once even with several rows', () => {
    expect(
      activeTypers([row('a', 3000), row('a', 1000), row('b', 2000)], o)
    ).toEqual(['a', 'b']);
  });
});
