import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  role: vi.fn(),
  timers: vi.fn(),
  timer: vi.fn(),
  event: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
vi.mock('@/lib/cases/server', () => ({
  caseStore: () => ({ get: m.get, role: m.role }),
  caseSlaStore: () => ({ timers: m.timers, timer: m.timer, event: m.event }),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  m.getCurrentAccount.mockResolvedValue({ userId: 'u-1', accountId: 'acct-1' });
  m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
  m.role.mockResolvedValue('agent');
  m.timers.mockResolvedValue([{ timer: 'bank_response' }]);
  m.timer.mockResolvedValue('on_track');
  m.event.mockResolvedValue(null);
});

describe('sla', () => {
  it('lists the timers', async () => {
    const res = await GET(new Request('http://x'), params());
    expect(await res.json()).toEqual({ timers: [{ timer: 'bank_response' }] });
  });

  it('runs a timer action as the caller', async () => {
    const res = await post({ timer: 'bank_response', action: 'start' });
    expect(await res.json()).toEqual({ slaState: 'on_track' });
    expect(m.timer).toHaveBeenCalledWith(C, 'u-1', 'bank_response', 'start');
    expect(m.event).not.toHaveBeenCalled();
  });

  it('records an event as the caller', async () => {
    const res = await post({ event: 'customer_message' });
    expect(await res.json()).toEqual({ slaState: null });
    expect(m.event).toHaveBeenCalledWith(C, 'u-1', 'customer_message');
  });

  it('answers 400 for both, neither or bad values', async () => {
    for (const body of [
      {},
      { timer: 'bank_response', action: 'start', event: 'bank_response' },
      { timer: 'nap', action: 'start' },
      { timer: 'bank_response', action: 'pause' },
      { event: 'stage_change' },
    ])
      expect((await post(body)).status).toBe(400);
    expect(m.timer).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  });

  it("answers 404 for another account's case and role null", async () => {
    m.get.mockResolvedValue({ id: C, accountId: 'acct-2' });
    expect((await post({ event: 'bank_response' })).status).toBe(404);
    m.get.mockResolvedValue({ id: C, accountId: 'acct-1' });
    m.role.mockResolvedValue(null);
    expect((await post({ event: 'bank_response' })).status).toBe(404);
    expect(m.event).not.toHaveBeenCalled();
  });

  it('maps SLA_NOT_CONFIGURED to 422', async () => {
    m.timer.mockRejectedValue(new CaseRefusedError('SLA_NOT_CONFIGURED'));
    const res = await post({ timer: 'customer_reply', action: 'reset' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SLA_NOT_CONFIGURED');
  });
});
