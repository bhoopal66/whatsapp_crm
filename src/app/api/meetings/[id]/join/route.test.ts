import { beforeEach, describe, expect, it, vi } from 'vitest';

// Join checks meeting_can_view through the caller's client; only then
// does the service role close the caller's other seats and insert the
// new one.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  createSession: vi.fn(),
  meetingIceServers: vi.fn(),
  configured: vi.fn(() => true),
  rpc: vi.fn(),
  meeting: null as unknown,
  removal: null as unknown,
  removalEq: [] as [string, unknown][],
  adminCalls: [] as string[],
  insertResults: [] as { data: unknown; error: unknown }[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/sfu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/sfu')>()),
  isMeetingsConfigured: mocks.configured,
  createSession: mocks.createSession,
}));
vi.mock('@/lib/meetings/turn', () => ({
  meetingIceServers: mocks.meetingIceServers,
}));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.update = () => (mocks.adminCalls.push('close'), q);
      q.eq = () => q;
      q.is = async () => ({ error: null });
      q.insert = (row: unknown) => (
        mocks.adminCalls.push(`insert ${JSON.stringify(row)}`),
        q
      );
      q.select = () => q;
      q.single = async () =>
        mocks.insertResults.shift() ?? { data: { id: 'part-1' }, error: null };
      return q;
    },
  }),
}));

import { POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: M }) };

function meetings(table = 'meetings') {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (c: string, v: unknown) => {
    if (table === 'meeting_removed_users') mocks.removalEq.push([c, v]);
    return q;
  };
  q.maybeSingle = async () => ({
    data: table === 'meeting_removed_users' ? mocks.removal : mocks.meeting,
    error: null,
  });
  return q;
}

const join = () => POST(new Request('http://x', { method: 'POST' }), params);

describe('POST /api/meetings/[id]/join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminCalls = [];
    mocks.removal = null;
    mocks.removalEq = [];
    mocks.insertResults = [];
    mocks.configured.mockReturnValue(true);
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from: meetings, rpc: mocks.rpc },
    });
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'scheduled' };
    mocks.createSession.mockResolvedValue({ sessionId: 'sess-1' });
    mocks.meetingIceServers.mockResolvedValue([
      { urls: 'stun:stun.cloudflare.com:3478' },
    ]);
  });

  it('hands out the TURN servers lib/meetings/turn minted', async () => {
    const turn = [
      {
        urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'u',
        credential: 'c',
      },
    ];
    mocks.meetingIceServers.mockResolvedValue(turn);
    expect((await (await join()).json()).iceServers).toEqual(turn);
  });

  it('opens a session, closes older seats, inserts the new one', async () => {
    const res = await join();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      participantId: 'part-1',
      sessionId: 'sess-1',
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    });
    expect(mocks.rpc).toHaveBeenCalledWith('meeting_can_view', {
      p_meeting: M,
    });
    expect(mocks.adminCalls).toEqual([
      'close',
      `insert ${JSON.stringify({ meeting_id: M, account_id: 'acct-1', user_id: 'user-1', cf_session_id: 'sess-1' })}`,
    ]);
  });

  it('retries once when a racing tab took the open seat (23505)', async () => {
    mocks.insertResults = [{ data: null, error: { code: '23505' } }];
    const res = await join();
    expect(res.status).toBe(200);
    expect(mocks.adminCalls.filter((c) => c === 'close')).toHaveLength(2);
    expect(mocks.adminCalls.filter((c) => c.startsWith('insert'))).toHaveLength(
      2
    );
  });

  it('answers 404 when meeting_can_view says no, writing nothing', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await join()).status).toBe(404);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.adminCalls).toEqual([]);
  });

  it('answers 503, not 404, when meeting_can_view itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    const res = await join();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.adminCalls).toEqual([]);
  });

  it('refuses someone the host removed, before any Cloudflare session', async () => {
    mocks.removal = { user_id: 'user-1' };
    const res = await join();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'removed_from_meeting' });
    expect(mocks.removalEq).toEqual([
      ['meeting_id', M],
      ['user_id', 'user-1'],
    ]);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.adminCalls).toEqual([]);
  });

  it('answers 409 for an ended or cancelled meeting', async () => {
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'ended' };
    expect((await join()).status).toBe(409);
    expect(mocks.adminCalls).toEqual([]);
  });

  it('answers 503 meetings_not_configured without the env vars', async () => {
    mocks.configured.mockReturnValue(false);
    const res = await join();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'meetings_not_configured' });
  });

  it('refuses a bank guest', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'bank_guest',
      supabase: { from: meetings, rpc: mocks.rpc },
    });
    expect((await join()).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
