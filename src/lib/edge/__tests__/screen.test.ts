import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SCOPES,
  MemoryRateStore,
  RateLimiter,
  type RateStore,
} from '../ratelimit';
import { MemorySeenStore, ReplayGuard, type SeenStore } from '../replay';
import {
  confirmAccepted,
  releaseAccepted,
  screenWebhook,
  type ScreenCtx,
  type ScreenEvent,
  type ScreenInput,
  type ScreenResult,
} from '../screen';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const A = '971501111111';
const B = '971502222222';
const boom = async (): Promise<never> => {
  throw new Error('db down');
};

function ctx(over: { seen?: SeenStore; rate?: RateStore } = {}) {
  const logger = { warn: vi.fn() };
  const c: ScreenCtx = {
    replay: new ReplayGuard(over.seen ?? new MemorySeenStore()),
    limiter: new RateLimiter(
      over.rate ?? new MemoryRateStore(),
      DEFAULT_SCOPES,
      logger
    ),
    logger,
  };
  return { c, log: logger };
}
const msg = (id: string, from = A): ScreenEvent => ({
  key: `msg:${id}`,
  senderKey: from,
  kind: 'message',
});
const req = (events: ScreenEvent[], ip = '173.252.88.1'): ScreenInput => ({
  ip,
  events,
});
const outcomes = (r: ScreenResult) =>
  r.decisions.map((d) => [d.key, d.outcome]);
const accepted = (r: ScreenResult) =>
  r.decisions.filter((d) => d.outcome === 'accept').map((d) => d.key);

