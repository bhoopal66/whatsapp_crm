import { describe, expect, it, vi } from 'vitest';
import { rateLimited } from '@/lib/api/v1/respond';
import { guardAdmin } from '@/lib/edge/admin';
import { AuthLockout, MemoryLockoutStore } from '@/lib/edge/lockout';
import {
  DEFAULT_SCOPES,
  MemoryRateStore,
  RateLimiter,
} from '@/lib/edge/ratelimit';
import { MemorySeenStore, ReplayGuard } from '@/lib/edge/replay';
import { screenWebhook, type ScreenEvent } from '@/lib/edge/screen';
import { edgeRefusals, type EdgeRefusal } from './registry';

const T0 = Date.parse('2026-10-04T10:00:00.000Z');
const count = (kind: EdgeRefusal) => edgeRefusals().value({ kind });

describe('edge refusals are counted where edge security refuses', () => {
  it('a locked sign-in', async () => {
    const c = {
      lockout: new AuthLockout(new MemoryLockoutStore()),
      limiter: new RateLimiter(new MemoryRateStore(), DEFAULT_SCOPES, {
        warn: vi.fn(),
      }),
    };
    for (let i = 0; i < 5; i++)
      await guardAdmin(c, { ip: '9.9.9.9', authOk: false }, T0 + i * 60_000);
    const before = count('signin_locked');
    const d = await guardAdmin(
      c,
      { ip: '9.9.9.9', authOk: true },
      T0 + 5 * 60_000
    );
    expect(d.status).toBe(423);
    expect(count('signin_locked') - before).toBe(1);
  });

  it('webhook duplicates and senders over their limit', async () => {
    const logger = { warn: vi.fn() };
    const c = {
      replay: new ReplayGuard(new MemorySeenStore()),
      limiter: new RateLimiter(new MemoryRateStore(), DEFAULT_SCOPES, logger),
      logger,
    };
    const msg = (id: string): ScreenEvent => ({
      key: `msg:${id}`,
      senderKey: '971501111111',
      kind: 'message',
    });
    const dup0 = count('webhook_duplicate');
    const lim0 = count('webhook_sender_limited');
    const r = await screenWebhook(
      c,
      {
        ip: '173.252.88.1',
        events: [msg('a'), msg('a'), ...['b', 'c', 'd', 'e', 'f'].map(msg)],
      },
      T0
    );
    const outcomes = r.decisions.map((d) => d.outcome);
    expect(count('webhook_duplicate') - dup0).toBe(
      outcomes.filter((o) => o === 'duplicate').length
    );
    expect(count('webhook_sender_limited') - lim0).toBe(
      outcomes.filter((o) => o === 'rate_limited').length
    );
    expect(count('webhook_duplicate') - dup0).toBeGreaterThan(0);
    expect(count('webhook_sender_limited') - lim0).toBeGreaterThan(0);
  });

  it('an API key over its budget', () => {
    const before = count('api_rate_limited');
    const err = rateLimited({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 1000,
    } as never);
    expect(err.status).toBe(429);
    expect(count('api_rate_limited') - before).toBe(1);
  });
});
