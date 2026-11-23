import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: mocks.rpc,
    auth: {
      getUser: async () => ({ data: { user: { id: 'u' } }, error: null }),
    },
  }),
}));

import { GET } from './peek/route';
import { POST } from './redeem/route';

beforeEach(() => mocks.rpc.mockReset());

// Migration 287: the database hashes the token; the app never sends a hash.
describe('an invitation link is opened by its token', () => {
  const at = { params: Promise.resolve({ token: 'the-token' }) };

  it('peek', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await GET(new Request('http://localhost/x'), at);
    expect(mocks.rpc).toHaveBeenCalledWith('peek_invitation_token', {
      p_token: 'the-token',
    });
  });

  it('redeem', async () => {
    mocks.rpc.mockResolvedValue({ data: 'a', error: null });
    const res = await POST(
      new Request('http://localhost/x', { method: 'POST' }),
      at
    );
    expect(await res.json()).toEqual({ ok: true, accountId: 'a' });
    expect(mocks.rpc).toHaveBeenCalledWith('redeem_invitation_token', {
      p_token: 'the-token',
    });
  });
});
