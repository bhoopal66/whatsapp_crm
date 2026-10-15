import { beforeEach, describe, expect, it, vi } from 'vitest';

// tracks/update is proxied on the caller's own open session only, and
// only for pulls of someone present in this meeting, with a valid layer.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  updateTracks: vi.fn(),
  configured: vi.fn(() => true),
  own: null as unknown,
  present: [] as { cf_session_id: string }[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/sfu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/sfu')>()),
  isMeetingsConfigured: mocks.configured,
  updateTracks: mocks.updateTracks,
}));

import { PUT } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const P = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: M }) };

function participants() {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'gt']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: mocks.own, error: null });
  q.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: mocks.present, error: null }).then(ok);
  return q;
}

const put = (request: unknown) =>
  PUT(
    new Request('http://x', {
      method: 'PUT',
      body: JSON.stringify({ participantId: P, request }),
    }),
    params
  );
const pull = (over: Record<string, unknown> = {}) => ({
  tracks: [
    {
      location: 'remote',
      sessionId: 'sess-b',
      trackName: 'b:video',
      mid: '2',
      simulcast: { preferredRid: 'q' },
      ...over,
    },
  ],
});

describe('PUT /api/meetings/[id]/sfu/tracks/update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.configured.mockReturnValue(true);
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from: participants },
    });
    mocks.own = { id: P, cf_session_id: 'sess-a', left_at: null };
    mocks.present = [{ cf_session_id: 'sess-a' }, { cf_session_id: 'sess-b' }];
    mocks.updateTracks.mockResolvedValue({
      requiresImmediateRenegotiation: false,
      tracks: [{ mid: '2' }],
    });
  });

  it('switches a layer on the caller’s own session and returns Cloudflare’s answer', async () => {
    const res = await put(pull());
    expect(res.status).toBe(200);
    expect(mocks.updateTracks).toHaveBeenCalledWith('sess-a', pull());
    expect(await res.json()).toEqual({
      requiresImmediateRenegotiation: false,
      tracks: [{ mid: '2' }],
    });
  });

  it('refuses an absent session, a bad layer and a closed seat', async () => {
    expect((await put(pull({ sessionId: 'sess-z' }))).status).toBe(403);
    expect((await put(pull({ simulcast: { preferredRid: 'x' } }))).status).toBe(
      400
    );
    mocks.own = {
      id: P,
      cf_session_id: 'sess-a',
      left_at: '2026-10-15T08:00:00Z',
    };
    expect((await put(pull())).status).toBe(404);
    expect(mocks.updateTracks).not.toHaveBeenCalled();
  });

  it('answers 503 meetings_not_configured without the env vars', async () => {
    mocks.configured.mockReturnValue(false);
    expect((await put(pull())).status).toBe(503);
  });
});
