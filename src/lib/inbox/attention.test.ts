import { describe, expect, it } from 'vitest';

import {
  countNeedingAttention,
  needsAttention,
  sortForInbox,
} from './attention';
import type { Conversation } from '@/types';

type Row = Pick<Conversation, 'id' | 'last_message_at' | 'ai_attention_at'>;
const row = (
  id: string,
  last_message_at: string | null,
  ai_attention_at: string | null = null
): Row => ({
  id,
  last_message_at: last_message_at ?? undefined,
  ai_attention_at,
});

describe('sortForInbox', () => {
  it('pins chats the AI handed over above newer chats', () => {
    const sorted = sortForInbox([
      row('fresh', '2026-10-09T10:00:00Z'),
      row('handed', '2026-10-09T08:00:00Z', '2026-10-09T08:00:05Z'),
      row('older', '2026-10-09T07:00:00Z'),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['handed', 'fresh', 'older']);
  });

  it('puts the newest hand-off first among pinned chats', () => {
    const sorted = sortForInbox([
      row('a', '2026-10-09T10:00:00Z', '2026-10-09T09:00:00Z'),
      row('b', '2026-10-09T08:00:00Z', '2026-10-09T09:30:00Z'),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('orders the rest by recency, id descending on ties, timeless last', () => {
    const ts = '2026-10-09T09:00:00Z';
    const sorted = sortForInbox([
      row('none', null),
      row('a', ts),
      row('c', ts),
      row('new', '2026-10-09T11:00:00Z'),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['new', 'c', 'a', 'none']);
  });

  it('drops a chat back into place once attention clears', () => {
    const sorted = sortForInbox([
      row('fresh', '2026-10-09T10:00:00Z'),
      row('was-handed', '2026-10-09T08:00:00Z', null),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['fresh', 'was-handed']);
  });

  it('does not mutate its input', () => {
    const held = [row('a', '2026-01-01T00:00:00Z'), row('b', null, 'x')];
    sortForInbox(held);
    expect(held.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('needsAttention', () => {
  it('is set by a valid ai_attention_at only', () => {
    expect(needsAttention({ ai_attention_at: '2026-10-09T08:00:00Z' })).toBe(
      true
    );
    expect(needsAttention({ ai_attention_at: null })).toBe(false);
    expect(needsAttention({})).toBe(false);
    expect(needsAttention({ ai_attention_at: 'garbage' })).toBe(false);
  });

  it('counts the rows needing attention', () => {
    expect(
      countNeedingAttention([
        { ai_attention_at: '2026-10-09T08:00:00Z' },
        { ai_attention_at: null },
        { ai_attention_at: '2026-10-09T09:00:00Z' },
      ])
    ).toBe(2);
  });
});
