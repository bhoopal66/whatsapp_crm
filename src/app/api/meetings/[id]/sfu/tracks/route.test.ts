import { beforeEach, describe, expect, it, vi } from 'vitest';

// tracks/new is proxied on the caller's own session only after the
// participant row is theirs and open, every local name carries their
// `${participantId}:` prefix, and every remote track comes from someone
// present in this meeting.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  newTracks: vi.fn(),
  configured: vi.fn(() => true),
  adminUpdate: vi.fn(),
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
  newTracks: mocks.newTracks,
}));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: () => ({
    from: () => {
      const q = {
        update: (v: unknown) => (mocks.adminUpdate(v), q),
        eq: () => q,
        is: () => Promise.resolve({ error: null }),
      };
      return q;
    },
  }),
}));

import { POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const P = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: M }) };

/** meeting_participants under the caller's RLS: the own-row read ends in
 *  maybeSingle, the present list is awaited directly. */
function participants() {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'gt']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: mocks.own, error: null });
  q.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: mocks.present, error: null }).then(ok);
  return q;
}

function post(request: unknown) {
  return POST(
    new Request('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ participantId: P, request }),
    }),
    params
  );
}

const localAudio = { location: 'local', mid: '0', trackName: `${P}:audio` };

describe('POST /api/meetings/[id]/sfu/tracks', () => {
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
    mocks.own = {
      id: P,
      cf_session_id: 'sess-own',
      left_at: null,
      tracks: [],
    };
    mocks.present = [
      { cf_session_id: 'sess-own' },
      { cf_session_id: 'sess-b' },
    ];
    mocks.newTracks.mockResolvedValue({
      tracks: [{ trackName: `${P}:audio` }],
    });
  });

  it('pushes own tracks on the own session and records them', async () => {
    const res = await post({
      sessionDescription: { type: 'offer', sdp: 'v=0' },
      tracks: [localAudio],
    });
    expect(res.status).toBe(200);
    expect(mocks.newTracks).toHaveBeenCalledWith('sess-own', expect.anything());
    expect(mocks.adminUpdate).toHaveBeenCalledWith({
      tracks: [{ trackName: `${P}:audio`, kind: 'audio' }],
    });
  });

  it('pulls a track from a present participant', async () => {
    const res = await post({
      tracks: [
        { location: 'remote', sessionId: 'sess-b', trackName: 'b:audio' },
      ],
    });
    expect(res.status).toBe(200);
    expect(mocks.adminUpdate).not.toHaveBeenCalled();
  });

  it('refuses a track from a session not present in this meeting', async () => {
    const res = await post({
      tracks: [
        {
          location: 'remote',
          sessionId: 'sess-elsewhere',
          trackName: 'z:audio',
        },
      ],
    });
    expect(res.status).toBe(403);
    expect(mocks.newTracks).not.toHaveBeenCalled();
  });

  it('refuses a local track named for another participant', async () => {
    const res = await post({
      tracks: [{ location: 'local', mid: '0', trackName: 'other:audio' }],
    });
    expect(res.status).toBe(403);
    expect(mocks.newTracks).not.toHaveBeenCalled();
  });

  it('refuses a seat that is not the caller’s or already left', async () => {
    mocks.own = null;
    expect((await post({ tracks: [localAudio] })).status).toBe(404);
    mocks.own = { id: P, cf_session_id: 's', left_at: 'x', tracks: [] };
    expect((await post({ tracks: [localAudio] })).status).toBe(404);
    expect(mocks.newTracks).not.toHaveBeenCalled();
  });

  it('answers 503 meetings_not_configured without the env vars', async () => {
    mocks.configured.mockReturnValue(false);
    const res = await post({ tracks: [localAudio] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'meetings_not_configured' });
  });

  it('refuses a bank guest before reading anything', async () => {
    const from = vi.fn();
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'bank_guest',
      userId: 'g',
      accountId: 'acct-1',
      supabase: { from },
    });
    const res = await post({ tracks: [localAudio] });
    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
});
