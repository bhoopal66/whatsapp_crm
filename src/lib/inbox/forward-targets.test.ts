import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  matchForwardTargets,
  mergeForwardTargets,
  recentForwardTargets,
  searchForwardTargets,
  type ForwardTarget,
} from './forward-targets';

type Answer = { data?: unknown; error?: unknown };

/** A client whose reads of a table answer in order, and whose calls are kept. */
function client(tables: Record<string, Answer[]>, rpc?: Answer) {
  const calls: string[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'order', 'in', 'or']) {
      chain[m] = (...a: unknown[]) => {
        calls.push(`${table}.${m} ${JSON.stringify(a)}`);
        return chain;
      };
    }
    // `.limit()` may be followed by nothing: the answer is there.
    chain.limit = () => {
      const a = tables[table]?.shift() ?? { data: [], error: null };
      return Promise.resolve({ data: a.data ?? null, error: a.error ?? null });
    };
    return chain;
  };
  return {
    sb: {
      from,
      rpc: vi.fn(async () => ({
        data: rpc?.data ?? null,
        error: rpc?.error ?? null,
      })),
    } as unknown as SupabaseClient,
    calls,
  };
}

const scope = { accountId: 'acc', exclude: 'this', unknown: 'Unknown' };
const chat = (id: string, contact: string, name: string | null = contact) => ({
  id,
  contact: { id: contact, name, phone: '+971 50 111 2233' },
});

describe('the chats a forward can go to', () => {
  it('lists the recent ones, never the chat the message is in', async () => {
    const { sb, calls } = client({
      conversations: [{ data: [chat('1', 'a'), chat('2', 'b', null)] }],
    });
    const got = await recentForwardTargets(sb, scope);
    expect(got.map((t) => [t.id, t.name])).toEqual([
      ['1', 'a'],
      ['2', '+971 50 111 2233'],
    ]);
    expect(calls).toContain('conversations.neq ["id","this"]');
  });

  it('finds an older chat by its contact, best match first', async () => {
    const { sb, calls } = client(
      { conversations: [{ data: [chat('1', 'far'), chat('2', 'near')] }] },
      {
        data: [
          { contact_id: 'near', score: 1, exact: true },
          { contact_id: 'far', score: 0.4, exact: false },
        ],
      }
    );
    const got = await searchForwardTargets(sb, scope, 'near');
    expect(got.map((t) => t.id)).toEqual(['2', '1']);
    expect(calls).toContain('conversations.in ["contact_id",["near","far"]]');
  });

  it('asks for no chats when no contact was found', async () => {
    const { sb, calls } = client({}, { data: [] });
    expect(await searchForwardTargets(sb, scope, 'nobody')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('is a failure, not an empty list, when a read fails', async () => {
    const down = { error: { code: '57014', message: 'timeout' } };
    await expect(
      searchForwardTargets(client({}, down).sb, scope, 'ali')
    ).rejects.toMatchObject({ code: '57014' });
    await expect(
      searchForwardTargets(
        client(
          { conversations: [down] },
          { data: [{ contact_id: 'a', score: 1, exact: true }] }
        ).sb,
        scope,
        'ali'
      )
    ).rejects.toMatchObject({ code: '57014' });
    await expect(
      recentForwardTargets(client({ conversations: [down] }).sb, scope)
    ).rejects.toMatchObject({ code: '57014' });
  });

  it('uses the plain filter for a term the search takes nothing of', async () => {
    const { sb, calls } = client({
      contacts: [{ data: [{ id: 'a' }] }],
      conversations: [{ data: [chat('1', 'a')] }],
    });
    const got = await searchForwardTargets(sb, scope, 'x');
    expect(got.map((t) => t.id)).toEqual(['1']);
    expect(calls.some((c) => c.startsWith('contacts.or'))).toBe(true);
  });
});

describe('the typed term', () => {
  const list: ForwardTarget[] = [
    { id: '1', contactId: 'a', name: 'Ali', phone: '+971 50 111 2233' },
    { id: '2', contactId: 'b', name: 'Sara', phone: '+971 55 444 5566' },
  ];

  it('matches a name or the digits of a phone, in any numerals', () => {
    expect(matchForwardTargets(list, ' sar ').map((t) => t.id)).toEqual(['2']);
    expect(matchForwardTargets(list, '50 111').map((t) => t.id)).toEqual(['1']);
    expect(matchForwardTargets(list, '٥٥٤٤٤').map((t) => t.id)).toEqual(['2']);
    expect(matchForwardTargets(list, '')).toEqual(list);
  });

  it('adds what the search found, each chat once', () => {
    const found = [list[1], { ...list[0], id: '9' }];
    expect(mergeForwardTargets([list[1]], found).map((t) => t.id)).toEqual([
      '2',
      '9',
    ]);
  });
});
