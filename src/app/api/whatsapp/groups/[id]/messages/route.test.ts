import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  sendGroupText: vi.fn(),
  sendGroupMedia: vi.fn(),
  rls: null as unknown as FakeDb,
  admin: null as unknown as FakeDb,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));
vi.mock('@/lib/whatsapp/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/channels')>()),
  loadChannels: mocks.loadChannels,
}));
vi.mock('@/lib/whatsapp/groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/groups')>()),
  sendGroupText: mocks.sendGroupText,
  sendGroupMedia: mocks.sendGroupMedia,
}));
vi.mock('@/lib/groups/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/groups/server')>()),
  supabaseAdmin: () => fakeSupabase(mocks.admin),
}));

import { WhapiError } from '@/lib/whatsapp/whapi-api';

import { GET, POST } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ id: G }) };
let canManage = true;

const get = (qs = '') => GET(new Request(`http://x/${qs}`), params);
const post = (body: unknown) =>
  POST(
    new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
    params
  );
const stored = () => mocks.admin.tables.whatsapp_group_messages;

const msg = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `m${i}`,
  account_id: 'acct-1',
  group_id: G,
  wa_message_id: `w${i}`,
  direction: 'in',
  created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  canManage = true;
  mocks.rls = {
    tables: {
      whatsapp_groups: [
        {
          id: G,
          account_id: 'acct-1',
          channel_id: CH,
          wa_group_id: '120363000000000001@g.us',
          our_role: 'admin',
          settings: {},
        },
      ],
      whatsapp_group_messages: [1, 2, 3, 4, 5].map((i) => msg(i)),
    },
    rpc: { whatsapp_group_can_manage: () => ({ data: canManage }) },
  };
  mocks.admin = {
    tables: {
      whatsapp_group_messages: [],
      profiles: [
        { account_id: 'acct-1', user_id: 'agent-1', full_name: 'Aya' },
      ],
    },
  };
  mocks.getCurrentAccount.mockImplementation(async () => ({
    supabase: fakeSupabase(mocks.rls),
    userId: 'agent-1',
    accountId: 'acct-1',
    role: 'agent',
  }));
  mocks.loadChannels.mockResolvedValue([
    { id: CH, accountId: 'acct-1', provider: 'whapi', accessToken: 't' },
  ]);
  mocks.sendGroupText.mockResolvedValue({ messageId: 'wa-new' });
  mocks.sendGroupMedia.mockResolvedValue({ messageId: 'wa-media' });
});

describe('GET', () => {
  it('pages newest-first and answers oldest-first with hasMore', async () => {
    const res = await get('?limit=2');
    const body = await res.json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([
      'm4',
      'm5',
    ]);
    expect(body.hasMore).toBe(true);
  });

  it('continues before a timestamp and reports the end', async () => {
    const before = msg(4).created_at;
    const body = await (await get(`?limit=5&before=${before}`)).json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    expect(body.hasMore).toBe(false);
  });

  it('refuses a bad limit', async () => {
    expect((await get('?limit=101')).status).toBe(400);
  });

  it('answers 404 for an invisible group', async () => {
    mocks.rls.tables.whatsapp_groups = [];
    expect((await get()).status).toBe(404);
  });
});