describe('screenWebhook', () => {
  it('a new message → 200, accepted with a claim token', async () => {
    const { c } = ctx();
    expect(await screenWebhook(c, req([msg('m1')]), T0)).toEqual({
      status: 200,
      decisions: [
        { key: 'msg:m1', outcome: 'accept', claimToken: expect.any(String) },
      ],
    });
  });

  it('a confirmed message delivered again → duplicate (still 200)', async () => {
    const { c } = ctx();
    const d1 = await screenWebhook(c, req([msg('dup1')]), T0);
    expect(await confirmAccepted(c, d1.decisions)).toEqual({ unconfirmed: [] });
    expect(await screenWebhook(c, req([msg('dup1')]), T0 + 5000)).toEqual({
      status: 200,
      decisions: [{ key: 'msg:dup1', outcome: 'duplicate' }],
    });
  });

  it('an in-request duplicate is dropped without taking a claim', async () => {
    const seen = new MemorySeenStore();
    const claim = vi.spyOn(seen, 'claim');
    const { c } = ctx({ seen });
    const d = await screenWebhook(c, req([msg('x'), msg('x')]), T0);
    expect(outcomes(d)).toEqual([
      ['msg:x', 'accept'],
      ['msg:x', 'duplicate'],
    ]);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('crash between claim and confirm: immediate retry → 503 with nothing; retry after the lease → processed', async () => {
    let t = T0;
    const { c } = ctx({ seen: new MemorySeenStore(() => t) });
    const body = req([msg('ok0'), msg('crash1')]);
    const first = await screenWebhook(c, body, t);
    expect(accepted(first)).toEqual(['msg:ok0', 'msg:crash1']);
    await confirmAccepted(c, first.decisions.slice(0, 1)); // host persisted ok0, then crashed
    t += 2000;
    expect(await screenWebhook(c, body, t)).toEqual({
      status: 503,
      decisions: [],
    });
    t += 60_000;
    const later = await screenWebhook(c, body, t);
    expect(later.status).toBe(200);
    expect(outcomes(later)).toEqual([
      ['msg:ok0', 'duplicate'],
      ['msg:crash1', 'accept'],
    ]);
    expect(later.decisions[1].claimToken).not.toBe(
      first.decisions[1].claimToken
    );
  });

  it('a stale token cannot confirm a re-claimed key', async () => {
    let t = T0;
    const { c } = ctx({ seen: new MemorySeenStore(() => t) });
    const first = await screenWebhook(c, req([msg('st1')]), t);
    t += 61_000;
    const second = await screenWebhook(c, req([msg('st1')]), t);
    expect(await confirmAccepted(c, first.decisions)).toEqual({
      unconfirmed: ['msg:st1'],
    });
    expect((await screenWebhook(c, req([msg('st1')]), t + 1000)).status).toBe(
      503
    );
    expect(await confirmAccepted(c, second.decisions)).toEqual({
      unconfirmed: [],
    });
    expect(
      (await screenWebhook(c, req([msg('st1')]), t + 2000)).decisions
    ).toEqual([{ key: 'msg:st1', outcome: 'duplicate' }]);
  });

  it('a rate-limited message leaves no seen key', async () => {
    const store = new MemorySeenStore();
    const { c } = ctx({ seen: store });
    const d = await screenWebhook(
      c,
      req(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => msg(id))),
      T0
    );
    expect(d.decisions.filter((x) => x.outcome !== 'accept')).toEqual([
      { key: 'msg:r5', outcome: 'rate_limited' },
    ]);
    expect(store.size).toBe(4);
    expect(await screenWebhook(c, req([msg('r5')]), T0 + 1000)).toEqual({
      status: 200,
      decisions: [
        { key: 'msg:r5', outcome: 'accept', claimToken: expect.any(String) },
      ],
    });
  });

  it('redeliveries never spend quota, so a new message in the same second is processed', async () => {
    const { c } = ctx();
    const old = ['d1', 'd2', 'd3', 'd4'];
    const first = await screenWebhook(
      c,
      req(old.map((id) => msg(id))),
      T0 - 1500
    );
    await confirmAccepted(c, first.decisions);
    const d = await screenWebhook(
      c,
      req([...old, 'fresh'].map((id) => msg(id))),
      T0
    );
    expect(outcomes(d)).toEqual([
      ...old.map((id) => [`msg:${id}`, 'duplicate']),
      ['msg:fresh', 'accept'],
    ]);
    // In-request duplicates spend nothing either: x + 3 more = the 4/s quota.
    const e = await screenWebhook(
      c,
      req(['x', 'x', 'x', 'y1', 'y2', 'y3'].map((id) => msg(id, B))),
      T0
    );
    expect(e.decisions.map((x) => x.outcome)).toEqual([
      'accept',
      'duplicate',
      'duplicate',
      'accept',
      'accept',
      'accept',
    ]);
  });

  it("a 503 releases this request's earlier claims, so the retry is not blocked by them", async () => {
    const { c } = ctx();
    const pre = await screenWebhook(c, req([msg('mB')]), T0);
    const both = req([msg('mA'), msg('mB')]);
    expect(await screenWebhook(c, both, T0 + 1000)).toEqual({
      status: 503,
      decisions: [],
    });
    await confirmAccepted(c, pre.decisions);
    const retry = await screenWebhook(c, both, T0 + 2000);
    expect(retry.status).toBe(200);
    expect(outcomes(retry)).toEqual([
      ['msg:mA', 'accept'],
      ['msg:mB', 'duplicate'],
    ]);
  });

  it('6 messages from one number in one second → 4 accepted + 2 rate_limited, status 200', async () => {
    const { c, log } = ctx();
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const d = await screenWebhook(c, req(ids.map((id) => msg(id))), T0);
    expect(d.status).toBe(200);
    expect(d.decisions.map((x) => x.outcome)).toEqual([
      'accept',
      'accept',
      'accept',
      'accept',
      'rate_limited',
      'rate_limited',
    ]);
    expect(d.decisions[4].claimToken).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'webhook message rate limited',
      expect.objectContaining({ key: 'msg:a5' })
    );
  });

  it('messages from two numbers are unaffected by each other', async () => {
    const { c } = ctx();
    for (let i = 0; i < 6; i++)
      await screenWebhook(c, req([msg(`A${i}`)]), T0 + i);
    const d = await screenWebhook(
      c,
      req([msg('B0', B), msg('B1', B)]),
      T0 + 10
    );
    expect(accepted(d)).toEqual(['msg:B0', 'msg:B1']);
  });

  it('status updates are deduped per transition and not sender-limited', async () => {
    const rate = new MemoryRateStore();
    const { c } = ctx({ rate });
    const st = (id: string, s: string): ScreenEvent => ({
      key: `status:${id}:${s}`,
      senderKey: A,
      kind: 'status',
    });
    const d = await screenWebhook(
      c,
      req(
        ['sent', 'delivered', 'read', 'read', 'failed', 'sent'].map((s) =>
          st('wamid.OUT', s)
        )
      ),
      T0
    );
    expect(d.decisions.map((x) => x.outcome)).toEqual([
      'accept',
      'accept',
      'accept',
      'duplicate',
      'accept',
      'duplicate',
    ]);
    const many = await screenWebhook(
      c,
      req(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => st(id, 'read'))),
      T0
    );
    expect(many.decisions.every((x) => x.outcome === 'accept')).toBe(true);
    expect(rate.size('webhook.number', A)).toBe(0);
  });

  it('IP over its sanity limit (600/s) → 200, everything ip_limited, nothing claimed', async () => {
    const store = new MemorySeenStore();
    const { c, log } = ctx({ seen: store });
    const ip = '66.220.149.1';
    for (let i = 0; i < 600; i++)
      expect((await screenWebhook(c, req([], ip), T0)).status).toBe(200);
    const late = req(
      [msg('late1'), { key: 'status:x:read', kind: 'status' }],
      ip
    );
    expect(await screenWebhook(c, late, T0 + 200)).toEqual({
      status: 200,
      decisions: [
        { key: 'msg:late1', outcome: 'ip_limited' },
        { key: 'status:x:read', outcome: 'ip_limited' },
      ],
    });
    expect(log.warn).toHaveBeenCalledWith(
      'webhook ip rate limited; request dropped',
      expect.objectContaining({ ip })
    );
    expect(store.size).toBe(0);
    expect(
      accepted(
        await screenWebhook(c, req([msg('other')], '66.220.149.2'), T0 + 200)
      )
    ).toEqual(['msg:other']);
    expect(accepted(await screenWebhook(c, late, T0 + 1000))).toEqual([
      'msg:late1',
      'status:x:read',
    ]);
  });

  it('broken stores fail open: accepted without a claim token, degraded', async () => {
    const { c, log } = ctx({
      seen: { claim: boom, confirm: boom, release: boom },
      rate: { hit: boom },
    });
    const d = await screenWebhook(c, req([msg('deg1')]), T0);
    expect(d).toEqual({
      status: 200,
      decisions: [{ key: 'msg:deg1', outcome: 'accept' }],
      degraded: true,
    });
    expect(log.warn).toHaveBeenCalledWith(
      'replay store failed; failing open',
      expect.objectContaining({ key: 'msg:deg1' })
    );
    expect(await confirmAccepted(c, d.decisions)).toEqual({ unconfirmed: [] }); // nothing was claimed
  });
});

