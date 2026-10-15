import { beforeEach, describe, expect, it, vi } from 'vitest';

// Moderation needs meeting_can_manage through the caller's client and an
// open seat of this meeting; only then does the service role write, and
// a removal cuts the seat's Cloudflare media.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  cutSeats: vi.fn(),
  adminUpdate: vi.fn(),
  meeting: null as unknown,
  seat: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/cut', () => ({ cutSeats: mocks.cutSeats }));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: () => ({
    from: () => {
      const q = {
        update: (v: unknown) => (mocks.adminUpdate(v), q),
        eq: () => q,
        is: async () => ({ error: null }),
      };
      return q;
    },
  }),
}));

import { POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ id: M }) };

function from(table: string) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) q[m] = () => q;
  q.maybeSingle = async () => ({
    data: table === 'meetings' ? mocks.meeting : mocks.seat,
    error: null,
  });
  return q;
}

const moderate = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params
  );

describe('POST /api/meetings/[id]/moderate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'host-1',
      accountId: 'acct-1',
      supabase: { from, rpc: mocks.rpc },
    });
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'scheduled' };
    mocks.seat = {
      id: T,
      user_id: 'user-2',
      cf_session_id: 'sess-2',
      left_at: null,
    };
  });

  it('asks the host to mute and lowers a hand, cutting nothing', async () => {
    expect((await moderate({ target: T, action: 'mute' })).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('meeting_can_manage', {
      p_meeting: M,
    });
    expect(mocks.adminUpdate).toHaveBeenLastCalledWith({
      mute_requested_at: expect.any(String),
    });
    expect((await moderate({ target: T, action: 'lower_hand' })).status).toBe(
      200
    );
    expect(mocks.adminUpdate).toHaveBeenLastCalledWith({
      hand_raised_at: null,
    });
    expect(mocks.cutSeats).not.toHaveBeenCalled();
  });

  it('removes a seat: closes it, records who, and cuts its media', async () => {
    const res = await moderate({ target: T, action: 'remove' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const update = mocks.adminUpdate.mock.calls[0][0];
    expect(update).toMatchObject({ removed_by: 'host-1' });
    expect(update.left_at).toBe(update.removed_at);
    expect(mocks.cutSeats).toHaveBeenCalledWith([mocks.seat]);
  });

  it('refuses someone who cannot manage the meeting, writing nothing', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await moderate({ target: T, action: 'remove' })).status).toBe(403);
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
    expect(mocks.cutSeats).not.toHaveBeenCalled();
  });

  it('answers 503 when meeting_can_manage itself fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    expect((await moderate({ target: T, action: 'mute' })).status).toBe(503);
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
  });

  it('refuses a closed seat, an ended meeting and removing yourself', async () => {
    mocks.seat = { id: T, user_id: 'user-2', left_at: '2026-10-15T08:00:00Z' };
    expect((await moderate({ target: T, action: 'mute' })).status).toBe(404);
    mocks.seat = { id: T, user_id: 'host-1', left_at: null };
    expect((await moderate({ target: T, action: 'remove' })).status).toBe(400);
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'ended' };
    expect((await moderate({ target: T, action: 'mute' })).status).toBe(409);
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
  });

  it('refuses a bad body and a bank guest', async () => {
    expect((await moderate({ target: T, action: 'ban' })).status).toBe(400);
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'bank_guest',
      supabase: { from, rpc: mocks.rpc },
    });
    const res = await moderate({ target: T, action: 'mute' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Video meetings are for staff only',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
