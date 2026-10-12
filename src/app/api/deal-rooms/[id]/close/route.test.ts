import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';
import { MetaError } from '@/lib/whatsapp/meta-api';

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  admin: null as unknown,
  deleteGroup: vi.fn(),
  removeParticipants: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: { rpc: m.rpc }, userId: 'tl-1' }),
  toErrorResponse: () => Response.json({ error: 'x' }, { status: 500 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));
vi.mock('@/lib/whatsapp/meta-groups', async (orig) => ({
  ...(await orig<object>()),
  deleteGroup: m.deleteGroup,
  removeParticipants: m.removeParticipants,
}));
vi.mock('@/lib/deal-rooms/shared', async (orig) => ({
  ...(await orig<object>()),
  metaChannel: async () => ({ phoneNumberId: 'pn-1', accessToken: 'tok' }),
}));

import { POST as transcript } from '../transcript/route';
import { POST as close } from './route';

let mem: ReturnType<typeof memoryDb>;

beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockResolvedValue({ data: true, error: null });
  m.deleteGroup.mockResolvedValue(undefined);
  m.removeParticipants.mockResolvedValue(undefined);
  mem = memoryDb(
    {
      deal_rooms: [
        {
          id: 'room-1',
          account_id: 'acct-1',
          subject: 'Loan',
          status: 'open',
          wa_group_id: 'grp-1',
          deal_id: 'deal-1',
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
      deal_room_participants: [],
      deal_files: [],
    },
    {
      rpc: (fn, params) => {
        if (fn === 'deal_room_set_status')
          mem.tables.deal_rooms[0].status = params.p_status;
        return null;
      },
    }
  );
  m.admin = mem.db;
});

const call = (route: typeof close, body?: unknown) =>
  route(
    new Request('http://localhost/x', {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      params: Promise.resolve({ id: 'room-1' }),
    }
  );

describe('POST /api/deal-rooms/[id]/close', () => {
  it('closes for a manager: 200 with the transcript file', async () => {
    const res = await call(close, { reason: ' won ' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: 'closed',
      transcriptFileId: mem.tables.deal_files[0].id,
    });
    expect(m.rpc).toHaveBeenCalledWith('deal_room_can_manage', {
      p_room: 'room-1',
    });
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_set_status',
      { p_room: 'room-1', p_status: 'closing', p_reason: 'won' },
    ]);
  });

  it('answers 502 close_incomplete with the step when WhatsApp fails mid-way, and finishes on a retry', async () => {
    m.deleteGroup.mockRejectedValueOnce(new MetaError('down', 500, 2));
    const res = await call(close, {});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: 'close_incomplete',
      status: 'closing',
      step: 'delete',
      error: expect.stringContaining('Close it again'),
    });
    expect(mem.tables.deal_rooms[0].status).toBe('closing');
    expect((await call(close, {})).status).toBe(200);
    expect(mem.tables.deal_files).toHaveLength(1);
  });

  it('refuses a non-manager (403) and a reason that is not text (400)', async () => {
    expect((await call(close, { reason: 5 })).status).toBe(400);
    m.rpc.mockResolvedValue({ data: false, error: null });
    expect((await call(close, {})).status).toBe(403);
    expect(m.deleteGroup).not.toHaveBeenCalled();
  });
});

describe('POST /api/deal-rooms/[id]/transcript', () => {
  it('saves a transcript for a manager: { fileId, name }', async () => {
    const res = await call(transcript);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      fileId: mem.tables.deal_files[0].id,
      name: expect.stringMatching(/^transcript-.+\.html$/),
    });
    expect(mem.uploads[0].path).toMatch(/^account-acct-1\/room-room-1\//);
  });

  it('refuses a non-manager and an unknown room', async () => {
    m.rpc.mockResolvedValue({ data: false, error: null });
    expect((await call(transcript)).status).toBe(403);
    m.rpc.mockResolvedValue({ data: true, error: null });
    mem.tables.deal_rooms.length = 0;
    expect((await call(transcript)).status).toBe(404);
    expect(mem.uploads).toHaveLength(0);
  });
});
