import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ending stamps the meeting, and 106's trigger closes every open seat,
// but Cloudflare keeps relaying: the route reads the open seats before
// the update and cuts their sessions after it.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  cutSeats: vi.fn(),
  log: [] as string[],
  seats: { data: [] as unknown[], error: null as unknown },
  ended: { data: null as unknown, error: null as unknown },
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

import { POST } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: M }) };
const MEETING = { id: M, account_id: 'acct-1', status: 'scheduled' };

function from(table: string) {
  const q: Record<string, unknown> = {};
  let op = 'select';
  for (const m of ['select', 'eq']) q[m] = () => q;
  q.update = () => ((op = 'update'), q);
  q.is = async () => (mocks.log.push(`read ${table}`), mocks.seats);
  q.maybeSingle = async () => {
    if (op === 'update') {
      mocks.log.push('end');
      return mocks.ended;
    }
    return { data: MEETING, error: null };
  };
  return q;
}

const end = () => POST(new Request('http://x', { method: 'POST' }), params);

describe('POST /api/meetings/[id]/end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.log = [];
    mocks.seats = {
      data: [{ cf_session_id: 's1' }, { cf_session_id: 's2' }],
      error: null,
    };
    mocks.ended = { data: { ...MEETING, status: 'ended' }, error: null };
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from, rpc: mocks.rpc },
    });
  });

  it('reads the open seats, ends the meeting, then cuts them', async () => {
    expect((await end()).status).toBe(200);
    expect(mocks.log).toEqual(['read meeting_participants', 'end', 'cut']);
    expect(mocks.cutSeats).toHaveBeenCalledWith([
      { cf_session_id: 's1' },
      { cf_session_id: 's2' },
    ]);
  });

  it('answers 503 and ends nothing when the seats cannot be read', async () => {
    mocks.seats = { data: [], error: { code: '57014' } };
    expect((await end()).status).toBe(503);
    expect(mocks.log).toEqual(['read meeting_participants']);
  });

  it('cuts nothing when another request ended it first', async () => {
    mocks.ended = { data: null, error: null };
    expect((await end()).status).toBe(409);
    expect(mocks.cutSeats).not.toHaveBeenCalled();
  });

  it('answers 503, not 403, when meeting_can_manage itself fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    const res = await end();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(mocks.log).toEqual([]);
  });
});
