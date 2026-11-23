import { describe, expect, it, vi } from 'vitest';

import { installLogTimestamps, stamped, type LogTarget } from './timestamps';

const AT = new Date('2026-11-23T10:00:00.123Z');

describe('stamped', () => {
  it('keeps a format string working', () => {
    expect(stamped('warn', AT, ['took %d ms', 5])).toEqual([
      '2026-11-23T10:00:00.123Z WARN took %d ms',
      5,
    ]);
  });
  it('puts the prefix before anything that is not a string', () => {
    const err = new Error('x');
    expect(stamped('error', AT, [err])).toEqual([
      '2026-11-23T10:00:00.123Z ERROR',
      err,
    ]);
  });
});

describe('installLogTimestamps', () => {
  it('wraps every level once', () => {
    const calls: unknown[][] = [];
    const write = (...a: unknown[]) => void calls.push(a);
    const target: LogTarget = {
      debug: vi.fn(write),
      log: vi.fn(write),
      info: vi.fn(write),
      warn: vi.fn(write),
      error: vi.fn(write),
    };
    installLogTimestamps(target, () => AT);
    installLogTimestamps(target, () => AT);
    target.log('a');
    target.error('b', { c: 1 });
    expect(calls).toEqual([
      ['2026-11-23T10:00:00.123Z INFO a'],
      ['2026-11-23T10:00:00.123Z ERROR b', { c: 1 }],
    ]);
  });
});
