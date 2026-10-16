import { beforeEach, describe, expect, it, vi } from 'vitest';

// Creating a meeting is the meeting plus its invitees under the caller's
// RLS client, all or nothing.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  insertMeeting: vi.fn(),
  insertInvitees: vi.fn(),
  deleteMeeting: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { MEETING_CREATORS_ONLY } from '@/lib/meetings/server';

import { GET, POST } from './route';

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function from(table: string) {
  if (table === 'meetings') {
    return {
      insert: (row: unknown) => {
        mocks.insertMeeting(row);
        return {
          select: () => ({
            single: async () => ({
              data: { id: 'm-1', title: 'Sync' },
              error: null,
            }),
          }),
        };
      },
      delete: () => ({ eq: mocks.deleteMeeting }),
    };
  }
  return { insert: mocks.insertInvitees };
}

const create = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/meetings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'team_leader',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from },
    });
    mocks.insertInvitees.mockResolvedValue({ error: null });
  });

  it('creates the meeting with the caller as host, then the invitees', async () => {
    const res = await create({ title: ' Sync ', inviteeUserIds: [U1] });
    expect(res.status).toBe(201);
    expect(mocks.insertMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sync',
        account_id: 'acct-1',
        host_user_id: 'user-1',
      })
    );
    expect(mocks.insertInvitees).toHaveBeenCalledWith([
      { meeting_id: 'm-1', account_id: 'acct-1', user_id: U1 },
    ]);
  });

  it('removes the meeting again when an invitee is refused', async () => {
    mocks.insertInvitees.mockResolvedValue({
      error: { code: '23514', message: 'Only a live staff member…' },
    });
    const res = await create({ title: 'Sync', inviteeUserIds: [U1] });
    expect(res.status).toBe(400);
    expect(mocks.deleteMeeting).toHaveBeenCalledWith('id', 'm-1');
  });

  it('refuses an invalid body before writing', async () => {
    expect((await create({ title: '' })).status).toBe(400);
    expect(mocks.insertMeeting).not.toHaveBeenCalled();
  });

  it.each(['agent', 'viewer'])(
    'refuses a %s: only team leaders and up create (111)',
    async (role) => {
      mocks.getCurrentAccount.mockResolvedValue({
        role,
        userId: 'user-1',
        accountId: 'acct-1',
        supabase: { from },
      });
      const res = await create({ title: 'Sync' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: MEETING_CREATORS_ONLY });
      expect(mocks.insertMeeting).not.toHaveBeenCalled();
    }
  );

  it('refuses a bank guest', async () => {
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'bank_guest',
      supabase: { from },
    });
    expect((await create({ title: 'Sync' })).status).toBe(403);
    expect((await GET(new Request('http://x/api/meetings'))).status).toBe(403);
    expect(mocks.insertMeeting).not.toHaveBeenCalled();
  });
});

describe('GET /api/meetings', () => {
  it('lists each meeting’s present seats with their raised hands', async () => {
    const meeting = {
      id: 'm-1',
      status: 'scheduled',
      scheduled_start: null,
      scheduled_end: null,
    };
    const result = (table: string) =>
      table === 'meetings'
        ? [meeting]
        : table === 'meeting_invitees'
          ? []
          : [
              { meeting_id: 'm-1', user_id: 'u-1', hand_raised_at: null },
              {
                meeting_id: 'm-1',
                user_id: 'u-2',
                hand_raised_at: '2026-10-15T08:00:00Z',
              },
            ];
    const list = (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of [
        'select',
        'eq',
        'is',
        'gt',
        'in',
        'or',
        'order',
        'limit',
      ])
        q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: result(table), error: null }).then(ok);
      return q;
    };
    mocks.getCurrentAccount.mockResolvedValue({
      role: 'agent',
      userId: 'user-1',
      accountId: 'acct-1',
      supabase: { from: list },
    });
    const res = await GET(new Request('http://x/api/meetings?scope=live'));
    expect(res.status).toBe(200);
    const [m] = (await res.json()).meetings;
    expect(m.present_count).toBe(2);
    expect(m.participants).toEqual([
      { user_id: 'u-1', hand_raised_at: null },
      { user_id: 'u-2', hand_raised_at: '2026-10-15T08:00:00Z' },
    ]);
  });
});
