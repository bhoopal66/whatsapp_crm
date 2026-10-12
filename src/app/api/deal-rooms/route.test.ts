import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createDealRoom: vi.fn(),
  admin: { service: true },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: m.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));
// The real body parser, a stubbed create.
vi.mock('@/lib/deal-rooms/create', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deal-rooms/create')>()),
  createDealRoom: m.createDealRoom,
}));

import { ChannelError } from '@/lib/whatsapp/channels';

import { POST } from './route';

const CTX = {
  supabase: { caller: true },
  accountId: 'acct-1',
  userId: 'user-1',
  role: 'agent',
};

const BODY = {
  contactId: 'contact-1',
  subject: 'Deal 42',
  participants: [
    { displayName: 'Aisha', phone: '971500000001', role: 'customer' },
  ],
  consent: { textVersion: 'v1', consentText: 'I agree', method: 'verbal' },
};

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/deal-rooms', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.requireRole.mockResolvedValue(CTX);
  m.createDealRoom.mockResolvedValue({
    ok: true,
    roomId: 'room-1',
    channelId: 'chan-1',
    status: 'creating',
  });
});

describe('POST /api/deal-rooms', () => {
  it('creates as the caller, with the service role beside it: 201', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      roomId: 'room-1',
      channelId: 'chan-1',
      status: 'creating',
    });
    expect(m.requireRole).toHaveBeenCalledWith('agent');
    expect(m.createDealRoom).toHaveBeenCalledWith({
      userDb: CTX.supabase,
      adminDb: m.admin,
      accountId: 'acct-1',
      input: expect.objectContaining({
        contactId: 'contact-1',
        subject: 'Deal 42',
      }),
    });
  });

  it('answers 400 to a body of the wrong shape, before creating anything', async () => {
    for (const body of ['not json', { ...BODY, contactId: '' }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
    expect(m.createDealRoom).not.toHaveBeenCalled();
  });

  it('passes a refusal through, with the failed room when there is one', async () => {
    m.createDealRoom.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: 'WhatsApp could not create the group: Too many groups',
      roomId: 'room-1',
    });
    let res = await post(BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'WhatsApp could not create the group: Too many groups',
      roomId: 'room-1',
      status: 'failed',
    });

    m.createDealRoom.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'Contact not found',
    });
    res = await post(BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Contact not found' });
  });

  it("answers a number-lookup failure with the ChannelError's status and message", async () => {
    m.createDealRoom.mockRejectedValueOnce(
      new ChannelError('channel_unreadable', 'Reconnect the number.', 409)
    );
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Reconnect the number.' });
  });

  it('leaves auth failures to toErrorResponse', async () => {
    m.requireRole.mockRejectedValueOnce(new Error('no session'));
    expect((await post(BODY)).status).toBe(403);
    expect(m.createDealRoom).not.toHaveBeenCalled();
  });
});
