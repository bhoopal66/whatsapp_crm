import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';
import { WhapiError } from '@/lib/whatsapp/whapi-api';

// Deleting is owner/admin only, for good, and confined to the caller's
// active account. A still-joined group is left on WhatsApp first; a
// submission group is never touched; the tombstone goes before the row.

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  channelForGroup: vi.fn(),
  leaveGroup: vi.fn(),
  probeChannel: vi.fn(),
  admin: null as unknown,
}));

// `requireRole` calls `getCurrentAccount` inside its own module, so it
// is re-implemented over the mock with the real role ladder and error.
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...real,
    requireRole: async (min: Parameters<typeof hasMinRole>[1]) => {
      const ctx = await mocks.getCurrentAccount();
      if (!hasMinRole(ctx.role, min)) {
        throw new real.ForbiddenError('Insufficient role');
      }
      return ctx;
    },
  };
});
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => mocks.admin,
  channelForGroup: mocks.channelForGroup,
}));
vi.mock('@/lib/whatsapp/groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/groups')>()),
  leaveGroup: mocks.leaveGroup,
}));
vi.mock('@/lib/whatsapp/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/provider')>()),
  probeChannel: mocks.probeChannel,
}));

import { POST } from './route';

const LEFT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER_ACCT = '33333333-3333-4333-8333-333333333333';
const LEFT2 = '44444444-4444-4444-8444-444444444444';
const MISSING = '55555555-5555-4555-8555-555555555555';
const MIRROR = '66666666-6666-4666-8666-666666666666';
const ORPHAN = '77777777-7777-4777-8777-777777777777';
const ADMIN_ROLE = '88888888-8888-4888-8888-888888888888';

const AUTHORIZED = { status: 'AUTH', authorized: true, phone: '971500000000' };

const wa = (id: string) => `wa-${id.slice(0, 1)}@g.us`;
const row = (
  id: string,
  our_role: string,
  account_id = 'acct-1',
  channel_id: string | null = 'ch-1'
) => ({ id, account_id, channel_id, wa_group_id: wa(id), our_role });

let db: FakeDb;
const groups = () => db.tables.whatsapp_groups;
const stones = () => db.tables.whatsapp_group_tombstones;
const ids = () => groups().map((g) => g.id);
const writesTo = (table: string) =>
  (db.writes ?? []).filter(([t]) => t === table);

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/whatsapp/groups/delete', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

function asRole(role: string) {
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: {},
    userId: 'u-1',
    accountId: 'acct-1',
    role,
    account: { id: 'acct-1', name: 'A' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = {
    tables: {
      whatsapp_groups: [
        row(LEFT, 'left'),
        row(LEFT2, 'left'),
        row(MEMBER, 'member'),
        row(ADMIN_ROLE, 'admin'),
        row(MIRROR, 'member'),
        row(ORPHAN, 'member', 'acct-1', null),
        row(OTHER_ACCT, 'left', 'acct-2'),
      ],
      submission_groups: [
        { account_id: 'acct-1', channel_id: 'ch-1', wa_group_id: wa(MIRROR) },
        // Another workspace's submission group refuses nothing here.
        { account_id: 'acct-2', channel_id: 'ch-9', wa_group_id: wa(LEFT2) },
      ],
      whatsapp_group_tombstones: [],
    },
    writes: [],
  };
  mocks.admin = fakeSupabase(db);
  mocks.channelForGroup.mockResolvedValue({
    id: 'ch-1',
    provider: 'whapi',
    status: 'connected',
  });
  mocks.leaveGroup.mockResolvedValue(undefined);
  mocks.probeChannel.mockResolvedValue(AUTHORIZED);
  asRole('admin');
});

