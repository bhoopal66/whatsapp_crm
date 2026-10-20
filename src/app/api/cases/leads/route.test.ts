import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  openLead: vi.fn(),
  listForContact: vi.fn(),
  role: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: m.requireRole,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({
    openLead: m.openLead,
    listForContact: m.listForContact,
    role: m.role,
  }),
}));

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { CaseRefusedError } from '@/lib/cases/store';
import { GET, POST } from './route';

const CONTACT = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const ctx = { userId: 'u-me', accountId: 'acct-1', role: 'agent' };

beforeEach(() => {
  vi.clearAllMocks();
  m.requireRole.mockResolvedValue(ctx);
  m.openLead.mockResolvedValue('lead-1');
});

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/cases/leads', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
const valid = { contactId: CONTACT, bankCode: 'ADCB', product: 'Mortgage' };

describe('POST /api/cases/leads', () => {
  it('is 401 unauthenticated and 403 for a viewer / bank guest', async () => {
    m.requireRole.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post(valid)).status).toBe(401);
    m.requireRole.mockRejectedValueOnce(new ForbiddenError());
    expect((await post(valid)).status).toBe(403);
    expect(m.requireRole).toHaveBeenCalledWith('agent');
    expect(m.openLead).not.toHaveBeenCalled();
  });

  it('takes the actor from the session, ignoring a body actor', async () => {
    const res = await post({ ...valid, actor: 'u-evil', accountId: 'acct-2' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'lead-1' });
    expect(m.openLead).toHaveBeenCalledWith({
      actor: 'u-me',
      accountId: 'acct-1',
      contactId: CONTACT,
      bankCode: 'ADCB',
      product: 'Mortgage',
      agentId: 'u-me',
      amount: null,
      coordinatorId: null,
      leadSource: null,
    });
  });

  it('passes an explicit agent, coordinator, source and amount', async () => {
    await post({
      ...valid,
      agentId: AGENT,
      coordinatorId: AGENT,
      leadSource: ' walk-in ',
      amount: '12.50',
    });
    expect(m.openLead).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        coordinatorId: AGENT,
        leadSource: 'walk-in',
        amount: '12.50',
      })
    );
  });

  it.each([
    ['amount 1e3', { amount: '1e3' }],
    ['negative amount', { amount: '-5' }],
    ['three decimals', { amount: '1.234' }],
    ['bad contact uuid', { contactId: 'x' }],
    ['bad agent uuid', { agentId: 'x' }],
    ['no bank', { bankCode: undefined }],
    ['no product', { product: ' ' }],
    ['long source', { leadSource: 'x'.repeat(201) }],
  ])('refuses %s with 400 and opens nothing', async (_n, over) => {
    const res = await post({ ...valid, ...over });
    expect(res.status).toBe(400);
    expect(m.openLead).not.toHaveBeenCalled();
  });

  it('maps LEAD_EXISTS / CASE_EXISTS to 409 and other refusals to 422', async () => {
    m.openLead.mockRejectedValueOnce(new CaseRefusedError('LEAD_EXISTS'));
    const a = await post(valid);
    expect(a.status).toBe(409);
    expect(await a.json()).toMatchObject({ code: 'LEAD_EXISTS' });
    m.openLead.mockRejectedValueOnce(new CaseRefusedError('CASE_EXISTS'));
    expect((await post(valid)).status).toBe(409);
    m.openLead.mockRejectedValueOnce(new CaseRefusedError('BANK_UNKNOWN'));
    expect((await post(valid)).status).toBe(422);
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
