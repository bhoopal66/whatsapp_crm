import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  due: [] as Record<string, unknown>[],
  updates: [] as { payload: Record<string, unknown>; id: string }[],
  claim: vi.fn(),
  plan: vi.fn(),
  markSending: vi.fn(),
  release: vi.fn(),
  deliver: vi.fn(),
  finalize: vi.fn(),
  reconcile: vi.fn(),
  afterCallbacks: [] as (() => Promise<void>)[],
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (cb: () => Promise<void>) => {
      h.afterCallbacks.push(cb);
    },
  };
});

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          lte: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: h.due, error: null }),
            }),
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          const done = Promise.resolve({ error: null });
          h.updates.push({ payload, id });
          return Object.assign(done, {
            eq: () => done,
          });
        },
      }),
    }),
  }),
}));

vi.mock('@/lib/whatsapp/broadcast-resume', () => ({
  claimBroadcastDelivery: h.claim,
  planBroadcastResume: h.plan,
  markBroadcastSending: h.markSending,
  releaseBroadcastDelivery: h.release,
}));

vi.mock('@/lib/whatsapp/broadcast-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/broadcast-core')>();
  return {
    ...actual,
    deliverBroadcast: h.deliver,
    finalizeBroadcastStatus: h.finalize,
    reconcileBroadcastStatuses: h.reconcile,
  };
});

import { GET } from './route';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';

function req(secret?: string) {
  return new Request('http://localhost/api/whatsapp/broadcast/cron', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

const DUE = {
  id: 'bc-1',
  account_id: 'acct-1',
  scheduled_at: '2026-09-16T05:00:00.000Z',
  quiet_hours: null,
};

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 's3cret';
  h.due = [];
  h.updates = [];
  h.afterCallbacks = [];
  h.claim.mockReset().mockResolvedValue(true);
  h.plan.mockReset().mockResolvedValue({
    plan: { broadcastId: 'bc-1', planned: [{}] },
    remaining: 0,
    unsendable: 0,
  });
  h.markSending.mockReset().mockResolvedValue(undefined);
  h.release.mockReset().mockResolvedValue(undefined);
  h.deliver.mockReset().mockResolvedValue(undefined);
  h.finalize.mockReset().mockResolvedValue(undefined);
  h.reconcile.mockReset().mockResolvedValue(0);
  vi.useFakeTimers();
  // 12:00 Dubai (08:00Z) — outside the default test window.
  vi.setSystemTime(new Date('2026-09-16T08:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/whatsapp/broadcast/cron — auth', () => {
  it('503s when the secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    expect((await GET(req('x'))).status).toBe(503);
  });

  it('401s on a wrong or missing secret', async () => {
    expect((await GET(req('nope'))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
  });
});

describe('GET /api/whatsapp/broadcast/cron — delivery', () => {
  it('reports nothing to do when no campaign is due', async () => {
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 0,
      deferred: 0,
      skipped: 0,
      reconciled: 0,
    });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('claims, plans, marks sending, and delivers in after()', async () => {
    h.due = [DUE];
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 1,
      deferred: 0,
      skipped: 0,
      reconciled: 0,
    });
    expect(h.claim).toHaveBeenCalledWith(expect.anything(), 'acct-1', 'bc-1');
    expect(h.plan).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'bc-1',
      'pending'
    );
    expect(h.markSending).toHaveBeenCalledWith(expect.anything(), 'bc-1');

    // Fan-out is deferred to after() — nothing sent yet.
    expect(h.deliver).not.toHaveBeenCalled();
    for (const cb of h.afterCallbacks) await cb();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'bc-1');
  });

  it('skips a campaign another tick already claimed', async () => {
    h.due = [DUE];
    h.claim.mockResolvedValue(false);
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 0,
      deferred: 0,
      skipped: 1,
      reconciled: 0,
    });
    expect(h.plan).not.toHaveBeenCalled();
  });

  it('defers a campaign that comes due inside its quiet hours', async () => {
    // 23:00 Dubai
    vi.setSystemTime(new Date('2026-09-16T19:00:00Z'));
    h.due = [
      {
        ...DUE,
        quiet_hours: { start: '21:00', end: '08:00', tz: 'Asia/Dubai' },
      },
    ];
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 0,
      deferred: 1,
      skipped: 0,
      reconciled: 0,
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.updates).toEqual([
      { id: 'bc-1', payload: { scheduled_at: '2026-09-17T04:00:00.000Z' } },
    ]);
  });

  it('sends a campaign whose quiet hours are not in effect', async () => {
    h.due = [
      {
        ...DUE,
        quiet_hours: { start: '21:00', end: '08:00', tz: 'Asia/Dubai' },
      },
    ];
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 1,
      deferred: 0,
      skipped: 0,
      reconciled: 0,
    });
  });

  it('settles a campaign with nothing left to send and releases the lock', async () => {
    h.due = [DUE];
    h.plan.mockRejectedValue(
      new BroadcastError('nothing_to_resume', 'nothing', 400)
    );
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 0,
      deferred: 0,
      skipped: 1,
      reconciled: 0,
    });
    expect(h.finalize).toHaveBeenCalledWith(expect.anything(), 'bc-1');
    expect(h.release).toHaveBeenCalledWith(expect.anything(), 'bc-1');
    expect(h.updates).toEqual([]);
  });

  it('marks a campaign failed when planning fails for a config reason', async () => {
    h.due = [DUE];
    h.plan.mockRejectedValue(
      new BroadcastError('template_not_found', 'No template', 404)
    );
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 0,
      deferred: 0,
      skipped: 1,
      reconciled: 0,
    });
    expect(h.release).toHaveBeenCalled();
    expect(h.updates[0]).toMatchObject({
      id: 'bc-1',
      payload: expect.objectContaining({ status: 'failed' }),
    });
  });
});

describe('GET /api/whatsapp/broadcast/cron — receipt reconcile (066)', () => {
  it('replays lost receipts on every tick, even with nothing due', async () => {
    h.reconcile.mockResolvedValue(4);
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 0,
      deferred: 0,
      skipped: 0,
      reconciled: 4,
    });
    // Account-wide, default window: the function scopes itself.
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledWith();
  });

  it('still delivers when the reconcile is unavailable', async () => {
    // null: migration 066 not applied yet, or the RPC failed.
    h.reconcile.mockResolvedValue(null);
    h.due = [DUE];
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({
      started: 1,
      deferred: 0,
      skipped: 0,
      reconciled: null,
    });
  });

  it('does not reconcile for an unauthenticated caller', async () => {
    await GET(req('nope'));
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});
