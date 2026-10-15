import { beforeEach, describe, expect, it, vi } from 'vitest';

// A failed read is not "you left": the client tears the call down on a
// 404 ("joined from another tab"), so only a missing or closed seat may
// answer 404, and a read error answers 503.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  reads: {} as Record<string, { data: unknown; error: unknown }>,
  adminUpdates: [] as unknown[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.update = (v: unknown) => (mocks.adminUpdates.push(v), q);
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

function from(table: string) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) q[m] = () => q;
  q.maybeSingle = async () => mocks.reads[table];
  return q;
}

const beat = () =>
  POST(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({
        participantId: P,
        audioMuted: false,
        videoOff: true,
      }),
    }),
    params
  );

describe('POST /api/meetings/[id]/heartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.adminUpdates = [];
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from },
    });
    mocks.reads = {
      meeting_participants: {
        data: { id: P, left_at: null, user_id: 'user-1' },
        error: null,
      },
      meetings: { data: { id: M, status: 'scheduled' }, error: null },
    };
  });

  it('records the beat on an open seat', async () => {
    const res = await beat();
    expect(res.status).toBe(200);
    expect(mocks.adminUpdates).toEqual([
      expect.objectContaining({ audio_muted: false, video_off: true }),
    ]);
  });

  it('answers 503, not 404, when the seat cannot be read', async () => {
    mocks.reads.meeting_participants = {
      data: null,
      error: { code: '57014', message: 'canceling statement' },
    };
    const res = await beat();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(mocks.adminUpdates).toEqual([]);
  });

  it('answers 503 when the meeting cannot be read', async () => {
    mocks.reads.meetings = { data: null, error: { message: 'timeout' } };
    expect((await beat()).status).toBe(503);
    expect(mocks.adminUpdates).toEqual([]);
  });

  it('answers 404 for a seat that is missing or closed', async () => {
    mocks.reads.meeting_participants = { data: null, error: null };
    expect((await beat()).status).toBe(404);
    mocks.reads.meeting_participants = {
      data: { id: P, left_at: '2026-10-15T00:00:00Z' },
      error: null,
    };
    expect((await beat()).status).toBe(404);
    expect(mocks.adminUpdates).toEqual([]);
  });

  it('closes the seat and answers 409 on an ended meeting', async () => {
    mocks.reads.meetings = { data: { id: M, status: 'ended' }, error: null };
    expect((await beat()).status).toBe(409);
    expect(mocks.adminUpdates).toEqual([{ left_at: expect.any(String) }]);
  });
});
