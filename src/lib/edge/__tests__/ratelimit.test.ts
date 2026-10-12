import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SCOPES,
  MemoryRateStore,
  RateLimiter,
  type RateStore,
} from '../ratelimit';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const quiet = { warn: vi.fn() };
const mk = () => new RateLimiter(new MemoryRateStore(), DEFAULT_SCOPES, quiet);

describe('RateLimiter (memory)', () => {
  it('4 allowed, 5th in the same second refused with retryAfterMs > 0; next window allowed', async () => {
    const rl = mk();
    const res = [];
    for (let i = 0; i < 5; i++)
      res.push(await rl.check('webhook.number', 'n1', T0 + i * 100));
    expect(res.map((r) => r.allowed)).toEqual([true, true, true, true, false]);
    expect(res.map((r) => r.remaining)).toEqual([3, 2, 1, 0, 0]);
    expect(res[4].retryAfterMs).toBe(600); // oldest hit at T0 leaves the window at T0+1000
    expect((await rl.check('webhook.number', 'n1', T0 + 1000)).allowed).toBe(
      true
    );
  });

  it('the window slides: old hits are pruned, recent ones still count', async () => {
    const rl = mk();
    for (const dt of [0, 0, 900, 900])
      expect((await rl.check('webhook.number', 'n2', T0 + dt)).allowed).toBe(
        true
      );
    expect((await rl.check('webhook.number', 'n2', T0 + 1000)).allowed).toBe(
      true
    ); // two from T0 pruned
    expect((await rl.check('webhook.number', 'n2', T0 + 1001)).allowed).toBe(
      true
    );
    expect((await rl.check('webhook.number', 'n2', T0 + 1002)).allowed).toBe(
      false
    ); // 900,900,1000,1001
  });

  it('scopes are independent and keys are independent', async () => {
    const rl = mk();
    for (let i = 0; i < 4; i++) await rl.check('webhook.number', 'k', T0);
    expect((await rl.check('webhook.number', 'k', T0)).allowed).toBe(false);
    expect((await rl.check('webhook.number', 'k2', T0)).allowed).toBe(true);
    expect((await rl.check('webhook.ip', 'k', T0)).allowed).toBe(true);
    expect((await rl.check('admin.user', 'k', T0)).allowed).toBe(true);
  });

  it('refused hits are not recorded (a blocked caller is not locked out forever)', async () => {
    const rl = mk();
    for (let i = 0; i < 4; i++) await rl.check('webhook.number', 'n3', T0);
    for (let i = 0; i < 10; i++)
      expect((await rl.check('webhook.number', 'n3', T0 + 500)).allowed).toBe(
        false
      );
    expect((await rl.check('webhook.number', 'n3', T0 + 1000)).allowed).toBe(
      true
    );
  });
});

describe('MemoryRateStore pruning', () => {
  it('keeps only the hits inside the window', async () => {
    const s = new MemoryRateStore();
    for (let i = 0; i < 4; i++)
      await s.hit('webhook.number', 'p', 4, 1000, T0 + i);
    await s.hit('webhook.number', 'p', 4, 1000, T0 + 5000);
    expect(s.size('webhook.number', 'p')).toBe(1);
  });
});

describe('default scopes', () => {
  it('match the spec', () => {
    expect(DEFAULT_SCOPES).toEqual({
      'webhook.number': { limit: 4, windowMs: 1000, failOpen: true },
      'webhook.ip': { limit: 600, windowMs: 1000, failOpen: true },
      'admin.ip': { limit: 10, windowMs: 1000, failOpen: false },
      'admin.user': { limit: 30, windowMs: 1000, failOpen: false },
    });
  });

  it('an unknown scope is a programming error', async () => {
    await expect(
      new RateLimiter(new MemoryRateStore(), DEFAULT_SCOPES, quiet).check(
        'nope',
        'k'
      )
    ).rejects.toThrow(/not configured/);
  });
});

describe('store failure policy', () => {
  const broken: RateStore = {
    hit: async () => {
      throw new Error('db down');
    },
  };

  it('webhook scopes fail open with degraded:true and log', async () => {
    const log = { warn: vi.fn() };
    for (const scope of ['webhook.number', 'webhook.ip']) {
      const r = await new RateLimiter(broken, DEFAULT_SCOPES, log).check(
        scope,
        'k'
      );
      expect(r).toEqual({
        allowed: true,
        remaining: 0,
        retryAfterMs: 0,
        degraded: true,
      });
    }
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/failing open/),
      expect.objectContaining({ scope: 'webhook.number' })
    );
  });

  it('admin scopes fail closed with degraded:true', async () => {
    const log = { warn: vi.fn() };
    for (const scope of ['admin.ip', 'admin.user']) {
      const r = await new RateLimiter(broken, DEFAULT_SCOPES, log).check(
        scope,
        'k'
      );
      expect(r).toMatchObject({ allowed: false, degraded: true });
      expect(r.retryAfterMs).toBeGreaterThan(0);
    }
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/failing closed/),
      expect.anything()
    );
  });
});
