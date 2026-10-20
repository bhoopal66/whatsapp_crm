import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { GET } from './route';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

function client(role: string) {
  const tables: Record<string, unknown[]> = {
    coordinator_banks: [
      { user_id: U1, bank_code: 'ADCB' },
      { user_id: U1, bank_code: 'FAB' },
      { user_id: U2, bank_code: 'FAB' },
    ],
    profiles: [
      { user_id: U1, full_name: 'One', email: 'one@x.ae' },
      { user_id: U2, full_name: 'Two', email: 'two@x.ae' },
    ],
  };
  mocks.requireRole.mockResolvedValue({
    supabase: {
      from: (t: string) => {
        const q: Record<string, unknown> = {};
        const done = Promise.resolve({ data: tables[t], error: null });
        for (const m of ['select', 'eq', 'is', 'in']) q[m] = () => q;
        q.order = () => done;
        q.then = done.then.bind(done);
        return q;
      },
    },
    accountId: 'a',
    userId: 'u',
    role,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/coordinators', () => {
  it('rejects an invalid bank filter', async () => {
    client('agent');
    const res = await GET(
      new Request('http://localhost/api/coordinators?bank=x')
    );
    expect(res.status).toBe(400);
  });

  it('lists coordinators with banks and hides email from agents', async () => {
    client('agent');
    const res = await GET(new Request('http://localhost/api/coordinators'));
    const { coordinators } = await res.json();
    expect(coordinators).toHaveLength(2);
    expect(coordinators[0]).toEqual({
      user_id: U1,
      name: 'One',
      banks: ['ADCB', 'FAB'],
    });
  });

  it('shows email to admins', async () => {
    client('admin');
    const { coordinators } = await (
      await GET(new Request('http://localhost/api/coordinators'))
    ).json();
    expect(coordinators[0].email).toBe('one@x.ae');
  });
});
