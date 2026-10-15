import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  eq: vi.fn(),
  result: { error: null as unknown },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: mocks.getCurrentAccount,
}));

import { POST } from './route';

function query() {
  const q: Record<string, unknown> = {
    delete: () => q,
    eq: (col: string, val: string) => {
      mocks.eq(col, val);
      return q;
    },
    then: (ok: (v: unknown) => unknown) =>
      Promise.resolve(mocks.result).then(ok),
  };
  return q;
}

const unsubscribe = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/push/unsubscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.result = { error: null };
    mocks.getCurrentAccount.mockResolvedValue({
      userId: 'user-1',
      supabase: { from: query },
    });
  });

  it('deletes the caller’s own row for that endpoint', async () => {
    const res = await unsubscribe({ endpoint: 'https://p.example.com/1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mocks.eq).toHaveBeenCalledWith(
      'endpoint',
      'https://p.example.com/1'
    );
  });

  it('deletes every one of the caller’s rows for { all: true }', async () => {
    const res = await unsubscribe({ all: true });
    expect(res.status).toBe(200);
    expect(mocks.eq.mock.calls).toEqual([['user_id', 'user-1']]);
  });

  it('refuses a missing endpoint', async () => {
    expect((await unsubscribe({})).status).toBe(400);
    expect(mocks.eq).not.toHaveBeenCalled();
  });

  it('answers 500 when the delete fails', async () => {
    mocks.result = { error: { message: 'boom' } };
    expect(
      (await unsubscribe({ endpoint: 'https://p.example.com/1' })).status
    ).toBe(500);
  });
});
