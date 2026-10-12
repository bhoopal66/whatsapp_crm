import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelError } from '@/lib/whatsapp/channels';

const h = vi.hoisted(() => ({
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  sendRoomInvites: vi.fn(),
  metaChannel: vi.fn(),
}));
vi.mock('@/lib/whatsapp/meta-groups', () => ({
  listGroups: h.listGroups,
  createGroup: h.createGroup,
}));
vi.mock('./invites', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./invites')>()),
  sendRoomInvites: h.sendRoomInvites,
}));
vi.mock('./shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shared')>()),
  metaChannel: h.metaChannel,
}));

import { buildInviteClaim } from './invites';
import { reconcileCreatingRooms } from './reconcile';
import { memoryDb } from './test-db';

const NOW = new Date('2026-10-12T09:00:00.000Z');
const minutesAgo = (m: number) =>
  new Date(NOW.getTime() - m * 60_000).toISOString();
/** Unix seconds of a room created `m` minutes ago, plus `s`. */
const secondsAfter = (m: number, s: number) =>
  Math.floor(Date.parse(minutesAgo(m)) / 1000) + s;

const RETRY_NOTE =
  'WhatsApp had not confirmed the group after 2 minutes; asked again.';

const room = (over: Record<string, unknown> = {}) => ({
  id: 'room-1',
  account_id: 'acct-1',
  channel_id: 'chan-1',
  created_by: 'user-1',
  subject: 'Deal 42',
  description: 'Mortgage, unit 7',
  whatsapp_config_id: 'cfg-1',
  wa_group_id: null,
  create_request_id: 'req-1',
  status: 'creating',
  created_at: minutesAgo(3),
  last_error: null,
  ...over,
});

const group = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  subject: 'Deal 42',
  createdAt: secondsAfter(3, 20),
  ...over,
});

function setup(
  rooms: Record<string, unknown>[],
  beforeUpdate?: (table: string, values: Record<string, unknown>) => void,
  participants: Record<string, unknown>[] = []
) {
  const rpc = vi.fn((fn: string) =>
    fn === 'deal_room_group_created' ? 'room-1' : null
  );
  return {
    ...memoryDb(
      { deal_rooms: rooms, deal_room_participants: participants },
      { rpc, beforeUpdate }
    ),
    rpc,
  };
}

const groups = (...list: ReturnType<typeof group>[]) =>
  h.listGroups.mockResolvedValue({ groups: list, after: null });

const counts = (over: Record<string, number>) => ({
  checked: 1,
  opened: 0,
  retried: 0,
  failed: 0,
  waiting: 0,
  errors: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.metaChannel.mockResolvedValue({
    id: 'cfg-1',
    provider: 'meta',
    phoneNumberId: '106',
    accessToken: 'tok',
  });
  h.listGroups.mockResolvedValue({ groups: [], after: null });
  h.createGroup.mockResolvedValue({ requestId: 'req-retry' });
  h.sendRoomInvites.mockResolvedValue({ sent: 1 });
});

