import { beforeEach, describe, expect, it, vi } from 'vitest';

// Inviting runs on the caller's client, so 110's host-only policy and
// 106's staff guard decide; the route's own job is what never reaches
// them: nobody new to add, a closed meeting, the 100 cap.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  upsert: vi.fn(),
  meeting: null as unknown,
  meetingError: null as unknown,
  invitees: { data: [] as unknown, error: null as unknown },
  removed: { data: [] as unknown, error: null as unknown },
  written: { error: null as unknown },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const HOST = '11111111-1111-4111-8111-111111111111';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const params = { params: Promise.resolve({ id: M }) };

function from(table: string) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.in = () => q;
  q.maybeSingle = async () => ({
    data: mocks.meeting,
    error: mocks.meetingError,
  });
  q.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve(
      table === 'meeting_removed_users' ? mocks.removed : mocks.invitees
    ).then(ok);
  if (table === 'meeting_invitees') {
    q.upsert = async (rows: unknown, opts: unknown) => {
      mocks.upsert(rows, opts);
      return mocks.written;
    };
  }
  return q;
}

const invite = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params
  );

describe('POST /api/meetings/[id]/invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'team_leader',
      userId: HOST,
      accountId: 'acct-1',
      supabase: { from },
    });
    mocks.meeting = {
      id: M,
      account_id: 'acct-1',
      host_user_id: HOST,
      status: 'scheduled',
    };
    mocks.meetingError = null;
    mocks.invitees = { data: [], error: null };
    mocks.removed = { data: [], error: null };
    mocks.written = { error: null };
  });

  it('adds the people through the caller’s client, in one write', async () => {
    const res = await invite({ userIds: [U1, U2] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invited: [U1, U2], needs_readmit: [] });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith(
      [
        { meeting_id: M, account_id: 'acct-1', user_id: U1 },
        { meeting_id: M, account_id: 'acct-1', user_id: U2 },
      ],
      { onConflict: 'meeting_id,user_id', ignoreDuplicates: true }
    );
  });

  it('skips someone already invited and the host, silently', async () => {
    mocks.invitees = { data: [{ user_id: U1.toUpperCase() }], error: null };
    const res = await invite({ userIds: [U1, U2, HOST] });
    expect(await res.json()).toEqual({ invited: [U2], needs_readmit: [] });
    expect(mocks.upsert.mock.calls[0][0]).toEqual([
      { meeting_id: M, account_id: 'acct-1', user_id: U2 },
    ]);
  });

  it('answers an empty list, writing nothing, when nobody is new', async () => {
    mocks.invitees = { data: [{ user_id: U1 }], error: null };
    const res = await invite({ userIds: [U1, HOST] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invited: [], needs_readmit: [] });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('names someone the host removed instead of inviting them', async () => {
    mocks.removed = { data: [{ user_id: U1 }], error: null };
    let res = await invite({ userIds: [U1, U2] });
    expect(await res.json()).toEqual({ invited: [U2], needs_readmit: [U1] });
    expect(mocks.upsert.mock.calls[0][0]).toEqual([
      { meeting_id: M, account_id: 'acct-1', user_id: U2 },
    ]);
    // Still on the invitee list from before, as a removal leaves them.
    mocks.upsert.mockClear();
    mocks.invitees = { data: [{ user_id: U1 }], error: null };
    res = await invite({ userIds: [U1] });
    expect(await res.json()).toEqual({ invited: [], needs_readmit: [U1] });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('invites nobody when the removals cannot be read', async () => {
    mocks.removed = { data: null, error: { message: 'boom' } };
    expect((await invite({ userIds: [U1] })).status).toBe(503);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('refuses a bad body before reading anything', async () => {
    expect((await invite({ userIds: [] })).status).toBe(400);
    expect((await invite({ userIds: ['x'] })).status).toBe(400);
    expect((await invite(null)).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('answers 403 in plain words to someone who is not the host', async () => {
    mocks.meeting = { ...(mocks.meeting as object), host_user_id: U2 };
    const res = await invite({ userIds: [U1] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/only the organiser/i);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('answers 403 even when a non-host names nobody new', async () => {
    mocks.meeting = { ...(mocks.meeting as object), host_user_id: U2 };
    mocks.invitees = { data: [{ user_id: U1 }], error: null };
    expect((await invite({ userIds: [U1] })).status).toBe(403);
  });

  it('answers the same 403 when the policy refuses the write', async () => {
    mocks.written = { error: { code: '42501', message: 'row-level security' } };
    const res = await invite({ userIds: [U1] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/only the organiser/i);
  });

  it('answers 404 for a meeting the caller cannot see', async () => {
    mocks.meeting = null;
    expect((await invite({ userIds: [U1] })).status).toBe(404);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each(['ended', 'cancelled'])('answers 409 on a meeting %s', async (s) => {
    mocks.meeting = { ...(mocks.meeting as object), status: s };
    expect((await invite({ userIds: [U1] })).status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('answers 503, not 404, when the meeting read fails', async () => {
    mocks.meeting = null;
    mocks.meetingError = { code: '57014' };
    const res = await invite({ userIds: [U1] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('answers 503 when the invitee read fails, writing nothing', async () => {
    mocks.invitees = { data: null, error: { code: '57014' } };
    expect((await invite({ userIds: [U1] })).status).toBe(503);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  describe('the 100 cap', () => {
    const others = (n: number) => ({
      data: Array.from({ length: n }, (_, i) => ({
        user_id: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`,
      })),
      error: null,
    });

    it('fills up to it', async () => {
      mocks.invitees = others(98);
      expect((await invite({ userIds: [U1, U2] })).status).toBe(200);
    });

    it('refuses past it, adding nobody', async () => {
      mocks.invitees = others(99);
      const res = await invite({ userIds: [U1, U2] });
      expect(res.status).toBe(400);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it('counts only the people who are new', async () => {
      const full = others(100);
      mocks.invitees = full;
      const already = full.data[0].user_id;
      expect((await invite({ userIds: [already] })).status).toBe(200);
    });
  });

  it('maps someone who is not staff as PATCH does', async () => {
    mocks.written = {
      error: { code: '23514', message: 'Only a live staff member…' },
    };
    const res = await invite({ userIds: [U1] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Only a live staff member…' });
  });

  it('keeps any other write failure a 500', async () => {
    mocks.written = { error: { code: 'XX000' } };
    expect((await invite({ userIds: [U1] })).status).toBe(500);
  });

  it('refuses a bank guest', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'bank_guest',
      supabase: { from },
    });
    expect((await invite({ userIds: [U1] })).status).toBe(403);
  });
});
