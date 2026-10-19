import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  setOutcomeReason: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
  bankDashboard: () => ({ setOutcomeReason: m.setOutcomeReason }),
}));

import { BankDashboardRefusedError } from '@/lib/cases/dashboard';

import { POST } from './route';

const C = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: C }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
  m.role.mockResolvedValue('agent');
  m.setOutcomeReason.mockResolvedValue(undefined);
});

describe('POST outcome-reason', () => {
  it('sets the reason as the caller', async () => {
    const res = await post({ code: 'CREDIT_POLICY', text: ' DBR too high ' });
    expect(res.status).toBe(200);
    expect(m.setOutcomeReason).toHaveBeenCalledWith(
      'u-1',
      C,
      'CREDIT_POLICY',
      'DBR too high'
    );
  });

  it('passes no text as null', async () => {
    await post({ code: 'OTHER' });
    expect(m.setOutcomeReason).toHaveBeenCalledWith('u-1', C, 'OTHER', null);
  });

  it('refuses an unknown code or over-long text with 422 before the call', async () => {
    let res = await post({ code: 'BAD' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('REASON_INVALID');
    res = await post({ code: 'OTHER', text: 'x'.repeat(501) });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('REASON_TEXT_TOO_LONG');
    expect(m.setOutcomeReason).not.toHaveBeenCalled();
  });

  it.each([
    'OUTCOME_NOT_DECLINED',
    'REASON_ALREADY_SET',
    'REASON_INVALID',
    'REASON_TEXT_TOO_LONG',
  ] as const)('maps refusal %s to 422 with the code', async (reason) => {
    m.setOutcomeReason.mockRejectedValue(new BankDashboardRefusedError(reason));
    const res = await post({ code: 'OTHER' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe(reason);
  });

  it("answers 404 for another account's case and role null", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await post({ code: 'OTHER' })).status).toBe(404);
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
    m.role.mockResolvedValue(null);
    expect((await post({ code: 'OTHER' })).status).toBe(404);
    expect(m.setOutcomeReason).not.toHaveBeenCalled();
  });
});
