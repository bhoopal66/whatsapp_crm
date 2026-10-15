import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH writes the invitee change before the meeting itself, so a
// refused invitee (23514: not a live staff member) leaves the title and
// the current invitee list untouched. A PATCH that takes access away
// closes and cuts the seats of the people who lost it (M1), and an RPC
// failure is a 503, not a 403/404.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  rpc: vi.fn(),
  cutSeats: vi.fn(),
  writes: [] as string[],
  insertError: null as unknown,
  meeting: {} as Record<string, unknown>,
  seats: [] as { id: string; user_id: string; cf_session_id: string }[],
  profiles: [] as { user_id: string; role: string }[],
  closedSeatIds: [] as unknown[],
  inviteeReadError: null as unknown,
  chatCount: 0,
  chatError: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/meetings/cut', () => ({
  cutSeats: async (seats: unknown) => (
    mocks.writes.push('cut'),
    mocks.cutSeats(seats)
  ),
}));
vi.mock('@/lib/meetings/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meetings/server')>()),
  supabaseAdmin: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let op = 'select';
      for (const m of ['select', 'eq', 'is']) q[m] = () => q;
      q.update = () => ((op = 'update'), q);
      q.in = (_col: string, ids: unknown) => (
        op === 'update' &&
          (mocks.writes.push('close seats'), mocks.closedSeatIds.push(ids)),
        q
      );
      q.then = (resolve: (v: unknown) => void) =>
        resolve(
          table === 'profiles'
            ? { data: mocks.profiles, error: null }
            : { error: null }
        );
      return q;
    },
  }),
}));

import { DELETE, GET, PATCH } from './route';

const M = '22222222-2222-4222-8222-222222222222';
const OLD = '44444444-4444-4444-8444-444444444444';
const NEW = '55555555-5555-4555-8555-555555555555';
const HOST = '66666666-6666-4666-8666-666666666666';
const ADMIN = '77777777-7777-4777-8777-777777777777';
const STRANGER = '88888888-8888-4888-8888-888888888888';
const params = { params: Promise.resolve({ id: M }) };

function from(table: string) {
  const q: Record<string, unknown> = {};
  let op = 'select';
  let values: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'is', 'gt']) q[m] = () => q;
  q.update = (v: Record<string, unknown>) => (
    (op = 'update'),
    (values = v),
    mocks.writes.push('update'),
    q
  );
  q.delete = () => ((op = 'delete'), mocks.writes.push('delete'), q);
  q.insert = async () => (
    mocks.writes.push('insert'),
    { error: mocks.insertError }
  );
  q.maybeSingle = async () => ({
    data: op === 'update' ? { ...mocks.meeting, ...values } : mocks.meeting,
    error: null,
  });
  q.then = (resolve: (v: unknown) => void) => {
    if (table === 'meeting_messages') {
      return resolve({ count: mocks.chatCount, error: mocks.chatError });
    }
    if (table === 'meeting_invitees' && op === 'select') {
      return resolve(
        mocks.inviteeReadError
          ? { data: null, error: mocks.inviteeReadError }
          : { data: [{ user_id: OLD }], error: null }
      );
    }
    if (table === 'meeting_participants') {
      mocks.writes.push('read seats');
      return resolve({ data: mocks.seats, error: null });
    }
    return resolve({ error: null });
  };
  return q;
}

const patch = (body: unknown) =>
  PATCH(
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
    params
  );
const seat = (user_id: string) => ({
  id: `seat-${user_id.slice(0, 1)}`,
  user_id,
  cf_session_id: `sess-${user_id.slice(0, 1)}`,
});

