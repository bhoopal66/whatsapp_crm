import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  openAccessLabel: vi.fn(),
  addNumber: vi.fn(),
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
const post = (body: unknown, id = G) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );
const as = (role: string) =>
  mocks.getCurrentAccount.mockResolvedValue({
    userId: 'user-1',
    accountId: 'acct-1',
    role,
  });

beforeEach(() => {
  vi.clearAllMocks();
  as('agent');
  mocks.get.mockResolvedValue({
    id: G,
    accountId: 'acct-1',
    status: 'ACTIVE',
  });
  mocks.openAccessLabel.mockResolvedValue('agent');
  mocks.service.mockReturnValue({ addNumber: mocks.addNumber });
  mocks.addNumber.mockResolvedValue({ status: 'added' });
});

describe('POST /api/submission-groups/[id]/participants', () => {
  it('adds a number for someone on the group, as digits', async () => {
    const res = await post({ phone: '+971 50 123 4567' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: true, phone: '971501234567' });
    expect(mocks.addNumber).toHaveBeenCalledWith(G, 'user-1', '971501234567');
  });

  it('refuses someone not on the group before the service', async () => {
    mocks.openAccessLabel.mockResolvedValue(null);
    const res = await post({ phone: '+971501234567' });
    expect(res.status).toBe(403);
    expect(mocks.addNumber).not.toHaveBeenCalled();
  });

  it('lets an admin add without a label', async () => {
    as('admin');
    mocks.openAccessLabel.mockResolvedValue(null);
    expect((await post({ phone: '+971501234567' })).status).toBe(200);
  });

  it('answers 404 for another account’s group', async () => {
    mocks.get.mockResolvedValue({
      id: G,
      accountId: 'other',
      status: 'ACTIVE',
    });
    expect((await post({ phone: '+971501234567' })).status).toBe(404);
    expect(mocks.addNumber).not.toHaveBeenCalled();
  });

  it('answers 400 for a missing or bad number', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ phone: '123' })).status).toBe(400);
    expect(mocks.addNumber).not.toHaveBeenCalled();
  });

  it('words a refusal from SQL', async () => {
    mocks.addNumber.mockResolvedValue({
      status: 'not_allowed',
      code: 'too_many',
    });
    const res = await post({ phone: '+971501234567' });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/last 24 hours/);
    expect(body.code).toBe('too_many');
  });

  it('hands back the invite link when WhatsApp declines', async () => {
    mocks.addNumber.mockResolvedValue({
      status: 'refused',
      inviteLink: 'https://chat.whatsapp.com/X',
    });
    const res = await post({ phone: '+971501234567' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      added: false,
      phone: '971501234567',
      inviteLink: 'https://chat.whatsapp.com/X',
    });
  });

  it('answers 502 when the gateway failed', async () => {
    mocks.addNumber.mockResolvedValue({ status: 'failed', reason: 'down' });
    expect((await post({ phone: '+971501234567' })).status).toBe(502);
  });

  it('says an unconfirmed add may have happened', async () => {
    mocks.addNumber.mockResolvedValue({ status: 'unconfirmed' });
    const res = await post({ phone: '+971501234567' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'The number may have been added; check the group',
      code: 'send_unconfirmed',
    });
  });
});
