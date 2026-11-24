import { beforeEach, describe, expect, it, vi } from 'vitest';

// renegotiate is proxied on the caller's own open session only, and a
// seat closed while Cloudflare was answering is cut again.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  renegotiate: vi.fn(),
  cutSeats: vi.fn(),
  own: null as unknown,
  /** Set: the own-row read that follows Cloudflare's answer. */
  reread: null as null | { data: unknown; error: unknown },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/sfu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/sfu')>()),
  isMeetingsConfigured: () => true,
  renegotiate: mocks.renegotiate,
}));
vi.mock('@/lib/meetings/cut', () => ({ cutSeats: mocks.cutSeats }));

import { PUT } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const P = '11111111-1111-4111-8111-111111111111';

function participants() {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) q[m] = () => q;
  q.maybeSingle = async () =>
    mocks.reread && mocks.renegotiate.mock.calls.length > 0
      ? mocks.reread
      : { data: mocks.own, error: null };
  return q;
}

const put = () =>
  PUT(
    new Request('http://x', {
      method: 'PUT',
      body: JSON.stringify({
        participantId: P,
        sessionDescription: { type: 'answer', sdp: 'v=0' },
      }),
    }),
    { params: Promise.resolve({ id: M }) }
  );

describe('PUT /api/meetings/[id]/sfu/renegotiate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from: participants },
    });
    mocks.own = { id: P, cf_session_id: 'sess-own', left_at: null };
    mocks.reread = null;
    mocks.renegotiate.mockResolvedValue({ ok: 1 });
  });

  it('returns Cloudflare’s answer on an open seat', async () => {
    const res = await put();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(mocks.cutSeats).not.toHaveBeenCalled();
  });

  it('refuses a seat already left', async () => {
    mocks.own = { id: P, cf_session_id: 'sess-own', left_at: 'x' };
    expect((await put()).status).toBe(404);
    expect(mocks.renegotiate).not.toHaveBeenCalled();
  });

  it.each([
    ['closed', { id: P, cf_session_id: 'sess-own', left_at: 'x' }],
    ['hidden by a removal', null],
  ])('cuts the session of a seat %s meanwhile', async (_what, data) => {
    mocks.reread = { data, error: null };
    const res = await put();
    expect(res.status).toBe(404);
    expect(mocks.renegotiate).toHaveBeenCalled();
    expect(mocks.cutSeats).toHaveBeenCalledWith([
      expect.objectContaining({ cf_session_id: 'sess-own' }),
    ]);
  });

  it('does not read a failed re-read as closed', async () => {
    mocks.reread = { data: null, error: { code: '57014' } };
    expect((await put()).status).toBe(200);
    expect(mocks.cutSeats).not.toHaveBeenCalled();
  });
});
