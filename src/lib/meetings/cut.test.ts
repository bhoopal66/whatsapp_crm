import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Cutting a seat closes its Cloudflare session's tracks with force:true
// (no SDP exchange). Best-effort: never throws, skips when unconfigured.

const mocks = vi.hoisted(() => ({
  configured: vi.fn(() => true),
  getSession: vi.fn(),
  closeTracks: vi.fn(),
}));

vi.mock('./sfu', () => ({
  isMeetingsConfigured: mocks.configured,
  getSession: mocks.getSession,
  closeTracks: mocks.closeTracks,
}));

import { cutMemberSeats, cutSeats, MEMBER_CUT_WAIT_MS } from './cut';

describe('cutSeats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.configured.mockReturnValue(true);
    mocks.closeTracks.mockResolvedValue({});
  });

  it('does nothing when meetings are not configured', async () => {
    mocks.configured.mockReturnValue(false);
    await cutSeats([{ cf_session_id: 's1' }]);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.closeTracks).not.toHaveBeenCalled();
  });

  it('force-closes the open mids of each session', async () => {
    mocks.getSession.mockImplementation(async (sid: string) =>
      sid === 's1'
        ? {
            tracks: [
              { location: 'local', mid: '0', status: 'active' },
              { location: 'remote', mid: '1', status: 'active' },
              { location: 'remote', mid: '2', status: 'inactive' },
            ],
          }
        : { tracks: [{ location: 'remote', mid: '5', status: 'active' }] }
    );
    await cutSeats([{ cf_session_id: 's1' }, { cf_session_id: 's2' }]);
    expect(mocks.closeTracks).toHaveBeenCalledTimes(2);
    expect(mocks.closeTracks).toHaveBeenCalledWith('s1', {
      tracks: [{ mid: '0' }, { mid: '1' }],
      force: true,
    });
    expect(mocks.closeTracks).toHaveBeenCalledWith('s2', {
      tracks: [{ mid: '5' }],
      force: true,
    });
  });

  it('sends no close for a session with nothing open', async () => {
    mocks.getSession.mockResolvedValue({
      tracks: [{ mid: '0', status: 'inactive' }],
    });
    await cutSeats([{ cf_session_id: 's1' }]);
    expect(mocks.closeTracks).not.toHaveBeenCalled();
  });

  it('never throws on a Cloudflare error, and still cuts the others', async () => {
    mocks.getSession.mockImplementation(async (sid: string) => {
      if (sid === 'bad') throw new Error('Cloudflare Realtime answered 500');
      return { tracks: [{ mid: '3', status: 'active' }] };
    });
    mocks.closeTracks.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      cutSeats([
        { cf_session_id: 'bad' },
        { cf_session_id: 'ok' },
        { cf_session_id: 'ok2' },
      ])
    ).resolves.toBeUndefined();
    expect(mocks.closeTracks).toHaveBeenCalledTimes(2);
  });

  it('logs nothing when the session is already gone (410)', async () => {
    mocks.getSession.mockRejectedValue(
      Object.assign(new Error('gone'), { status: 410, code: 'session_error' })
    );
    await cutSeats([{ cf_session_id: 's1' }]);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('cutMemberSeats', () => {
  const calls: unknown[][] = [];
  let answer: { data: unknown; error: unknown };
  const admin = {
    from: (table: string) => {
      calls.push(['from', table]);
      const q: Record<string, unknown> = {};
      for (const m of ['update', 'eq', 'is']) {
        q[m] = (...a: unknown[]) => (calls.push([m, ...a]), q);
      }
      q.select = async () => answer;
      return q;
    },
  } as unknown as SupabaseClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    calls.length = 0;
    answer = { data: [{ cf_session_id: 's1' }], error: null };
    mocks.configured.mockReturnValue(true);
    mocks.getSession.mockResolvedValue({
      tracks: [{ mid: '0', status: 'active' }],
    });
    mocks.closeTracks.mockResolvedValue({});
  });
  afterEach(() => vi.useRealTimers());

  it('closes the open seats of that person in that account, then cuts', async () => {
    await cutMemberSeats(admin, 'acct-1', 'user-2');
    expect(calls).toEqual([
      ['from', 'meeting_participants'],
      ['update', { left_at: '2026-11-24T10:00:00.000Z' }],
      ['eq', 'account_id', 'acct-1'],
      ['eq', 'user_id', 'user-2'],
      ['is', 'left_at', null],
    ]);
    expect(mocks.closeTracks).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs and never throws when the seats could not be closed', async () => {
    answer = { data: null, error: { code: '57014' } };
    await expect(
      cutMemberSeats(admin, 'acct-1', 'user-2')
    ).resolves.toBeUndefined();
    expect(mocks.closeTracks).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('does not hold the answer for a Cloudflare that does not reply', async () => {
    mocks.getSession.mockReturnValue(new Promise(() => {}));
    const done = vi.fn();
    void cutMemberSeats(admin, 'acct-1', 'user-2').then(done);
    await vi.advanceTimersByTimeAsync(MEMBER_CUT_WAIT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });
});
