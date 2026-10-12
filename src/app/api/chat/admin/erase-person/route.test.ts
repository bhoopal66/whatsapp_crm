import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

// Owner only. The RPC runs on the caller's own session (it checks the
// owner role and audits under their name); the storage paths it returns
// are removed with the service role, in batches, and only inside the
// caller's workspace prefix.

const ME = '11111111-1111-4111-8111-111111111111';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  caller: { role: 'owner' as string },
  rpc: vi.fn(),
  audit: vi.fn(),
  auditCalls: [] as { op: string; args: unknown[] }[],
  remove: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async (min: AccountRole) => {
    if (!hasMinRole(mocks.caller.role as AccountRole, min))
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    const builder: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'order', 'limit']) {
      builder[op] = (...args: unknown[]) => {
        mocks.auditCalls.push({ op, args });
        return builder;
      };
    }
    builder.maybeSingle = () => mocks.audit();
    return {
      supabase: { rpc: mocks.rpc, from: () => builder },
      userId: ME,
      accountId: WS,
      role: mocks.caller.role,
      account: { id: WS, name: 'WS' },
    };
  },
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

const post = (body: unknown) =>
  POST({ json: async () => body } as unknown as Request);
const path = (i: number) => `account-${WS}/channel-c/${i}-f.png`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.caller.role = 'owner';
  mocks.auditCalls.length = 0;
  mocks.rpc.mockResolvedValue({ data: [path(1), path(2)], error: null });
  mocks.audit.mockResolvedValue({
    data: { detail: { user_id: PERSON, messages: 7 } },
    error: null,
  });
  mocks.remove.mockImplementation(async (_b: string, p: string[]) => ({
    data: p.map((name) => ({ name })),
    error: null,
  }));
});

describe('POST /api/chat/admin/erase-person', () => {
  it.each(['admin', 'team_leader', 'agent', 'viewer'])(
    'refuses a %s before the RPC or storage',
    async (role) => {
      mocks.caller.role = role;
      const res = await post({ userId: PERSON, reason: 'GDPR request' });
      expect(res.status).toBe(403);
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    }
  );

  it('needs a person and a reason of 5 characters', async () => {
    expect(
      (await post({ userId: 'nope', reason: 'GDPR request' })).status
    ).toBe(400);
    const short = await post({ userId: PERSON, reason: ' abcd ' });
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ key: 'reasonRequired' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('erases on the caller session, then deletes the files and reports', async () => {
    const res = await post({ userId: PERSON, reason: '  GDPR request ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: 7,
      files: 2,
      filesDeleted: 2,
      filesFailed: 0,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('chat_erase_person', {
      p_ws: WS,
      p_user_id: PERSON,
      p_reason: 'GDPR request',
    });
    expect(mocks.auditCalls).toEqual(
      expect.arrayContaining([
        { op: 'eq', args: ['actor_id', ME] },
        { op: 'eq', args: ['action', 'erase_person'] },
        { op: 'eq', args: ['detail->>user_id', PERSON] },
      ])
    );
    expect(mocks.remove).toHaveBeenCalledWith('chat-files', [path(1), path(2)]);
  });

  it('removes in batches of 100 and never outside the workspace', async () => {
    const many = Array.from({ length: 205 }, (_, i) => path(i));
    const foreign =
      'account-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/channel-c/x-f.png';
    mocks.rpc.mockResolvedValue({ data: [...many, foreign], error: null });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ userId: PERSON, reason: 'GDPR request' });
    spy.mockRestore();
    expect(mocks.remove.mock.calls.map((c) => c[1].length)).toEqual([
      100, 100, 5,
    ]);
    expect(mocks.remove.mock.calls.flatMap((c) => c[1])).not.toContain(foreign);
    expect(await res.json()).toEqual({
      messages: 7,
      files: 206,
      filesDeleted: 205,
      filesFailed: 1,
    });
  });

  it('retries a failed batch once, then counts it as left behind', async () => {
    mocks.remove.mockResolvedValue({ data: null, error: { message: 'down' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ userId: PERSON, reason: 'GDPR request' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ filesDeleted: 0, filesFailed: 2 });
  });

  it('passes the RPC refusal through with its translation key', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message: 'chat_erase_person: workspace owner role required',
      },
    });
    const res = await post({ userId: PERSON, reason: 'GDPR request' });
    expect(res.status).toBe(403);
    expect((await res.json()).key).toBeTruthy();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('reports an unknown message count as null', async () => {
    mocks.audit.mockResolvedValue({ data: null, error: { message: 'x' } });
    const res = await post({ userId: PERSON, reason: 'GDPR request' });
    expect(await res.json()).toMatchObject({ messages: null, filesDeleted: 2 });
  });
});
