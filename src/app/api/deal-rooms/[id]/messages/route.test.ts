import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryDb } from '@/lib/deal-rooms/test-db';
import { MetaError } from '@/lib/whatsapp/meta-api';

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  admin: null as unknown,
  sendGroupText: vi.fn(),
  sendGroupTemplate: vi.fn(),
  sendGroupMedia: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    toErrorResponse: (err: unknown) =>
      Response.json(
        { error: 'x' },
        { status: err instanceof UnauthorizedError ? 401 : 500 }
      ),
  };
});
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: m.getUser }, rpc: m.rpc }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => m.admin,
}));
vi.mock('@/lib/whatsapp/meta-groups', async (orig) => ({
  ...(await orig<object>()),
  sendGroupText: m.sendGroupText,
  sendGroupTemplate: m.sendGroupTemplate,
  sendGroupMedia: m.sendGroupMedia,
}));
vi.mock('@/lib/deal-rooms/shared', async (orig) => ({
  ...(await orig<object>()),
  metaChannel: async () => ({ phoneNumberId: 'pn-1', accessToken: 'tok' }),
}));

import { POST } from './route';

const HOUR = 3_600_000;
let mem: ReturnType<typeof memoryDb>;

function seed(windowUntil: string | null, status = 'open') {
  mem = memoryDb(
    {
      deal_rooms: [
        {
          id: 'room-1',
          account_id: 'acct-1',
          status,
          wa_group_id: 'grp-1',
          whatsapp_config_id: 'cfg-1',
          window_until: windowUntil,
        },
      ],
    },
    {
      rpc: (fn) => {
        if (fn === 'deal_room_record_message') return 'gm-1';
        return null;
      },
    }
  );
  m.admin = mem.db;
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/deal-rooms/room-1/messages', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'room-1' }) }
  );

const postFile = (file: File, caption?: string) => {
  const form = new FormData();
  form.set('file', file);
  if (caption !== undefined) form.set('caption', caption);
  return POST(
    new Request('http://localhost/api/deal-rooms/room-1/messages', {
      method: 'POST',
      body: form,
    }),
    { params: Promise.resolve({ id: 'room-1' }) }
  );
};
/** "%PDF-1.7": a PDF's leading bytes, which the route checks. */
const pdf = (name = 'Offer letter.pdf') =>
  new File([new TextEncoder().encode('%PDF-1.7')], name, {
    type: 'application/pdf',
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  m.rpc.mockResolvedValue({ data: true, error: null });
  m.sendGroupText.mockResolvedValue({ messageId: 'wamid.T' });
  m.sendGroupTemplate.mockResolvedValue({ messageId: 'wamid.P' });
  m.sendGroupMedia.mockResolvedValue({ messageId: 'wamid.M' });
  seed(new Date(Date.now() + HOUR).toISOString());
});

