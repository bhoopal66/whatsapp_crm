import { beforeEach, describe, expect, it, vi } from 'vitest';

// Any viewer of the meeting may read it, seats included, past meetings
// too: both reads go through the caller's client.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  meeting: null as unknown,
  meetingError: null as unknown,
  seats: { data: [] as unknown, error: null as unknown, count: 0 as number },
  seatQuery: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { GET } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: M }) };

function from(table: string) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (column: string, value: unknown) => {
    if (table === 'meeting_participants') mocks.seatQuery(column, value);
    return q;
  };
  q.order = () => q;
  q.range = async () => mocks.seats;
  q.maybeSingle = async () => ({
    data: mocks.meeting,
    error: mocks.meetingError,
  });
  return q;
}

const read = () => GET(new Request('http://x'), params);

const seat = {
  user_id: 'u-1',
  joined_at: '2026-11-05T10:00:00.000Z',
  last_seen_at: '2026-11-05T10:30:00.000Z',
  left_at: '2026-11-05T10:30:00.000Z',
  removed_at: null,
};

describe('GET /api/meetings/[id]/attendance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'viewer',
      userId: 'viewer-1',
      accountId: 'acct-1',
      supabase: { from },
    });
    mocks.meeting = {
      id: M,
      account_id: 'acct-1',
      status: 'ended',
      ended_at: '2026-11-05T11:00:00.000Z',
    };
    mocks.meetingError = null;
    mocks.seats = { data: [seat], error: null, count: 1 };
  });

  it('answers the entries in snake_case with the summary', async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      attendance: [
        {
          user_id: 'u-1',
          first_joined_at: '2026-11-05T10:00:00.000Z',
          last_left_at: '2026-11-05T10:30:00.000Z',
          total_ms: 1_800_000,
          seats: 1,
          removed: false,
        },
      ],
      summary: {
        people: 1,
        started_at: '2026-11-05T10:00:00.000Z',
        ended_at: '2026-11-05T10:30:00.000Z',
        longest_ms: 1_800_000,
      },
    });
    expect(mocks.seatQuery).toHaveBeenCalledWith('meeting_id', M);
    expect(mocks.seatQuery).toHaveBeenCalledWith('account_id', 'acct-1');
  });

  it('clamps to when the meeting ended', async () => {
    mocks.meeting = {
      ...(mocks.meeting as object),
      ended_at: '2026-11-05T10:10:00.000Z',
    };
    const { attendance } = await (await read()).json();
    expect(attendance[0].total_ms).toBe(600_000);
  });

  it('reads a live seat as present on a meeting not ended', async () => {
    const now = Date.now();
    mocks.meeting = {
      ...(mocks.meeting as object),
      status: 'scheduled',
      ended_at: null,
    };
    mocks.seats = {
      data: [
        {
          ...seat,
          joined_at: new Date(now - 600_000).toISOString(),
          last_seen_at: new Date(now - 5_000).toISOString(),
          left_at: null,
        },
      ],
      error: null,
      count: 1,
    };
    const { attendance, summary } = await (await read()).json();
    expect(attendance[0].last_left_at).toBeNull();
    expect(attendance[0].total_ms).toBeGreaterThanOrEqual(600_000);
    expect(summary.ended_at).toBeNull();
  });

  it('answers an empty report for a meeting nobody joined', async () => {
    mocks.seats = { data: [], error: null, count: 0 };
    expect(await (await read()).json()).toEqual({
      attendance: [],
      summary: { people: 0, started_at: null, ended_at: null, longest_ms: 0 },
    });
  });

  it('answers 404 for a meeting the caller cannot see', async () => {
    mocks.meeting = null;
    expect((await read()).status).toBe(404);
  });

  it('answers 503, not 404, when the meeting read fails', async () => {
    mocks.meeting = null;
    mocks.meetingError = { code: '57014' };
    const res = await read();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('answers 503 when the seats read fails', async () => {
    mocks.seats = { data: null, error: { code: '57014' }, count: 0 };
    expect((await read()).status).toBe(503);
  });

  it('refuses a bad id and a bank guest', async () => {
    const bad = await GET(new Request('http://x'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(bad.status).toBe(400);
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'bank_guest',
      supabase: { from },
    });
    expect((await read()).status).toBe(403);
  });
});
