import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

// Owner only. The RPC runs on the caller's own session (it checks the
// owner role and audits under their name); the storage paths it returns
// are removed with the service role, in batches, and only inside the
// caller's account prefix.

const ME = '11111111-1111-4111-8111-111111111111';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  caller: { role: 'owner' as string },
  rpc: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async (min: AccountRole) => {
    if (!hasMinRole(mocks.caller.role as AccountRole, min))
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    return {
      supabase: { rpc: mocks.rpc },
      userId: ME,
      accountId: WS,
      role: mocks.caller.role,
      account: { id: WS, name: 'WS' },
    };
  },
  toErrorResponse: (err: { status?: number; message: string }) =>
    Response.json({ error: err.message }, { status: err.status ?? 500 }),
}));

vi.mock('@/lib/pbx/admin', () => ({
  pbxServiceDb: () => ({
    storage: {
      from: (bucket: string) => ({
        remove: (p: string[]) => mocks.remove(bucket, p),
      }),
    },
  }),
}));

import { POST } from './route';

const post = (body: unknown) =>
  POST({ json: async () => body } as unknown as Request);
const path = (i: number) => `account-${WS}/calls/call-${i}.wav`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.caller.role = 'owner';
  mocks.rpc.mockResolvedValue({ data: [path(1), path(2)], error: null });
  mocks.remove.mockImplementation(async (_b: string, p: string[]) => ({
    data: p.map((name) => ({ name })),
    error: null,
  }));
});

describe('POST /api/pbx/erase-contact', () => {
  it.each(['admin', 'team_leader', 'agent', 'viewer'])(
    'refuses a %s before the RPC or storage',
    async (role) => {
      mocks.caller.role = role;
      const res = await post({ contactId: CONTACT, reason: 'GDPR request' });
      expect(res.status).toBe(403);
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    }
  );

  it('needs a contact and a reason of 5 characters', async () => {
    expect(
      (await post({ contactId: 'nope', reason: 'GDPR request' })).status
    ).toBe(400);
    expect((await post({ contactId: CONTACT, reason: ' abcd ' })).status).toBe(
      400
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('erases on the caller session, then deletes the recordings', async () => {
    const res = await post({ contactId: CONTACT, reason: '  GDPR request ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recordings: 2, deleted: 2, failed: 0 });
    expect(mocks.rpc).toHaveBeenCalledWith('pbx_erase_contact_calls', {
      p_contact_id: CONTACT,
      p_reason: 'GDPR request',
    });
    expect(mocks.remove).toHaveBeenCalledWith('call-recordings', [
      path(1),
      path(2),
    ]);
  });

  it('deletes only the returned paths under the account prefix, in batches of 100', async () => {
    const many = Array.from({ length: 205 }, (_, i) => path(i));
    const foreign = 'account-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/calls/x.wav';
    const sneaky = `account-${WS}/../account-bbbb/calls/y.wav`;
    mocks.rpc.mockResolvedValue({
      data: [...many, foreign, sneaky],
      error: null,
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ contactId: CONTACT, reason: 'GDPR request' });
    spy.mockRestore();
    expect(mocks.remove.mock.calls.map((c) => c[1].length)).toEqual([
      100, 100, 5,
    ]);
    const removed = mocks.remove.mock.calls.flatMap((c) => c[1]);
    expect(removed).toEqual(many);
    expect(await res.json()).toEqual({
      recordings: 207,
      deleted: 205,
      failed: 2,
    });
  });

  it('retries a failed batch once, then counts it as left behind', async () => {
    mocks.remove.mockResolvedValue({ data: null, error: { message: 'down' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ contactId: CONTACT, reason: 'GDPR request' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(await res.json()).toEqual({ recordings: 2, deleted: 0, failed: 2 });
  });

  it.each([
    ['42501', 403],
    ['P0002', 404],
    ['55000', 409],
  ])(
    'answers the RPC refusal %s as %i and deletes nothing',
    async (code, status) => {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code, message: 'no' },
      });
      const res = await post({ contactId: CONTACT, reason: 'GDPR request' });
      expect(res.status).toBe(status);
      expect(mocks.remove).not.toHaveBeenCalled();
    }
  );
});
