import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  store: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: m.getCurrentAccount,
}));
// The real CaseViews over a fake rpc; the case store is mocked (tenancy + read check).
vi.mock('@/lib/cases/server', async () => {
  const { CaseViews } = await import('@/lib/cases/views');
  return {
    caseStore: () => m.store,
    caseViews: () =>
      new CaseViews(
        { rpc: m.rpc } as never,
        () => new Date('2026-11-10T09:00:00Z')
      ),
  };
});

import { POST as SNOOZE } from './route';
import { POST as UNSNOOZE } from '../unsnooze/route';

const ID = '11111111-1111-4111-8111-111111111111';
const UNTIL = '2026-11-12T09:00:00.000Z';
const aCase = (over: Record<string, unknown> = {}) => ({
  id: ID,
  accountId: 'acct-1',
  ...over,
});
const refuse = (hint: string) => ({
  data: null,
  error: { code: 'P0001', hint },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.getCurrentAccount.mockResolvedValue({
    userId: 'u-me',
    accountId: 'acct-1',
    role: 'agent',
  });
  m.store = {
    get: vi.fn(async () => aCase()),
    role: vi.fn(async () => 'coordinator'),
  };
  m.rpc.mockResolvedValue({ data: '2026-11-12T09:00:00+00:00', error: null });
});

const p = (id = ID) => ({ params: Promise.resolve({ id }) });
const snooze = (body: unknown, id = ID) =>
  SNOOZE(
    new Request(`http://x/api/cases/${id}/snooze`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    p(id)
  );
const unsnooze = (id = ID) =>
  UNSNOOZE(
    new Request(`http://x/api/cases/${id}/unsnooze`, { method: 'POST' }),
    p(id)
  );

describe('POST /api/cases/[id]/snooze', () => {
  it('is 404 for another account’s case, with no role or snooze call', async () => {
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    const res = await snooze({ until: UNTIL });
    expect(res.status).toBe(404);
    expect(m.store.role).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('is 404 for a case the caller cannot read, and for a non-uuid id', async () => {
    m.store.role.mockResolvedValue(null);
    expect((await snooze({ until: UNTIL })).status).toBe(404);
    expect((await snooze({ until: UNTIL }, 'x')).status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('snoozes at the server clock and answers { snoozedUntil }', async () => {
    const res = await snooze({ until: UNTIL, reason: 'bank is closed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ snoozedUntil: UNTIL });
    expect(m.rpc).toHaveBeenCalledWith('case_snooze', {
      p_actor: 'u-me',
      p_case: ID,
      p_until: UNTIL,
      p_reason: 'bank is closed',
      p_now: '2026-11-10T09:00:00.000Z',
    });
  });

  it.each([
    ['CASE_CLOSED', 409],
    ['NOT_ALLOWED', 403],
    ['SNOOZE_INVALID', 422],
    ['CASE_NOT_FOUND', 404],
  ])('maps %s to %i', async (hint, status) => {
    m.rpc.mockResolvedValue(refuse(hint));
    const res = await snooze({ until: UNTIL });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code: hint });
  });

  it('is 400 for a missing until or a non-text reason, before the snooze call', async () => {
    expect((await snooze({})).status).toBe(400);
    expect((await snooze({ until: 'soon' })).status).toBe(400);
    expect((await snooze({ until: UNTIL, reason: 5 })).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/cases/[id]/unsnooze', () => {
  it('ends the snooze: 200 { snoozedUntil: null }', async () => {
    m.rpc.mockResolvedValue({ data: null, error: null });
    const res = await unsnooze();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ snoozedUntil: null });
    expect(m.rpc).toHaveBeenCalledWith('case_unsnooze', {
      p_actor: 'u-me',
      p_case: ID,
      p_now: '2026-11-10T09:00:00.000Z',
    });
  });

  it('is 422 SNOOZE_INVALID when not snoozed; 404 for another account first', async () => {
    m.rpc.mockResolvedValue(refuse('SNOOZE_INVALID'));
    const res = await unsnooze();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'SNOOZE_INVALID' });
    m.rpc.mockClear();
    m.store.get.mockResolvedValue(aCase({ accountId: 'acct-2' }));
    expect((await unsnooze()).status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
