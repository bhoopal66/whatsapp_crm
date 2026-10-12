import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MetaError } from '@/lib/whatsapp/meta-api';

import { memoryDb } from './test-db';

const h = vi.hoisted(() => ({
  events: [] as string[],
  removeParticipants: vi.fn(),
  deleteGroup: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-groups', async (orig) => ({
  ...(await orig<object>()),
  removeParticipants: h.removeParticipants,
  deleteGroup: h.deleteGroup,
}));
vi.mock('./shared', async (orig) => ({
  ...(await orig<object>()),
  metaChannel: async () => ({ phoneNumberId: 'pn-1', accessToken: 'tok' }),
}));

import { closeRoom } from './operations';
import { saveTranscript } from './transcript';

const ROOM = {
  id: 'room-1',
  account_id: 'acct-1',
  channel_id: 'ch-1',
  created_by: 'user-1',
  subject: 'Mortgage <ADCB>',
  status: 'open',
  wa_group_id: 'grp-1',
  whatsapp_config_id: 'cfg-1',
  window_until: null,
  deal_id: 'deal-1',
  created_at: '2026-10-01T09:00:00Z',
  close_reason: null,
};

let mem: ReturnType<typeof memoryDb>;

function seed(status = 'open') {
  h.events.length = 0;
  mem = memoryDb(
    {
      deal_rooms: [{ ...ROOM, status, last_error: null }],
      deal_room_participants: [
        {
          id: 'p-biz',
          room_id: 'room-1',
          display_name: 'Taamul',
          role: 'business',
          status: 'joined',
          wa_id: null,
          phone: null,
        },
        {
          id: 'p-cus',
          room_id: 'room-1',
          display_name: 'Ahmed',
          role: 'customer',
          status: 'joined',
          wa_id: '971501234512',
          phone: '971501234512',
        },
        {
          id: 'p-par',
          room_id: 'room-1',
          display_name: 'Partner',
          role: 'partner',
          status: 'left',
          wa_id: '971509999999',
          phone: '971509999999',
        },
      ],
      group_messages: [
        {
          room_id: 'room-1',
          created_at: '2026-10-01T10:00:00Z',
          direction: 'in',
          type: 'text',
          body: 'Hi <all>',
          template_name: null,
          media: null,
          status: null,
          sender_participant_id: 'p-cus',
        },
      ],
      deal_files: [],
      deal_room_audit: [],
    },
    {
      rpc: (fn, params) => {
        if (fn === 'deal_room_set_status') {
          h.events.push(`status:${params.p_status}`);
          mem.tables.deal_rooms[0].status = params.p_status;
        }
        if (fn === 'deal_room_participant_event') {
          const p = mem.tables.deal_room_participants.find(
            (r) => r.wa_id === params.p_wa_id
          );
          if (p) p.status = 'removed';
        }
        return null;
      },
      upload: (_bucket, path) => {
        h.events.push(`upload:${path.split('/')[0]}`);
      },
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  h.removeParticipants.mockImplementation(async () => {
    h.events.push('remove');
  });
  h.deleteGroup.mockImplementation(async () => {
    h.events.push('delete');
  });
});

describe('saveTranscript', () => {
  it('uploads escaped HTML to the room folder and records a deal file', async () => {
    const saved = await saveTranscript(mem.db, ROOM, 'user-1');
    expect(mem.uploads).toHaveLength(1);
    const up = mem.uploads[0];
    expect(up.bucket).toBe('deal-files');
    expect(up.path).toMatch(
      /^account-acct-1\/room-room-1\/transcript-.+\.html$/
    );
    const html = Buffer.from(up.bytes).toString('utf8');
    expect(html).toContain('Ahmed (customer)');
    expect(html).toContain('Hi &lt;all&gt;');
    expect(html).not.toContain('971501234512');
    expect(mem.tables.deal_files).toEqual([
      expect.objectContaining({
        id: saved.id,
        name: saved.name,
        deal_id: 'deal-1',
        room_id: 'room-1',
        source: 'transcript',
        ref_type: null,
        storage_path: up.path,
      }),
    ]);
  });

  it("reuses a close's own transcript instead of saving another", async () => {
    const first = await saveTranscript(mem.db, ROOM, 'user-1', 'close');
    const again = await saveTranscript(mem.db, ROOM, 'user-1', 'close');
    expect(again.id).toBe(first.id);
    expect(mem.uploads).toHaveLength(1);
  });

  it('throws when the upload is refused, recording nothing', async () => {
    mem = memoryDb(
      { deal_files: [] },
      {
        upload: () => {
          throw { message: 'bucket full' };
        },
      }
    );
    await expect(saveTranscript(mem.db, ROOM, null)).rejects.toThrow(
      'bucket full'
    );
    expect(mem.tables.deal_files).toEqual([]);
  });
});

describe('closeRoom', () => {
  it('goes closing → transcript → remove → delete → closed, in that order', async () => {
    const out = await closeRoom(mem.db, {
      roomId: 'room-1',
      userId: 'user-1',
      reason: 'won',
    });
    expect(out).toEqual({
      ok: true,
      status: 'closed',
      transcriptFileId: expect.any(String),
    });
    expect(h.events).toEqual([
      'status:closing',
      'upload:account-acct-1',
      'remove',
      'delete',
      'status:closed',
    ]);
    // only the joined, non-business people
    expect(h.removeParticipants).toHaveBeenCalledWith({
      groupId: 'grp-1',
      accessToken: 'tok',
      participants: ['971501234512'],
    });
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_set_status',
      { p_room: 'room-1', p_status: 'closing', p_reason: 'won' },
    ]);
  });

  it('stops at a Meta failure: closing, last_error, 502 close_incomplete; closing again finishes without a second transcript', async () => {
    h.deleteGroup.mockRejectedValueOnce(new MetaError('boom', 500, 1));
    const out = await closeRoom(mem.db, {
      roomId: 'room-1',
      userId: 'user-1',
      reason: null,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 502,
      code: 'close_incomplete',
      detail: { status: 'closing', step: 'delete' },
    });
    expect(mem.tables.deal_rooms[0]).toMatchObject({
      status: 'closing',
      last_error: expect.stringContaining('delete'),
    });

    h.events.length = 0;
    const retry = await closeRoom(mem.db, {
      roomId: 'room-1',
      userId: 'user-1',
      reason: null,
    });
    expect(retry).toMatchObject({ ok: true, status: 'closed' });
    expect(mem.uploads).toHaveLength(1);
    // closing again is a no-op in SQL; the removed customer is not removed twice
    expect(h.events).toEqual(['status:closing', 'delete', 'status:closed']);
    expect(mem.tables.deal_rooms[0]).toMatchObject({
      status: 'closed',
      last_error: null,
    });
  });

  it('treats a group WhatsApp no longer knows as already deleted', async () => {
    h.removeParticipants.mockRejectedValueOnce(
      new MetaError('gone', 400, 131041)
    );
    const out = await closeRoom(mem.db, {
      roomId: 'room-1',
      userId: 'user-1',
      reason: null,
    });
    expect(out).toMatchObject({ ok: true, status: 'closed' });
    expect(h.deleteGroup).not.toHaveBeenCalled();
  });

  it('stops before anything at WhatsApp when the transcript cannot be saved', async () => {
    seed();
    mem.tables.deal_files = [];
    const failing = memoryDb(mem.tables, {
      rpc: (fn, params) => {
        if (fn === 'deal_room_set_status')
          mem.tables.deal_rooms[0].status = params.p_status;
        return null;
      },
      upload: () => {
        throw { message: 'storage down' };
      },
    });
    const out = await closeRoom(failing.db, {
      roomId: 'room-1',
      userId: 'user-1',
      reason: null,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 502,
      detail: { step: 'transcript' },
    });
    expect(h.removeParticipants).not.toHaveBeenCalled();
    expect(h.deleteGroup).not.toHaveBeenCalled();
  });

  it('refuses a closed room and one still being created', async () => {
    seed('closed');
    expect(
      await closeRoom(mem.db, { roomId: 'room-1', userId: 'u', reason: null })
    ).toMatchObject({ status: 409, code: 'already_closed' });
    seed('creating');
    expect(
      await closeRoom(mem.db, { roomId: 'room-1', userId: 'u', reason: null })
    ).toMatchObject({ status: 409, code: 'room_creating' });
  });
});
