import { beforeEach, describe, expect, it, vi } from 'vitest';

// Moderation needs meeting_can_manage through the caller's client and an
// open seat of this meeting; only then does the service role write, and
// a removal cuts the seat's Cloudflare media.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  cutSeats: vi.fn(),
  adminUpdate: vi.fn(),
  adminUpsert: vi.fn(),
  adminDelete: vi.fn(),
  calls: [] as string[],
  removedRows: [{ user_id: 'user-2' }] as unknown[],
  adminEq: [] as [string, unknown][],
  adminRows: [{ id: 'x' }] as unknown[],
  seatEq: [] as [string, unknown][],
  meeting: null as unknown,
  seat: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/cut', () => ({
  cutSeats: (...a: unknown[]) => (
    mocks.calls.push('cut'),
    mocks.cutSeats(...a)
  ),
}));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'meeting_removed_users') {
        const r = {
          upsert: async (v: unknown, o: unknown) => (
            mocks.calls.push('record'),
            mocks.adminUpsert(v, o),
            { error: null }
          ),
          delete: () => (mocks.adminDelete(), r),
          eq: (c: string, v: unknown) => (mocks.adminEq.push([c, v]), r),
          select: async () => ({ data: mocks.removedRows, error: null }),
        };
        return r;
      }
      const q = {
        update: (v: unknown) => (
          mocks.calls.push('close'),
          mocks.adminUpdate(v),
          q
        ),
        eq: (c: string, v: unknown) => (mocks.adminEq.push([c, v]), q),
        is: () => q,
        select: async () => ({ data: mocks.adminRows, error: null }),
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
  q.select = () => q;
  q.eq = (c: string, v: unknown) => {
    if (table === 'meeting_participants') mocks.seatEq.push([c, v]);
    return q;
  };
  q.maybeSingle = async () => {
    if (table === 'meetings') return { data: mocks.meeting, error: null };
    // The seat lives in `mocks.seat`, which belongs to meeting M only.
    const forThisMeeting = mocks.seatEq.some(
      ([c, v]) => c === 'meeting_id' && v === M
    );
    return { data: forThisMeeting ? mocks.seat : null, error: null };
  };
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
    mocks.adminEq = [];
    mocks.seatEq = [];
    mocks.adminRows = [{ id: T }];
    mocks.calls = [];
    mocks.removedRows = [{ user_id: 'user-2' }];
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

  it('records the removal before closing the seat and cutting', async () => {
    expect((await moderate({ target: T, action: 'remove' })).status).toBe(200);
    expect(mocks.adminUpsert).toHaveBeenCalledWith(
      {
        meeting_id: M,
        account_id: 'acct-1',
        user_id: 'user-2',
        removed_by: 'host-1',
        removed_at: expect.any(String),
      },
      { onConflict: 'meeting_id,user_id' }
    );
    expect(mocks.calls).toEqual(['record', 'close', 'cut']);
    await moderate({ target: T, action: 'mute' });
    expect(mocks.adminUpsert).toHaveBeenCalledTimes(1);
  });

  it('lets a removed person back in by user id', async () => {
    const U = '44444444-4444-4444-8444-444444444444';
    const res = await moderate({ target: U, action: 'readmit' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.adminDelete).toHaveBeenCalledTimes(1);
    expect(mocks.adminEq).toEqual([
      ['meeting_id', M],
      ['user_id', U],
    ]);
    expect(mocks.seatEq).toEqual([]);
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
    expect(mocks.cutSeats).not.toHaveBeenCalled();
  });

  it('answers 404 when the person was not removed', async () => {
    mocks.removedRows = [];
    const res = await moderate({ target: T, action: 'readmit' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'That person was not removed from this meeting',
    });
  });

  it('refuses a readmit from someone who cannot manage the meeting', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await moderate({ target: T, action: 'readmit' })).status).toBe(403);
    expect(mocks.adminDelete).not.toHaveBeenCalled();
  });

  it('scopes the seat lookup and the write to this meeting', async () => {
    await moderate({ target: T, action: 'mute' });
    expect(mocks.seatEq).toContainEqual(['meeting_id', M]);
    expect(mocks.adminEq).toContainEqual(['meeting_id', M]);
    expect(mocks.adminEq).toContainEqual(['id', T]);
  });

  it('answers 404 for a seat that belongs to another meeting', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'host-1',
      accountId: 'acct-1',
      supabase: {
        from: (table: string) => {
          const q = from(table) as Record<string, unknown>;
          // Filter on a different meeting id than the route's: finds nothing.
          q.eq = (c: string, v: unknown) => {
            if (table === 'meeting_participants') {
              mocks.seatEq.push([c, c === 'meeting_id' ? 'other' : v]);
            }
            return q;
          };
          return q;
        },
        rpc: mocks.rpc,
      },
    });
    expect((await moderate({ target: T, action: 'remove' })).status).toBe(404);
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
    expect(mocks.cutSeats).not.toHaveBeenCalled();
  });

  it('answers 404 and cuts nothing when the write changed no row', async () => {
    mocks.adminRows = [];
    for (const action of ['remove', 'mute', 'lower_hand']) {
      const res = await moderate({ target: T, action });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: 'That person is not in this meeting',
      });
    }
    expect(mocks.cutSeats).not.toHaveBeenCalled();
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