describe('POST /api/whatsapp/groups/delete', () => {
  it('refuses a team leader before touching the database', async () => {
    asRole('team_leader');
    const res = await post({ ids: [LEFT] });
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty('error');
    expect(db.writes).toEqual([]);
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', null],
    ['no ids', {}],
    ['empty ids', { ids: [] }],
    ['a non-uuid', { ids: [LEFT, 'nope'] }],
    ['over 100 ids', { ids: Array.from({ length: 101 }, () => LEFT) }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(db.writes).toEqual([]);
  });

  it('deletes left groups of the caller account with no gateway call', async () => {
    const res = await post({ ids: [LEFT, OTHER_ACCT, LEFT2, MISSING] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted.sort()).toEqual([LEFT, LEFT2].sort());
    expect(body.skipped.sort()).toEqual([OTHER_ACCT, MISSING].sort());
    expect(body.refused).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(ids()).toContain(OTHER_ACCT);
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
  });

  it('tombstones a left group before deleting it', async () => {
    asRole('owner');
    const res = await post({ ids: [LEFT] });
    expect(await res.json()).toEqual({
      deleted: [LEFT],
      skipped: [],
      refused: [],
      failed: [],
    });
    expect(stones()).toEqual([
      expect.objectContaining({
        account_id: 'acct-1',
        channel_id: 'ch-1',
        wa_group_id: wa(LEFT),
        deleted_by: 'u-1',
      }),
    ]);
    expect((db.writes ?? []).map(([t, op]) => `${t}:${op}`)).toEqual([
      'whatsapp_group_tombstones:upsert',
      'whatsapp_groups:delete',
    ]);
  });

  it('keeps a group re-joined between the read and the delete', async () => {
    // The re-join lands while the tombstone is being written, so only
    // the `our_role` filter on the DELETE itself can save the group.
    const base = fakeSupabase(db);
    mocks.admin = {
      ...base,
      from(table: string) {
        if (table === 'whatsapp_group_tombstones') {
          groups().find((g) => g.id === LEFT)!.our_role = 'member';
        }
        return base.from(table);
      },
    };
    const res = await post({ ids: [LEFT, LEFT2] });
    expect(await res.json()).toMatchObject({
      deleted: [LEFT2],
      skipped: [LEFT],
    });
    expect(ids()).toContain(LEFT);
    // It keeps syncing: no tombstone may outlive the surviving row.
    expect(stones().map((s) => s.wa_group_id)).toEqual([wa(LEFT2)]);
  });

  it('leaves a joined group first, then tombstones and deletes it', async () => {
    const res = await post({ ids: [MEMBER] });
    expect(await res.json()).toEqual({
      deleted: [MEMBER],
      skipped: [],
      refused: [],
      failed: [],
    });
    expect(mocks.leaveGroup).toHaveBeenCalledTimes(1);
    expect(mocks.leaveGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: wa(MEMBER) })
    );
    expect(ids()).not.toContain(MEMBER);
    expect(stones()).toHaveLength(1);
  });

  it('writes nothing when the gateway refuses the leave', async () => {
    mocks.leaveGroup.mockImplementation(async () => {
      expect(db.writes).toEqual([]);
      throw new WhapiError('boom', 500);
    });
    const res = await post({ ids: [MEMBER] });
    expect(await res.json()).toEqual({
      deleted: [],
      skipped: [],
      refused: [],
      failed: [{ id: MEMBER, reason: 'WhatsApp did not respond; try again' }],
    });
    expect(ids()).toContain(MEMBER);
    expect(stones()).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('never leaves or deletes from a number marked disconnected', async () => {
    mocks.channelForGroup.mockResolvedValue({
      id: 'ch-1',
      provider: 'whapi',
      status: 'disconnected',
    });
    const body = await (await post({ ids: [MEMBER] })).json();
    expect(body.failed).toEqual([
      { id: MEMBER, reason: "The group's number is disconnected" },
    ]);
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(ids()).toContain(MEMBER);
    expect(stones()).toEqual([]);
  });

  describe('a leave answered 404', () => {
    // A wrong token is a 404 too, and this bare message is all Whapi's
    // error leaves us for a non-JSON body: only the probe can tell.
    const expectStillJoined = async () => {
      const body = await (await post({ ids: [MEMBER] })).json();
      expect(body.deleted).toEqual([]);
      expect(body.failed).toEqual([
        { id: MEMBER, reason: "The group's number is disconnected" },
      ]);
      expect(ids()).toContain(MEMBER);
      expect(stones()).toEqual([]);
      expect(db.writes).toEqual([]);
    };

    beforeEach(() => {
      mocks.leaveGroup.mockRejectedValue(
        new WhapiError('Whapi API error: 404', 404)
      );
    });

    it('counts as left when the number probes as authorized', async () => {
      const body = await (await post({ ids: [MEMBER] })).json();
      expect(mocks.probeChannel).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ch-1' })
      );
      expect(body.deleted).toEqual([MEMBER]);
      expect(body.failed).toEqual([]);
      expect(ids()).not.toContain(MEMBER);
      expect(stones()).toEqual([
        expect.objectContaining({ wa_group_id: wa(MEMBER) }),
      ]);
    });

    it('is a failure when the 404 names the token, whatever the probe says', async () => {
      mocks.leaveGroup.mockRejectedValue(
        new WhapiError('Service not found', 404)
      );
      await expectStillJoined();
    });

    it('is a failure when the probe throws', async () => {
      mocks.probeChannel.mockRejectedValue(
        new WhapiError('Service not found', 404)
      );
      await expectStillJoined();
    });

    it('is a failure when the number is not authorized', async () => {
      mocks.probeChannel.mockResolvedValue({
        ...AUTHORIZED,
        status: 'QR',
        authorized: false,
      });
      await expectStillJoined();
    });

    it('is a failure when the probe has nothing to say', async () => {
      mocks.probeChannel.mockResolvedValue(null);
      await expectStillJoined();
    });
  });

  it('words a refused number, not "not an admin", on a leave 403', async () => {
    mocks.leaveGroup.mockRejectedValue(new WhapiError('nope', 403));
    const body = await (await post({ ids: [MEMBER] })).json();
    expect(body.failed[0].reason).toBe("The group's number is disconnected");
    // Only a 404 can mean "already out": nothing to probe for.
    expect(mocks.probeChannel).not.toHaveBeenCalled();
    expect(stones()).toEqual([]);
  });

  it('treats a row with no number as left, with no tombstone', async () => {
    const body = await (await post({ ids: [ORPHAN] })).json();
    expect(body.deleted).toEqual([ORPHAN]);
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(mocks.channelForGroup).not.toHaveBeenCalled();
    expect(ids()).not.toContain(ORPHAN);
    expect(stones()).toEqual([]);
  });

  it('refuses a submission group: no leave, no delete, no tombstone', async () => {
    const res = await post({ ids: [MIRROR] });
    expect(await res.json()).toEqual({
      deleted: [],
      skipped: [],
      refused: [MIRROR],
      failed: [],
    });
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(ids()).toContain(MIRROR);
    expect(db.writes).toEqual([]);
  });

  it('refuses a left mirror too', async () => {
    groups().find((g) => g.id === MIRROR)!.our_role = 'left';
    const body = await (await post({ ids: [MIRROR, LEFT] })).json();
    expect(body.refused).toEqual([MIRROR]);
    expect(body.deleted).toEqual([LEFT]);
    expect(ids()).toContain(MIRROR);
  });

  it('stops everything when submission groups cannot be read', async () => {
    db.errors = { 'submission_groups:select': { message: 'down' } };
    const res = await post({ ids: [MEMBER, LEFT] });
    expect(res.status).toBe(500);
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('deletes nothing when the tombstone cannot be written', async () => {
    db.errors = { 'whatsapp_group_tombstones:upsert': { message: 'down' } };
    const body = await (await post({ ids: [LEFT] })).json();
    expect(body.deleted).toEqual([]);
    expect(body.failed).toEqual([{ id: LEFT, reason: expect.any(String) }]);
    expect(ids()).toContain(LEFT);
  });

  it('keeps the tombstone when the delete fails, so a retry can finish', async () => {
    db.errors = { 'whatsapp_groups:delete': { message: 'down' } };
    const body = await (await post({ ids: [MEMBER] })).json();
    expect(body.failed).toEqual([{ id: MEMBER, reason: expect.any(String) }]);
    expect(stones()).toHaveLength(1);
    // We did leave: the retry takes the left path, with no second leave.
    expect(groups().find((g) => g.id === MEMBER)?.our_role).toBe('left');
    db.errors = {};
    mocks.leaveGroup.mockClear();
    const retry = await (await post({ ids: [MEMBER] })).json();
    expect(retry.deleted).toEqual([MEMBER]);
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
  });

  it('takes at most 10 joined groups per call, the rest in failed', async () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
    );
    for (const [i, id] of many.entries()) {
      groups().push({ ...row(id, 'member'), wa_group_id: `m${i}@g.us` });
    }
    const body = await (await post({ ids: [...many, LEFT] })).json();
    expect(mocks.leaveGroup).toHaveBeenCalledTimes(10);
    expect(body.deleted).toHaveLength(11);
    expect(body.failed.map((f: { id: string }) => f.id)).toEqual(
      many.slice(10)
    );
    expect(ids()).toEqual(expect.arrayContaining(many.slice(10)));
  });

  it('starts no leave past the time budget', async () => {
    const now = vi.spyOn(Date, 'now');
    const start = Date.now();
    now.mockReturnValueOnce(start).mockReturnValue(start + 40_000);
    const body = await (await post({ ids: [MEMBER] })).json();
    now.mockRestore();
    expect(mocks.leaveGroup).not.toHaveBeenCalled();
    expect(body.failed).toHaveLength(1);
    expect(writesTo('whatsapp_groups')).toEqual([]);
  });
});
