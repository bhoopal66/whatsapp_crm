import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  contact: null as Record<string, unknown> | null,
  contactError: null as { code: string } | null,
  eq: vi.fn(),
  memory: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/memory/server', () => ({ memoryStore: () => m.memory }));

import { POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const SCOPE = { type: 'contact', id: ID };

/** The caller's RLS client: from('contacts').select(...).eq('id', id).maybeSingle(). */
const supabase = {
  from: (table: string) => ({
    select: (cols: string) => ({
      eq: (col: string, v: string) => {
        m.eq(table, cols, col, v);
        return {
          maybeSingle: async () => ({ data: m.contact, error: m.contactError }),
        };
      },
    }),
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    supabase,
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
  m.contact = { id: ID, account_id: 'acct-1' };
  m.contactError = null;
  m.memory = { list: vi.fn(async () => []), recall: vi.fn(async () => []) };
});

const search = (body: unknown, id = ID) =>
  POST(
    new Request(`http://x/api/contacts/${id}/memory/search`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

describe('POST /api/contacts/[id]/memory/search', () => {
  it('loads the contact with the caller RLS client', async () => {
    await search({ q: 'salary' });
    expect(m.eq).toHaveBeenCalledWith('contacts', 'id, account_id', 'id', ID);
  });

  it('is 404 when the contact is not visible, another account or not a uuid — no memory call', async () => {
    m.contact = null;
    expect((await search({ q: 'salary' })).status).toBe(404);
    m.contact = { id: ID, account_id: 'acct-2' };
    expect((await search({ q: 'salary' })).status).toBe(404);
    m.contact = { id: ID, account_id: 'acct-1' };
    expect((await search({ q: 'salary' }, 'nope')).status).toBe(404);
    expect(m.memory.recall).not.toHaveBeenCalled();
  });

  it('searches only the contact scope, without embeddings, never cached', async () => {
    m.memory.recall.mockResolvedValue([
      { id: 'mem-2', embedding: [0.1], rank: 1 },
    ]);
    const res = await search({ q: '  salary ' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ items: [{ id: 'mem-2', rank: 1 }] });
    expect(m.memory.recall).toHaveBeenCalledWith(
      'u-me',
      'acct-1',
      'salary',
      20,
      [SCOPE]
    );
    expect(m.memory.list).not.toHaveBeenCalled();
  });

  it('takes a limit of 1–100', async () => {
    await search({ q: 'salary', limit: 100 });
    await search({ q: 'salary', limit: 1 });
    expect(m.memory.recall.mock.calls.map((c) => c[3])).toEqual([100, 1]);
  });

  it('is 400 for a bad body, without searching', async () => {
    for (const body of [
      'not json',
      [],
      {},
      { q: 7 },
      { q: '   ' },
      { q: 'x'.repeat(501) },
      { q: 'x', limit: 0 },
      { q: 'x', limit: 101 },
      { q: 'x', limit: 2.5 },
      { q: 'x', limit: '10' },
    ])
      expect((await search(body)).status).toBe(400);
    expect(m.memory.recall).not.toHaveBeenCalled();
    expect((await search({ q: 'x'.repeat(500) })).status).toBe(200);
  });

  it('is 500 (no detail) when the contact read fails', async () => {
    m.contactError = { code: '57014' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await search({ q: 'salary' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong' });
    spy.mockRestore();
  });
});
