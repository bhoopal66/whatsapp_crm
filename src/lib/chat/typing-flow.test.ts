import { describe, expect, it } from 'vitest';

import {
  applyTypingChange,
  mergeTypingRead,
  pruneTyping,
  typingStep,
} from './typing-flow';
import { TYPING_SEND_INTERVAL_MS, TYPING_TTL_MS } from './typing';
import type { TypingRow } from './types';

const NOW = Date.parse('2026-10-30T10:00:00.000Z');
const step = (o: Partial<Parameters<typeof typingStep>[0]>) =>
  typingStep({
    prevText: '',
    nextText: 'h',
    lastSentAt: null,
    now: NOW,
    blocked: false,
    ...o,
  });

const row = (
  userId: string,
  at: number,
  o: Partial<TypingRow> = {}
): TypingRow => ({
  channelId: 'c1',
  accountId: 'a1',
  userId,
  threadRootId: null,
  at: new Date(at).toISOString(),
  stopped: false,
  ...o,
});

describe('typingStep', () => {
  it('starts on the first keystroke', () => {
    expect(step({})).toBe('start');
  });

  it('sends again only once the interval has passed', () => {
    const sent = NOW - TYPING_SEND_INTERVAL_MS + 1;
    expect(step({ prevText: 'h', nextText: 'he', lastSentAt: sent })).toBe(
      null
    );
    expect(
      step({
        prevText: 'h',
        nextText: 'he',
        lastSentAt: NOW - TYPING_SEND_INTERVAL_MS,
      })
    ).toBe('start');
  });

  it('stops when the text is cleared, but only after a start', () => {
    expect(step({ prevText: 'hi', nextText: '', lastSentAt: NOW })).toBe(
      'stop'
    );
    expect(step({ prevText: 'hi', nextText: '  \n', lastSentAt: NOW })).toBe(
      'stop'
    );
    expect(step({ prevText: 'hi', nextText: '', lastSentAt: null })).toBe(null);
  });

  it('never starts while blocked, and stops a live one', () => {
    expect(step({ blocked: true })).toBe(null);
    expect(step({ blocked: true, lastSentAt: NOW - 10_000 })).toBe('stop');
  });

  it('ignores a change that leaves the text as it was', () => {
    expect(step({ prevText: 'hi @Sara', nextText: 'hi @Sara' })).toBe(null);
  });
});

describe('applyTypingChange', () => {
  it('upserts one row per person, stamped with the arrival time', () => {
    const held = [row('u1', NOW - 5000), row('u2', NOW - 1000)];
    const next = applyTypingChange(
      held,
      { type: 'update', row: row('u1', NOW - 60_000, { threadRootId: 'r' }) },
      'c1',
      NOW
    );
    expect(next).toHaveLength(2);
    const u1 = next.find((r) => r.userId === 'u1');
    expect(u1?.threadRootId).toBe('r');
    expect(u1?.at).toBe(new Date(NOW).toISOString());
  });

  it('removes on delete and ignores other channels', () => {
    const held = [row('u1', NOW)];
    expect(
      applyTypingChange(
        held,
        { type: 'delete', row: { channelId: 'c1', userId: 'u1' } },
        'c1',
        NOW
      )
    ).toEqual([]);
    expect(
      applyTypingChange(
        held,
        { type: 'insert', row: row('u2', NOW, { channelId: 'c2' }) },
        'c1',
        NOW
      )
    ).toBe(held);
    expect(
      applyTypingChange(
        held,
        { type: 'delete', row: { channelId: 'c1', userId: 'u9' } },
        'c1',
        NOW
      )
    ).toBe(held);
  });
});

describe('mergeTypingRead', () => {
  it('keeps a live row over the one read for the same person', () => {
    const live = [row('u1', NOW)];
    const read = [
      row('u1', NOW - 4000),
      row('u2', NOW - 2000),
      row('u3', NOW, { channelId: 'c2' }),
    ];
    const merged = mergeTypingRead(live, read, 'c1');
    expect(merged.map((r) => [r.userId, r.at])).toEqual([
      ['u1', new Date(NOW).toISOString()],
      ['u2', new Date(NOW - 2000).toISOString()],
    ]);
  });
});

describe('pruneTyping', () => {
  it('drops rows past the TTL and keeps the reference when none go', () => {
    const fresh = [row('u1', NOW - TYPING_TTL_MS)];
    expect(pruneTyping(fresh, NOW)).toBe(fresh);
    const mixed = [...fresh, row('u2', NOW - TYPING_TTL_MS - 1)];
    expect(pruneTyping(mixed, NOW).map((r) => r.userId)).toEqual(['u1']);
  });
});