describe('PATCH /api/meetings/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.writes = [];
    mocks.insertError = null;
    mocks.closedSeatIds = [];
    mocks.seats = [];
    mocks.profiles = [];
    mocks.meeting = {
      id: M,
      account_id: 'acct-1',
      host_user_id: HOST,
      open_to_workspace: false,
      status: 'scheduled',
      title: 'T',
    };
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from, rpc: mocks.rpc },
    });
  });

  it('adds, then removes, then updates the meeting', async () => {
    expect(
      (await patch({ title: 'Renamed', inviteeUserIds: [NEW] })).status
    ).toBe(200);
    expect(mocks.writes.slice(0, 3)).toEqual(['insert', 'delete', 'update']);
  });

  it('changes nothing else when an invitee is refused', async () => {
    mocks.insertError = { code: '23514', message: 'Only a live staff member' };
    expect(
      (await patch({ title: 'Renamed', inviteeUserIds: [NEW] })).status
    ).toBe(400);
    expect(mocks.writes).toEqual(['insert']);
  });

  it('closes and cuts a removed invitee’s seat, keeping host, invitees and admins', async () => {
    mocks.seats = [seat(OLD), seat(HOST), seat(NEW), seat(ADMIN)];
    mocks.profiles = [
      { user_id: OLD, role: 'agent' },
      { user_id: ADMIN, role: 'admin' },
    ];
    expect((await patch({ inviteeUserIds: [NEW] })).status).toBe(200);
    expect(mocks.writes).toEqual([
      'insert',
      'delete',
      'read seats',
      'close seats',
      'cut',
    ]);
    expect(mocks.closedSeatIds).toEqual([[seat(OLD).id]]);
    expect(mocks.cutSeats).toHaveBeenCalledWith([seat(OLD)]);
  });

  it('closes the workspace’s seats when open_to_workspace goes off', async () => {
    mocks.meeting.open_to_workspace = true;
    mocks.seats = [seat(STRANGER), seat(OLD)];
    mocks.profiles = [{ user_id: STRANGER, role: 'viewer' }];
    expect((await patch({ openToWorkspace: false })).status).toBe(200);
    expect(mocks.closedSeatIds).toEqual([[seat(STRANGER).id]]);
    expect(mocks.cutSeats).toHaveBeenCalledWith([seat(STRANGER)]);
  });

  it('closes nobody while the meeting stays open to the workspace', async () => {
    mocks.meeting.open_to_workspace = true;
    mocks.seats = [seat(OLD)];
    expect((await patch({ inviteeUserIds: [NEW] })).status).toBe(200);
    expect(mocks.writes).not.toContain('read seats');
    expect(mocks.cutSeats).not.toHaveBeenCalled();
  });

  it('answers 503, not 403, when meeting_can_manage itself fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    const res = await patch({ title: 'Renamed' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(mocks.writes).toEqual([]);
  });
});

describe('GET /api/meetings/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inviteeReadError = null;
    mocks.chatCount = 0;
    mocks.chatError = null;
    mocks.seats = [];
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'scheduled' };
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from, rpc: mocks.rpc },
    });
  });

  it('lists the invitees', async () => {
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect((await res.json()).invitee_user_ids).toEqual([OLD]);
  });

  it('counts the chat lines, and answers 503 when that read fails', async () => {
    mocks.chatCount = 12;
    const res = await GET(new Request('http://x'), params);
    expect((await res.json()).chat_count).toBe(12);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.chatError = { code: '57014' };
    expect((await GET(new Request('http://x'), params)).status).toBe(503);
  });

  // The edit dialog saves the list it was shown: an empty list from a
  // failed read would PATCH every invitee away.
  it('answers 503, not an empty invitee list, when that read fails', async () => {
    mocks.inviteeReadError = { code: '57014' };
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });
});

describe('DELETE /api/meetings/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writes = [];
    mocks.seats = [seat(OLD)];
    mocks.meeting = { id: M, account_id: 'acct-1', status: 'scheduled' };
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from, rpc: mocks.rpc },
    });
  });

  it('reads the open seats, cancels, then cuts them', async () => {
    const res = await DELETE(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.writes).toEqual(['read seats', 'update', 'cut']);
    expect(mocks.cutSeats).toHaveBeenCalledWith([seat(OLD)]);
  });
});
