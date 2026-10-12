import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { TASK_COLUMNS } from '@/lib/tasks/types';

import { DELETE, PATCH } from './route';

const ACCOUNT = 'account-1';
const ID = '6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b';
const params = { params: Promise.resolve({ id: ID }) };
const badParams = { params: Promise.resolve({ id: 'not-a-task' }) };

/** A chainable query builder that records its calls and resolves `result`. */
function query(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'update', 'delete']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return { builder, calls };
}

function signIn(result: { data: unknown; error: unknown }) {
  const q = query(result);
  const from = vi.fn(() => q.builder);
  mocks.requireRole.mockResolvedValue({
    supabase: { from },
    accountId: ACCOUNT,
    userId: 'user-1',
    role: 'agent',
  });
  return { ...q, from };
}

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

describe('PATCH /api/tasks/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates the columns sent, in the caller account', async () => {
    const q = signIn({ data: { id: ID, status: 'done' }, error: null });
    const res = await PATCH(
      request({ status: 'done', assignedTo: null }),
      params
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task: { id: ID, status: 'done' } });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(q.from).toHaveBeenCalledWith('tasks');
    expect(q.calls).toEqual([
      ['update', [{ status: 'done', assigned_to: null }]],
      ['eq', ['account_id', ACCOUNT]],
      ['eq', ['id', ID]],
      ['select', [TASK_COLUMNS]],
    ]);
  });

  it('refuses a bad id or an empty patch before writing', async () => {
    const q = signIn({ data: null, error: null });
    let res = await PATCH(request({ status: 'done' }), badParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid task id' });
    res = await PATCH(request({ colour: 'red' }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Nothing to update' });
    expect(q.from).not.toHaveBeenCalled();
  });

  it("answers 404 when no row was updated (gone, or not the caller's)", async () => {
    signIn({ data: null, error: null });
    const res = await PATCH(request({ status: 'done' }), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
  });

  it('maps an RLS refusal to 403 and a trigger refusal to 400', async () => {
    signIn({ data: null, error: { code: '42501', message: 'policy' } });
    let res = await PATCH(request({ assignedTo: ID }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "You can't make that change to this task",
    });

    signIn({
      data: null,
      error: { code: '23514', message: 'That person cannot be assigned tasks' },
    });
    res = await PATCH(request({ assignedTo: ID }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'That person cannot be assigned tasks',
    });
  });

  it('passes a role refusal through', async () => {
    mocks.requireRole.mockRejectedValue(new Error('Insufficient role'));
    const res = await PATCH(request({ status: 'done' }), params);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/tasks/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes the task in the caller account', async () => {
    const q = signIn({ data: [{ id: ID }], error: null });
    const res = await DELETE(request(null), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(q.calls).toEqual([
      ['delete', []],
      ['eq', ['account_id', ACCOUNT]],
      ['eq', ['id', ID]],
      ['select', ['id']],
    ]);
  });

  it('answers 404 when nothing was deleted', async () => {
    signIn({ data: [], error: null });
    const res = await DELETE(request(null), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Task not found' });
  });

  it('refuses a bad id before deleting', async () => {
    const q = signIn({ data: [], error: null });
    const res = await DELETE(request(null), badParams);
    expect(res.status).toBe(400);
    expect(q.from).not.toHaveBeenCalled();
  });

  it('maps an RLS refusal to 403', async () => {
    signIn({ data: null, error: { code: '42501', message: 'policy' } });
    const res = await DELETE(request(null), params);
    expect(res.status).toBe(403);
  });
});
