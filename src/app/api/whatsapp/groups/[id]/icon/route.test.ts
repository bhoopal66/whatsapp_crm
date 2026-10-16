import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeDb } from '@/lib/groups/test-db';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  loadChannels: vi.fn(),
  getIcon: vi.fn(),
  setIcon: vi.fn(),
  deleteIcon: vi.fn(),
  rls: null as unknown as FakeDb,
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
  getIcon: mocks.getIcon,
  setIcon: mocks.setIcon,
  deleteIcon: mocks.deleteIcon,
}));

import { DELETE, GET, PUT } from './route';

const G = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ id: G }) };
let canManage = true;

const upload = (blob: Blob | null) => {
  const form = new FormData();
  if (blob) form.set('file', blob, 'icon');
  return PUT(new Request('http://x', { method: 'PUT', body: form }), params);
};
const png = (size = 4) =>
  new Blob([new Uint8Array(size).fill(7)], { type: 'image/png' });

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
    },
    rpc: { whatsapp_group_can_manage: () => ({ data: canManage }) },
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
  mocks.setIcon.mockResolvedValue(undefined);
  mocks.deleteIcon.mockResolvedValue(undefined);
});

describe('GET', () => {
  it('streams the image with its type and a private cache', async () => {
    mocks.getIcon.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      contentType: 'image/jpeg',
    });
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it('answers 404 when there is no picture', async () => {
    mocks.getIcon.mockResolvedValue(null);
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
  });

  it('answers 404 without a number, never calling Whapi', async () => {
    mocks.rls.tables.whatsapp_groups[0].channel_id = null;
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
    expect(mocks.getIcon).not.toHaveBeenCalled();
  });
});

describe('PUT', () => {
  it('sets the icon from a base64 data URL', async () => {
    const res = await upload(png(3));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.setIcon).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: '120363000000000001@g.us',
        media: `data:image/png;base64,${Buffer.from([7, 7, 7]).toString('base64')}`,
        mimeType: 'image/png',
      })
    );
  });

  it('refuses a non-manager before Whapi', async () => {
    canManage = false;
    expect((await upload(png())).status).toBe(403);
    expect(mocks.setIcon).not.toHaveBeenCalled();
  });

  it('refuses when our number is not a group admin', async () => {
    mocks.rls.tables.whatsapp_groups[0].our_role = 'member';
    const res = await upload(png());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_group_admin' });
  });

  it('refuses a GIF', async () => {
    const res = await upload(new Blob(['x'], { type: 'image/gif' }));
    expect(res.status).toBe(400);
    expect(mocks.setIcon).not.toHaveBeenCalled();
  });

  it('refuses a file over 2 MB with 413', async () => {
    const res = await upload(png(2 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(mocks.setIcon).not.toHaveBeenCalled();
  });

  it('refuses a request with no file', async () => {
    expect((await upload(null)).status).toBe(400);
  });
});

describe('DELETE', () => {
  it('removes the icon', async () => {
    const res = await DELETE(
      new Request('http://x', { method: 'DELETE' }),
      params
    );
    expect(res.status).toBe(200);
    expect(mocks.deleteIcon).toHaveBeenCalledOnce();
  });

  it('refuses a non-manager', async () => {
    canManage = false;
    const res = await DELETE(
      new Request('http://x', { method: 'DELETE' }),
      params
    );
    expect(res.status).toBe(403);
    expect(mocks.deleteIcon).not.toHaveBeenCalled();
  });
});
