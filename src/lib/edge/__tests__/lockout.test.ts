import { describe, it, expect } from 'vitest';
import { AuthLockout, LOCKOUT, MemoryLockoutStore } from '../lockout';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const MIN = 60_000;
const mk = () => new AuthLockout(new MemoryLockoutStore());

describe('AuthLockout (memory)', () => {
  it('defaults: 5 per (ip, user), 20 per ip, 10-minute window, 15-minute lock', () => {
    expect(LOCKOUT).toEqual({
      ipMax: 20,
      userMax: 5,
      windowMs: 10 * MIN,
      lockMs: 15 * MIN,
    });
  });

  it('5 failures within 10 minutes lock the IP for 15 minutes', async () => {
    const lo = mk();
    const ip = '10.0.0.1';
    for (let i = 0; i < 4; i++)
      expect((await lo.recordFailure(ip, T0 + i * MIN)).locked).toBe(false);
    expect(await lo.isLocked(ip, T0 + 4 * MIN)).toBe(false);
    const fifth = await lo.recordFailure(ip, T0 + 9 * MIN);
    expect(fifth).toEqual({ locked: true, retryAfterMs: 15 * MIN });
    expect(await lo.isLocked(ip, T0 + 9 * MIN)).toBe(true);
    expect(await lo.isLocked('10.9.9.9', T0 + 9 * MIN)).toBe(false);
  });

  it('the lock expires after 15 minutes', async () => {
    const lo = mk();
    const ip = '10.0.0.2';
    for (let i = 0; i < 5; i++) await lo.recordFailure(ip, T0);
    expect(await lo.isLocked(ip, T0 + 15 * MIN - 1)).toBe(true);
    expect(await lo.isLocked(ip, T0 + 15 * MIN)).toBe(false);
    expect((await lo.recordFailure(ip, T0 + 16 * MIN)).locked).toBe(false); // fresh window
  });

  it('failures spread beyond the 10-minute window do not lock', async () => {
    const lo = mk();
    const ip = '10.0.0.3';
    for (let i = 0; i < 8; i++) await lo.recordFailure(ip, T0 + i * 3 * MIN);
    expect(await lo.isLocked(ip, T0 + 21 * MIN)).toBe(false);
  });

  it('7 failures in 200 ms straddling a fixed-window edge lock (sliding log)', async () => {
    const lo = mk();
    const ip = '10.0.0.5';
    await lo.recordFailure(ip, T0);
    const edge = T0 + 10 * MIN;
    for (const dt of [-100, -60, -20, 20, 60, 90, 100])
      await lo.recordFailure(ip, edge + dt);
    expect(await lo.isLocked(ip, edge + 100)).toBe(true);
  });

  it("a success for user A clears neither user B's failures nor the ip count", async () => {
    const lo = mk();
    const ip = '10.0.0.6';
    for (let i = 0; i < 4; i++) await lo.recordFailure(ip, T0, 'B');
    for (let i = 0; i < 4; i++) await lo.recordFailure(ip, T0, 'A');
    await lo.recordSuccess(ip, 'A');
    expect(await lo.isLocked(ip, T0, 'A')).toBe(false);
    expect((await lo.recordFailure(ip, T0 + 1, 'B')).locked).toBe(true);
    expect(await lo.isLocked(ip, T0 + 1, 'A')).toBe(false); // B's pair lock is not A's
    expect((await lo.recordFailure(ip, T0 + 2, 'A')).locked).toBe(false); // A's count restarted at 1
    for (let i = 0; i < 11; i++) await lo.recordFailure(ip, T0 + 3, `u${i}`); // 9 + 11 = 20 in the window
    expect(await lo.isLocked(ip, T0 + 3, 'fresh')).toBe(true);
  });

  it('20 failures from one ip across many users lock the whole ip for 15 minutes', async () => {
    const lo = mk();
    const ip = '10.0.0.7';
    for (let i = 0; i < 19; i++)
      expect(
        (await lo.recordFailure(ip, T0 + i * 1000, `user${i}`)).locked
      ).toBe(false);
    expect(await lo.isLocked(ip, T0 + 19_000, 'someone')).toBe(false);
    expect(await lo.recordFailure(ip, T0 + 19_000, 'user19')).toEqual({
      locked: true,
      retryAfterMs: 15 * MIN,
    });
    expect(await lo.isLocked(ip, T0 + 19_000, 'someone')).toBe(true);
    expect(await lo.isLocked(ip, T0 + 19_000)).toBe(true);
    expect(await lo.isLocked('10.0.0.8', T0 + 19_000, 'someone')).toBe(false);
    expect(await lo.isLocked(ip, T0 + 19_000 + 15 * MIN, 'someone')).toBe(
      false
    ); // expired
  });

  it('success clears the failure count', async () => {
    const lo = mk();
    const ip = '10.0.0.4';
    for (let i = 0; i < 4; i++) await lo.recordFailure(ip, T0);
    await lo.recordSuccess(ip);
    for (let i = 0; i < 4; i++) await lo.recordFailure(ip, T0 + 1);
    expect(await lo.isLocked(ip, T0 + 1)).toBe(false);
  });
});