describe('reconcileCreatingRooms — matching', () => {
  it('opens the room on its one group, then invites', async () => {
    const mem = setup([room()]);
    groups(group('G1'));
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ opened: 1 })
    );
    expect(mem.rpcCalls).toEqual([
      [
        'deal_room_group_created',
        {
          p_account: 'acct-1',
          p_request_id: 'req-1',
          p_group_id: 'G1',
          p_invite_link_hash: null,
        },
      ],
    ]);
    expect(mem.tables.deal_room_audit).toEqual([
      {
        room_id: 'room-1',
        account_id: 'acct-1',
        actor_id: null,
        action: 'create_reconciled',
        detail: { group_id: 'G1' },
      },
    ]);
    expect(h.sendRoomInvites).toHaveBeenCalledWith(mem.db, 'room-1');
    expect(mem.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      h.sendRoomInvites.mock.invocationCallOrder[0]
    );
    expect(h.createGroup).not.toHaveBeenCalled();
  });

  it('records a request id first when the room has none', async () => {
    const mem = setup([room({ create_request_id: null })]);
    // A minute of clock skew: stamped 60 s before the room still counts.
    groups(group('G1', { createdAt: secondsAfter(3, -60) }));
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ opened: 1 })
    );
    expect(mem.rpcCalls).toEqual([
      [
        'deal_room_mark_requested',
        { p_room: 'room-1', p_request_id: 'reconciled:G1' },
      ],
      [
        'deal_room_group_created',
        {
          p_account: 'acct-1',
          p_request_id: 'reconciled:G1',
          p_group_id: 'G1',
          p_invite_link_hash: null,
        },
      ],
    ]);
    expect(h.sendRoomInvites).toHaveBeenCalledWith(mem.db, 'room-1');
  });

  it('only logs a failed invite: the room is open', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mem = setup([room()]);
    groups(group('G1'));
    h.sendRoomInvites.mockRejectedValue(new Error('template missing'));
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ opened: 1 })
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('ignores another subject, an older group, an undated one, and one a room has', async () => {
    const mem = setup([
      room(),
      room({
        id: 'room-0',
        status: 'open',
        wa_group_id: 'G4',
        created_at: minutesAgo(60),
      }),
    ]);
    groups(
      group('G1', { subject: 'Deal 42 ' }),
      group('G2', { createdAt: secondsAfter(3, -61) }),
      group('G3', { createdAt: null }),
      group('G4')
    );
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ retried: 1 })
    );
    expect(mem.rpcCalls).toEqual([]);
    expect(h.sendRoomInvites).not.toHaveBeenCalled();
  });

  it('lists each number once per run, following `after` for at most 5 pages', async () => {
    const mem = setup([
      room(),
      room({ id: 'room-2', subject: 'Deal 43', create_request_id: 'req-2' }),
    ]);
    h.listGroups.mockImplementation(async ({ after }) => {
      const page = after ? Number(after) : 0;
      return {
        groups: page === 1 ? [group('G1')] : [],
        after: String(page + 1),
      };
    });
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ checked: 2, opened: 1, retried: 1 })
    );
    expect(h.listGroups).toHaveBeenCalledTimes(5);
  });
});

describe('reconcileCreatingRooms — ambiguity', () => {
  it('neither opens nor retries with two groups', async () => {
    const mem = setup([room()]);
    groups(group('G1'), group('G2'));
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ waiting: 1 })
    );
    expect(mem.rpcCalls).toEqual([]);
    expect(h.createGroup).not.toHaveBeenCalled();
  });

  it.each([
    ['one group', [group('G1')]],
    ['no group', []],
  ])(
    'neither opens nor retries beside a twin room, with %s',
    async (_, list) => {
      // The twin is younger than 2 minutes: any age counts.
      const mem = setup([
        room(),
        room({
          id: 'room-2',
          channel_id: 'chan-2',
          create_request_id: 'req-2',
          created_at: NOW.toISOString(),
        }),
      ]);
      groups(...list);
      expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
        counts({ waiting: 1 })
      );
      expect(mem.rpcCalls).toEqual([]);
      expect(h.createGroup).not.toHaveBeenCalled();
    }
  );

  it('gives up on an ambiguous room at 10 minutes', async () => {
    const mem = setup([room({ created_at: minutesAgo(10) })]);
    groups(
      group('G1', { createdAt: secondsAfter(10, 5) }),
      group('G2', { createdAt: secondsAfter(10, 9) })
    );
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ failed: 1 })
    );
    expect(mem.rpcCalls.map(([fn]) => fn)).toEqual(['deal_room_set_status']);
  });
});

