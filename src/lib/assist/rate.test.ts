// Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (test/019a/assist.pg.test.ts,
// "019a G7 rate limit atomic and fail-closed"). The reference ran against a real Postgres; here the limiter runs on a
// fake supabase-js client, and the SQL side (atomicity, per-key locks, prune, reset audit) is migration 120's.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS, RateLimiter, rateKey } from './rate';

type Answer = { data?: unknown; error?: { message: string; code?: string } };

class FakeDb {
  readonly calls: { fn: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly answer: (fn: string) => Answer | Error) {}
  async rpc(fn: string, args: Record<string, unknown>) {
    this.calls.push({ fn, args });
    const a = this.answer(fn);
    if (a instanceof Error) throw a;
    return { data: a.data ?? null, error: a.error ?? null };
  }
  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

const USER = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const quiet = { warn: () => {} };
const limiter = (db: FakeDb, opts = {}) =>
  new RateLimiter(db.client, { logger: quiet, ...opts });

describe('019a G7 rate limit', () => {
  it('takes the user and workspace slots in ONE assist_rate_take call (defaults 30/min and 300/min)', async () => {
    const db = new FakeDb(() => ({
      data: [{ allowed: true, denied_key: null, retry_after_ms: 0 }],
    }));
    expect(
      await limiter(db).check({ userId: USER, workspaceId: ACCOUNT })
    ).toEqual({
      allowed: true,
    });
    expect(db.calls).toEqual([
      {
        fn: 'assist_rate_take',
        args: {
          p_keys: [`assistant:user:${USER}`, `assistant:workspace:${ACCOUNT}`],
          p_limits: [30, 300],
          p_windows_ms: [60_000, 60_000],
        },
      },
    ]);
    expect(DEFAULT_RATE_LIMITS).toEqual({
      user: { limit: 30, windowMs: 60_000 },
      workspace: { limit: 300, windowMs: 60_000 },
    });
  });

  it('a refusal returns the refusing key and retryAfterMs', async () => {
    const key = `assistant:workspace:${ACCOUNT}`;
    const db = new FakeDb(() => ({
      data: [{ allowed: false, denied_key: key, retry_after_ms: '1234' }],
    }));
    expect(
      await limiter(db).check({ userId: USER, workspaceId: ACCOUNT })
    ).toEqual({
      allowed: false,
      reason: 'RATE_LIMITED',
      key,
      retryAfterMs: 1234,
    });
  });

  it('fails closed: an RPC error, a thrown call or no row is RATE_STATE_UNAVAILABLE, and is logged', async () => {
    const warned: string[] = [];
    const logger = { warn: (m: string) => warned.push(m) };
    const unavailable = { allowed: false, reason: 'RATE_STATE_UNAVAILABLE' };
    for (const answer of [
      { error: { message: 'boom', code: '57014' } },
      new Error('fetch failed'),
      { data: [] },
      { data: null },
    ]) {
      const db = new FakeDb(() => answer);
      expect(
        await new RateLimiter(db.client, { logger }).check({
          userId: USER,
          workspaceId: ACCOUNT,
        })
      ).toEqual(unavailable);
    }
    expect(warned).toHaveLength(2);
  });

  it('a malformed user or account id throws TypeError before any call', () => {
    const db = new FakeDb(() => ({ data: [{ allowed: true }] }));
    const l = limiter(db);
    expect(() => l.check({ userId: '7', workspaceId: ACCOUNT })).toThrow(
      TypeError
    );
    expect(() => l.check({ userId: USER, workspaceId: '' })).toThrow(TypeError);
    expect(() =>
      l.check({ userId: `${USER}:x`, workspaceId: ACCOUNT })
    ).toThrow(TypeError);
    expect(db.calls).toHaveLength(0);
    expect(() => rateKey('assistant')).toThrow(TypeError);
    expect(() => rateKey('Assistant', 'user', 'x')).toThrow(TypeError);
    expect(rateKey('assistant', 'user', 'x')).toBe('assistant:user:x');
  });

  it('rejects bad limits', () => {
    const db = new FakeDb(() => ({}));
    expect(() =>
      limiter(db, { limits: { user: { limit: -1, windowMs: 1 } } })
    ).toThrow(TypeError);
    expect(() =>
      limiter(db, { limits: { workspace: { limit: 1, windowMs: 0 } } })
    ).toThrow(TypeError);
  });

  it('resetKey is per key through assist_rate_reset (an owner connection); prune calls assist_rate_prune', async () => {
    const db = new FakeDb((fn) => ({
      data: fn === 'assist_rate_reset' ? 4 : 9,
    }));
    const l = limiter(db);
    const key = `assistant:user:${USER}`;
    expect(await l.resetKey(key, { actor: 'admin:1', reason: 'support' })).toBe(
      4
    );
    expect(await l.prune()).toBe(9);
    expect(db.calls).toEqual([
      {
        fn: 'assist_rate_reset',
        args: { p_key: key, p_actor: 'admin:1', p_reason: 'support' },
      },
      { fn: 'assist_rate_prune', args: {} },
    ]);
    await expect(
      l.resetKey('nokey', { actor: 'a', reason: 'r' })
    ).rejects.toThrow(TypeError);
    const denied = new FakeDb(() => ({
      error: { code: '42501', message: 'permission denied for row 7' },
    }));
    const err = await limiter(denied)
      .resetKey(key, { actor: 'a', reason: 'r' })
      .then(
        () => null,
        (e: Error) => e
      );
    // Function name and SQLSTATE only, never PostgREST's text.
    expect(err?.message).toBe('assist_rate_reset failed (42501)');
  });
});