describe('POST', () => {
  it('sends, records the row with the sender and returns it', async () => {
    const res = await post({ text: ' hello ' });
    expect(res.status).toBe(200);
    expect(mocks.sendGroupText).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: '120363000000000001@g.us',
        text: 'hello',
      })
    );
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({
      group_id: G,
      wa_message_id: 'wa-new',
      direction: 'out',
      status: 'sent',
      sender_user_id: 'agent-1',
      sender_name: 'Aya',
      body: 'hello',
    });
    expect((await res.json()).message).toMatchObject({
      wa_message_id: 'wa-new',
      sender_name: 'Aya',
    });
  });

  it('attributes the row the webhook echo already wrote', async () => {
    stored().push({
      id: 'echo',
      account_id: 'acct-1',
      group_id: G,
      wa_message_id: 'wa-new',
      direction: 'out',
      sender_user_id: null,
      sender_name: null,
      status: null,
      created_at: new Date().toISOString(),
    });
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(200);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({
      sender_user_id: 'agent-1',
      sender_name: 'Aya',
      status: 'sent',
    });
  });

  it('answers 429 at 20 sends a minute and never calls Whapi', async () => {
    for (let i = 0; i < 20; i++) {
      stored().push({
        id: `o${i}`,
        account_id: 'acct-1',
        group_id: G,
        wa_message_id: `o${i}`,
        direction: 'out',
        created_at: new Date(Date.now() - 5_000).toISOString(),
      });
    }
    const res = await post({ text: 'one too many' });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'rate_limited' });
    expect(mocks.sendGroupText).not.toHaveBeenCalled();
  });

  it('does not count old or inbound rows', async () => {
    for (let i = 0; i < 25; i++) {
      stored().push({
        id: `o${i}`,
        account_id: 'acct-1',
        group_id: G,
        wa_message_id: `o${i}`,
        direction: i % 2 ? 'in' : 'out',
        created_at: new Date(
          Date.now() - (i % 2 ? 5_000 : 120_000)
        ).toISOString(),
      });
    }
    expect((await post({ text: 'fine' })).status).toBe(200);
  });

  it('requires our number to be an admin when sending is admins-only', async () => {
    mocks.rls.tables.whatsapp_groups[0].settings = { send_messages: 'admins' };
    mocks.rls.tables.whatsapp_groups[0].our_role = 'member';
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_group_admin' });
    expect(mocks.sendGroupText).not.toHaveBeenCalled();
  });

  it('lets a plain member number send when anyone may', async () => {
    mocks.rls.tables.whatsapp_groups[0].our_role = 'member';
    expect((await post({ text: 'hi' })).status).toBe(200);
  });

  it('refuses a non-manager and a left group', async () => {
    canManage = false;
    expect((await post({ text: 'hi' })).status).toBe(403);
    canManage = true;
    mocks.rls.tables.whatsapp_groups[0].our_role = 'left';
    expect((await post({ text: 'hi' })).status).toBe(409);
    expect(mocks.sendGroupText).not.toHaveBeenCalled();
  });

  it('refuses empty and over-long text', async () => {
    expect((await post({ text: '  ' })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(4097) })).status).toBe(400);
  });

  it('inserts nothing and maps the error when the send fails', async () => {
    mocks.sendGroupText.mockRejectedValue(new WhapiError('boom', 429));
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(429);
    expect(stored()).toHaveLength(0);
  });

  const PATH = 'account-acct-1/groups/1700000000000-photo.jpg';
  const URL_OK = `https://tunnel.example/storage/v1/object/public/chat-media/${PATH}`;
  // The link sent and stored is rebuilt on our own public origin.
  const URL_SENT = `http://supabase.test/storage/v1/object/public/chat-media/${PATH}`;

  it('sends an attachment and records it in the media shape', async () => {
    const res = await post({
      media: {
        kind: 'image',
        url: URL_OK,
        path: PATH,
        caption: ' look ',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
      },
    });
    expect(res.status).toBe(200);
    expect(mocks.sendGroupText).not.toHaveBeenCalled();
    expect(mocks.sendGroupMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: '120363000000000001@g.us',
        kind: 'image',
        link: URL_SENT,
        caption: 'look',
      })
    );
    expect(stored()[0]).toMatchObject({
      wa_message_id: 'wa-media',
      type: 'image',
      body: 'look',
      media: { link: URL_SENT, mime_type: 'image/jpeg', filename: 'photo.jpg' },
    });
  });

  it('gives the echo of an attachment, which has no file, the one sent', async () => {
    stored().push({
      id: 'echo',
      account_id: 'acct-1',
      group_id: G,
      wa_message_id: 'wa-media',
      direction: 'out',
      sender_user_id: null,
      sender_name: null,
      type: 'unsupported',
      body: null,
      media: null,
      status: 'delivered',
      created_at: new Date().toISOString(),
    });
    const res = await post({
      media: {
        kind: 'image',
        url: URL_OK,
        path: PATH,
        caption: 'look',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
      },
    });
    expect(res.status).toBe(200);
    expect(stored()).toHaveLength(1);
    const want = {
      sender_user_id: 'agent-1',
      sender_name: 'Aya',
      type: 'image',
      body: 'look',
      media: { link: URL_SENT, mime_type: 'image/jpeg', filename: 'photo.jpg' },
      // A receipt that already moved it is not set back.
      status: 'delivered',
    };
    expect(stored()[0]).toMatchObject(want);
    expect((await res.json()).message).toMatchObject(want);
  });

  it("leaves the words of a text's echo alone", async () => {
    stored().push({
      id: 'echo',
      account_id: 'acct-1',
      group_id: G,
      wa_message_id: 'wa-new',
      direction: 'out',
      type: 'text',
      body: 'hi',
      media: null,
      status: 'sent',
      created_at: new Date().toISOString(),
    });
    await post({ text: 'hi' });
    expect(stored()[0]).toMatchObject({
      type: 'text',
      body: 'hi',
      media: null,
    });
  });

  it('records a voice note as audio, without a caption', async () => {
    const path = 'account-acct-1/groups/1700000000000-voice.ogg';
    const res = await post({
      media: {
        kind: 'voice',
        url: `https://x.test/storage/v1/object/public/chat-media/${path}`,
        path,
        caption: 'ignored',
      },
    });
    expect(res.status).toBe(200);
    expect(mocks.sendGroupMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'voice', caption: undefined })
    );
    expect(stored()[0]).toMatchObject({ type: 'audio', body: null });
  });

  it('refuses a media URL that is not our chat-media upload', async () => {
    for (const url of [
      'https://evil.example/payload.jpg',
      `https://tunnel.example/storage/v1/object/public/flow-media/${PATH}`,
      `${URL_OK}?x=1`,
    ]) {
      const res = await post({ media: { kind: 'image', url, path: PATH } });
      expect(res.status).toBe(400);
    }
    expect(mocks.sendGroupMedia).not.toHaveBeenCalled();
  });

  it("refuses another account's folder and a non-group folder", async () => {
    for (const path of [
      'account-acct-2/groups/1700000000000-photo.jpg',
      'account-acct-1/staged/1700000000000-photo.jpg',
      'account-acct-1/groups/../staged/x.jpg',
    ]) {
      const res = await post({
        media: {
          kind: 'image',
          url: `https://t.example/storage/v1/object/public/chat-media/${path}`,
          path,
        },
      });
      expect(res.status).toBe(400);
    }
    expect(mocks.sendGroupMedia).not.toHaveBeenCalled();
  });

  it('refuses a bad kind and an over-long caption', async () => {
    expect(
      (await post({ media: { kind: 'sticker', url: URL_OK, path: PATH } }))
        .status
    ).toBe(400);
    expect(
      (
        await post({
          media: {
            kind: 'image',
            url: URL_OK,
            path: PATH,
            caption: 'x'.repeat(1025),
          },
        })
      ).status
    ).toBe(400);
    expect(mocks.sendGroupMedia).not.toHaveBeenCalled();
  });
});
