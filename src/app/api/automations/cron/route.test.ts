import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  due: [] as Record<string, unknown>[],
  dueError: null as { message: string } | null,
  resume: vi.fn(),
  health: vi.fn(),
  sweep: vi.fn(),
  rpc: vi.fn(),
  journeyTick: vi.fn(),
  pbx: vi.fn(),
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

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: h.rpc,
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        lte: () => builder,
        order: () => builder,
        update: () => builder,
        limit: () =>
          Promise.resolve({
            data: h.dueError ? null : h.due,
            error: h.dueError,
          }),
        maybeSingle: () => Promise.resolve({ data: { id: 'x' }, error: null }),
      };
      return builder;
    },
  }),
}));

vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: h.resume,
}));

// Real `everyInterval`, stubbed sweep.
vi.mock('@/lib/whatsapp/channel-health', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runChannelHealthCheck: h.health,
}));

vi.mock('@/lib/team-activity/alert-sweep', () => ({
  runTeamActivityAlertSweep: h.sweep,
}));

vi.mock('@/lib/journeys/host/tick', () => ({
  runJourneyTick: h.journeyTick,
}));

vi.mock('@/lib/pbx/housekeeping', () => ({ runPbxCron: h.pbx }));

function req() {
  return new Request('http://localhost/api/automations/cron', {
    headers: { 'x-cron-secret': 's3cret' },
  });
}

async function runAfter() {
  const callbacks = h.afterCallbacks.splice(0);
  for (const cb of callbacks) await cb();
}

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 's3cret';
  h.due = [];
  h.dueError = null;
  h.afterCallbacks = [];
  h.resume.mockReset().mockResolvedValue(undefined);
  h.health
    .mockReset()
    .mockResolvedValue({ checked: 1, changed: 0, notified: 0, failed: 0 });
  h.sweep.mockReset().mockResolvedValue({ alerts: 0, notifications: 0 });
  h.rpc.mockReset().mockResolvedValue({ data: 3, error: null });
  h.pbx.mockReset().mockResolvedValue({ outOfTime: [], errors: {} });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T13:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/automations/cron — channel health piggy-back', () => {
  it('runs the sweep after the automation work, at most every 5 minutes', async () => {
    // Fresh module per test: the throttle is per process.
    vi.resetModules();
    const { GET } = await import('./route');

    h.due = [{ id: 'p1', next_step_position: 1 }];
    const res = await GET(req());
    expect(await res.json()).toEqual({ processed: 1 });
    // Scheduled with after(), not awaited by the response.
    expect(h.health).not.toHaveBeenCalled();
    await runAfter();
    expect(h.health).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:01:00Z'));
    await GET(req());
    await runAfter();
    expect(h.health).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:05:00Z'));
    await GET(req());
    await runAfter();
    expect(h.health).toHaveBeenCalledTimes(2);
  });

  it('still runs when there is nothing to process or the queue read fails', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.dueError = { message: 'boom' };
    expect((await GET(req())).status).toBe(500);
    await runAfter();
    expect(h.health).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing sweep', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.health.mockRejectedValue(new Error('channels unreadable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('does not run for an unauthenticated caller', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost/api/automations/cron'));
    expect(res.status).toBe(401);
    expect(h.afterCallbacks).toEqual([]);
  });
});

describe('GET /api/automations/cron — team activity alerts piggy-back', () => {
  it('runs the sweep after the response, at most every 5 minutes', async () => {
    vi.resetModules();
    const { GET } = await import('./route');

    await GET(req());
    expect(h.sweep).not.toHaveBeenCalled();
    await runAfter();
    expect(h.sweep).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:04:59Z'));
    await GET(req());
    await runAfter();
    expect(h.sweep).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:05:00Z'));
    await GET(req());
    await runAfter();
    expect(h.sweep).toHaveBeenCalledTimes(2);
  });

  it('runs even when the channel health sweep fails', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.health.mockRejectedValue(new Error('channels unreadable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await GET(req());
    await runAfter();
    expect(h.sweep).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe('GET /api/automations/cron — edge store purge', () => {
  it('runs edge_purge after the response, at most every 15 minutes', async () => {
    vi.resetModules();
    const { GET } = await import('./route');

    await GET(req());
    expect(h.rpc).not.toHaveBeenCalled();
    await runAfter();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith('edge_purge');

    vi.setSystemTime(new Date('2026-09-29T13:14:59Z'));
    await GET(req());
    await runAfter();
    expect(h.rpc).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:15:00Z'));
    await GET(req());
    await runAfter();
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it('logs a failed purge and leaves the other jobs running', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(200);
    await runAfter();
    expect(log).toHaveBeenCalledWith(
      '[automations-cron] edge purge failed:',
      'boom'
    );
    expect(h.health).toHaveBeenCalledTimes(1);
    expect(h.sweep).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('swallows a thrown purge', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.rpc.mockRejectedValue(new Error('network down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await GET(req());
    await expect(runAfter()).resolves.toBeUndefined();
    log.mockRestore();
  });

  it('does not run for an unauthenticated caller', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    const res = await GET(
      new Request('http://localhost/api/automations/cron', {
        headers: { 'x-cron-secret': 'wrong!' },
      })
    );
    expect(res.status).toBe(401);
    await runAfter();
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('GET /api/automations/cron — journey tick', () => {
  it('runs the journey tick after the response, at most once a minute', async () => {
    vi.resetModules();
    h.journeyTick.mockReset();
    h.journeyTick.mockResolvedValue({});
    vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));
    const { GET } = await import('./route');

    await GET(req());
    expect(h.journeyTick).not.toHaveBeenCalled();
    await runAfter();
    expect(h.journeyTick).toHaveBeenCalledTimes(1);
    expect(h.journeyTick.mock.calls[0][0]).toHaveProperty('db');

    vi.setSystemTime(new Date('2026-10-12T09:00:59Z'));
    await GET(req());
    await runAfter();
    expect(h.journeyTick).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-12T09:01:00Z'));
    await GET(req());
    await runAfter();
    expect(h.journeyTick).toHaveBeenCalledTimes(2);
  });

  it('logs a failed journey tick and still answers', async () => {
    vi.resetModules();
    h.journeyTick.mockReset();
    h.journeyTick.mockRejectedValue(new Error('boom'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('./route');

    const res = await GET(req());
    expect(res.status).toBe(200);
    await runAfter();
    expect(log).toHaveBeenCalledWith(
      '[automations-cron] journey tick failed:',
      'boom'
    );
    log.mockRestore();
  });
});

describe('GET /api/automations/cron — phone system piggy-back', () => {
  it('runs the PBX work after the response, at most once a minute', async () => {
    vi.resetModules();
    const { GET } = await import('./route');

    await GET(req());
    expect(h.pbx).not.toHaveBeenCalled();
    await runAfter();
    expect(h.pbx).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:00:59Z'));
    await GET(req());
    await runAfter();
    expect(h.pbx).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:01:00Z'));
    await GET(req());
    await runAfter();
    expect(h.pbx).toHaveBeenCalledTimes(2);
  });

  it('swallows a thrown PBX run and leaves the other jobs running', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.pbx.mockRejectedValue(new Error('pbx down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await GET(req())).status).toBe(200);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(h.health).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[automations-cron] pbx run failed:',
      'pbx down'
    );
    log.mockRestore();
  });

  it('does not run for an unauthenticated caller', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    await GET(new Request('http://localhost/api/automations/cron'));
    await runAfter();
    expect(h.pbx).not.toHaveBeenCalled();
  });
});
