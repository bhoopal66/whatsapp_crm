import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  list: vi.fn(),
  add: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
  caseBankContactsStore: () => ({ list: m.list, add: m.add }),
}));

import { CaseRefusedError } from '@/lib/cases/store';

import { GET, POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const params = () => ({ params: Promise.resolve({ id: C }) });
const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params()
  );
const valid = {
  contact_name: 'Rana (ADCB)',
  contacted_at: '2026-10-19T08:00:00Z',
  summary: 'Asked for the salary letter',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
  m.role.mockResolvedValue('team_lead');
  m.list.mockResolvedValue([{ id: 'b1' }]);
  m.add.mockResolvedValue('b2');
});

describe('bank contacts', () => {
  it('lists the contacts', async () => {
    const res = await GET(new Request('http://x'), params());
    expect(await res.json()).toEqual({ contacts: [{ id: 'b1' }] });
  });

  it('adds a contact as the caller', async () => {
    const res = await post({
      ...valid,
      next_action: 'Chase Thursday',
      next_action_at: '2026-10-22T08:00:00Z',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'b2' });
    expect(m.add).toHaveBeenCalledWith({
      caseId: C,
      actor: 'u-1',
      contactName: 'Rana (ADCB)',
      contactedAt: new Date('2026-10-19T08:00:00Z'),
      summary: 'Asked for the salary letter',
      nextAction: 'Chase Thursday',
      nextActionAt: new Date('2026-10-22T08:00:00Z'),
    });
  });

  it('answers 400 for missing fields, bad dates and the caps', async () => {
    for (const body of [
      { ...valid, contact_name: '' },
      { ...valid, contacted_at: 'yesterday' },
      { ...valid, summary: undefined },
      { ...valid, contact_name: 'x'.repeat(201) },
      { ...valid, summary: 'x'.repeat(4001) },
      { ...valid, next_action: 'x'.repeat(4001) },
      { ...valid, next_action_at: 'later' },
    ])
      expect((await post(body)).status).toBe(400);
    expect(m.add).not.toHaveBeenCalled();
  });

  it("answers 404 for another account's case and role null", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await post(valid)).status).toBe(404);
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
    m.role.mockResolvedValue(null);
    expect((await post(valid)).status).toBe(404);
    expect(m.add).not.toHaveBeenCalled();
  });

  it('maps refusals', async () => {
    m.add.mockRejectedValue(new CaseRefusedError('CONTACT_INCOMPLETE'));
    const res = await post(valid);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CONTACT_INCOMPLETE');
  });
});
