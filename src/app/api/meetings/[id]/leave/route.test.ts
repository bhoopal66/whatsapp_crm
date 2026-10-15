import { beforeEach, describe, expect, it, vi } from 'vitest';

// Leaving closes the seat and cuts its Cloudflare session, so a client
// that keeps the peer connection open stops receiving the call.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  cutSeats: vi.fn(),
  own: { data: null as unknown, error: null as unknown },
  log: [] as string[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/cut', () => ({
  cutSeats: async (seats: unknown) => (
    mocks.log.push('cut'),
    mocks.cutSeats(seats)
  ),
}));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.update = () => (mocks.log.push('close'), q);
      q.eq = () => q;
      q.is = async () => ({ error: null });
      return q;
    },
  }),
}));

import { POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ id: M }) };
const SEAT = { id: P, meeting_id: M, cf_session_id: 'sess-1', left_at: null };

function from() {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) q[m] = () => q;
  q.maybeSingle = async () => mocks.own;
  return q;
}

const leave = () =>
  POST(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ participantId: P }),
    }),
    params
  );

describe('POST /api/meetings/[id]/leave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.log = [];
    mocks.own = { data: SEAT, error: null };
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from },
    });
  });

  it('closes the seat, then cuts its session', async () => {
    expect((await leave()).status).toBe(200);
    expect(mocks.log).toEqual(['close', 'cut']);
    expect(mocks.cutSeats).toHaveBeenCalledWith([SEAT]);
  });

  it('still cuts a seat that was already closed', async () => {
    mocks.own = {
      data: { ...SEAT, left_at: '2026-10-15T10:00:00Z' },
      error: null,
    };
    expect((await leave()).status).toBe(200);
    expect(mocks.log).toEqual(['cut']);
  });

  it('cuts nothing for a seat that is not the caller’s', async () => {
    mocks.own = { data: null, error: null };
    expect((await leave()).status).toBe(404);
    expect(mocks.log).toEqual([]);
  });
});
