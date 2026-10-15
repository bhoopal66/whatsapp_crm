import { beforeEach, describe, expect, it, vi } from 'vitest';

// A seat's own state: found through the caller's client (own, open),
// written by the service role. A raised hand keeps its place.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  adminUpdate: vi.fn(),
  meeting: null as unknown,
  own: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
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
const P = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: M }) };
const EARLIER = '2026-10-15T08:00:00.000Z';

function from(table: string) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) q[m] = () => q;
  q.maybeSingle = async () => ({
    data: table === 'meetings' ? mocks.meeting : mocks.own,
    error: null,
  });
  return q;
}

const state = (body: Record<string, unknown>) =>
  POST(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ participantId: P, ...body }),
    }),
    params
  );

describe('POST /api/meetings/[id]/state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'viewer',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from },
    });
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'scheduled' };
    mocks.own = {
      id: P,
      user_id: 'user-1',
      left_at: null,
      hand_raised_at: null,
    };
  });

  it('raises a hand with a timestamp, and a second raise keeps it', async () => {
    const res = await state({ handRaised: true });
    expect(res.status).toBe(200);
    const { hand_raised_at } = await res.json();
    expect(typeof hand_raised_at).toBe('string');
    expect(mocks.adminUpdate).toHaveBeenLastCalledWith({
      last_seen_at: expect.any(String),
      hand_raised_at,
    });
    mocks.own = {
      id: P,
      user_id: 'user-1',
      left_at: null,
      hand_raised_at: EARLIER,
    };
    expect(
      (await (await state({ handRaised: true })).json()).hand_raised_at
    ).toBe(EARLIER);
  });

  it('lowers a hand and publishes mic/camera flags', async () => {
    mocks.own = {
      id: P,
      user_id: 'user-1',
      left_at: null,
      hand_raised_at: EARLIER,
    };
    await state({ handRaised: false, audioMuted: true, videoOff: false });
    expect(mocks.adminUpdate).toHaveBeenLastCalledWith({
      last_seen_at: expect.any(String),
      hand_raised_at: null,
      audio_muted: true,
      video_off: false,
    });
    await state({ audioMuted: false });
    expect(mocks.adminUpdate).toHaveBeenLastCalledWith({
      last_seen_at: expect.any(String),
      audio_muted: false,
    });
  });

  it('refuses a seat that is not the caller’s open one, or an ended meeting', async () => {
    mocks.own = null;
    expect((await state({ handRaised: true })).status).toBe(404);
    mocks.own = {
      id: P,
      user_id: 'user-1',
      left_at: EARLIER,
      hand_raised_at: null,
    };
    expect((await state({ handRaised: true })).status).toBe(404);
    mocks.own = {
      id: P,
      user_id: 'user-1',
      left_at: null,
      hand_raised_at: null,
    };
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'cancelled' };
    expect((await state({ handRaised: true })).status).toBe(409);
    expect((await state({})).status).toBe(400);
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
  });
});
