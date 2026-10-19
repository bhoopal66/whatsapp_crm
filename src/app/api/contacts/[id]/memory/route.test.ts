import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  addStaffMemory: vi.fn(),
  deps: { deps: true },
  contact: null as Record<string, unknown> | null,
  contactError: null as { code: string } | null,
  eq: vi.fn(),
  memory: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/memory/server', () => ({
  memoryStore: () => m.memory,
  staffMemoryDeps: () => m.deps,
}));
vi.mock('@/lib/memory/staff', () => ({ addStaffMemory: m.addStaffMemory }));

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
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

const asRole = (role: string) =>
  m.getCurrentAccount.mockResolvedValue({
    supabase,
    userId: 'u-me',
    accountId: 'acct-1',
    role,
  });

beforeEach(() => {
  vi.clearAllMocks();
  asRole('agent');
  m.contact = { id: ID, account_id: 'acct-1' };
  m.contactError = null;
  m.memory = {
    list: vi.fn(async () => []),
    recall: vi.fn(async () => []),
    canRead: vi.fn(async () => true),
    forget: vi.fn(async () => 3),
  };
  m.addStaffMemory.mockResolvedValue({
    ok: true,
    id: 'mem-1',
    deduped: false,
    evicted: 0,
    trust: 'verified',
    importance: 3,
  });
});

const p = (id = ID) => ({ params: Promise.resolve({ id }) });

import { GET, POST } from './route';

const get = (q = '', id = ID) =>
  GET(new Request(`http://x/api/contacts/${id}/memory${q}`), p(id));
const post = (body: unknown, id = ID) =>
  POST(
    new Request(`http://x/api/contacts/${id}/memory`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    p(id)
  );

describe('GET /api/contacts/[id]/memory', () => {
  it('loads the contact with the caller RLS client', async () => {
    await get();
    expect(m.eq).toHaveBeenCalledWith('contacts', 'id, account_id', 'id', ID);
  });

  it('is 404 when the contact is not visible, another account or not a uuid — no memory call', async () => {
    m.contact = null;
    expect((await get()).status).toBe(404);
    m.contact = { id: ID, account_id: 'acct-2' };
    expect((await get()).status).toBe(404);
    m.contact = { id: ID, account_id: 'acct-1' };
    expect((await get('', 'nope')).status).toBe(404);
    expect(m.memory.list).not.toHaveBeenCalled();
    expect(m.memory.recall).not.toHaveBeenCalled();
  });

  it('lists the contact scope with limit and before', async () => {
    m.memory.list.mockResolvedValue([{ id: 'mem-1' }]);
    const res = await get('?limit=10&before=2026-10-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ items: [{ id: 'mem-1' }] });
    expect(m.memory.list).toHaveBeenCalledWith('u-me', 'acct-1', SCOPE, {
      limit: 10,
      before: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('is 400 when q is in the URL: search is a POST', async () => {
    for (const q of ['?q=784-1990-1234567-1', '?q=', '?limit=5&q=salary']) {
      const res = await get(q);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Search with POST' });
    }
    expect(m.memory.recall).not.toHaveBeenCalled();
    expect(m.memory.list).not.toHaveBeenCalled();
  });

  it('is 400 for a bad limit or before', async () => {
    expect((await get('?limit=0')).status).toBe(400);
    expect((await get('?limit=201')).status).toBe(400);
    expect((await get('?before=yesterday')).status).toBe(400);
  });

  it('is 500 (no detail) when the contact read fails', async () => {
    m.contactError = { code: '57014' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong' });
    spy.mockRestore();
  });
});

describe('POST /api/contacts/[id]/memory', () => {
  it('is 404 for a contact not visible, without adding', async () => {
    m.contact = null;
    expect((await post({ content: 'x' })).status).toBe(404);
    expect(m.addStaffMemory).not.toHaveBeenCalled();
  });

  it('is 403 for a workspace viewer', async () => {
    asRole('viewer');
    expect((await post({ content: 'x' })).status).toBe(403);
    expect(m.addStaffMemory).not.toHaveBeenCalled();
  });

  it('is 403 for a bank guest, without adding', async () => {
    asRole('bank_guest');
    expect((await post({ content: 'x' })).status).toBe(403);
    expect(m.addStaffMemory).not.toHaveBeenCalled();
  });

  it('is 403 when the caller cannot read the scope', async () => {
    m.memory.canRead.mockResolvedValue(false);
    expect((await post({ content: 'x' })).status).toBe(403);
    expect(m.memory.canRead).toHaveBeenCalledWith('u-me', 'acct-1', SCOPE);
    expect(m.addStaffMemory).not.toHaveBeenCalled();
  });

  it('adds a staff memory to the contact scope and answers 201', async () => {
    const res = await post({
      content: 'Prefers calls after 4pm',
      kind: 'preference',
      importance: 4,
      supersedes: OTHER,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ itemId: 'mem-1', deduped: false });
    expect(m.addStaffMemory).toHaveBeenCalledWith(m.deps, {
      accountId: 'acct-1',
      userId: 'u-me',
      scope: SCOPE,
      content: 'Prefers calls after 4pm',
      kind: 'preference',
      importance: 4,
      supersedes: OTHER,
    });
  });

  it('is 400 for a bad body', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ content: 'x', kind: 'gossip' })).status).toBe(400);
    expect((await post({ content: 'x', importance: 6 })).status).toBe(400);
    expect((await post({ content: 'x', supersedes: 'nope' })).status).toBe(400);
    expect(m.addStaffMemory).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, refused: 'TOKENIZE_FAILED' }, 'TOKENIZE_FAILED'],
    [{ ok: false, refused: 'EMPTY', reason: 'r' }, 'EMPTY'],
    [{ ok: false, refused: 'TOO_LONG', reason: 'r' }, 'TOO_LONG'],
    [
      { ok: false, refused: 'SUPERSEDE_VERIFIED', reason: 'r' },
      'SUPERSEDE_VERIFIED',
    ],
    [{ ok: false, refused: true, reason: 'r' }, 'REDACTION_REFUSED'],
  ])('maps a refusal to 422 %#', async (result, code) => {
    m.addStaffMemory.mockResolvedValue(result);
    const res = await post({ content: 'x' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code });
  });
});
