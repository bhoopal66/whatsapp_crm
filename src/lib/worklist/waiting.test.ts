import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  businessWait,
  filterWaitingChats,
  loadWaitingChats,
  parseWaitingChats,
  waitingChatHref,
  wallWait,
  type WaitingChat,
} from './waiting';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const MIN = 60_000;

function raw(id: string, minsAgo: number, assignee: string | null) {
  return {
    conversation_id: id,
    contact_id: `k-${id}`,
    contact_name: `Customer ${id}`,
    contact_phone: '971500000000',
    assigned_agent_id: assignee,
    waiting_since: new Date(NOW - minsAgo * MIN).toISOString(),
    business_minutes: minsAgo,
    unassigned: assignee === null,
  };
}

const ROWS: WaitingChat[] = parseWaitingChats([
  raw('a', 20, 'u-me'),
  raw('b', 90, 'u-other'),
  raw('c', 40, null),
  raw('d', 5, 'u-team'),
]);

describe('parseWaitingChats', () => {
  it('orders oldest first and keeps the fields', () => {
    expect(ROWS.map((r) => r.conversationId)).toEqual(['b', 'c', 'a', 'd']);
    expect(ROWS[1]).toMatchObject({
      unassigned: true,
      assignedAgentId: null,
      businessMinutes: 40,
      contactName: 'Customer c',
    });
  });

  it('drops malformed rows and tolerates junk', () => {
    expect(parseWaitingChats(null)).toEqual([]);
    expect(parseWaitingChats({})).toEqual([]);
    expect(
      parseWaitingChats([
        null,
        { conversation_id: 'x' },
        { conversation_id: 'y', waiting_since: 'not a date' },
        { ...raw('z', 3, 'u'), business_minutes: 'lots' },
      ]).map((r) => [r.conversationId, r.businessMinutes])
    ).toEqual([['z', 0]]);
  });

  it('treats a row with no assignee as unassigned whatever the flag says', () => {
    const [r] = parseWaitingChats([
      { ...raw('q', 1, null), unassigned: false },
    ]);
    expect(r.unassigned).toBe(true);
  });
});

describe('filterWaitingChats', () => {
  it('own mode: my chats and unassigned ones', () => {
    expect(
      filterWaitingChats(ROWS, { mode: 'own', userId: 'u-me' }).map(
        (r) => r.conversationId
      )
    ).toEqual(['c', 'a']);
  });

  it('all mode: everything, one person, or my team', () => {
    const ids = (s: Parameters<typeof filterWaitingChats>[1]) =>
      filterWaitingChats(ROWS, s).map((r) => r.conversationId);
    expect(ids({ mode: 'all', userId: 'u-me' })).toEqual(['b', 'c', 'a', 'd']);
    expect(ids({ mode: 'all', userId: 'u-me', assignedTo: 'u-other' })).toEqual(
      ['b']
    );
    expect(
      ids({
        mode: 'all',
        userId: 'u-me',
        assignedTo: 'u-other',
        team: ['u-me', 'u-team'],
      })
    ).toEqual(['a', 'd']);
  });

  it('none mode: nothing', () => {
    expect(filterWaitingChats(ROWS, { mode: 'none', userId: 'u-me' })).toEqual(
      []
    );
  });
});

describe('wording', () => {
  it('opens the chat in the inbox', () => {
    expect(waitingChatHref('abc')).toBe('/inbox?c=abc');
  });

  it('says clock time and business time', () => {
    const b = ROWS[0];
    expect(wallWait(b, NOW)).toEqual({ unit: 'hours', n: 1 });
    expect(businessWait(b)).toEqual({ unit: 'hours', n: 1 });
    expect(businessWait({ ...b, businessMinutes: 0 })).toBeNull();
    expect(wallWait(ROWS[3], NOW)).toEqual({ unit: 'minutes', n: 5 });
  });
});

describe('loadWaitingChats', () => {
  it('calls the RPC with the limit and parses', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: [raw('a', 2, null)], error: null });
    const rows = await loadWaitingChats(
      { rpc } as unknown as SupabaseClient,
      7
    );
    expect(rpc).toHaveBeenCalledWith('worklist_waiting_chats', { p_limit: 7 });
    expect(rows.map((r) => r.conversationId)).toEqual(['a']);
  });

  it('never throws: an error or a throw is an empty list', async () => {
    const failing = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: '42883' } }),
    } as unknown as SupabaseClient;
    expect(await loadWaitingChats(failing)).toEqual([]);
    const throwing = {
      rpc: vi.fn().mockRejectedValue(new Error('network')),
    } as unknown as SupabaseClient;
    expect(await loadWaitingChats(throwing)).toEqual([]);
  });
});
