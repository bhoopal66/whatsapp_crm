import { beforeEach, describe, expect, it, vi } from 'vitest';

// The RPC runs on the caller's own session and alone decides who may
// delete (no role check in the route); the storage paths it returns are
// removed with the service role, only inside the caller's workspace.

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  role: 'viewer' as string,
  rpc: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({
    supabase: { rpc: mocks.rpc },
    userId: '11111111-1111-4111-8111-111111111111',
    accountId: WS,
    role: mocks.role,
    account: { id: WS, name: 'WS' },
  }),
  toErrorResponse: (err: { status?: number; message: string }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      from: (bucket: string) => ({
        remove: (p: string[]) => mocks.remove(bucket, p),
      }),
    },
  }),
}));

vi.mock('@/lib/supabase/urls', () => ({
  serverSupabaseUrl: () => 'http://localhost:8000',
}));

import { POST } from './route';

const del = (id = MSG) =>
  POST(new Request('http://localhost/x', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
const path = (i: number) => `account-${WS}/channel-c/${i}-f.png`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'viewer';
  mocks.rpc.mockResolvedValue({ data: [path(1), path(2)], error: null });
  mocks.remove.mockImplementation(async (_b: string, p: string[]) => ({
    data: p.map((name) => ({ name })),
    error: null,
  }));
});

describe('POST /api/chat/messages/[id]/delete', () => {
  it.each(['bank_guest', 'viewer', 'agent', 'owner'])(
    'leaves the decision to the RPC on the caller session (%s)',
    async (role) => {
      mocks.role = role;
      const res = await del();
      expect(res.status).toBe(200);
      expect(mocks.rpc).toHaveBeenCalledWith('chat_delete_message', {
        p_message: MSG,
      });
    }
  );

  it('deletes the returned files with the service role and reports', async () => {
    const res = await del();
    expect(await res.json()).toEqual({
      files: 2,
      filesDeleted: 2,
      filesFailed: 0,
    });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith('chat-files', [path(1), path(2)]);
  });

  it.each([
    [
      '42501',
      'chat_delete_message: only the author or a workspace owner/admin can delete',
      403,
    ],
    ['P0002', 'chat_delete_message: message not found', 404],
  ])(
    'a refusal (%s) is the RPC’s answer and touches no file',
    async (code, message, status) => {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message } });
      const res = await del();
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ key: expect.any(String) });
      expect(mocks.remove).not.toHaveBeenCalled();
    }
  );

  it('refuses a malformed id before the RPC', async () => {
    expect((await del('nope')).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('never removes a path outside the caller workspace', async () => {
    const foreign =
      'account-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/channel-c/x-f.png';
    const climbing = `account-${WS}/../account-b/x.png`;
    mocks.rpc.mockResolvedValue({
      data: [path(1), foreign, climbing],
      error: null,
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await del();
    expect(mocks.remove).toHaveBeenCalledWith('chat-files', [path(1)]);
    expect(await res.json()).toEqual({
      files: 3,
      filesDeleted: 1,
      filesFailed: 2,
    });
    expect(spy.mock.calls[0][1]).toEqual([foreign, climbing]);
    spy.mockRestore();
  });

  it('retries a failed remove once, then logs and still answers 200', async () => {
    mocks.remove.mockResolvedValue({ data: null, error: { message: 'down' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await del();
    expect(res.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(await res.json()).toEqual({
      files: 2,
      filesDeleted: 0,
      filesFailed: 2,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('does not call storage for a message without files', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await (await del()).json()).toEqual({
      files: 0,
      filesDeleted: 0,
      filesFailed: 0,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
