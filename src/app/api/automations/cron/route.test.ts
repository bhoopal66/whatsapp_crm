import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  due: [] as Record<string, unknown>[],
  dueError: null as { message: string } | null,
  resume: vi.fn(),
  health: vi.fn(),
  sweep: vi.fn(),
  rpc: vi.fn(),
  journeyTick: vi.fn(),
  reconcile: vi.fn(),
  submissionGroups: vi.fn(),
  pbx: vi.fn(),
  chatFiles: vi.fn(),
  push: vi.fn(),
  recurring: vi.fn(),
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

vi.mock('@/lib/deal-rooms/reconcile', () => ({
  reconcileCreatingRooms: h.reconcile,
}));
vi.mock('@/lib/submission-groups/cron', () => ({
  runSubmissionGroupsCron: h.submissionGroups,
}));
vi.mock('@/lib/pbx/housekeeping', () => ({ runPbxCron: h.pbx }));
vi.mock('@/lib/chat/file-cleanup', () => ({ runChatFileSweep: h.chatFiles }));
vi.mock('@/lib/push/dispatch', () => ({ dispatchPush: h.push }));
vi.mock('@/lib/calendar/reminders', () => ({
  runRecurringReminders: h.recurring,
}));

/** Calls of one RPC: the edge purge, push purge and calendar sweep share `rpc`. */
const rpcCalls = (name: string) =>
  h.rpc.mock.calls.filter((c) => c[0] === name);

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
  h.push.mockReset().mockResolvedValue({
    claimed: 0,
    sent: 0,
    held: 0,
    skipped: 0,
    failed: 0,
  });
  h.recurring.mockReset().mockResolvedValue(0);
  h.submissionGroups.mockReset().mockResolvedValue({ errors: [] });
  h.chatFiles
    .mockReset()
    .mockResolvedValue({ found: 0, deleted: 0, failed: [] });
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

    vi.setSystemTime(new Date('2026-09-29T13:04:00Z'));
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
    expect(rpcCalls('edge_purge')).toEqual([['edge_purge']]);

    vi.setSystemTime(new Date('2026-09-29T13:14:00Z'));
    await GET(req());
    await runAfter();
    expect(rpcCalls('edge_purge')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-09-29T13:15:00Z'));
    await GET(req());
    await runAfter();
    expect(rpcCalls('edge_purge')).toHaveLength(2);
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

describe('GET /api/automations/cron — chat file sweep', () => {
  it('runs the sweep after the response, at most every 15 minutes', async () => {
    vi.resetModules();
    const { GET } = await import('./route');

    await GET(req());
    expect(h.chatFiles).not.toHaveBeenCalled();
    await runAfter();
    expect(h.chatFiles).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:14:00Z'));
    await GET(req());
    await runAfter();
    expect(h.chatFiles).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:15:00Z'));
    await GET(req());
    await runAfter();
    expect(h.chatFiles).toHaveBeenCalledTimes(2);
  });

  it('logs a failed sweep or leftover files and leaves the other jobs running', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.chatFiles.mockRejectedValue(new Error('permission denied'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await GET(req())).status).toBe(200);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      '[automations-cron] chat file sweep failed:',
      'permission denied'
    );
    expect(h.rpc).toHaveBeenCalledWith('edge_purge');
    expect(h.health).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:15:00Z'));
    h.chatFiles.mockResolvedValue({ found: 2, deleted: 1, failed: ['x'] });
    await GET(req());
    await runAfter();
    expect(log).toHaveBeenCalledWith(
      '[automations-cron] chat file sweep left 1 of 2 file(s):',
      ['x']
    );
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
    expect(h.chatFiles).not.toHaveBeenCalled();
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

    vi.setSystemTime(new Date('2026-10-12T09:00:30Z'));
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

describe('GET /api/automations/cron — deal-room reconcile', () => {
  it('runs the reconcile after the response, at most every 2 minutes', async () => {
    vi.resetModules();
    vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));
    const { GET } = await import('./route');

    await GET(req());
    expect(h.reconcile).not.toHaveBeenCalled();
    await runAfter();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.reconcile.mock.calls[0][0]).toHaveProperty('from');

    vi.setSystemTime(new Date('2026-10-12T09:01:30Z'));
    await GET(req());
    await runAfter();
    expect(h.reconcile).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-12T09:02:00Z'));
    await GET(req());
    await runAfter();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/automations/cron — submission groups', () => {
  it('runs after the response, at most every 2 minutes, and survives a throw', async () => {
    vi.resetModules();
    vi.setSystemTime(new Date('2026-10-16T09:00:00Z'));
    const { GET } = await import('./route');

    await GET(req());
    expect(h.submissionGroups).not.toHaveBeenCalled();
    await runAfter();
    expect(h.submissionGroups).toHaveBeenCalledTimes(1);
    expect(h.submissionGroups.mock.calls[0][0]).toHaveProperty('from');

    vi.setSystemTime(new Date('2026-10-16T09:01:30Z'));
    await GET(req());
    await runAfter();
    expect(h.submissionGroups).toHaveBeenCalledTimes(1);

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.submissionGroups.mockRejectedValueOnce(new Error('boom'));
    vi.setSystemTime(new Date('2026-10-16T09:02:00Z'));
    const res = await GET(req());
    expect(res.status).toBe(200);
    await runAfter();
    expect(h.submissionGroups).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      '[automations-cron] submission groups failed:',
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

    vi.setSystemTime(new Date('2026-09-29T13:00:30Z'));
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
describe('GET /api/automations/cron — web push fallback', () => {
  it('dispatches and purges after the response, at most once a minute', async () => {
    vi.resetModules();
    const { GET } = await import('./route');

    await GET(req());
    expect(h.push).not.toHaveBeenCalled();
    await runAfter();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(rpcCalls('push_purge')).toHaveLength(1);
    // The purge runs after the dispatch pass, not before it.
    expect(h.push.mock.invocationCallOrder[0]).toBeLessThan(
      h.rpc.mock.invocationCallOrder[
        h.rpc.mock.calls.findIndex((c) => c[0] === 'push_purge')
      ]
    );

    vi.setSystemTime(new Date('2026-09-29T13:00:30Z'));
    await GET(req());
    await runAfter();
    expect(h.push).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-29T13:01:00Z'));
    await GET(req());
    await runAfter();
    expect(h.push).toHaveBeenCalledTimes(2);
    expect(rpcCalls('push_purge')).toHaveLength(2);
  });

  it('swallows a thrown dispatch and leaves the other jobs running', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.push.mockRejectedValue(new Error('push down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await GET(req())).status).toBe(200);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(h.pbx).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[automations-cron] push run failed:',
      'push down'
    );
    log.mockRestore();
  });

  it('does not run for an unauthenticated caller', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    await GET(new Request('http://localhost/api/automations/cron'));
    await runAfter();
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe('GET /api/automations/cron — calendar reminders', () => {
  it('runs the SQL sweep and the recurring reminders after the response, at most once a minute', async () => {
    vi.resetModules();
    const { GET } = await import('./route');

    await GET(req());
    expect(rpcCalls('calendar_reminder_sweep')).toEqual([]);
    expect(h.recurring).not.toHaveBeenCalled();
    await runAfter();
    expect(rpcCalls('calendar_reminder_sweep')).toEqual([
      ['calendar_reminder_sweep', { p_now: '2026-09-29T13:00:00.000Z' }],
    ]);
    expect(h.recurring).toHaveBeenCalledTimes(1);
    expect(h.recurring.mock.calls[0][0]).toHaveProperty('rpc', h.rpc);

    vi.setSystemTime(new Date('2026-09-29T13:00:30Z'));
    await GET(req());
    await runAfter();
    expect(rpcCalls('calendar_reminder_sweep')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-09-29T13:01:00Z'));
    await GET(req());
    await runAfter();
    expect(rpcCalls('calendar_reminder_sweep')).toHaveLength(2);
    expect(h.recurring).toHaveBeenCalledTimes(2);
  });

  it('logs a failed SQL sweep and still runs the recurring reminders', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await GET(req())).status).toBe(200);
    await runAfter();
    expect(log).toHaveBeenCalledWith(
      '[calendar] reminder sweep failed',
      'boom'
    );
    expect(h.recurring).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('swallows a thrown run and leaves the other jobs running', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.recurring.mockRejectedValue(new Error('down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await GET(req())).status).toBe(200);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(h.pbx).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[calendar] reminder sweep failed',
      expect.any(Error)
    );
    log.mockRestore();
  });

  it('does not run for an unauthenticated caller', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    await GET(new Request('http://localhost/api/automations/cron'));
    await runAfter();
    expect(rpcCalls('calendar_reminder_sweep')).toEqual([]);
    expect(h.recurring).not.toHaveBeenCalled();
  });
});

describe('GET /api/automations/cron — assistant safety housekeeping', () => {
  it('expires stale pending actions once a minute and prunes rate events once an hour', async () => {
    vi.resetModules();
    const { GET } = await import('./route');

    await GET(req());
    expect(rpcCalls('assist_pending_expire')).toEqual([]);
    await runAfter();
    expect(rpcCalls('assist_pending_expire')).toEqual([
      ['assist_pending_expire', { p_actor: 'system:sweep' }],
    ]);
    expect(rpcCalls('assist_rate_prune')).toEqual([['assist_rate_prune', {}]]);

    vi.setSystemTime(new Date('2026-09-29T13:01:00Z'));
    await GET(req());
    await runAfter();
    expect(rpcCalls('assist_pending_expire')).toHaveLength(2);
    expect(rpcCalls('assist_rate_prune')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-09-29T14:00:00Z'));
    await GET(req());
    await runAfter();
    expect(rpcCalls('assist_pending_expire')).toHaveLength(3);
    expect(rpcCalls('assist_rate_prune')).toHaveLength(2);
  });

  it('logs a failed sweep and still prunes', async () => {
    vi.resetModules();
    const { GET } = await import('./route');
    h.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await GET(req())).status).toBe(200);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      '[automations-cron] assist pending sweep failed:',
      'assist_pending_expire: boom'
    );
    expect(rpcCalls('assist_rate_prune')).toHaveLength(1);
    log.mockRestore();
  });
});
