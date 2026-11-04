import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { assignChatFromCallHistory, findLastCaller } from './assign-from-calls';
import { normalizeRemoteNumber } from './phone';

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

/** `remote_number.in.(a,b),contact_id.eq.c`, as findLastCaller sends it. */
function matchesOr(row: Row, expr: string): boolean {
  const numbers = /remote_number\.in\.\(([^)]*)\)/.exec(expr)?.[1].split(',');
  const contact = /contact_id\.eq\.([^,]+)/.exec(expr)?.[1];
  return (
    (numbers ?? []).includes(row.remote_number as string) ||
    row.contact_id === contact
  );
}

/** A PostgREST stand-in that really filters and orders its rows. */
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
      let orExpr: string | null = null;
      let orderBy: { column: string; ascending: boolean } | null = null;
      b.select = () => b;
      b.limit = () => b;
      b.or = (expr: string) => {
        orExpr = expr;
        return b;
      };
      b.order = (column: string, opts: { ascending: boolean }) => {
        orderBy = { column, ascending: opts.ascending };
        return b;
      };
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
      const run = () => {
        if (errors[table]) {
          return { data: null, error: { message: errors[table] } };
        }
        const rows = (tables[table] ?? []).filter(
          (row) =>
            q.filters.every((f) =>
              f.op === 'in'
                ? (f.value as unknown[]).includes(row[f.column])
                : (row[f.column] ?? null) === f.value
            ) &&
            (orExpr === null || matchesOr(row, orExpr))
        );
        const by = orderBy;
        if (by) {
          const sign = by.ascending ? 1 : -1;
          rows.sort(
            (x, y) =>
              sign * String(x[by.column]).localeCompare(String(y[by.column]))
          );
        }
        if (q.update) rows.forEach((row) => Object.assign(row, q.update));
        return { data: rows, error: null };
      };
      b.then = (resolve: (r: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve);
      b.maybeSingle = () => {
        const r = run();
        return Promise.resolve({ ...r, data: r.data?.[0] ?? null });
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}

const ACCOUNT = 'acct-1';
const PHONE = '971501234567';
const CUSTOMER = { phone: PHONE, contactId: 'contact-1' };

// The list keeps calls newest first unless a test says otherwise: each
// fixture is a minute older than the one before.
let minute = 59;
const call = (over: Row = {}): Row => ({
  account_id: ACCOUNT,
  connection_id: 'conn-1',
  direction: 'outbound',
  remote_number: PHONE,
  contact_id: null,
  user_id: 'agent-1',
  extension: '2851',
  started_at: `2026-11-01T10:${String(minute--).padStart(2, '0')}:00Z`,
  ...over,
});
const staff = (user_id: string, over: Row = {}): Row => ({
  account_id: ACCOUNT,
  user_id,
  account_role: 'agent',
  deactivated_at: null,
  ...over,
});

const holder = (user_id: string, over: Row = {}): Row => ({
  account_id: ACCOUNT,
  connection_id: 'conn-1',
  extension: '2851',
  user_id,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  minute = 59;
});

describe('findLastCaller', () => {
  it('picks the person on the newest outbound call', async () => {
    const { db } = fakeDb({
      calls: [
        call({
          user_id: 'agent-1',
          extension: '2851',
          started_at: '2026-10-01T09:00:00Z',
        }),
        call({
          user_id: 'agent-2',
          extension: '2852',
          started_at: '2026-11-01T09:00:00Z',
        }),
      ],
      profiles: [staff('agent-1'), staff('agent-2')],
    });
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBe('agent-2');
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
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBeNull();
    expect(queries.map((q) => q.table)).toEqual(['calls']);
  });

  it('matches a call stored in a trunk-0 form of the number', async () => {
    const { db } = fakeDb({
      calls: [call({ remote_number: '9710501234567' })],
      profiles: [staff('agent-1')],
    });
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBe('agent-1');
  });

  it.each(['0501234567', '+971 50 123 4567', '00971501234567', '501234567'])(
    'finds a call the PBX reported as %s',
    async (raw) => {
      const { db } = fakeDb({
        calls: [call({ remote_number: normalizeRemoteNumber(raw)?.number })],
        profiles: [staff('agent-1')],
      });
      expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBe('agent-1');
    }
  );

  it('finds a call linked to the contact under another form of the number', async () => {
    const { db } = fakeDb({
      calls: [call({ remote_number: '501234567', contact_id: 'contact-1' })],
      profiles: [staff('agent-1')],
    });
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBe('agent-1');
  });

  it('uses the extension holder for a call with no person', async () => {
    const { db } = fakeDb({
      calls: [call({ user_id: null })],
      pbx_extensions: [holder('agent-3')],
      profiles: [staff('agent-3')],
    });
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBe('agent-3');
  });

  it('never takes another workspace’s holder of the same extension', async () => {
    const { db } = fakeDb({
      calls: [call({ user_id: null })],
      pbx_extensions: [holder('agent-3', { account_id: 'acct-2' })],
      profiles: [staff('agent-3')],
    });
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBeNull();
  });

  it('never takes the holder of the same extension on another PBX', async () => {
    const { db } = fakeDb({
      calls: [call({ user_id: null })],
      pbx_extensions: [holder('agent-3', { connection_id: 'conn-2' })],
      profiles: [staff('agent-3')],
    });
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBeNull();
  });

  it('gives a leaver’s customer to whoever holds the extension now', async () => {
    const { db } = fakeDb({
      calls: [
        call({ user_id: 'left-1' }),
        call({ user_id: 'agent-1', extension: '2800' }),
      ],
      pbx_extensions: [holder('agent-3')],
      profiles: [
        staff('left-1', { deactivated_at: '2026-11-01T00:00:00Z' }),
        staff('agent-1'),
        staff('agent-3'),
      ],
    });
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBe('agent-3');
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
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBe('agent-1');
  });

  it('answers null when no call has a person', async () => {
    const { db } = fakeDb({
      calls: [call({ user_id: null, extension: null })],
    });
    expect(await findLastCaller(db, ACCOUNT, CUSTOMER)).toBeNull();
  });
});

describe('assignChatFromCallHistory', () => {
  const chat = {
    accountId: ACCOUNT,
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactOwnerId: 'owner-1',
    phone: PHONE,
  };

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

  const unassigned = (): Row => ({
    id: 'conv-1',
    account_id: ACCOUNT,
    assigned_agent_id: null,
  });

  it('replaces an admin owner of the contact', async () => {
    const conv = unassigned();
    const { db } = fakeDb({
      calls: [call()],
      profiles: [staff('agent-1'), staff('owner-1', { account_role: 'admin' })],
      conversations: [conv],
    });
    expect(await assignChatFromCallHistory(db, chat)).toBe('agent-1');
  });

  it('leaves a contact another agent owns with them', async () => {
    const conv = unassigned();
    const { db } = fakeDb({
      calls: [call()],
      profiles: [staff('agent-1'), staff('owner-1')],
      conversations: [conv],
    });
    expect(await assignChatFromCallHistory(db, chat)).toBeNull();
    expect(conv.assigned_agent_id).toBeNull();
  });

  it('assigns the agent who owns the contact when they called', async () => {
    const conv = unassigned();
    const { db } = fakeDb({
      calls: [call({ user_id: 'owner-1' })],
      profiles: [staff('owner-1')],
      conversations: [conv],
    });
    expect(await assignChatFromCallHistory(db, chat)).toBe('owner-1');
  });

  it('takes a contact from an owner who has left', async () => {
    const conv = unassigned();
    const { db } = fakeDb({
      calls: [call()],
      profiles: [
        staff('agent-1'),
        staff('owner-1', { deactivated_at: '2026-11-01T00:00:00Z' }),
      ],
      conversations: [conv],
    });
    expect(await assignChatFromCallHistory(db, chat)).toBe('agent-1');
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
