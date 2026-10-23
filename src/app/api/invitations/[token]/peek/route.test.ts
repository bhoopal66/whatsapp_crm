import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async () => ({ data: { ok: true }, error: null }),
  }),
}));

import { GET } from './route';

function peek(token: string, headers: Record<string, string> = {}) {
  return GET(
    new Request(`http://localhost/api/invitations/${token}/peek`, { headers }),
    { params: Promise.resolve({ token }) }
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/invitations/[token]/peek rate limit', () => {
  it('with no client IP configured, one client cannot exhaust every link', async () => {
    vi.stubEnv('EDGE_CLIENT_IP_HEADER', '');
    for (let i = 0; i < 30; i++) {
      expect((await peek('token-flooded')).status).toBe(200);
    }
    expect((await peek('token-flooded')).status).toBe(429);
    // Another visitor's link is untouched: no shared "unknown" bucket.
    expect((await peek('token-other')).status).toBe(200);
  });

  it('ignores a client-written x-forwarded-for when no header is configured', async () => {
    vi.stubEnv('EDGE_CLIENT_IP_HEADER', '');
    for (let i = 0; i < 30; i++) {
      await peek('token-spoof', { 'x-forwarded-for': `198.51.100.${i}` });
    }
    expect(
      (await peek('token-spoof', { 'x-forwarded-for': '203.0.113.99' })).status
    ).toBe(429);
  });
});