describe('confirmAccepted / releaseAccepted', () => {
  it('releaseAccepted gives the claims back, so the retry is processed at once', async () => {
    const { c } = ctx();
    const body = req([msg('p1'), msg('p2')]);
    const d = await screenWebhook(c, body, T0);
    await releaseAccepted(c, d.decisions); // host failed to persist
    const retry = await screenWebhook(c, body, T0 + 10);
    expect(retry.status).toBe(200);
    expect(accepted(retry)).toEqual(['msg:p1', 'msg:p2']);
  });

  it('only accepted decisions with a token are confirmed or released', async () => {
    const seen = new MemorySeenStore();
    const confirm = vi.spyOn(seen, 'confirm');
    const release = vi.spyOn(seen, 'release');
    const { c } = ctx({ seen });
    const d = await screenWebhook(
      c,
      req(['a1', 'a2', 'a3', 'a4', 'a5', 'a1'].map((id) => msg(id))),
      T0
    );
    release.mockClear(); // a5's rate-limit release
    await releaseAccepted(c, [
      ...d.decisions,
      { key: 'msg:z', outcome: 'accept' },
    ]);
    expect(release.mock.calls.map(([k]) => k)).toEqual([
      'msg:a1',
      'msg:a2',
      'msg:a3',
      'msg:a4',
    ]);
    await confirmAccepted(c, d.decisions);
    expect(confirm.mock.calls.map(([k]) => k)).toEqual([
      'msg:a1',
      'msg:a2',
      'msg:a3',
      'msg:a4',
    ]);
  });

  it('store errors are logged, never thrown; a failed confirm is reported unconfirmed', async () => {
    const seen = new MemorySeenStore();
    const { c, log } = ctx({ seen });
    const d = await screenWebhook(c, req([msg('e1')]), T0);
    vi.spyOn(seen, 'confirm').mockRejectedValue(new Error('db down'));
    vi.spyOn(seen, 'release').mockRejectedValue(new Error('db down'));
    expect(await confirmAccepted(c, d.decisions)).toEqual({
      unconfirmed: ['msg:e1'],
    });
    await expect(releaseAccepted(c, d.decisions)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'replay confirm failed',
      expect.objectContaining({ key: 'msg:e1' })
    );
    expect(log.warn).toHaveBeenCalledWith(
      'replay release failed',
      expect.objectContaining({ key: 'msg:e1' })
    );
  });
});