describe('POST /api/deal-rooms/[id]/messages', () => {
  it('sends free text inside the window and records it as the caller', async () => {
    const res = await post({ text: ' Hello all ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'gm-1', waMessageId: 'wamid.T' });
    expect(m.rpc).toHaveBeenCalledWith('deal_room_can_post', {
      p_room: 'room-1',
    });
    expect(m.sendGroupText).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'grp-1', text: 'Hello all' })
    );
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_record_message',
      expect.objectContaining({
        p_group_id: 'grp-1',
        p_direction: 'out',
        p_type: 'text',
        p_wa_message_id: 'wamid.T',
        p_body: 'Hello all',
        p_staff_user_id: 'user-1',
      }),
    ]);
  });

  it('refuses free text once the window has closed (409 window_closed), sending nothing', async () => {
    for (const until of [new Date(Date.now() - 1000).toISOString(), null]) {
      seed(until);
      const res = await post({ text: 'Hello' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('window_closed');
    }
    expect(m.sendGroupText).not.toHaveBeenCalled();
  });

  it('still sends a template outside the window', async () => {
    seed(new Date(Date.now() - HOUR).toISOString());
    const res = await post({
      templateName: 'deal_update',
      language: 'en',
      params: ['ADCB'],
    });
    expect(res.status).toBe(201);
    expect(m.sendGroupTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'deal_update',
        language: 'en',
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'ADCB' }] },
        ],
      })
    );
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_record_message',
      expect.objectContaining({
        p_type: 'template',
        p_template_name: 'deal_update',
      }),
    ]);
  });

  it('lets a bank guest post in their room: the decision is deal_room_can_post, not requireRole', async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: 'guest-1' } } });
    const res = await post({ text: 'Officer here' });
    expect(res.status).toBe(201);
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_record_message',
      expect.objectContaining({ p_staff_user_id: 'guest-1' }),
    ]);
  });

  it('answers 403 where the caller cannot post (a guest elsewhere), and 401 signed out', async () => {
    m.rpc.mockResolvedValue({ data: false, error: null });
    expect((await post({ text: 'x' })).status).toBe(403);
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect((await post({ text: 'x' })).status).toBe(401);
    expect(m.sendGroupText).not.toHaveBeenCalled();
  });

  it('maps 131020 to 409 group_not_ready and records nothing', async () => {
    m.sendGroupText.mockRejectedValue(new MetaError('not ready', 400, 131020));
    const res = await post({ text: 'Hello' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('group_not_ready');
    expect(mem.rpcCalls.map(([fn]) => fn)).not.toContain(
      'deal_room_record_message'
    );
  });

  it('marks the room suspended on 131207', async () => {
    m.sendGroupText.mockRejectedValue(new MetaError('suspended', 400, 131207));
    const res = await post({ text: 'Hello' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('group_suspended');
    expect(mem.rpcCalls).toContainEqual([
      'deal_room_set_status',
      {
        p_room: 'room-1',
        p_status: 'suspended',
        p_reason: 'suspended by WhatsApp',
      },
    ]);
  });

  it('refuses a room that is not open, and a malformed body', async () => {
    seed(new Date(Date.now() + HOUR).toISOString(), 'closing');
    expect((await post({ text: 'Hello' })).status).toBe(409);
    expect((await post({ text: '  ' })).status).toBe(400);
    expect((await post({ text: 'a', templateName: 'b' })).status).toBe(400);
  });

  describe('a file', () => {
    it('stores it in the deal file, sends Meta a signed link and records the message with its media', async () => {
      const res = await postFile(pdf(), ' Signed copy ');
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: 'gm-1', waMessageId: 'wamid.M' });
      expect(mem.uploads).toHaveLength(1);
      const { bucket, path, options } = mem.uploads[0];
      expect(bucket).toBe('deal-files');
      expect(path).toMatch(
        /^account-acct-1\/room-room-1\/out-\d+-Offer_letter\.pdf$/
      );
      expect(options).toMatchObject({ contentType: 'application/pdf' });
      expect(m.sendGroupMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 'grp-1',
          kind: 'document',
          link: expect.stringContaining(`deal-files/${path}?token=`),
          caption: 'Signed copy',
          filename: 'Offer letter.pdf',
        })
      );
      expect(mem.tables.deal_files).toEqual([
        expect.objectContaining({
          account_id: 'acct-1',
          room_id: 'room-1',
          storage_path: path,
          name: 'Offer letter.pdf',
          mime: 'application/pdf',
          bytes: 8,
          source: 'deal_room_media',
          ref_type: 'group_message',
          ref_id: 'wamid.M',
          created_by: 'user-1',
        }),
      ]);
      expect(mem.rpcCalls).toContainEqual([
        'deal_room_record_message',
        expect.objectContaining({
          p_direction: 'out',
          p_type: 'document',
          p_wa_message_id: 'wamid.M',
          p_body: 'Signed copy',
          p_staff_user_id: 'user-1',
          p_media: expect.objectContaining({
            mime_type: 'application/pdf',
            filename: 'Offer letter.pdf',
            storage_path: path,
          }),
        }),
      ]);
    });

    it('refuses a file once the window has closed (409 window_closed), storing and sending nothing', async () => {
      for (const until of [new Date(Date.now() - 1000).toISOString(), null]) {
        seed(until);
        const res = await postFile(pdf());
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('window_closed');
        expect(mem.uploads).toEqual([]);
      }
      expect(m.sendGroupMedia).not.toHaveBeenCalled();
    });

    it('refuses an unsupported type and an image over 5 MB, storing nothing', async () => {
      const gif = new File([new Uint8Array(3)], 'a.gif', { type: 'image/gif' });
      const res = await postFile(gif);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('media_type');
      const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'a.jpg', {
        type: 'image/jpeg',
      });
      const res2 = await postFile(big);
      expect(res2.status).toBe(400);
      expect((await res2.json()).code).toBe('media_size');
      expect(mem.uploads).toEqual([]);
      expect(m.sendGroupMedia).not.toHaveBeenCalled();
    });

    it('refuses a file whose name or bytes do not bear out its type, storing nothing', async () => {
      // An executable the browser was told is a PDF.
      const exe = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0])], 'a.pdf', {
        type: 'application/pdf',
      });
      const res = await postFile(exe);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('media_content');
      const named = await postFile(pdf('Offer letter.exe'));
      expect(named.status).toBe(400);
      expect((await named.json()).code).toBe('media_name');
      expect(mem.uploads).toEqual([]);
      expect(m.sendGroupMedia).not.toHaveBeenCalled();
    });

    it('removes the stored file when WhatsApp refuses the send, recording nothing', async () => {
      m.sendGroupMedia.mockRejectedValue(
        new MetaError('not ready', 400, 131020)
      );
      const res = await postFile(pdf());
      expect(res.status).toBe(409);
      expect(mem.removed).toEqual([
        { bucket: 'deal-files', paths: [mem.uploads[0].path] },
      ]);
      expect(mem.tables.deal_files ?? []).toEqual([]);
      expect(mem.rpcCalls.map(([fn]) => fn)).not.toContain(
        'deal_room_record_message'
      );
    });

    it('still answers 403 to someone who cannot post, before reading the file', async () => {
      m.rpc.mockResolvedValue({ data: false, error: null });
      expect((await postFile(pdf())).status).toBe(403);
      expect(mem.uploads).toEqual([]);
    });
  });
});
