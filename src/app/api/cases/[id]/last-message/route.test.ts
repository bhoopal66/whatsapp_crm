import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  store: { get: vi.fn(), role: vi.fn() },
  conv: { data: null as unknown, error: null as unknown },
  msg: { data: null as unknown, error: null as unknown },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({ caseStore: () => m.store }));

import { GET } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const chain = (answer: () => unknown) => {
  const q: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'is', 'order', 'limit']) q[k] = () => q;
  q.maybeSingle = async () => answer();
  return q;
};

beforeEach(() => {
  m.conv = { data: { id: 'conv-1' }, error: null };
  m.msg = {
    data: {
      content_text: '  Hello   there ',
      created_at: '2026-11-01T10:00:00Z',
    },
    error: null,
  };
  m.getCurrentAccount.mockResolvedValue({
    accountId: 'a1',
    userId: 'u1',
    role: 'agent',
    department: 'sales',
    supabase: {
      from: (t: string) =>
        chain(() => (t === 'conversations' ? m.conv : m.msg)),
    },
  });
  m.store.get.mockResolvedValue({ id: ID, accountId: 'a1', contactId: 'k1' });
  m.store.role.mockResolvedValue('agent');
});

const call = () =>
  GET(new Request('http://x'), { params: Promise.resolve({ id: ID }) });

describe('GET /api/cases/[id]/last-message', () => {
  it("answers the customer's last message with the chat id", async () => {
    const res = await call();
    expect(await res.json()).toEqual({
      message: {
        conversationId: 'conv-1',
        text: 'Hello there',
        at: '2026-11-01T10:00:00Z',
      },
    });
  });
  it('answers null when the caller cannot see a chat', async () => {
    m.conv = { data: null, error: null };
    expect(await (await call()).json()).toEqual({ message: null });
  });
  it('answers null for a case with no contact', async () => {
    m.store.get.mockResolvedValue({ id: ID, accountId: 'a1', contactId: null });
    expect(await (await call()).json()).toEqual({ message: null });
  });
  it('is 404 when the caller has no role on the case', async () => {
    m.store.role.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
