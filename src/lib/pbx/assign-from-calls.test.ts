import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { assignChatFromCallHistory, findLastCaller } from './assign-from-calls';

type Row = Record<string, unknown>;
interface Filter {
  op: 'eq' | 'in' | 'is';
  column: string;
  value: unknown;
}
interface Query {
  table: string;
  filters: Filter[];
  update?: Row;
}

/** A PostgREST stand-in that really applies eq / in / is to its rows. */
function fakeDb(
  tables: Record<string, Row[]>,
  errors: Record<string, string> = {}
) {
  const queries: Query[] = [];
  const db = {
    from(table: string) {
      const q: Query = { table, filters: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.update = (payload: Row) => {
        q.update = payload;
        return b;
      };
      for (const op of ['eq', 'in', 'is'] as const) {
        b[op] = (column: string, value: unknown) => {
          q.filters.push({ op, column, value });
          return b;
        };
      }
      b.then = (resolve: (r: unknown) => unknown) => {
        if (errors[table]) {
          return Promise.resolve({
            data: null,
            error: { message: errors[table] },
          }).then(resolve);
        }
        const rows = (tables[table] ?? []).filter((row) =>
          q.filters.every((f) =>
            f.op === 'in'
              ? (f.value as unknown[]).includes(row[f.column])
              : (row[f.column] ?? null) === f.value
          )
        );
        if (q.update) rows.forEach((row) => Object.assign(row, q.update));
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}

const ACCOUNT = 'acct-1';
const PHONE = '971501234567';

/** Newest first, as the query's order asks. */
const call = (over: Row = {}): Row => ({
  account_id: ACCOUNT,
  direction: 'outbound',
  remote_number: PHONE,
  user_id: 'agent-1',
  extension: '2851',
  ...over,
});
const staff = (user_id: string, over: Row = {}): Row => ({
  account_id: ACCOUNT,
  user_id,
  account_role: 'agent',
  deactivated_at: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('findLastCaller', () => {
  it('picks the person on the newest outbound call', async () => {
    const { db } = fakeDb({
      calls: [
        call({ user_id: 'agent-2', extension: '2852' }),
        call({ user_id: 'agent-1', extension: '2851' }),
      ],
      profiles: [staff('agent-1'), staff('agent-2')],
    });
    expect(await findLastCaller(db, ACCOUNT, PHONE)).toBe('agent-2');
  });

  it('looks in this workspace, for outbound calls, by the number', async () => {
    const { db, queries } = fakeDb({
      calls: [
        call({ direction: 'inbound' }),
        call({ account_id: 'acct-2' }),
        call({ remote_number: '971509999999' }),
      ],
      profiles: [staff('agent-1')],
    });
    expect(await findLastCaller(db, ACCOUNT, PHONE)).toBeNull();
    expect(queries.map((q) => q.table)).toEqual(['calls']);
  });

  it('matches a call stored in a trunk-0 form of the number', async () => {
    const { db } = fakeDb({
      calls: [call({ remote_number: '9710501234567' })],
      profiles: [staff('agent-1')],
    });
    expect(await findLastCaller(db, ACCOUNT, PHONE)).toBe('agent-1');
  });

  it('uses the extension holder for a call with no person', async () => {
    const { db } = fakeDb({
      calls: [call({ user_id: null })],
      pbx_extensions: [
        { account_id: ACCOUNT, extension: '2851', user_id: 'agent-3' },
      ],
      profiles: [staff('agent-3')],
    });
    expect(await findLastCaller(db, ACCOUNT, PHONE)).toBe('agent-3');
  });

  it('never takes another workspace’s holder of the same extension', async () => {
    const { db } = fakeDb({
      calls: [call({ user_id: null })],
      pbx_extensions: [
        { account_id: 'acct-2', extension: '2851', user_id: 'agent-3' },
      ],
      profiles: [staff('agent-3')],
    });
    expect(await findLastCaller(db, ACCOUNT, PHONE)).toBeNull();
  });

  it('gives a leaver’s customer to whoever holds the extension now', async () => {
    const { db } = fakeDb({
      calls: [
        call({ user_id: 'left-1' }),
        call({ user_id: 'agent-1', extension: '2800' }),
      ],
      pbx_extensions: [
        { account_id: ACCOUNT, extension: '2851', user_id: 'agent-3' },
      ],
      profiles: [
        staff('left-1', { deactivated_at: '2026-11-01T00:00:00Z' }),
        staff('agent-1'),
        staff('agent-3'),
      ],
    });
    expect(await findLastCaller(db, ACCOUNT, PHONE)).toBe('agent-3');
  });

  it('passes over people who cannot hold a chat for an earlier caller', async () => {
    const { db } = fakeDb({
      calls: [
        call({ user_id: 'left-1', extension: null }),
        call({ user_id: 'viewer-1', extension: null }),
        call({ user_id: 'guest-1', extension: null }),
        call({ user_id: 'other-ws', extension: null }),
        call({ user_id: 'agent-1', extension: null }),
      ],
      profiles: [
        staff('left-1', { deactivated_at: '2026-11-01T00:00:00Z' }),
        staff('viewer-1', { account_role: 'viewer' }),
        staff('guest-1', { account_role: 'bank_guest' }),
        staff('other-ws', { account_id: 'acct-2' }),
        staff('agent-1'),
      ],
    });
    expect(await findLastCaller(db, ACCOUNT, PHONE)).toBe('agent-1');
  });

  it('answers null when no call has a person', async () => {
    const { db } = fakeDb({
      calls: [call({ user_id: null, extension: null })],
    });
    expect(await findLastCaller(db, ACCOUNT, PHONE)).toBeNull();
  });
});

describe('assignChatFromCallHistory', () => {
  const chat = { accountId: ACCOUNT, conversationId: 'conv-1', phone: PHONE };

  it('assigns an unassigned chat to the last caller', async () => {
    const conv: Row = {
      id: 'conv-1',
      account_id: ACCOUNT,
      assigned_agent_id: null,
    };
    const { db } = fakeDb({
      calls: [call()],
      profiles: [staff('agent-1')],
      conversations: [conv],
    });
    expect(await assignChatFromCallHistory(db, chat)).toBe('agent-1');
    expect(conv.assigned_agent_id).toBe('agent-1');
  });

  it('leaves a chat someone took since it was read', async () => {
    const conv: Row = {
      id: 'conv-1',
      account_id: ACCOUNT,
      assigned_agent_id: 'agent-9',
    };
    const { db } = fakeDb({
      calls: [call()],
      profiles: [staff('agent-1')],
      conversations: [conv],
    });
    expect(await assignChatFromCallHistory(db, chat)).toBeNull();
    expect(conv.assigned_agent_id).toBe('agent-9');
  });

  it('writes nothing when nobody called the number', async () => {
    const { db, queries } = fakeDb({ calls: [] });
    expect(await assignChatFromCallHistory(db, chat)).toBeNull();
    expect(queries.some((q) => q.update)).toBe(false);
  });

  it('never throws: a failed read leaves the chat unassigned', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, queries } = fakeDb({}, { calls: 'boom' });
    expect(await assignChatFromCallHistory(db, chat)).toBeNull();
    expect(queries.some((q) => q.update)).toBe(false);
    expect(log).toHaveBeenCalled();
  });
});
