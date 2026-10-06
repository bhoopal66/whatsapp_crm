import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  run: vi.fn(),
  admin: { tag: 'service-role' },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => h.admin,
}));
vi.mock('@/lib/whatsapp/channel-health', () => ({
  runChannelHealthCheck: h.run,
}));
// A pinger has no session: getUser() finds nobody.
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';
import { GET } from './route';

function req(secret?: string) {
  return new Request('http://localhost/api/whatsapp/health/cron', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 's3cret';
  h.run.mockReset();
});

describe('GET /api/whatsapp/health/cron', () => {
  it('503s when the secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    expect((await GET(req('x'))).status).toBe(503);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('401s on a wrong or missing secret', async () => {
    expect((await GET(req('nope'))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('runs the sweep with the service-role client and returns its summary', async () => {
    const summary = { checked: 2, changed: 1, notified: 3, failed: 0 };
    h.run.mockResolvedValue(summary);
    const res = await GET(req('s3cret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(h.run).toHaveBeenCalledWith(h.admin);
  });

  it('500s without leaking the database wording when the channel list fails', async () => {
    h.run.mockRejectedValue(new Error('relation does not exist'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req('s3cret'));
    log.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation/);
  });
});

describe('middleware — the health cron is reachable without a session', () => {
  it('lets the pinger through to the route’s own secret check', async () => {
    // Without the allowlist entry the session gate answers 401 before
    // the route runs, and the monitor silently never fires.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    const res = await middleware(
      new NextRequest('https://app.test/api/whatsapp/health/cron')
    );
    expect(res.status).toBe(200);
    const gated = await middleware(
      new NextRequest('https://app.test/api/whatsapp/health')
    );
    expect(gated.status).toBe(401);
  });
});
