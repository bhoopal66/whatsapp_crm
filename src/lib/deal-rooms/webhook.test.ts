import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  approveJoinRequests,
  removeParticipants,
  getMediaUrl,
  downloadMedia,
  markOptedOut,
} = vi.hoisted(() => ({
  approveJoinRequests: vi.fn(async () => ({ done: [], failed: [] })),
  removeParticipants: vi.fn(async () => undefined),
  getMediaUrl: vi.fn(async () => ({
    url: 'https://lookaside.fbsbx.com/m',
    mimeType: 'application/pdf',
    fileSize: 3,
  })),
  downloadMedia: vi.fn(async () => ({
    buffer: Buffer.from('pdf'),
    contentType: 'application/pdf',
  })),
  markOptedOut: vi.fn(async () => true),
}));
vi.mock('@/lib/whatsapp/meta-groups', () => ({
  approveJoinRequests,
  removeParticipants,
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({ getMediaUrl, downloadMedia }));
vi.mock('@/lib/ai/opt-out', () => ({ markOptedOut }));

import {
  groupMessages,
  groupStatuses,
  handleGroupWebhook,
  isGroupChange,
  isOptOutText,
} from './webhook';

const GROUP = 'HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRB';
const ROOM = {
  id: 'room-1',
  channel_id: 'chan-1',
  deal_id: 'deal-1',
  created_by: 'user-creator',
  subject: 'Deal 42',
};

// A query builder that records every call and resolves to a per-table result.
function fakeDb(
  opts: { rpc?: Record<string, unknown>; tables?: Record<string, unknown> } = {}
) {
  const calls: { table: string; ops: unknown[][] }[] = [];
  const rpc = vi.fn(async (fn: string) => {
    const r = opts.rpc?.[fn];
    if (r instanceof Error)
      return { data: null, error: { code: 'P0002', message: r.message } };
    return { data: r ?? null, error: null };
  });
  const from = (table: string) => {
    const entry = { table, ops: [] as unknown[][] };
    calls.push(entry);
    const result = { data: opts.tables?.[table] ?? null, error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'limit', 'insert', 'update', 'is']) {
      builder[m] = (...a: unknown[]) => (entry.ops.push([m, ...a]), builder);
    }
    builder.maybeSingle = async () => result;
    builder.single = async () => ({ data: { id: 'file-1' }, error: null });
    builder.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(result).then(ok);
    return builder;
  };
  const upload = vi.fn(async () => ({ error: null }));
  const db = { rpc, from, storage: { from: () => ({ upload }) } };
  const inserts = (table: string) =>
    calls
      .filter((c) => c.table === table)
      .flatMap((c) => c.ops.filter((o) => o[0] === 'insert').map((o) => o[1]));
  return { db: db as never, rpc, upload, inserts };
}

const run = (db: never, value: Record<string, unknown>) =>
  handleGroupWebhook({
    db,
    accountId: 'acct-1',
    phoneNumberId: '106',
    accessToken: 'tok',
    value,
  });

beforeEach(() => vi.clearAllMocks());

describe('helpers', () => {
  it('recognises the four group fields and group-only messages/statuses', () => {
    expect(isGroupChange({ field: 'group_lifecycle_update' })).toBe(true);
    expect(isGroupChange({ field: 'messages' })).toBe(false);
    const value = {
      messages: [
        { id: 'a', from: '1' },
        { id: 'b', from: '1', group_id: GROUP },
      ],
      statuses: [
        { id: 'x', recipient_id: '1' },
        { id: 'y', recipient_type: 'group' },
      ],
    };
    expect(groupMessages(value).map((m) => m.id)).toEqual(['b']);
    expect(groupStatuses(value).map((s) => s.id)).toEqual(['y']);
  });

  it('matches opt-out keywords trimmed, case- and diacritic-insensitively', () => {
    for (const t of [
      'STOP',
      ' stop ',
      'Unsubscribe',
      'إلغاء',
      'الغاء',
      ' ايقاف',
      'إيقاف',
      'إِلْغَاء',
    ])
      expect(isOptOutText(t)).toBe(true);
    for (const t of ['stop it', 'please stop', '', null])
      expect(isOptOutText(t)).toBe(false);
  });
});

describe('lifecycle', () => {
  it('finishes a created group with the sha256 of its invite link', async () => {
    const { db, rpc } = fakeDb();
    const link = 'https://chat.whatsapp.com/AAA';
    await run(db, {
      groups: [
        {
          type: 'group_create',
          group_id: GROUP,
          request_id: 'req-1',
          invite_link: link,
          timestamp: '1',
        },
      ],
    });
    expect(rpc).toHaveBeenCalledWith('deal_room_group_created', {
      p_request_id: 'req-1',
      p_group_id: GROUP,
      p_invite_link_hash: createHash('sha256').update(link).digest('hex'),
    });
  });

  it('marks a failed create failed and tells the room creator', async () => {
    const { db, rpc, inserts } = fakeDb({ tables: { deal_rooms: ROOM } });
    await run(db, {
      groups: [
        {
          type: 'group_create',
          request_id: 'req-1',
          errors: [{ code: 131211, message: 'limit' }],
        },
      ],
    });
    expect(rpc).toHaveBeenCalledWith('deal_room_set_status', {
      p_room: 'room-1',
      p_status: 'failed',
      p_reason: 'limit',
    });
    expect(inserts('notifications')[0]).toEqual([
      expect.objectContaining({
        user_id: 'user-creator',
        type: 'deal_room_update',
      }),
    ]);
  });

  it('logs and ignores a group no room of this account knows', async () => {
    const { db, rpc } = fakeDb({ tables: { deal_rooms: null } });
    await expect(
      run(db, { groups: [{ type: 'group_suspend', group_id: GROUP }] })
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('suspends and notifies the managers', async () => {
    const { db, rpc, inserts } = fakeDb({
      tables: {
        deal_rooms: ROOM,
        chat_channel_members: [{ user_id: 'admin-1' }],
      },
    });
    await run(db, { groups: [{ type: 'group_suspend', group_id: GROUP }] });
    expect(rpc).toHaveBeenCalledWith(
      'deal_room_set_status',
      expect.objectContaining({ p_status: 'suspended' })
    );
    expect(
      (inserts('notifications')[0] as { user_id: string }[]).map(
        (n) => n.user_id
      )
    ).toEqual(['user-creator', 'admin-1']);
  });
});

describe('participants and join requests', () => {
  it('approves an auto-approved join request with Meta right away', async () => {
    const { db, inserts } = fakeDb({
      tables: { deal_rooms: ROOM },
      rpc: { deal_room_record_join_request: 'auto_approved' },
    });
    await run(db, {
      groups: [
        {
          type: 'group_join_request_created',
          group_id: GROUP,
          join_request_id: 'jr-1',
          wa_id: '971501234567',
        },
      ],
    });
    expect(approveJoinRequests).toHaveBeenCalledWith({
      groupId: GROUP,
      accessToken: 'tok',
      joinRequestIds: ['jr-1'],
    });
    expect(inserts('notifications')).toEqual([]);
  });

  it('asks the managers about a pending join request', async () => {
    const { db, inserts } = fakeDb({
      tables: { deal_rooms: ROOM },
      rpc: { deal_room_record_join_request: 'pending' },
    });
    await run(db, {
      groups: [
        {
          type: 'group_join_request_created',
          group_id: GROUP,
          join_request_id: 'jr-2',
          wa_id: '971501234567',
        },
      ],
    });
    expect(approveJoinRequests).not.toHaveBeenCalled();
    expect(inserts('notifications')[0]).toEqual([
      expect.objectContaining({ type: 'deal_room_join_request' }),
    ]);
  });

  it('records joins, and a participant leaving notifies the managers', async () => {
    const { db, rpc, inserts } = fakeDb({
      tables: { deal_rooms: ROOM },
      rpc: { deal_room_participant_event: 'left' },
    });
    await run(db, {
      groups: [
        {
          type: 'group_participants_add',
          group_id: GROUP,
          added_participants: [{ wa_id: '971501234567' }],
        },
        {
          type: 'group_participants_remove',
          group_id: GROUP,
          initiated_by: 'participant',
          removed_participants: [{ wa_id: '971509999999' }],
        },
      ],
    });
    expect(rpc).toHaveBeenCalledWith('deal_room_participant_event', {
      p_group_id: GROUP,
      p_wa_id: '971501234567',
      p_event: 'joined',
    });
    expect(rpc).toHaveBeenCalledWith('deal_room_participant_event', {
      p_group_id: GROUP,
      p_wa_id: '971509999999',
      p_event: 'left',
    });
    expect(inserts('notifications')).toHaveLength(1);
  });
});

describe('group messages and receipts', () => {
  it('records an inbound text, and a bad item does not stop the next', async () => {
    const { db, rpc } = fakeDb({ tables: { deal_rooms: ROOM } });
    rpc.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await run(db, {
      messages: [
        {
          id: 'wamid.1',
          from: '971501234567',
          group_id: GROUP,
          type: 'text',
          text: { body: 'first' },
        },
        {
          id: 'wamid.2',
          from: '+971501234567',
          group_id: GROUP,
          type: 'text',
          text: { body: 'Hello all' },
        },
      ],
    });
    expect(rpc).toHaveBeenLastCalledWith(
      'deal_room_record_message',
      expect.objectContaining({
        p_direction: 'in',
        p_type: 'text',
        p_wa_message_id: 'wamid.2',
        p_sender_wa_id: '971501234567',
        p_body: 'Hello all',
      })
    );
  });

  it('saves inbound media to the deal file', async () => {
    const { db, rpc, upload, inserts } = fakeDb({
      tables: { deal_rooms: ROOM },
    });
    await run(db, {
      messages: [
        {
          id: 'wamid.3',
          from: '971501234567',
          group_id: GROUP,
          type: 'document',
          document: {
            id: 'media-1',
            filename: 'offer.pdf',
            mime_type: 'application/pdf',
          },
        },
      ],
    });
    expect(upload).toHaveBeenCalledWith(
      'account-acct-1/room-room-1/wamid.3-offer.pdf',
      expect.any(Buffer),
      expect.anything()
    );
    expect(inserts('deal_files')[0]).toEqual(
      expect.objectContaining({
        source: 'deal_room_media',
        room_id: 'room-1',
        deal_id: 'deal-1',
      })
    );
    expect(rpc).toHaveBeenCalledWith(
      'deal_room_record_message',
      expect.objectContaining({
        p_type: 'document',
        p_media: expect.objectContaining({
          storage_path: 'account-acct-1/room-room-1/wamid.3-offer.pdf',
        }),
      })
    );
  });

  it('removes and opts out a participant who writes an opt-out keyword', async () => {
    const { db, rpc } = fakeDb({
      tables: {
        deal_rooms: ROOM,
        deal_room_participants: { contact_id: 'contact-9' },
      },
    });
    await run(db, {
      messages: [
        {
          id: 'wamid.4',
          from: '971501234567',
          group_id: GROUP,
          type: 'text',
          text: { body: ' إلغاء ' },
        },
      ],
    });
    expect(removeParticipants).toHaveBeenCalledWith({
      groupId: GROUP,
      accessToken: 'tok',
      participants: ['971501234567'],
    });
    expect(markOptedOut).toHaveBeenCalledWith(db, {
      accountId: 'acct-1',
      contactId: 'contact-9',
    });
    expect(rpc).toHaveBeenCalledWith(
      'deal_room_record_message',
      expect.objectContaining({ p_type: 'system', p_direction: 'out' })
    );
  });

  it('records receipts per participant under either field spelling', async () => {
    const { db, rpc } = fakeDb();
    await run(db, {
      statuses: [
        {
          id: 'wamid.o',
          status: 'sent',
          recipient_type: 'group',
          recipient_id: GROUP,
        },
        {
          id: 'wamid.o',
          status: 'delivered',
          recipient_type: 'group',
          recipient_id: GROUP,
          recipient_participant_id: '971501111111',
        },
        {
          id: 'wamid.o',
          status: 'read',
          recipient_type: 'group',
          recipient_id: GROUP,
          participant_recipient_id: '971502222222',
        },
      ],
    });
    expect(rpc.mock.calls).toEqual([
      [
        'deal_room_record_receipt',
        {
          p_wa_message_id: 'wamid.o',
          p_participant_wa_id: '971501111111',
          p_status: 'delivered',
        },
      ],
      [
        'deal_room_record_receipt',
        {
          p_wa_message_id: 'wamid.o',
          p_participant_wa_id: '971502222222',
          p_status: 'read',
        },
      ],
    ]);
  });
});
