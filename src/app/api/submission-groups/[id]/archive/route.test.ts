import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  get: vi.fn(),
  viewArchive: vi.fn(),
  service: vi.fn(),
  loadNames: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/submission-groups/server', () => ({
  submissionGroupStore: () => ({ get: mocks.get }),
  submissionGroupService: mocks.service,
  supabaseAdmin: () => 'admin-client',
}));
vi.mock('@/lib/submission-groups/view-refs', () => ({
  loadNames: mocks.loadNames,
}));

import { UnauthorizedError } from '@/lib/auth/account';

import { POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';

/** The row shape the store's `toMessage` hands the service. */
const stored = (over: Record<string, unknown>) => ({
  id: '1',
  direction: 'in',
  senderUserId: null,
  senderWaId: null,
  senderKind: null,
  type: 'text',
  body: 'hello',
  prefixedBody: null,
  media: null,
  waMessageId: 'wamid.1',
  sendStatus: null,
  postEnd: false,
  createdAt: new Date('2026-11-01T09:00:00.000Z'),
  waTimestamp: null,
  ...over,
});
const post = () =>
  POST(new Request('http://x', { method: 'POST' }), {
    params: Promise.resolve({ id: G }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAccount.mockResolvedValue({
    userId: 'lead-1',
    accountId: 'acct-1',
    role: 'team_leader',
  });
  mocks.get.mockResolvedValue({ id: G, accountId: 'acct-1' });
  mocks.service.mockReturnValue({ viewArchive: mocks.viewArchive });
  mocks.viewArchive.mockResolvedValue({
    allowed: true,
    messages: [
      stored({ senderWaId: '971501234567', senderKind: 'customer' }),
      stored({
        id: '2',
        direction: 'out',
        senderUserId: 'user-1',
        prefixedBody: 'Sara (Agent): hello',
        sendStatus: 'sent',
      }),
    ],
  });
  mocks.loadNames.mockResolvedValue(new Map([['user-1', 'Sara']]));
});

describe('POST archive', () => {
  it('answers the archive when the service allows it', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const { messages } = await res.json();
    expect(messages.map((m: { id: string }) => m.id)).toEqual(['1', '2']);
    expect(mocks.service).toHaveBeenCalledWith('acct-1');
    expect(mocks.viewArchive).toHaveBeenCalledWith({
      groupId: G,
      userId: 'lead-1',
    });
  });

  // The page renders these through the same list as the live messages: a
  // raw row has no `created_at`, and formatting that crashes the page.
  it('answers the message view the page renders', async () => {
    const { messages } = await (await post()).json();
    expect(messages[0]).toMatchObject({
      direction: 'in',
      sender_wa_id: '971501234567',
      sender_kind: 'customer',
      created_at: '2026-11-01T09:00:00.000Z',
    });
    expect(messages[1]).toMatchObject({
      direction: 'out',
      sender_user_id: 'user-1',
      sender_name: 'Sara',
      send_status: 'sent',
    });
    expect(mocks.loadNames).toHaveBeenCalledWith('admin-client', 'acct-1', [
      null,
      'user-1',
    ]);
  });

  it('answers 403 when the service refuses', async () => {
    mocks.viewArchive.mockResolvedValue({ allowed: false });
    expect((await post()).status).toBe(403);
  });

  it("answers 404 for another account's group and reads nothing", async () => {
    mocks.get.mockResolvedValue({ id: G, accountId: 'acct-2' });
    expect((await post()).status).toBe(404);
    expect(mocks.viewArchive).not.toHaveBeenCalled();
  });

  it('answers 401 without a session', async () => {
    mocks.getCurrentAccount.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
