import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  listForContact: vi.fn(),
  role: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: m.requireRole,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({
    listForContact: m.listForContact,
    role: m.role,
  }),
}));

import { ForbiddenError } from '@/lib/auth/account';
import * as route from './route';

const { GET } = route;

const CONTACT = '22222222-2222-4222-8222-222222222222';
const ctx = { userId: 'u-me', accountId: 'acct-1', role: 'agent' };

beforeEach(() => {
  vi.clearAllMocks();
  m.requireRole.mockResolvedValue(ctx);
});

// Cases come only from the submission tracker: nobody opens a lead here.
describe('POST /api/cases/leads', () => {
  it('does not exist, so Next answers 405', () => {
    expect('POST' in route).toBe(false);
  });
});

describe('GET /api/cases/leads', () => {
  const get = (qs: string) =>
    GET(new Request(`http://x/api/cases/leads?${qs}`));
  const row = (id: string, over: object = {}) => ({
    id,
    stage: 'Interested',
    bankCode: 'ADCB',
    product: 'Mortgage',
    amount: '100.00',
    isLead: true,
    openedAt: new Date('2026-10-20T08:00:00Z'),
    closedAt: null,
    ...over,
  });

  it('is 403 for a viewer and 400 for a bad contactId', async () => {
    m.requireRole.mockRejectedValueOnce(new ForbiddenError());
    expect((await get(`contactId=${CONTACT}`)).status).toBe(403);
    expect((await get('contactId=x')).status).toBe(400);
    expect((await get('')).status).toBe(400);
    expect(m.listForContact).not.toHaveBeenCalled();
  });

  it('keeps only the cases the caller may read, no-store', async () => {
    m.listForContact.mockResolvedValue([row('c1'), row('c2'), row('c3')]);
    m.role.mockImplementation(async (id: string) =>
      id === 'c2' ? null : 'agent'
    );
    const res = await get(`contactId=${CONTACT}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(m.listForContact).toHaveBeenCalledWith('acct-1', CONTACT);
    expect(m.role).toHaveBeenCalledWith('c1', 'u-me');
    const body = await res.json();
    expect(body.cases.map((c: { id: string }) => c.id)).toEqual(['c1', 'c3']);
    expect(body.cases[0]).toMatchObject({
      stage: 'Interested',
      amount: '100.00',
      isLead: true,
      closedAt: null,
    });
  });
});
