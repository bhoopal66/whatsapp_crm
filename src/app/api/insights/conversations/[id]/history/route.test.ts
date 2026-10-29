import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

const CONV = '6f1c2a34-1b2c-4d5e-8f90-123456789abc';

type Result = { data: unknown; error: { message: string } | null };

/** A PostgREST stand-in: one result per table, every call recorded. */
function fakeDb(results: Record<string, Result>) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'order', 'limit'])
      b[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        return b;
      };
    const result = results[table] ?? { data: null, error: null };
    b.maybeSingle = async () => result;
    b.then = (ok: (r: Result) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(ok, fail);
    return b;
  };
  return { db: { from }, calls };
}

let db: ReturnType<typeof fakeDb>;
function useDb(results: Record<string, Result>) {
  db = fakeDb(results);
  mocks.requireRole.mockResolvedValue({
    supabase: db.db,
    accountId: 'account-1',
    userId: 'user-1',
    role: 'agent',
  });
}

const get = (id = CONV) =>
  GET(
    new Request(`http://localhost/api/insights/conversations/${id}/history`),
    {
      params: Promise.resolve({ id }),
    }
  );

const visible = { data: { id: CONV }, error: null };

beforeEach(() => {
  mocks.requireRole.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/insights/conversations/[id]/history', () => {
  it('returns the newest 30 events, newest first, through the RLS client', async () => {
    useDb({
      conversations: visible,
      conversation_insight_events: {
        data: [
          { message_at: '2026-10-29T10:00:00Z', figures: { sentiment: 3 } },
          { message_at: '2026-10-29T09:00:00Z', figures: null },
        ],
        error: null,
      },
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
    expect(await res.json()).toEqual({
      events: [
        { at: '2026-10-29T10:00:00Z', figures: { sentiment: 3 } },
        { at: '2026-10-29T09:00:00Z', figures: {} },
      ],
    });
    const ev = db.calls.filter(
      (c) => c.table === 'conversation_insight_events'
    );
    expect(ev).toContainEqual({
      table: 'conversation_insight_events',
      op: 'eq',
      args: ['conversation_id', CONV],
    });
    expect(ev).toContainEqual({
      table: 'conversation_insight_events',
      op: 'eq',
      args: ['account_id', 'account-1'],
    });
    expect(ev).toContainEqual({
      table: 'conversation_insight_events',
      op: 'order',
      args: ['message_at', { ascending: false }],
    });
    expect(ev).toContainEqual({
      table: 'conversation_insight_events',
      op: 'limit',
      args: [30],
    });
  });

  it('answers an empty list for a visible chat never judged', async () => {
    useDb({
      conversations: visible,
      conversation_insight_events: { data: [], error: null },
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });

  it('answers 404 when the caller cannot see the chat, before reading events', async () => {
    useDb({ conversations: { data: null, error: null } });
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(
      db.calls.some((c) => c.table === 'conversation_insight_events')
    ).toBe(false);
    expect(db.calls).toContainEqual({
      table: 'conversations',
      op: 'eq',
      args: ['account_id', 'account-1'],
    });
  });

  it('rejects an id that is not a UUID', async () => {
    useDb({ conversations: visible });
    const res = await get('not-a-uuid');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid id' });
    expect(db.calls).toEqual([]);
  });

  it('answers 500 { error } when a read fails', async () => {
    useDb({ conversations: { data: null, error: { message: 'boom' } } });
    expect((await get()).status).toBe(500);
    useDb({
      conversations: visible,
      conversation_insight_events: { data: null, error: { message: 'boom' } },
    });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Failed to load the insight history',
    });
  });

  it('passes an auth failure (a bank guest) through toErrorResponse', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await get();
    expect(res.status).toBe(403);
  });
});
