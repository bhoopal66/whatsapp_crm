import { describe, it, expect, vi } from 'vitest';
import { guardAdmin, type AdminCtx } from '../admin';
import { AuthLockout, MemoryLockoutStore, type LockoutStore } from '../lockout';
import {
  DEFAULT_SCOPES,
  MemoryRateStore,
  RateLimiter,
  type RateStore,
} from '../ratelimit';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const MIN = 60_000;
const mk = (
  rate: RateStore = new MemoryRateStore(),
  lock: LockoutStore = new MemoryLockoutStore()
): AdminCtx => ({
  lockout: new AuthLockout(lock),
  limiter: new RateLimiter(rate, DEFAULT_SCOPES, { warn: vi.fn() }),
});
const boom = async (): Promise<never> => {
  throw new Error('db down');
};

describe('guardAdmin', () => {
  it('good credentials → 200', async () => {
    expect(
      await guardAdmin(mk(), { ip: '1.2.3.4', userId: 'u1', authOk: true }, T0)
    ).toEqual({ allowed: true, status: 200 });
  });

  it('bad credentials → 401; the 5th failure locks the IP → 423 with retryAfterMs', async () => {
    const c = mk();
    for (let i = 0; i < 5; i++)
      expect(
        (await guardAdmin(c, { ip: '5.5.5.5', authOk: false }, T0 + i * MIN))
          .status
      ).toBe(401);
    const d = await guardAdmin(
      c,
      { ip: '5.5.5.5', authOk: true },
      T0 + 5 * MIN
    );
    expect(d).toEqual({ allowed: false, status: 423, retryAfterMs: 14 * MIN });
    expect(
      (await guardAdmin(c, { ip: '6.6.6.6', authOk: true }, T0 + 5 * MIN))
        .status
    ).toBe(200);
    expect(
      (await guardAdmin(c, { ip: '5.5.5.5', authOk: true }, T0 + 19 * MIN))
        .status
    ).toBe(200);
  });

  it('a success clears earlier failures', async () => {
    const c = mk();
    for (let i = 0; i < 4; i++)
      await guardAdmin(c, { ip: '7.7.7.7', authOk: false }, T0 + i * 1000);
    await guardAdmin(c, { ip: '7.7.7.7', authOk: true }, T0 + 5000);
    for (let i = 0; i < 4; i++)
      await guardAdmin(
        c,
        { ip: '7.7.7.7', authOk: false },
        T0 + 6000 + i * 1000
      );
    expect(
      (await guardAdmin(c, { ip: '7.7.7.7', authOk: true }, T0 + 20_000)).status
    ).toBe(200);
  });

  it('over the per-IP rate (10/s) → 429', async () => {
    const c = mk();
    for (let i = 0; i < 10; i++)
      expect(
        (await guardAdmin(c, { ip: '8.8.8.8', authOk: true }, T0)).status
      ).toBe(200);
    const d = await guardAdmin(c, { ip: '8.8.8.8', authOk: true }, T0 + 1);
    expect(d).toMatchObject({ allowed: false, status: 429 });
    expect(d.retryAfterMs).toBeGreaterThan(0);
  });

  it('over the per-user rate (30/s) across IPs → 429', async () => {
    const c = mk();
    for (let i = 0; i < 30; i++)
      expect(
        (
          await guardAdmin(
            c,
            { ip: `9.0.0.${i % 5}`, userId: 'u9', authOk: true },
            T0
          )
        ).status
      ).toBe(200);
    expect(
      (await guardAdmin(c, { ip: '9.0.0.99', userId: 'u9', authOk: true }, T0))
        .status
    ).toBe(429);
  });

  it('a rate-limited request does not count as an auth failure', async () => {
    const c = mk();
    for (let i = 0; i < 10; i++)
      await guardAdmin(c, { ip: '4.4.4.4', authOk: true }, T0);
    for (let i = 0; i < 10; i++)
      expect(
        (await guardAdmin(c, { ip: '4.4.4.4', authOk: false }, T0)).status
      ).toBe(429);
    expect(await c.lockout.isLocked('4.4.4.4', T0)).toBe(false);
  });

  it('two IPv6 addresses in one /64 share the per-IP rate', async () => {
    const c = mk();
    for (let i = 0; i < 10; i++)
      expect(
        (
          await guardAdmin(
            c,
            { ip: `2001:db8:5:6::${i + 1}`, authOk: true },
            T0
          )
        ).status
      ).toBe(200);
    expect(
      (await guardAdmin(c, { ip: '2001:db8:5:6:ffff::1', authOk: true }, T0))
        .status
    ).toBe(429);
  });

  it('an IPv4-mapped address shares the lockout of the plain IPv4', async () => {
    const c = mk();
    for (let i = 0; i < 5; i++)
      await guardAdmin(
        c,
        {
          ip: i % 2 ? '::ffff:5.6.7.8' : '5.6.7.8',
          userId: 'u',
          authOk: false,
        },
        T0 + i * 1000
      );
    expect(
      (
        await guardAdmin(
          c,
          { ip: '5.6.7.8', userId: 'u', authOk: true },
          T0 + 6000
        )
      ).status
    ).toBe(423);
  });

  it('failures against user B survive a success by user A from the same IP', async () => {
    const c = mk();
    for (let i = 0; i < 4; i++)
      await guardAdmin(
        c,
        { ip: '2.2.2.2', userId: 'B', authOk: false },
        T0 + i * 1000
      );
    expect(
      (
        await guardAdmin(
          c,
          { ip: '2.2.2.2', userId: 'A', authOk: true },
          T0 + 5000
        )
      ).status
    ).toBe(200);
    await guardAdmin(
      c,
      { ip: '2.2.2.2', userId: 'B', authOk: false },
      T0 + 6000
    );
    expect(
      (
        await guardAdmin(
          c,
          { ip: '2.2.2.2', userId: 'B', authOk: true },
          T0 + 7000
        )
      ).status
    ).toBe(423);
  });

  it('broken rate store fails closed on admin → 429', async () => {
    const c = mk({ hit: boom });
    expect(
      await guardAdmin(c, { ip: '3.3.3.3', authOk: true }, T0)
    ).toMatchObject({ allowed: false, status: 429 });
  });

  it('a broken lockout store propagates (the host answers 500)', async () => {
    const c = mk(new MemoryRateStore(), {
      fail: boom,
      clear: boom,
      state: boom,
    });
    await expect(
      guardAdmin(c, { ip: '3.3.3.4', authOk: true }, T0)
    ).rejects.toThrow('db down');
  });

  it('user ids are case-insensitive for lockout and the user limit', async () => {
    const c = mk();
    for (let i = 0; i < 5; i++)
      await guardAdmin(
        c,
        { ip: '7.7.7.7', userId: i % 2 ? 'Bob' : 'bob', authOk: false },
        T0 + i * 1000
      );
    expect(
      (
        await guardAdmin(
          c,
          { ip: '7.7.7.7', userId: 'BOB', authOk: true },
          T0 + 6000
        )
      ).status
    ).toBe(423);
    const r = mk();
    for (let i = 0; i < 30; i++)
      await guardAdmin(
        r,
        { ip: `9.1.0.${i % 5}`, userId: i % 2 ? 'Eve' : 'eve', authOk: true },
        T0
      );
    expect(
      (await guardAdmin(r, { ip: '9.1.0.99', userId: 'EVE', authOk: true }, T0))
        .status
    ).toBe(429);
  });
});