describe('reconcileCreatingRooms — retry', () => {
  it('asks Meta once more, claiming the retry, and never twice', async () => {
    const mem = setup([room()]);
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ retried: 1 })
    );
    expect(h.createGroup).toHaveBeenCalledTimes(1);
    expect(h.createGroup).toHaveBeenCalledWith({
      phoneNumberId: '106',
      accessToken: 'tok',
      subject: 'Deal 42',
      description: 'Mortgage, unit 7',
      joinApprovalMode: 'approval_required',
    });
    expect(mem.tables.deal_rooms[0].last_error).toBe(RETRY_NOTE);
    expect(mem.tables.deal_room_audit.map((a) => a.action)).toEqual([
      'create_retried',
    ]);
    // The retry's request id is not recorded: that would clear the claim.
    expect(mem.rpcCalls).toEqual([]);

    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ waiting: 1 })
    );
    expect(h.createGroup).toHaveBeenCalledTimes(1);
  });

  it('retries once when two ticks race', async () => {
    const mem = setup([room()]);
    const [a, b] = await Promise.all([
      reconcileCreatingRooms(mem.db, NOW),
      reconcileCreatingRooms(mem.db, NOW),
    ]);
    expect(h.createGroup).toHaveBeenCalledTimes(1);
    expect([a.retried + b.retried, a.waiting + b.waiting]).toEqual([1, 1]);
  });

  it('records a failed retry, and fails the room with it at 10 minutes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mem = setup([room()]);
    h.createGroup.mockRejectedValue(new Error('Meta API error: 500'));
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ retried: 1 })
    );
    expect(mem.tables.deal_rooms[0].last_error).toBe(
      'Retry failed: Meta API error: 500'
    );

    expect(
      await reconcileCreatingRooms(mem.db, new Date(NOW.getTime() + 7 * 60_000))
    ).toEqual(counts({ failed: 1 }));
    expect(mem.rpcCalls).toEqual([
      [
        'deal_room_set_status',
        {
          p_room: 'room-1',
          p_status: 'failed',
          p_reason:
            'WhatsApp had not confirmed the group after 10 minutes. ' +
            'Retry failed: Meta API error: 500',
        },
      ],
    ]);
    warn.mockRestore();
  });
});

describe('reconcileCreatingRooms — giving up', () => {
  const REASON = 'WhatsApp had not confirmed the group after 10 minutes.';

  it('waits on a retried room until 10 minutes', async () => {
    const mem = setup([room({ created_at: minutesAgo(9), last_error: 'x' })]);
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ waiting: 1 })
    );
    expect(mem.rpcCalls).toEqual([]);
  });

  it('fails a retried room after 10 minutes and tells its creator', async () => {
    const mem = setup([
      room({ created_at: minutesAgo(11), last_error: RETRY_NOTE }),
    ]);
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ failed: 1 })
    );
    expect(mem.tables.deal_rooms[0].last_error).toBe(REASON);
    expect(mem.rpcCalls).toEqual([
      [
        'deal_room_set_status',
        { p_room: 'room-1', p_status: 'failed', p_reason: REASON },
      ],
    ]);
    expect(mem.tables.notifications).toEqual([
      {
        account_id: 'acct-1',
        user_id: 'user-1',
        type: 'deal_room_update',
        title: 'Deal room could not be created',
        body: 'Deal 42',
        meta: {
          room_id: 'room-1',
          channel_id: 'chan-1',
          event: 'create_failed',
          reason: REASON,
        },
      },
    ]);
    expect(h.createGroup).not.toHaveBeenCalled();
  });

  it('loses a give-up to a room the webhook opened meanwhile', async () => {
    const stored = room({ created_at: minutesAgo(11), last_error: RETRY_NOTE });
    const mem = setup([stored], (table) => {
      if (table === 'deal_rooms') {
        Object.assign(stored, { status: 'open', wa_group_id: 'G9' });
      }
    });
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ waiting: 1 })
    );
    expect(mem.rpcCalls).toEqual([]);
    expect(mem.tables.notifications).toBeUndefined();
    expect(stored.status).toBe('open');
  });

  it('gives up at once when the Meta number cannot be read or is gone', async () => {
    h.metaChannel.mockRejectedValue(
      new ChannelError('channel_credentials_unreadable', 'no decrypt', 500)
    );
    let mem = setup([room()]);
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ failed: 1 })
    );
    expect(mem.rpcCalls).toEqual([
      [
        'deal_room_set_status',
        {
          p_room: 'room-1',
          p_status: 'failed',
          p_reason: "The Meta number's credentials could not be read.",
        },
      ],
    ]);

    mem = setup([room({ whatsapp_config_id: null })]);
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ failed: 1 })
    );
    expect(mem.rpcCalls[0][1].p_reason).toBe(
      "The room's Meta number is not connected."
    );
    expect(h.listGroups).not.toHaveBeenCalled();
  });

  it('counts a failed channel lookup as an error and leaves the room', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.metaChannel.mockRejectedValue(
      new ChannelError('channel_lookup_failed', 'Could not load', 500)
    );
    const mem = setup([room()]);
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ errors: 1 })
    );
    expect(mem.rpcCalls).toEqual([]);
    expect(mem.tables.deal_rooms[0].last_error).toBeNull();
    log.mockRestore();
  });
});

