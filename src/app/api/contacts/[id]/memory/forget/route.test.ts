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

import { POST } from './route';

const post = (body: unknown, id = ID) =>
  POST(
    new Request(`http://x/api/contacts/${id}/memory/forget`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    p(id)
  );

describe('POST /api/contacts/[id]/memory/forget', () => {
  it('is 404 for a contact not visible, without forgetting', async () => {
    asRole('admin');
    m.contact = { id: ID, account_id: 'acct-2' };
    expect((await post({ reason: 'privacy request' })).status).toBe(404);
    expect(m.memory.forget).not.toHaveBeenCalled();
  });

  it('is 403 for an agent and a team leader', async () => {
    for (const role of ['agent', 'team_leader']) {
      asRole(role);
      expect((await post({ reason: 'privacy request' })).status).toBe(403);
    }
    expect(m.memory.forget).not.toHaveBeenCalled();
  });

  it('forgets the contact scope for an owner / admin', async () => {
    for (const role of ['owner', 'admin']) {
      asRole(role);
      const res = await post({ reason: 'privacy request' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ erased: 3 });
    }
    expect(m.memory.forget).toHaveBeenCalledWith(
      'u-me',
      'acct-1',
      SCOPE,
      'privacy request'
    );
  });

  it('is 400 without a reason, or when the store rejects it', async () => {
    asRole('admin');
    expect((await post({})).status).toBe(400);
    m.memory.forget.mockImplementation(async () => {
      throw new RangeError('blank');
    });
    expect((await post({ reason: ' ' })).status).toBe(400);
  });
});
