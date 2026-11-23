import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from './webhook-inbox';

// The wrappers over migration 264. Only the RPC client is faked.

const rpc = vi.fn();
const db = { rpc } as never;

const event = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  accountId: 'acct-1',
  channel: 'cfg-1',
  provider: 'whapi',
  eventKey: 'whapi:cfg-1:m1',
  kind: 'message',
  payload: { message: { id: 'm1' } },
  ...over,
});

/** A fresh module per test: the 264 warning is once per process. */
let inbox: typeof import('./webhook-inbox');
let logged: unknown[][];

beforeEach(async () => {
  vi.resetModules();
  rpc.mockReset();
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => void logged.push(a));
  inbox = await import('./webhook-inbox');
});

describe('recordInboundEvents', () => {
  it('sends the contract shape and answers in the delivery order', async () => {
    rpc.mockResolvedValue({
      data: [
        { event_key: 'a', id: 'id-a', attempt: 1, state: 'new' },
        { event_key: 'b', id: 'id-b', attempt: 2, state: 'busy' },
      ],
      error: null,
    });
    const b = event({ eventKey: 'b' });
    const a = event({ eventKey: 'a' });
    const res = await inbox.recordInboundEvents([b, a, b], db);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('webhook_inbox_record');
    // A key repeated in the delivery is one event: 264 would answer 'busy'
    // for the repeat, over the first one's 'new'.
    expect(rpc.mock.calls[0][1].p_events).toHaveLength(2);
    expect(rpc.mock.calls[0][1].p_events[0]).toEqual({
      account_id: 'acct-1',
      channel: 'cfg-1',
      provider: 'whapi',
      event_key: 'b',
      kind: 'message',
      payload: { message: { id: 'm1' } },
    });
    expect(res).toEqual({
      status: 'recorded',
      events: [
        { event: b, id: 'id-b', attempt: 2, state: 'busy' },
        { event: a, id: 'id-a', attempt: 1, state: 'new' },
      ],
    });
  });

  it('strips what jsonb refuses and keeps real text', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await inbox.recordInboundEvents(
      [
        event({
          payload: {
            text: 'a\u0000b \ud83d c \udc00 \u{1f600} literal \\u0000',
            ['k\u0000']: [null, 1, { x: '\udfff' }],
          },
        }),
      ],
      db
    );
    expect(rpc.mock.calls[0][1].p_events[0].payload).toEqual({
      text: 'ab � c � \u{1f600} literal \\u0000',
      k: [null, 1, { x: '�' }],
    });
  });

  it.each(['x'.repeat(600), 'm\u0000'])(
    'hashes a key 264 would refuse',
    async (eventKey) => {
      rpc.mockImplementation(async (_fn, args) => ({
        data: [
          {
            event_key: args.p_events[0].event_key,
            id: 'i',
            attempt: 1,
            state: 'new',
          },
        ],
        error: null,
      }));
      const res = await inbox.recordInboundEvents([event({ eventKey })], db);
      expect(rpc.mock.calls[0][1].p_events[0].event_key).toMatch(
        /^h:[0-9a-f]{64}$/
      );
      expect(res).toMatchObject({ events: [{ event: { eventKey }, id: 'i' }] });
    }
  );

  it.each(['PGRST202', '42883'])(
    '%s: unavailable, logged once per process',
    async (code) => {
      rpc.mockResolvedValue({ data: null, error: { code } });
      const run = () => inbox.recordInboundEvents([event()], db);
      expect(await run()).toEqual({ status: 'unavailable' });
      expect(await run()).toEqual({ status: 'unavailable' });
      expect(logged).toHaveLength(1);
      expect(logged[0][0]).toContain('NOT DURABLE');
    }
  );

  it('any other failure is failed, and quotes nothing', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'secret words' },
    });
    expect(await inbox.recordInboundEvents([event()], db)).toEqual({
      status: 'failed',
      reason: '57014',
    });
    rpc.mockRejectedValueOnce(new Error('secret words'));
    expect(await inbox.recordInboundEvents([event()], db)).toEqual({
      status: 'failed',
      reason: 'unknown',
    });
    // An event the function did not answer for.
    rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await inbox.recordInboundEvents([event()], db)).toMatchObject({
      status: 'failed',
    });
    expect(JSON.stringify(logged)).not.toContain('secret');
  });

  it('no events: no call', async () => {
    expect(await inbox.recordInboundEvents([], db)).toEqual({
      status: 'recorded',
      events: [],
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('settleInboundEvent', () => {
  it('passes the outcome and answers the new state', async () => {
    rpc.mockResolvedValue({ data: 'retry', error: null });
    const reason = 'r'.repeat(300);
    expect(
      await inbox.settleInboundEvent('i', 2, { outcome: 'failed', reason }, db)
    ).toBe('retry');
    expect(rpc).toHaveBeenCalledWith('webhook_inbox_settle', {
      p_id: 'i',
      p_attempt: 2,
      p_outcome: 'failed',
      p_error: 'r'.repeat(200),
    });
  });

  it('never throws, and logs one line without the message', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'secret words' },
    });
    const done = { outcome: 'done' } as const;
    expect(await inbox.settleInboundEvent('i', 1, done, db)).toBeNull();
    rpc.mockImplementationOnce(() => {
      throw new Error('secret words');
    });
    expect(await inbox.settleInboundEvent('i', 1, done, db)).toBeNull();
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain('secret');
  });
});

describe('the cron calls', () => {
  it('map their rows', async () => {
    rpc.mockImplementation(async (fn: string) => ({
      error: null,
      data: {
        webhook_inbox_claim: [
          {
            id: 'i',
            account_id: 'a',
            channel: 'c',
            provider: 'meta',
            event_key: 'k',
            kind: 'status',
            payload: { status: {} },
            received_at: 't',
            attempt: 3,
          },
        ],
        webhook_inbox_notify_dead: [{ account_id: 'a', events: 2 }],
        webhook_inbox_purge: 4,
        webhook_inbox_stats: {
          pending: 1,
          dead: 2,
          oldest_pending_age_seconds: 9,
        },
      }[fn],
    }));
    expect(await inbox.claimInboundEvents(5, db)).toEqual([
      {
        id: 'i',
        accountId: 'a',
        channel: 'c',
        provider: 'meta',
        eventKey: 'k',
        kind: 'status',
        payload: { status: {} },
        receivedAt: 't',
        attempt: 3,
      },
    ]);
    expect(rpc).toHaveBeenCalledWith('webhook_inbox_claim', { p_limit: 5 });
    expect(await inbox.notifyDeadInboundEvents(db)).toEqual([
      { accountId: 'a', events: 2 },
    ]);
    expect(await inbox.purgeInboundEvents(db)).toBe(4);
    expect(await inbox.inboundQueueStats(db)).toEqual({
      pending: 1,
      dead: 2,
      oldestPendingAgeSeconds: 9,
    });
  });

  it('are empty before 264 and throw on anything else', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    expect(await inbox.claimInboundEvents(1, db)).toEqual([]);
    expect(await inbox.notifyDeadInboundEvents(db)).toEqual([]);
    expect(await inbox.purgeInboundEvents(db)).toBe(0);
    expect(await inbox.inboundQueueStats(db)).toBeNull();
    rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
    await expect(inbox.claimInboundEvents(1, db)).rejects.toThrow('57014');
  });
});