describe('reconcileCreatingRooms — invites stuck mid-send', () => {
  const claimAged = (minutes: number) =>
    buildInviteClaim(new Date(NOW.getTime() - minutes * 60_000), 'u1');
  const open = (over: Record<string, unknown> = {}) =>
    room({
      status: 'open',
      wa_group_id: 'G1',
      created_at: minutesAgo(90),
      ...over,
    });
  const invitee = (id: string, marker: string | null, over = {}) => ({
    id,
    room_id: 'room-1',
    status: 'invited',
    invite_message_id: marker,
    ...over,
  });
  const marker = (mem: ReturnType<typeof setup>, id: string) =>
    mem.tables.deal_room_participants.find((p) => p.id === id)!
      .invite_message_id;
  const none = counts({ checked: 0 });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps a fresh claim and runs no invites', async () => {
    const mem = setup([open()], undefined, [invitee('p1', claimAged(5))]);
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(none);
    expect(marker(mem, 'p1')).toBe(claimAged(5));
    expect(h.sendRoomInvites).not.toHaveBeenCalled();
  });

  it('releases a 31-minute-old claim and an old-style one, and runs the room once', async () => {
    const mem = setup([open()], undefined, [
      invitee('p1', claimAged(31)),
      invitee('p2', 'pending:6f1c2d3e-0000-4000-8000-000000000000'),
      invitee('p3', claimAged(5)),
    ]);
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(none);
    expect(marker(mem, 'p1')).toBeNull();
    expect(marker(mem, 'p2')).toBeNull();
    expect(marker(mem, 'p3')).toBe(claimAged(5));
    expect(h.sendRoomInvites).toHaveBeenCalledTimes(1);
    expect(h.sendRoomInvites).toHaveBeenCalledWith(mem.db, 'room-1');
  });

  it('releases the claim of a room that is not open but runs nothing', async () => {
    const mem = setup([open({ status: 'closed' })], undefined, [
      invitee('p1', claimAged(31)),
    ]);
    await reconcileCreatingRooms(mem.db, NOW);
    expect(marker(mem, 'p1')).toBeNull();
    expect(h.sendRoomInvites).not.toHaveBeenCalled();
  });

  it('leaves a claim replaced meanwhile, and runs nothing for it', async () => {
    const people = [invitee('p1', claimAged(31))];
    const mem = setup(
      [open()],
      (table) => {
        if (table === 'deal_room_participants') {
          people[0].invite_message_id = 'wamid.7';
        }
      },
      people
    );
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(none);
    expect(marker(mem, 'p1')).toBe('wamid.7');
    expect(h.sendRoomInvites).not.toHaveBeenCalled();
  });

  it('goes on to the stuck rooms when an invite run fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sendRoomInvites.mockRejectedValueOnce(new Error('meta down'));
    const mem = setup(
      [
        open(),
        room({ id: 'room-2', subject: 'Deal 43', create_request_id: 'req-2' }),
      ],
      undefined,
      [invitee('p1', claimAged(31))]
    );
    groups(group('G2', { subject: 'Deal 43' }));
    expect(await reconcileCreatingRooms(mem.db, NOW)).toEqual(
      counts({ opened: 1 })
    );
    expect(log).toHaveBeenCalled();
    expect(h.sendRoomInvites).toHaveBeenCalledTimes(2);
  });
});
