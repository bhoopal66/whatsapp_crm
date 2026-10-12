import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Reply } from '@/lib/journeys/host/fake-db';

const h = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: { message: string; status?: number }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
}));

import { GET } from './route';

function setup(...replies: Reply[]) {
  const { db, queries } = fakeDb(...replies);
  h.requireRole.mockResolvedValue({
    supabase: db,
    userId: 'user-1',
    accountId: 'acc-1',
    role: 'viewer',
  });
  return queries;
}

const get = (qs = '') => GET(new Request(`http://localhost/api/journeys${qs}`));

describe('GET /api/journeys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the visible files, open first, with the contact', async () => {
    const queries = setup({
      data: [
        {
          id: 'f1',
          contact_id: 'c1',
          conversation_id: 'v1',
          state: 'PARKED',
          product: 'POS',
          entry: 'INBOUND',
          outcome: { kind: 'PARKED', reason: 'NO_RESPONSE' },
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
          closed_at: null,
          contact: { name: 'Mona', phone: '+971501234567' },
        },
      ],
    });
    const res = await get('?state=PARKED&product=POS&limit=20');
    expect(res.status).toBe(200);
    expect(h.requireRole).toHaveBeenCalledWith('viewer');
    expect(await res.json()).toEqual({
      journeys: [
        {
          id: 'f1',
          contactId: 'c1',
          contactName: 'Mona',
          contactPhone: '+971501234567',
          conversationId: 'v1',
          state: 'PARKED',
          product: 'POS',
          entry: 'INBOUND',
          outcome: { kind: 'PARKED', reason: 'NO_RESPONSE' },
          open: true,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-02T00:00:00Z',
          closedAt: null,
        },
      ],
    });
    expect(queries[0]).toEqual(
      expect.arrayContaining([
        ['from', 'journey_files'],
        ['eq', 'account_id', 'acc-1'],
        ['eq', 'state', 'PARKED'],
        ['eq', 'product', 'POS'],
        ['order', 'closed_at', { ascending: false, nullsFirst: true }],
        ['order', 'updated_at', { ascending: false }],
        ['limit', 20],
      ])
    );
  });

  it('defaults to 50 rows and no filters', async () => {
    const queries = setup({ data: [] });
    expect(await (await get()).json()).toEqual({ journeys: [] });
    expect(queries[0]).toContainEqual(['limit', 50]);
    expect(queries[0].filter((c) => c[0] === 'eq')).toHaveLength(1);
  });

  it.each([
    '?state=NOPE',
    '?product=CARD',
    '?limit=0',
    '?limit=201',
    '?limit=x',
  ])('answers 400 for %s', async (qs) => {
    const queries = setup();
    expect((await get(qs)).status).toBe(400);
    expect(queries).toEqual([]);
  });
});
