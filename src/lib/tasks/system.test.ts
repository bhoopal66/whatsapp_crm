import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { closeSystemTasks, createSystemTask, resolveTaskOwner } from './system';

// A role ladder that also knows `bank_guest` and ranks it at the top,
// the worst place a later branch could put it. Who may hold a task is
// a named list, so where the ladder ranks a role must not matter.
vi.mock('@/lib/auth/roles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/roles')>();
  return {
    ...actual,
    isAccountRole: (value: unknown) =>
      value === 'bank_guest' || actual.isAccountRole(value),
    hasMinRole: (role: string, min: string) =>
      role === 'bank_guest' ||
      actual.hasMinRole(
        role as Parameters<typeof actual.hasMinRole>[0],
        min as Parameters<typeof actual.hasMinRole>[1]
      ),
  };
});

type Row = Record<string, unknown>;
type DbError = { code: string; message: string };

/**
 * An in-memory stand-in for the service-role client: the chain methods
 * system.ts uses, applying their filters and column lists to plain
 * rows, so a missing `.eq('account_id', …)` shows up as a wrong answer.
 * `fail` makes one `table.op` answer an error instead.
 */
function fakeDb(
  tables: Record<string, Row[]>,
  fail: Record<string, DbError> = {}
) {
  const ops: string[] = [];
  const upserts: { row: Row; options: unknown }[] = [];
  let nextId = 1;

  function from(table: string) {
    let op: 'select' | 'upsert' | 'update' = 'select';
    let payload: Row = {};
    let options: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let columns: string[] | null = null;
    const filters: ((row: Row) => boolean)[] = [];

    const run = (): { data: Row[] | null; error: DbError | null } => {
      ops.push(`${table}.${op}`);
      if (fail[`${table}.${op}`])
        return { data: null, error: fail[`${table}.${op}`] };
      const rows = (tables[table] ??= []);
      const project = (r: Row) =>
        columns ? Object.fromEntries(columns.map((c) => [c, r[c] ?? null])) : r;
      if (op === 'upsert') {
        upserts.push({ row: payload, options });
        const keys = (options.onConflict ?? '').split(',');
        const clash = rows.some((r) =>
          keys.every((k) => payload[k] != null && r[k] === payload[k])
        );
        if (clash && options.ignoreDuplicates) return { data: [], error: null };
        const row = { id: `task-new-${nextId++}`, status: 'open', ...payload };
        rows.push(row);
        return { data: [project(row)], error: null };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') matched.forEach((r) => Object.assign(r, payload));
      return { data: matched.map(project), error: null };
    };

    const builder = {
      select(cols: string) {
        columns = cols.split(',').map((c) => c.trim());
        return builder;
      },
      upsert(row: Row, opts: typeof options) {
        op = 'upsert';
        payload = row;
        options = opts;
        return builder;
      },
      update(patch: Row) {
        op = 'update';
        payload = patch;
        return builder;
      },
      eq(col: string, value: unknown) {
        filters.push((r) => r[col] === value);
        return builder;
      },
      in(col: string, values: unknown[]) {
        filters.push((r) => values.includes(r[col]));
        return builder;
      },
      is(col: string, value: null) {
        filters.push((r) => (r[col] ?? null) === value);
        return builder;
      },
      maybeSingle() {
        const { data, error } = run();
        return Promise.resolve({ data: data?.[0] ?? null, error });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  }

  return { db: { from } as unknown as SupabaseClient, ops, upserts, tables };
}

const A = 'account-a';
const B = 'account-b';

const INPUT = {
  accountId: A,
  kind: 'missed_call' as const,
  title: '  Missed call from +971 50 123 4567  ',
  source: 'pbx' as const,
  sourceRef: 'call-1',
};

describe('createSystemTask', () => {
  it('opens a task and says it created it', async () => {
    const { db, upserts } = fakeDb({ tasks: [] });
    const result = await createSystemTask(db, {
      ...INPUT,
      note: '   ',
      contactId: 'contact-1',
      assignedTo: 'agent-1',
      meta: { caller: '+971501234567' },
    });
    expect(result).toEqual({ id: 'task-new-1', created: true });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].options).toEqual({
      onConflict: 'account_id,source,source_ref',
      ignoreDuplicates: true,
    });
    expect(upserts[0].row).toEqual({
      account_id: A,
      kind: 'missed_call',
      title: 'Missed call from +971 50 123 4567',
      note: null,
      contact_id: 'contact-1',
      conversation_id: null,
      deal_id: null,
      assigned_to: 'agent-1',
      due_at: null,
      source: 'pbx',
      source_ref: 'call-1',
      meta: { caller: '+971501234567' },
    });
    // No person opened it.
    expect(upserts[0].row).not.toHaveProperty('created_by');
  });

  it('answers the task already holding the key, in this account', async () => {
    const { db, tables } = fakeDb({
      tasks: [
        { id: 'task-b', account_id: B, source: 'pbx', source_ref: 'call-1' },
        { id: 'task-a', account_id: A, source: 'pbx', source_ref: 'call-1' },
      ],
    });
    const result = await createSystemTask(db, INPUT);
    expect(result).toEqual({ id: 'task-a', created: false });
    expect(tables.tasks).toHaveLength(2);
  });

  it('cuts an overlong title and note by characters, never inside one', async () => {
    const { db, upserts } = fakeDb({ tasks: [] });
    await createSystemTask(db, {
      ...INPUT,
      title: `${'a'.repeat(299)}😀😀 tail`,
      note: 'n'.repeat(4100),
    });
    const row = upserts[0].row as { title: string; note: string };
    expect(Array.from(row.title)).toHaveLength(300);
    expect(row.title.endsWith('😀')).toBe(true);
    expect(row.note).toHaveLength(4000);
  });

  it('throws on a blank sourceRef or title before writing', async () => {
    const { db, ops } = fakeDb({ tasks: [] });
    await expect(
      createSystemTask(db, { ...INPUT, sourceRef: '  ' })
    ).rejects.toThrow(/sourceRef is blank/);
    await expect(
      createSystemTask(db, { ...INPUT, title: ' ' })
    ).rejects.toThrow(/title is blank/);
    expect(ops).toEqual([]);
  });

  it('throws, naming the operation, when the insert fails', async () => {
    const { db } = fakeDb(
      { tasks: [] },
      {
        'tasks.upsert': {
          code: '23514',
          message: 'Assignee cannot hold tasks',
        },
      }
    );
    await expect(createSystemTask(db, INPUT)).rejects.toThrow(
      'createSystemTask: insert failed (23514): Assignee cannot hold tasks'
    );
  });

  it('throws when the duplicate cannot be read back', async () => {
    const existing = [
      { id: 'task-a', account_id: A, source: 'pbx', source_ref: 'call-1' },
    ];
    const failing = fakeDb(
      { tasks: [...existing] },
      { 'tasks.select': { code: '57014', message: 'timeout' } }
    );
    await expect(createSystemTask(failing.db, INPUT)).rejects.toThrow(
      /reading the existing task failed \(57014\)/
    );
  });
});

describe('resolveTaskOwner', () => {
  const world = () =>
    fakeDb({
      profiles: [
        {
          user_id: 'agent-1',
          account_id: A,
          account_role: 'agent',
          deactivated_at: null,
        },
        {
          user_id: 'lead-2',
          account_id: A,
          account_role: 'team_leader',
          deactivated_at: null,
        },
        {
          user_id: 'viewer-3',
          account_id: A,
          account_role: 'viewer',
          deactivated_at: null,
        },
        {
          user_id: 'gone-4',
          account_id: A,
          account_role: 'agent',
          deactivated_at: '2026-10-01T00:00:00Z',
        },
        {
          user_id: 'other-5',
          account_id: B,
          account_role: 'admin',
          deactivated_at: null,
        },
        {
          user_id: 'guest-6',
          account_id: A,
          account_role: 'bank_guest',
          deactivated_at: null,
        },
      ],
      conversations: [
        {
          id: 'conv-1',
          account_id: A,
          assigned_agent_id: 'agent-1',
          contact_id: 'contact-1',
        },
        {
          id: 'conv-2',
          account_id: A,
          assigned_agent_id: null,
          contact_id: 'contact-1',
        },
        {
          id: 'conv-3',
          account_id: A,
          assigned_agent_id: 'viewer-3',
          contact_id: 'contact-1',
        },
        {
          id: 'conv-4',
          account_id: A,
          assigned_agent_id: 'gone-4',
          contact_id: 'contact-2',
        },
        {
          id: 'conv-5',
          account_id: A,
          assigned_agent_id: 'guest-6',
          contact_id: 'contact-1',
        },
        {
          id: 'conv-b',
          account_id: B,
          assigned_agent_id: 'other-5',
          contact_id: 'contact-1',
        },
      ],
      contacts: [
        { id: 'contact-1', account_id: A, user_id: 'lead-2' },
        { id: 'contact-2', account_id: A, user_id: 'gone-4' },
        { id: 'contact-3', account_id: A, user_id: 'other-5' },
        { id: 'contact-4', account_id: A, user_id: 'agent-1' },
      ],
    });

  it('prefers the person the chat is assigned to', async () => {
    expect(
      await resolveTaskOwner(world().db, A, { conversationId: 'conv-1' })
    ).toBe('agent-1');
  });

  it("falls back to the owner of the chat's contact", async () => {
    expect(
      await resolveTaskOwner(world().db, A, { conversationId: 'conv-2' })
    ).toBe('lead-2');
  });

  it("takes an explicit contactId over the chat's contact", async () => {
    expect(
      await resolveTaskOwner(world().db, A, {
        conversationId: 'conv-2',
        contactId: 'contact-4',
      })
    ).toBe('agent-1');
  });

  it('skips an assignee who is a viewer', async () => {
    expect(
      await resolveTaskOwner(world().db, A, { conversationId: 'conv-3' })
    ).toBe('lead-2');
  });

  it('skips a role outside the staff list, however the ladder ranks it', async () => {
    expect(
      await resolveTaskOwner(world().db, A, { conversationId: 'conv-5' })
    ).toBe('lead-2');
  });

  it('answers null when everyone found is deactivated', async () => {
    expect(
      await resolveTaskOwner(world().db, A, { conversationId: 'conv-4' })
    ).toBeNull();
  });

  it("never picks a person of another account, or reads another account's chat", async () => {
    const { db } = world();
    expect(
      await resolveTaskOwner(db, A, { contactId: 'contact-3' })
    ).toBeNull();
    expect(
      await resolveTaskOwner(db, A, { conversationId: 'conv-b' })
    ).toBeNull();
  });

  it('answers null without a query when nothing is linked', async () => {
    const { db, ops } = world();
    expect(await resolveTaskOwner(db, A, {})).toBeNull();
    expect(ops).toEqual([]);
  });

  it('throws when a read fails', async () => {
    const conv = fakeDb(
      {},
      { 'conversations.select': { code: '57014', message: 'timeout' } }
    );
    await expect(
      resolveTaskOwner(conv.db, A, { conversationId: 'conv-1' })
    ).rejects.toThrow(/reading the conversation failed/);
    const profiles = fakeDb(
      { contacts: [{ id: 'contact-1', account_id: A, user_id: 'lead-2' }] },
      { 'profiles.select': { code: '57014', message: 'timeout' } }
    );
    await expect(
      resolveTaskOwner(profiles.db, A, { contactId: 'contact-1' })
    ).rejects.toThrow(/reading profiles failed/);
  });
});

describe('closeSystemTasks', () => {
  it('closes only the open task holding the key, in this account', async () => {
    const { db, tables } = fakeDb({
      tasks: [
        {
          id: 't1',
          account_id: A,
          source: 'pbx',
          source_ref: 'call-1',
          status: 'open',
        },
        {
          id: 't2',
          account_id: B,
          source: 'pbx',
          source_ref: 'call-1',
          status: 'open',
        },
        {
          id: 't3',
          account_id: A,
          source: 'journey',
          source_ref: 'call-1',
          status: 'open',
        },
        {
          id: 't4',
          account_id: A,
          source: 'pbx',
          source_ref: 'call-2',
          status: 'open',
        },
      ],
    });
    expect(
      await closeSystemTasks(db, {
        accountId: A,
        source: 'pbx',
        sourceRef: 'call-1',
      })
    ).toBe(1);
    expect(tables.tasks.map((t) => t.status)).toEqual([
      'done',
      'open',
      'open',
      'open',
    ]);
  });

  it('leaves a task a person already finished or cancelled alone', async () => {
    const { db, tables } = fakeDb({
      tasks: [
        {
          id: 't1',
          account_id: A,
          source: 'pbx',
          source_ref: 'call-1',
          status: 'cancelled',
        },
      ],
    });
    expect(
      await closeSystemTasks(db, {
        accountId: A,
        source: 'pbx',
        sourceRef: 'call-1',
      })
    ).toBe(0);
    expect(tables.tasks[0].status).toBe('cancelled');
  });

  it('throws when the update fails', async () => {
    const { db } = fakeDb(
      { tasks: [] },
      { 'tasks.update': { code: '42P01', message: 'no table' } }
    );
    await expect(
      closeSystemTasks(db, { accountId: A, source: 'pbx', sourceRef: 'call-1' })
    ).rejects.toThrow('closeSystemTasks: update failed (42P01): no table');
  });
});
