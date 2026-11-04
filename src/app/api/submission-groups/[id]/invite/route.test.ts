import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  openAccessLabel: vi.fn(),
  resendInvite: vi.fn(),
  service: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => ({
    get: mocks.get,
    openAccessLabel: mocks.openAccessLabel,
  }),
  submissionGroupService: mocks.service,
}));

import { POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const post = (id = G) =>
  POST(new Request('http://x', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
const group = (extra: Record<string, unknown> = {}) => ({
  id: G,
  accountId: 'acct-1',
  status: 'ACTIVE',
  ...extra,
});
const as = (role: string) =>
  mocks.getCurrentAccount.mockResolvedValue({
    userId: 'user-1',
    accountId: 'acct-1',
    role,
  });

beforeEach(() => {
  vi.clearAllMocks();
  as('admin');
  mocks.get.mockResolvedValue(group());
  mocks.openAccessLabel.mockResolvedValue(null);
  mocks.service.mockReturnValue({ resendInvite: mocks.resendInvite });
  mocks.resendInvite.mockResolvedValue({
    status: 'sent',
    group: group({ inviteSendError: null }),
  });
});

describe('POST invite: who may resend', () => {
  it.each(['owner', 'admin'])('lets an %s through with no label', async (r) => {
    as(r);
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).group.id).toBe(G);
    expect(mocks.service).toHaveBeenCalledWith('acct-1');
    expect(mocks.resendInvite).toHaveBeenCalledWith(G);
  });

  it('lets anyone with an open label through', async () => {
    as('agent');
    mocks.openAccessLabel.mockResolvedValue('coordinator');
    expect((await post()).status).toBe(200);
    expect(mocks.openAccessLabel).toHaveBeenCalledWith(G, 'user-1');
    expect(mocks.resendInvite).toHaveBeenCalledWith(G);
  });

  it.each(['team_leader', 'agent', 'viewer'])(
    'answers 403 to a %s with no label and sends nothing',
    async (r) => {
      as(r);
      const res = await post();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: expect.any(String) });
      expect(mocks.resendInvite).not.toHaveBeenCalled();
    }
  );

  it("answers 404 for another account's group, even to an admin", async () => {
    mocks.get.mockResolvedValue(group({ accountId: 'acct-2' }));
    expect((await post()).status).toBe(404);
    expect(mocks.resendInvite).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that is not a uuid, without a lookup', async () => {
    expect((await post('nope')).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('POST invite: the answer', () => {
  it.each([
    ['not_active', 409],
    ['no_whatsapp', 409],
    ['no_group_yet', 409],
    ['detached', 409],
    ['opted_out', 409],
    ['do_not_contact', 409],
    ['no_phone', 409],
    ['too_soon', 429],
  ])('words the refusal %s as %i', async (code, status) => {
    mocks.resendInvite.mockResolvedValue({ status: 'refused', code });
    const res = await post();
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).not.toBe('');
    expect(body.error).not.toContain(code);
  });

  it('answers 502 with the plain reason when the gateway fails', async () => {
    mocks.resendInvite.mockResolvedValue({
      status: 'failed',
      reason: 'WhatsApp refused the invite',
    });
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'WhatsApp refused the invite' });
  });
});
