import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forbidden, unauthorized } from '@/lib/api/v1/respond';

const m = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  rows: [] as unknown[],
  eq: vi.fn(),
  order: vi.fn(),
}));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: m.requireApiKey }));

import { GET } from './route';

const get = (qs: string) =>
  GET(new Request(`http://x/api/v1/case-documents${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [
    {
      doc_key: 'eid',
      label: 'Emirates ID',
      position: 1,
      product: 'Personal loan',
    },
    {
      doc_key: 'sal',
      label: 'Salary cert',
      position: 2,
      product: ' PERSONAL LOAN ',
    },
    { doc_key: 'mtg', label: 'Title deed', position: 1, product: 'Mortgage' },
  ];
  const q = {
    select: () => q,
    eq: (...a: unknown[]) => (m.eq(...a), q),
    order: async (...a: unknown[]) => (
      m.order(...a),
      { data: m.rows, error: null }
    ),
  };
  m.requireApiKey.mockResolvedValue({
    accountId: 'acct-1',
    supabase: { from: () => q },
  });
});

describe('GET /api/v1/case-documents', () => {
  it('answers 401 and 403 from the key check, asking for the read scope', async () => {
    m.requireApiKey.mockRejectedValueOnce(unauthorized());
    expect((await get('?bank=FAB&product=x')).status).toBe(401);
    m.requireApiKey.mockRejectedValueOnce(forbidden('scope'));
    expect((await get('?bank=FAB&product=x')).status).toBe(403);
    expect(m.requireApiKey.mock.calls[0][1]).toBe('submission_groups:read');
  });

  it.each([
    '?product=x',
    '?bank=F&product=x',
    '?bank=FAB',
    '?bank=FAB&product=%20%20',
    `?bank=FAB&product=${'p'.repeat(201)}`,
  ])('refuses %s with 400 bad_request', async (qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('returns the matching items, case-insensitively, scoped to the key account and bank', async () => {
    const res = await get('?bank=fab&product=personal%20loan');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        bank: 'FAB',
        product: 'personal loan',
        items: [
          { key: 'eid', label: 'Emirates ID', position: 1 },
          { key: 'sal', label: 'Salary cert', position: 2 },
        ],
      },
    });
    expect(m.eq).toHaveBeenCalledWith('account_id', 'acct-1');
    expect(m.eq).toHaveBeenCalledWith('bank_code', 'FAB');
    expect(m.order).toHaveBeenCalledWith('position', { ascending: true });
  });
});
