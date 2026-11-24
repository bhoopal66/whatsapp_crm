import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { senderKey } from '@/lib/groups/sender-colors';
import {
  DETAIL_MESSAGE_LIMIT,
  toMessageView,
} from '@/lib/submission-groups/views';

import { liveGroupMessages } from './case-group';

/** A table that answers only the columns asked for, as PostgREST does. */
function tableOf(row: Record<string, unknown>) {
  let columns: string[] = [];
  const query = {
    select(list: string) {
      columns = list.split(',').map((c) => c.trim());
      return query;
    },
    eq: () => query,
    order: () => query,
    limit: () => query,
    then: (done: (r: { data: unknown[]; error: null }) => void) =>
      done({
        data: [Object.fromEntries(columns.map((c) => [c, row[c]]))],
        error: null,
      }),
  };
  return { from: () => query } as unknown as SupabaseClient;
}

describe('liveGroupMessages', () => {
  // Without the number a case's Conversation tab has nothing to name a
  // customer or coordinator by, and every one of them shares one grey.
  it('reads who wrote a message, the number included', async () => {
    const {
      messages: [message],
    } = await liveGroupMessages(
      tableOf({
        id: 7,
        direction: 'in',
        sender_wa_id: '971501234567',
        sender_kind: 'customer',
        type: 'text',
        body: 'Hello',
        post_end: false,
        created_at: '2026-11-05T09:00:00.000Z',
      }),
      'group-1'
    );
    expect(message.senderWaId).toBe('971501234567');
    expect(senderKey(toMessageView(message, new Map()))).toBe(
      'wa:971501234567'
    );
  });

  /** A table of `count` rows that cuts every answer at 1,000, as PostgREST does. */
  let asked: number | null = null;
  const longTable = (count: number) => {
    let data = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      direction: 'in',
      type: 'text',
      body: `message ${i + 1}`,
      post_end: false,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
    let max = 1000;
    asked = null;
    const query = {
      select: () => query,
      eq: () => query,
      order(column: string, o: { ascending: boolean }) {
        if (column === 'created_at' && !o.ascending) data = [...data].reverse();
        return query;
      },
      limit(n: number) {
        asked = n;
        max = Math.min(max, n);
        return query;
      },
      then: (done: (r: { data: unknown[]; error: null }) => void) =>
        done({ data: data.slice(0, max), error: null }),
    };
    return { from: () => query } as unknown as SupabaseClient;
  };

  // Oldest first with no limit stopped at message 1,000: a new message, and
  // the agent's own reply, never showed, and a reply was sent twice.
  it('reads the newest messages of a long chat, oldest first', async () => {
    const r = await liveGroupMessages(longTable(1200), 'group-1');
    expect(r.messages).toHaveLength(DETAIL_MESSAGE_LIMIT);
    expect(r.messages.at(-1)?.body).toBe('message 1200');
    expect(r.messages[0].body).toBe(`message ${1201 - DETAIL_MESSAGE_LIMIT}`);
    expect(r.truncated).toBe(true);
    expect(asked).toBe(DETAIL_MESSAGE_LIMIT + 1);
  });

  it('a chat of exactly one page is not called truncated', async () => {
    const r = await liveGroupMessages(
      longTable(DETAIL_MESSAGE_LIMIT),
      'group-1'
    );
    expect(r.messages).toHaveLength(DETAIL_MESSAGE_LIMIT);
    expect(r.truncated).toBe(false);
  });
});
