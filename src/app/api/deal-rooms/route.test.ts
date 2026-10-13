import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createDealRoom: vi.fn(),
  listRooms: vi.fn(),
  getUser: vi.fn(),
  admin: { service: true },
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

vi.mock('@/lib/auth/account', () => ({
  UnauthorizedError: m.UnauthorizedError,
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
// The real scope parser, a stubbed list; the session client is a stub.
vi.mock('@/lib/deal-rooms/reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deal-rooms/reads')>()),
  listRooms: m.listRooms,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ caller: true, auth: { getUser: m.getUser } }),
}));

import { toErrorResponse } from '@/lib/auth/account';
import { ChannelError } from '@/lib/whatsapp/channels';

import { GET, POST } from './route';

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

describe('GET /api/deal-rooms', () => {
  const CONTACT = '11111111-1111-4111-8111-111111111111';
  const DEAL = '33333333-3333-4333-8333-333333333333';
  const get = (query = '') =>
    GET(new Request(`http://localhost/api/deal-rooms${query}`));

  beforeEach(() => {
    m.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    m.listRooms.mockResolvedValue([{ id: 'room-1' }]);
  });

  it('lists every room the caller sees without a scope', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: [{ id: 'room-1' }] });
    expect(m.listRooms).toHaveBeenCalledWith(
      expect.objectContaining({ caller: true }),
      null
    );
  });

  it("lists one contact's or one deal's rooms", async () => {
    await get(`?contactId=${CONTACT}`);
    expect(m.listRooms).toHaveBeenLastCalledWith(expect.anything(), {
      contactId: CONTACT,
    });
    await get(`?dealId=${DEAL}`);
    expect(m.listRooms).toHaveBeenLastCalledWith(expect.anything(), {
      dealId: DEAL,
    });
  });

  it('answers 400 to a scope that is not a uuid, before reading anything', async () => {
    const res = await get('?contactId=not-a-uuid');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'contactId must be a uuid' });
    expect(m.listRooms).not.toHaveBeenCalled();
  });

  it('refuses a caller without a session', async () => {
    m.getUser.mockResolvedValue({ data: { user: null } });
    const res = await get(`?contactId=${CONTACT}`);
    expect(res.status).toBe(403);
    expect(vi.mocked(toErrorResponse)).toHaveBeenCalledWith(
      expect.any(m.UnauthorizedError)
    );
    expect(m.listRooms).not.toHaveBeenCalled();
  });
});
