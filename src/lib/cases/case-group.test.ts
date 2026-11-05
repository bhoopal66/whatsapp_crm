import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { senderKey } from '@/lib/groups/sender-colors';
import { toMessageView } from '@/lib/submission-groups/views';

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
    const [message] = await liveGroupMessages(
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
});
