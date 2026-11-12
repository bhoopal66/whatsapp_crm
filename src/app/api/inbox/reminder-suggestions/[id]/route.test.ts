import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  admin: null as unknown,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => mocks.admin }));

import { POST } from './route';

type Result = { data: unknown; error: unknown };
type Call = { table: string; method: string; args: unknown[] };

/** Chainable supabase-js stand-in: per table, a queue of results. */
function fakeClient(results: Record<string, Result[]>) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const take = () =>
        Promise.resolve(results[table]?.shift() ?? { data: null, error: null });
      for (const method of ['select', 'eq', 'or', 'update']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return builder;
        };
      }
      builder.maybeSingle = () => take();
      return builder;
    },
  };
}

const ACCOUNT = 'account-1';
const ID = '11111111-2222-4333-8444-555555555555';
const CONV = '99999999-2222-4333-8444-555555555555';
const TASK = '77777777-2222-4333-8444-555555555555';
const TABLE = 'message_reminder_suggestions';

function row(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    account_id: ACCOUNT,
    conversation_id: CONV,
    message_id: 'm1',
    side: 'customer',
    kind: 'call',
    due_at: '2026-11-13T11:00:00Z',
    date_only: false,
    phrase: 'tomorrow at 3',
    p: 0.9,
    status: 'open',
    task_id: null,
    acted_by: null,
    acted_at: null,
    created_at: '2026-11-12T08:00:00Z',
    ...over,
  };
}

let scoped: ReturnType<typeof fakeClient>;
let admin: ReturnType<typeof fakeClient>;

function setup({
  reads = [row()] as unknown[],
  task = { id: TASK, conversation_id: CONV } as unknown,
  written = null as unknown,
} = {}) {
  scoped = fakeClient({
    [TABLE]: reads.map((data) => ({ data, error: null })),
    tasks: [{ data: task, error: null }],
  });
  admin = fakeClient({ [TABLE]: [{ data: written, error: null }] });
  mocks.admin = admin;
  mocks.requireRole.mockResolvedValue({
    supabase: scoped,
    accountId: ACCOUNT,
    userId: 'user-1',
    role: 'agent',
  });
}

function post(body: unknown, id = ID) {
  return POST(
    new Request(`http://localhost/api/inbox/reminder-suggestions/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

const adminCalls = (method: string) =>
  admin.calls.filter((c) => c.method === method).map((c) => c.args);

beforeEach(() => {
  mocks.requireRole.mockReset();
});

describe('POST /api/inbox/reminder-suggestions/[id]', () => {
  it('needs an agent', async () => {
    setup();
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await post({ action: 'dismissed' });
    expect(res.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('answers 404 for an id that is not a uuid', async () => {
    setup();
    const res = await post({ action: 'dismissed' }, 'abc');
    expect(res.status).toBe(404);
    expect(scoped.calls).toHaveLength(0);
  });

  it('refuses a bad body', async () => {
    setup();
    const res = await post({ action: 'added', taskId: 'nope' });
    expect(res.status).toBe(400);
    expect(scoped.calls).toHaveLength(0);
    expect(admin.calls).toHaveLength(0);
  });

  it('answers 404 for a suggestion the caller cannot read', async () => {
    setup({ reads: [null] });
    const res = await post({ action: 'dismissed' });
    expect(res.status).toBe(404);
    expect(admin.calls).toHaveLength(0);
  });

  it('answers 404 for a suggestion of another account', async () => {
    setup({ reads: [row({ account_id: 'account-2' })] });
    const res = await post({ action: 'dismissed' });
    expect(res.status).toBe(404);
    expect(admin.calls).toHaveLength(0);
  });

  it('refuses a task on another chat', async () => {
    setup({ task: { id: TASK, conversation_id: 'other-conv' } });
    const res = await post({ action: 'added', taskId: TASK });
    expect(res.status).toBe(400);
    expect(admin.calls).toHaveLength(0);
  });

  it('refuses a task the caller cannot see', async () => {
    setup({ task: null });
    const res = await post({ action: 'added', taskId: TASK });
    expect(res.status).toBe(400);
    expect(admin.calls).toHaveLength(0);
  });

  it('marks it added, compare-and-set on open or a deleted task', async () => {
    const written = row({ status: 'added', task_id: TASK, acted_by: 'user-1' });
    setup({ written });
    const res = await post({ action: 'added', taskId: TASK });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: written });
    const [patch] = adminCalls('update')[0] as [Record<string, unknown>];
    expect(patch).toMatchObject({
      status: 'added',
      task_id: TASK,
      acted_by: 'user-1',
    });
    expect(typeof patch.acted_at).toBe('string');
    expect(adminCalls('eq')).toEqual([
      ['id', ID],
      ['account_id', ACCOUNT],
    ]);
    expect(adminCalls('or')).toEqual([
      ['status.eq.open,and(status.eq.added,task_id.is.null)'],
    ]);
    // The task was read through the caller's client.
    expect(
      scoped.calls.find((c) => c.table === 'tasks' && c.method === 'eq')?.args
    ).toEqual(['id', TASK]);
  });

  it('dismisses with the same predicate', async () => {
    const written = row({ status: 'dismissed', acted_by: 'user-1' });
    setup({ written });
    const res = await post({ action: 'dismissed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: written });
    const [patch] = adminCalls('update')[0] as [Record<string, unknown>];
    expect(patch).toMatchObject({
      status: 'dismissed',
      task_id: null,
      acted_by: 'user-1',
    });
    expect(adminCalls('or')).toEqual([
      ['status.eq.open,and(status.eq.added,task_id.is.null)'],
    ]);
    expect(scoped.calls.some((c) => c.table === 'tasks')).toBe(false);
  });

  it('reopens only from dismissed', async () => {
    const written = row();
    setup({ reads: [row({ status: 'dismissed' })], written });
    const res = await post({ action: 'reopen' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: written });
    expect(adminCalls('update')[0]).toEqual([
      { status: 'open', task_id: null, acted_by: null, acted_at: null },
    ]);
    expect(adminCalls('eq')).toEqual([
      ['id', ID],
      ['account_id', ACCOUNT],
      ['status', 'dismissed'],
    ]);
    expect(adminCalls('or')).toEqual([]);
  });

  for (const [name, body] of [
    ['added', { action: 'added', taskId: TASK }],
    ['dismissed', { action: 'dismissed' }],
    ['reopen', { action: 'reopen' }],
  ] as const) {
    it(`answers 409 with the current row when ${name} loses the race`, async () => {
      const now = row({ status: 'added', task_id: 'someone-else' });
      setup({ reads: [row(), now], written: null });
      const res = await post(body);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.suggestion).toEqual(now);
      expect(typeof json.error).toBe('string');
    });
  }
});
