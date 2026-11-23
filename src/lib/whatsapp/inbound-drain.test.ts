import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeInbox } from './webhook-inbox.fake';

const h = vi.hoisted(() => ({
  inbox: null as unknown as FakeInbox,
  process: vi.fn(),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => h.inbox.rpc(fn, args),
  }),
}));
vi.mock('./inbound-events', () => ({ processInboundEvent: h.process }));

import { drainInboundEvents, runInboundQueueTick } from './inbound-drain';

const names = () => h.inbox.calls.map((c) => c.name);

beforeEach(() => {
  vi.restoreAllMocks();
  h.inbox = new FakeInbox();
  h.process.mockReset().mockResolvedValue({ outcome: 'done' });
});

describe('drainInboundEvents', () => {
  it('claims one row at a time, processing and settling each before the next', async () => {
    h.inbox.add({});
    h.inbox.add({});
    await drainInboundEvents();
    expect(names()).toEqual(['claim', 'settle', 'claim', 'settle', 'claim']);
    expect(
      h.inbox.calls.filter((c) => c.name === 'claim').map((c) => c.args.p_limit)
    ).toEqual([1, 1, 1]);
    expect(h.inbox.rows.map((r) => r.state)).toEqual(['done', 'done']);
  });

  it('settles a failure and goes on to the next row', async () => {
    h.inbox.add({});
    h.inbox.add({});
    h.process.mockResolvedValueOnce({ outcome: 'failed', reason: 'x 57014' });
    // A failed row is due again only later; the fake is told so.
    const claim = h.inbox.rpc.bind(h.inbox);
    vi.spyOn(h.inbox, 'rpc').mockImplementation(async (fn, args) => {
      const res = await claim(fn, args);
      if (h.inbox.rows[0].last_error) h.inbox.rows[0].state = 'leased';
      return res;
    });
    await drainInboundEvents();
    expect(h.inbox.rows[0].last_error).toBe('x 57014');
    expect(h.inbox.rows[1].state).toBe('done');
  });

  it('stops at 50 rows', async () => {
    for (let i = 0; i < 60; i++) h.inbox.add({});
    expect(await drainInboundEvents()).toEqual({ processed: 50 });
    expect(h.process).toHaveBeenCalledTimes(50);
  });

  it('stops at the 40 second deadline', async () => {
    for (let i = 0; i < 10; i++) h.inbox.add({});
    let t = 0;
    h.process.mockImplementation(async () => {
      t += 15_000;
      return { outcome: 'done' };
    });
    expect(await drainInboundEvents(() => t)).toEqual({ processed: 3 });
  });
});

describe('runInboundQueueTick', () => {
  it('survives a throwing drain, bell and purge, each on its own', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const fn of ['claim', 'notify_dead', 'purge']) {
      h.inbox.errors[fn] = { code: '57014' };
    }
    await expect(runInboundQueueTick()).resolves.toBeUndefined();
    expect(names()).toEqual(['claim', 'notify_dead', 'purge']);
    expect(err).toHaveBeenCalledTimes(3);
  });

  it('logs dead events as a count per account', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.inbox.deadAccounts = [{ account_id: 'acc-1', events: 2 }];
    await runInboundQueueTick();
    expect(err.mock.calls).toEqual([
      ['[inbound-drain] 2 inbound event(s) given up on account acc-1'],
    ]);
  });

  it('does nothing while migration 264 is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.inbox.missing();
    await runInboundQueueTick();
    expect(h.process).not.toHaveBeenCalled();
  });
});
