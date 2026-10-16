import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  get: vi.fn(),
  retryOne: vi.fn(),
  service: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => ({ get: mocks.get }),
  submissionGroupService: mocks.service,
}));

import { ForbiddenError } from '@/lib/auth/account';

import { POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const post = () =>
  POST(new Request('http://x', { method: 'POST' }), {
    params: Promise.resolve({ id: G }),
  });
const group = (extra: Record<string, unknown> = {}) => ({
  id: G,
  accountId: 'acct-1',
  status: 'ACTIVE',
  waGroupId: null,
  ...extra,
});
const opened = (g: Record<string, unknown>) => ({
  consentRequired: false,
  created: false,
  group: g,
  inviteLink: null,
  refusedParticipants: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({
    userId: 'admin-1',
    accountId: 'acct-1',
    role: 'admin',
  });
  mocks.get.mockResolvedValue(group());
  mocks.service.mockReturnValue({ retryOne: mocks.retryOne });
  mocks.retryOne.mockResolvedValue(opened(group({ waGroupId: 'x@g.us' })));
});

describe('POST retry', () => {
  it('answers the group, no longer pending once created', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group.waGroupId).toBe('x@g.us');
    expect(body.pending).toBe(false);
    expect(mocks.service).toHaveBeenCalledWith('acct-1');
    expect(mocks.retryOne).toHaveBeenCalledWith(G);
  });

  it('reports pending while the WhatsApp group is still missing', async () => {
    mocks.retryOne.mockResolvedValue(opened(group()));
    expect((await (await post()).json()).pending).toBe(true);
  });

  it('answers 409 when consent is required', async () => {
    mocks.retryOne.mockResolvedValue({
      consentRequired: true,
      group: null,
      inviteLink: null,
    });
    expect((await post()).status).toBe(409);
  });

  it("answers 404 for another account's group and retries nothing", async () => {
    mocks.get.mockResolvedValue(group({ accountId: 'acct-2' }));
    expect((await post()).status).toBe(404);
    expect(mocks.retryOne).not.toHaveBeenCalled();
  });

  it('answers 403 below admin', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError());
    expect((await post()).status).toBe(403);
    expect(mocks.retryOne).not.toHaveBeenCalled();
  });
});
