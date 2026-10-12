import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sendGroupInviteTemplate: vi.fn(),
  metaChannel: vi.fn(),
}));
vi.mock('@/lib/whatsapp/meta-groups', () => ({
  sendGroupInviteTemplate: h.sendGroupInviteTemplate,
}));
vi.mock('./shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shared')>()),
  metaChannel: h.metaChannel,
}));

import { sendRoomInvites } from './invites';
import { memoryDb } from './test-db';

const ROOM = {
  id: 'room-1',
  account_id: 'acct-1',
  channel_id: 'chan-1',
  created_by: 'user-1',
  subject: 'Deal 42',
  status: 'open',
  wa_group_id: 'G1',
  whatsapp_config_id: 'cfg-1',
};

const person = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  room_id: 'room-1',
  phone: `97150000000${id.slice(-1)}`,
  role: 'customer',
  status: 'invited',
  invite_message_id: null,
  ...extra,
});

const SETTINGS = {
  account_id: 'acct-1',
  invite_template_name: 'group_invite',
  invite_template_language: 'en',
  invite_template_name_ar: null,
  updated_at: null,
};

function setup(
  over: {
    room?: Record<string, unknown>;
    people?: Record<string, unknown>[];
    settings?: Record<string, unknown>[];
    rpc?: (fn: string, params: Record<string, unknown>) => unknown;
  } = {}
) {
  return memoryDb(
    {
      deal_rooms: [{ ...ROOM, ...over.room }],
      deal_room_participants: over.people ?? [person('p1')],
      deal_room_settings: over.settings ?? [SETTINGS],
    },
    { rpc: over.rpc }
  );
}

const participant = (mem: ReturnType<typeof setup>, id: string) =>
  mem.tables.deal_room_participants.find((p) => p.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  h.metaChannel.mockResolvedValue({
    id: 'cfg-1',
    provider: 'meta',
    phoneNumberId: '106',
    accessToken: 'tok',
  });
  let n = 0;
  h.sendGroupInviteTemplate.mockImplementation(async () => ({
    messageId: `wamid.${++n}`,
  }));
});

