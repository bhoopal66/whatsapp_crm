import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  notifyInsightAttention,
  type InsightAttentionReason,
} from './insight-attention';
import { notificationTarget, type NotificationTargetRow } from './target';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

type Insert = {
  table: string;
  row: NotificationTargetRow & Record<string, unknown>;
};

function fakeDb(opts: { error?: string; throws?: boolean } = {}): {
  db: SupabaseClient;
  inserts: Insert[];
} {
  const inserts: Insert[] = [];
  const db = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          if (opts.throws) throw new Error('network down');
          inserts.push({ table, row: row as Insert['row'] });
          return Promise.resolve({
            error: opts.error ? { message: opts.error } : null,
          });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, inserts };
}

const bell = (
  reason: InsightAttentionReason = 'urgent',
  contactName: string | null = 'Aisha'
) => ({
  accountId: ACCOUNT,
  conversationId: CONV,
  recipientUserId: USER,
  reason,
  contactName,
});

afterEach(() => vi.restoreAllMocks());

describe('notifyInsightAttention', () => {
  it('writes one insight_attention row that opens the chat', async () => {
    const { db, inserts } = fakeDb();
    await expect(notifyInsightAttention(db, bell())).resolves.toBe(true);
    expect(inserts).toEqual([
      {
        table: 'notifications',
        row: {
          account_id: ACCOUNT,
          user_id: USER,
          type: 'insight_attention',
          conversation_id: CONV,
          actor_user_id: null,
          title: 'Needs attention: Aisha',
          body: 'Urgent',
          meta: { reason: 'urgent' },
        },
      },
    ]);
    expect(notificationTarget(inserts[0].row, 'agent')).toBe(
      `/inbox?c=${CONV}`
    );
  });

  it.each([
    ['urgent', 'Urgent'],
    ['wants_person', 'Wants a person'],
    ['upset', 'Upset'],
    ['callback', 'Asked for a call back'],
  ] as const)('words the %s reason as "%s"', async (reason, body) => {
    const { db, inserts } = fakeDb();
    await notifyInsightAttention(db, bell(reason));
    expect(inserts[0].row.body).toBe(body);
    expect(inserts[0].row.meta).toEqual({ reason });
  });

  it('names an unnamed contact "a customer"', async () => {
    const { db, inserts } = fakeDb();
    await notifyInsightAttention(db, bell('upset', '  '));
    expect(inserts[0].row.title).toBe('Needs attention: a customer');
    await notifyInsightAttention(db, bell('upset', null));
    expect(inserts[1].row.title).toBe('Needs attention: a customer');
  });

  it('returns false on an insert error, never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = fakeDb({ error: 'violates check constraint' });
    await expect(notifyInsightAttention(db, bell())).resolves.toBe(false);
  });

  it('returns false when the client throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = fakeDb({ throws: true });
    await expect(notifyInsightAttention(db, bell())).resolves.toBe(false);
  });
});
