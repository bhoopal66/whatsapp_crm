import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { cutSeats } from './cut';

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