describe('sendRoomInvites', () => {
  it('invites the invited people, and records the message id', async () => {
    const mem = setup();
    const summary = await sendRoomInvites(mem.db, 'room-1');
    expect(summary).toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
      notOpen: false,
      templateMissing: false,
    });
    expect(h.sendGroupInviteTemplate).toHaveBeenCalledWith({
      phoneNumberId: '106',
      accessToken: 'tok',
      to: '971500000001',
      templateName: 'group_invite',
      language: 'en',
      groupId: 'G1',
    });
    expect(participant(mem, 'p1').invite_message_id).toBe('wamid.1');
    expect(participant(mem, 'p1').invited_at).toEqual(expect.any(String));
    const audit = mem.log.find((q) => q.table === 'deal_room_audit');
    expect(audit?.values).toMatchObject({
      action: 'invites_sent',
      detail: { sent: 1, failed: 0 },
    });
  });

  it('never claims or invites a guest awaiting approval, our number, or someone already invited', async () => {
    const mem = setup({
      people: [
        person('p2', { role: 'bank_guest', status: 'pending_approval' }),
        person('p3', { role: 'business', phone: null }),
        person('p4', { invite_message_id: 'wamid.old' }),
      ],
    });
    const summary = await sendRoomInvites(mem.db, 'room-1');
    expect(summary).toMatchObject({ sent: 0, failed: 0, skipped: 3 });
    expect(h.sendGroupInviteTemplate).not.toHaveBeenCalled();
    // Not even claimed: nothing writes to these rows.
    expect(mem.log.filter((q) => q.op === 'update')).toEqual([]);
    expect(participant(mem, 'p2').invite_message_id).toBeNull();
  });

  it('leaves a person another sender claimed first', async () => {
    const mem = setup();
    let raced = false;
    const racing = memoryDb(mem.tables, {
      beforeUpdate: (table) => {
        if (table !== 'deal_room_participants' || raced) return;
        raced = true;
        participant(mem, 'p1').invite_message_id = 'pending:other';
      },
    });
    const summary = await sendRoomInvites(racing.db, 'room-1');
    expect(summary).toMatchObject({ sent: 0, skipped: 1 });
    expect(h.sendGroupInviteTemplate).not.toHaveBeenCalled();
    expect(participant(mem, 'p1').invite_message_id).toBe('pending:other');
  });

  it('sends nothing on a second run', async () => {
    const mem = setup({ people: [person('p1'), person('p2')] });
    expect((await sendRoomInvites(mem.db, 'room-1')).sent).toBe(2);
    const again = await sendRoomInvites(mem.db, 'room-1');
    expect(again).toMatchObject({ sent: 0, skipped: 2 });
    expect(h.sendGroupInviteTemplate).toHaveBeenCalledTimes(2);
  });

  it('releases the claim of a failed send for the next attempt', async () => {
    const mem = setup();
    h.sendGroupInviteTemplate.mockRejectedValueOnce(new Error('rate limited'));
    expect(await sendRoomInvites(mem.db, 'room-1')).toMatchObject({
      sent: 0,
      failed: 1,
    });
    expect(participant(mem, 'p1').invite_message_id).toBeNull();
    expect(await sendRoomInvites(mem.db, 'room-1')).toMatchObject({ sent: 1 });
    expect(participant(mem, 'p1').invite_message_id).toBe('wamid.1');
  });

  it('tells the creator when no invite template is configured, and sends nothing', async () => {
    const mem = setup({ settings: [] });
    const summary = await sendRoomInvites(mem.db, 'room-1');
    expect(summary).toMatchObject({ templateMissing: true, sent: 0 });
    expect(h.sendGroupInviteTemplate).not.toHaveBeenCalled();
    const note = mem.log.find((q) => q.table === 'notifications');
    expect(note?.values).toMatchObject({
      user_id: 'user-1',
      type: 'deal_room_update',
      meta: { room_id: 'room-1', event: 'invite_template_missing' },
    });
    expect(participant(mem, 'p1').invite_message_id).toBeNull();
  });

  it('re-checks each person before the send: skips, unclaimed, whoever may not be let in now, and records why', async () => {
    const mem = setup({
      people: [person('p1'), person('p2', { role: 'bank_guest' })],
      rpc: (fn, params) =>
        fn === 'deal_room_admit_block' && params.p_participant === 'p1'
          ? 'opted_out'
          : null,
    });
    const summary = await sendRoomInvites(mem.db, 'room-1');
    expect(summary).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    expect(mem.rpcCalls).toEqual([
      ['deal_room_admit_block', { p_participant: 'p1' }],
      ['deal_room_admit_block', { p_participant: 'p2' }],
    ]);
    expect(h.sendGroupInviteTemplate).toHaveBeenCalledTimes(1);
    expect(h.sendGroupInviteTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '971500000002' })
    );
    expect(participant(mem, 'p1').invite_message_id).toBeNull();
    const audit = mem.log.find((q) => q.table === 'deal_room_audit');
    expect(audit?.values).toMatchObject({
      action: 'invites_sent',
      detail: {
        sent: 1,
        blocked: [{ participant_id: 'p1', reason: 'opted_out' }],
      },
    });
  });

  it('sends nothing to a person the re-check could not be made for', async () => {
    const mem = setup({
      rpc: () => {
        throw { message: 'db down' };
      },
    });
    const summary = await sendRoomInvites(mem.db, 'room-1');
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(h.sendGroupInviteTemplate).not.toHaveBeenCalled();
    expect(participant(mem, 'p1').invite_message_id).toBeNull();
  });

  it('sends nothing while the room has no group', async () => {
    const mem = setup({ room: { status: 'creating', wa_group_id: null } });
    expect(await sendRoomInvites(mem.db, 'room-1')).toMatchObject({
      notOpen: true,
      sent: 0,
    });
    expect(h.sendGroupInviteTemplate).not.toHaveBeenCalled();
  });
});
