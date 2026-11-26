import { describe, expect, it, vi } from 'vitest';

import {
  createHeldCheck,
  HELD_CHECK_CHUNK,
  HELD_CHECK_GAP_MS,
} from './held-check';

function setup(
  ids: string[],
  answer: (chunk: string[]) => Promise<string[]> = async (chunk) => chunk,
  signedIn = async () => true
) {
  let now = 1_000;
  const read = vi.fn(answer);
  const drop = vi.fn();
  const check = createHeldCheck({
    held: () => new Set(ids),
    read,
    drop,
    signedIn,
    now: () => now,
  });
  return { check, read, drop, pass: (ms: number) => (now += ms) };
}

describe('createHeldCheck', () => {
  it('drops the rows the read no longer returns', async () => {
    const t = setup(['a', 'b', 'c'], async (chunk) =>
      chunk.filter((id) => id !== 'b')
    );
    await t.check.run();
    expect(t.drop.mock.calls).toEqual([[['b']]]);
  });

  it('drops nothing when every row is still there', async () => {
    const t = setup(['a']);
    await t.check.run();
    expect(t.drop).not.toHaveBeenCalled();
  });

  it('asks in chunks, and drops nothing when one of them fails', async () => {
    const ids = Array.from({ length: HELD_CHECK_CHUNK + 1 }, (_, i) => `c${i}`);
    const t = setup(ids, async (chunk) => {
      if (chunk.length === 1) throw new Error('timeout');
      return chunk.slice(1);
    });
    await t.check.run();
    expect(t.read.mock.calls.map(([c]) => c.length)).toEqual([
      HELD_CHECK_CHUNK,
      1,
    ]);
    expect(t.drop).not.toHaveBeenCalled();
  });

  it('takes an answer without any row for a lost session', async () => {
    const t = setup(
      ['a', 'b'],
      async () => [],
      async () => false
    );
    await t.check.run();
    expect(t.read).toHaveBeenCalledTimes(1);
    expect(t.drop).not.toHaveBeenCalled();
  });

  it('drops every row when, signed in, it answers so twice', async () => {
    const t = setup(['a', 'b'], async () => []);
    await t.check.run();
    expect(t.read).toHaveBeenCalledTimes(2);
    expect(t.drop.mock.calls).toEqual([[['a', 'b']]]);
    let first = true;
    const u = setup(['a', 'b'], async (chunk) => {
      if (!first) return chunk;
      first = false;
      return [];
    });
    await u.check.run();
    expect(u.drop).not.toHaveBeenCalled();
  });

  it('a failed check does not use up the minute', async () => {
    let up = false;
    const t = setup(['a', 'b'], async () => {
      if (!up) throw new Error('timeout');
      return ['a'];
    });
    await t.check.run();
    up = true;
    await t.check.run();
    expect(t.drop.mock.calls).toEqual([[['b']]]);
  });

  it('asks at most once a minute, and not once stopped', async () => {
    const t = setup(['a']);
    await t.check.run();
    t.pass(HELD_CHECK_GAP_MS - 1);
    await t.check.run();
    expect(t.read).toHaveBeenCalledTimes(1);
    t.pass(1);
    await t.check.run();
    expect(t.read).toHaveBeenCalledTimes(2);
    t.check.stop();
    t.pass(HELD_CHECK_GAP_MS);
    await t.check.run();
    expect(t.read).toHaveBeenCalledTimes(2);
  });
});
