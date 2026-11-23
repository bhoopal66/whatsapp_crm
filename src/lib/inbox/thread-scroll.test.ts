import { describe, expect, it } from 'vitest';

import type { Message } from '@/types';
import { bottomGap, threadScroll, threadSnapshot } from './thread-scroll';

type M = Pick<Message, 'id' | 'sender_type' | 'sender_id'>;
const c = (id: string): M => ({ id, sender_type: 'customer' });
const mine = (id: string): M => ({
  id,
  sender_type: 'agent',
  sender_id: 'me',
});
const held = [c('a'), c('b')];
const snap = threadSnapshot('c1', held);
const run = (next: M[], gap: number, prev: typeof snap | null = snap) =>
  threadScroll(prev, 'c1', next, gap, 'me');
const stay = (arrived: number) => ({ toBottom: false, arrived });
const bottom = { toBottom: true, arrived: 0 };

describe('threadScroll', () => {
  it('goes to the bottom when a chat is opened', () => {
    expect(run(held, 900, null)).toEqual(bottom);
    expect(run(held, 900, threadSnapshot('c0', held))).toEqual(bottom);
  });

  it('never moves or counts for ticks, reactions and edits', () => {
    expect(run([...held], 900)).toEqual(stay(0));
    expect(run([...held], 0)).toEqual(stay(0));
    expect(run([c('a')], 0)).toEqual(stay(0));
  });

  it('keeps the place and counts what arrived below', () => {
    expect(run([...held, c('x'), c('y')], 121)).toEqual(stay(2));
  });

  it('follows arrivals within 120 px of the end', () => {
    expect(run([...held, c('x')], 120)).toEqual(bottom);
  });

  it('goes to the bottom on the own send, whose row neither moves nor counts', () => {
    expect(run([...held, mine('temp-1')], 900)).toEqual(bottom);
    const sent = threadSnapshot('c1', [...held, mine('temp-1')]);
    expect(run([...held, mine('r1')], 900, sent)).toEqual(stay(0));
  });

  it('does not count an older page', () => {
    expect(run([c('0'), ...held], 900)).toEqual(stay(0));
    expect(run([c('0'), ...held], 0)).toEqual(stay(0));
    expect(run([c('0'), ...held, c('x')], 900)).toEqual(stay(1));
  });

  it('treats a replaced thread as opened', () => {
    expect(run([c('x'), c('y')], 900)).toEqual(bottom);
  });
});

it('bottomGap measures the part below the viewport', () => {
  expect(
    bottomGap({ scrollHeight: 1000, scrollTop: 300, clientHeight: 500 })
  ).toBe(200);
});
