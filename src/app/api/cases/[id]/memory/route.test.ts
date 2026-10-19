import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  addStaffMemory: vi.fn(),
  deps: { deps: true },
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
  memory: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({ caseStore: () => m.store }));
vi.mock('@/lib/memory/server', () => ({
  memoryStore: () => m.memory,
  staffMemoryDeps: () => m.deps,
}));
vi.mock('@/lib/memory/staff', () => ({ addStaffMemory: m.addStaffMemory }));

import { GET, POST } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SCOPE = { type: 'case', id: ID };

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
  m.store = {
    get: vi.fn(async () => ({ id: ID, accountId: 'acct-1' })),
    role: vi.fn(async () => 'agent'),
  };
  m.memory = { list: vi.fn(async () => []), recall: vi.fn(async () => []) };
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
const get = (q = '', id = ID) =>
  GET(new Request(`http://x/api/cases/${id}/memory${q}`), p(id));
const post = (body: unknown, id = ID) =>
  POST(
    new Request(`http://x/api/cases/${id}/memory`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    p(id)
  );

describe('GET /api/cases/[id]/memory', () => {
  it('is 404 for another account (no role call) and for no role', async () => {
    m.store.get.mockResolvedValue({ id: ID, accountId: 'acct-2' });
    expect((await get()).status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    m.store.get.mockResolvedValue({ id: ID, accountId: 'acct-1' });
    m.store.role.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(m.memory.list).not.toHaveBeenCalled();
  });

  it('lists the case scope with limit and before', async () => {
    m.memory.list.mockResolvedValue([{ id: 'mem-1' }]);
    const res = await get('?limit=10&before=2026-10-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: 'mem-1' }] });
    expect(m.memory.list).toHaveBeenCalledWith('u-me', 'acct-1', SCOPE, {
      limit: 10,
      before: new Date('2026-10-01T00:00:00Z'),
    });
    await get();
    expect(m.memory.list.mock.calls[1][3]).toEqual({
      limit: undefined,
      before: null,
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
});

describe('POST /api/cases/[id]/memory', () => {
  it('is 404 for another account and for no role, without adding', async () => {
    m.store.get.mockResolvedValue({ id: ID, accountId: 'acct-2' });
    expect((await post({ content: 'x' })).status).toBe(404);
    m.store.get.mockResolvedValue({ id: ID, accountId: 'acct-1' });
    m.store.role.mockResolvedValue(null);
    expect((await post({ content: 'x' })).status).toBe(404);
    expect(m.addStaffMemory).not.toHaveBeenCalled();
  });

  it('is 403 for a workspace viewer, even with a case role', async () => {
    m.getCurrentAccount.mockResolvedValue({
      userId: 'u-me',
      accountId: 'acct-1',
      role: 'viewer',
    });
    expect((await post({ content: 'x' })).status).toBe(403);
    expect(m.addStaffMemory).not.toHaveBeenCalled();
  });

  it('adds a staff memory to the case scope and answers 201', async () => {
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
