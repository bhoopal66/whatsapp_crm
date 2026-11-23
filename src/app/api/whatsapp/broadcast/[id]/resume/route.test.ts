import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeDb, type Row } from '@/lib/whatsapp/broadcast.fake';

const h = vi.hoisted(() => ({
  db: null as unknown,
  afterCallbacks: [] as (() => Promise<void>)[],
}));

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (cb: () => Promise<void>) => h.afterCallbacks.push(cb),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: h.db,
    accountId: 'acct-1',
    userId: 'u-1',
  }),
  toErrorResponse: () => new Response(null, { status: 500 }),
  assertSalesAccess: (ctx: unknown) => ctx,
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { broadcast: {} },
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }));

import { POST } from './route';

function world(status: string, recipients: Row[]) {
  const tables: Record<string, Row[]> = {
    broadcasts: [
      {
        id: 'bc-1',
        account_id: 'acct-1',
        status,
        quiet_hours: null,
        delivery_locked_at: null,
      },
    ],
    broadcast_recipients: recipients.map((r, i) => ({
      id: `r${i}`,
      broadcast_id: 'bc-1',
      error_message: null,
      ...r,
    })),
  };
  h.db = fakeDb(tables);
  return tables.broadcasts[0];
}

const resume = () =>
  POST(
    new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ scope: 'pending' }),
    }),
    { params: Promise.resolve({ id: 'bc-1' }) }
  );

beforeEach(() => {
  h.afterCallbacks.length = 0;
});

describe('nothing left to resume', () => {
  it('settles a campaign left sending, and frees the lock', async () => {
    const broadcast = world('sending', [
      { status: 'sent' },
      { status: 'pending', contact: { opted_out_at: '2026-11-22T00:00:00Z' } },
    ]);
    const res = await resume();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'nothing_to_resume' });
    expect(broadcast).toMatchObject({
      status: 'sent',
      delivery_locked_at: null,
    });
  });

  it('never settles a draft that has no recipients yet', async () => {
    const broadcast = world('draft', []);
    expect((await resume()).status).toBe(400);
    expect(broadcast.status).toBe('draft');
  });
});
