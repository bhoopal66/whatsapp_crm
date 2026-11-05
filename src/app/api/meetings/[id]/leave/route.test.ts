import { beforeEach, describe, expect, it, vi } from 'vitest';

// Leaving closes the seat and cuts its Cloudflare session, so a client
// that keeps the peer connection open stops receiving the call.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  cutSeats: vi.fn(),
  own: { data: null as unknown, error: null as unknown },
  log: [] as string[],
  recordingUpdate: vi.fn(),
  recordingEq: [] as [string, unknown][],
  recordingResult: (async () => ({ error: null })) as () => Promise<unknown>,
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
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      if (table === 'meetings') {
        q.update = (v: unknown) => (
          mocks.log.push('stop recording'),
          mocks.recordingUpdate(v),
          q
        );
        q.eq = (c: string, v: unknown) => (mocks.recordingEq.push([c, v]), q);
        q.then = (
          resolve: (v: unknown) => void,
          reject: (e: unknown) => void
        ) => mocks.recordingResult().then(resolve, reject);
        return q;
      }
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
    mocks.recordingEq = [];
    mocks.recordingResult = async () => ({ error: null });
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
    expect(mocks.log).toEqual(['close', 'stop recording', 'cut']);
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

  it('clears only a recording the caller holds', async () => {
    await leave();
    expect(mocks.recordingUpdate).toHaveBeenCalledWith({
      recording_started_at: null,
      recording_by: null,
    });
    expect(mocks.recordingEq).toEqual([
      ['id', M],
      ['recording_by', 'user-1'],
    ]);
  });

  // A stale tab's seat: the person may be recording from their new seat.
  it('leaves the recording alone when the seat was already closed', async () => {
    mocks.own = {
      data: { ...SEAT, left_at: '2026-10-15T10:00:00Z' },
      error: null,
    };
    await leave();
    expect(mocks.recordingUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing column', async () => ({ error: { code: '42703' } })],
    ['a failed write', async () => ({ error: { code: 'XX000' } })],
    ['a thrown error', () => Promise.reject(new Error('network'))],
  ])('never fails the leave on %s', async (_name, result) => {
    mocks.recordingResult = result;
    expect((await leave()).status).toBe(200);
    expect(mocks.log).toEqual(['close', 'stop recording', 'cut']);
  });

  it('stays quiet about a missing column, not another failure', async () => {
    mocks.recordingResult = async () => ({ error: { code: 'PGRST204' } });
    await leave();
    expect(console.error).not.toHaveBeenCalled();
    mocks.recordingResult = async () => ({ error: { code: 'XX000' } });
    await leave();
    expect(console.error).toHaveBeenCalled();
  });
});
