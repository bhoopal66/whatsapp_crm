import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateApiKey } from '@/lib/api-keys/keys';
import type { ApiKeyRow } from '@/lib/api-keys/store';
import { ApiError } from '@/lib/api/v1/respond';
import { __resetRateLimitForTests, RATE_LIMITS } from '@/lib/rate-limit';
import { AuthLockout, MemoryLockoutStore, type LockoutStore } from '@/lib/edge';

// Mock the service-role client factory — requireApiKey only stashes
// the returned client in the context; tests never call through it.
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ __isMockAdminClient: true }),
}));

// Mock the store so we control which row a hash resolves to.
const findActiveKeyByHash =
  vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
const touchLastUsed = vi.fn();
vi.mock('@/lib/api-keys/store', () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  touchLastUsed: (id: string) => touchLastUsed(id),
}));

// The bad-key lockout: the real AuthLockout over a memory store, fresh
// per test (the Postgres store is migration 084's).
const guards = vi.hoisted(() => ({ lockout: null as unknown }));
vi.mock('@/lib/auth/edge-guards', () => ({
  edgeAuthGuards: () => guards,
}));

// Import AFTER the mocks are registered.
const { requireApiKey } = await import('./api-context');

const KEY = generateApiKey().plaintext;

function reqWith(authHeader?: string, ip?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader) headers.authorization = authHeader;
  if (ip) headers['cf-connecting-ip'] = ip;
  return new Request('https://crm.example.com/api/v1/me', { headers });
}

let lockStore: LockoutStore;

function row(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 'key-1',
    account_id: 'acct-1',
    created_by: 'user-1',
    name: 'Test key',
    scopes: ['messages:send'],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  lockStore = new MemoryLockoutStore();
  guards.lockout = new AuthLockout(lockStore);
  __resetRateLimitForTests();
  findActiveKeyByHash.mockReset();
  touchLastUsed.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetRateLimitForTests();
});

async function expectApiError(
  p: Promise<unknown>,
  code: string,
  status: number
) {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await p.catch((e: unknown) => {
    const err = e as ApiError;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
}

describe('requireApiKey', () => {
  it('401s when no Authorization header is present', async () => {
    await expectApiError(requireApiKey(reqWith()), 'unauthorized', 401);
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s on a token that doesn't look like a Taamul Connect key", async () => {
    await expectApiError(
      requireApiKey(reqWith('Bearer some-invite-token')),
      'unauthorized',
      401
    );
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it('401s when the key is unknown / revoked / expired (store returns null)', async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      'unauthorized',
      401
    );
  });

  it('returns a context for a valid key with no scope required', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`));
    expect(ctx.authType).toBe('api_key');
    expect(ctx.accountId).toBe('acct-1');
    expect(ctx.keyId).toBe('key-1');
    expect(ctx.scopes).toEqual(['messages:send']);
    expect(touchLastUsed).toHaveBeenCalledWith('key-1');
  });

  it("accepts a bare key without the 'Bearer ' prefix", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(KEY));
    expect(ctx.accountId).toBe('acct-1');
  });

  it('403s when the key lacks the required scope', async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ['contacts:read'] }));
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`), 'messages:send'),
      'forbidden',
      403
    );
  });

  it('passes when the key has the required scope', async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ['messages:send'] }));
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`), 'messages:send');
    expect(ctx.accountId).toBe('acct-1');
  });

  it('429s once the per-key budget is exhausted', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    // Burn the whole window.
    for (let i = 0; i < RATE_LIMITS.publicApi.limit; i++) {
      await requireApiKey(reqWith(`Bearer ${KEY}`));
    }
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      'rate_limited',
      429
    );
  });
});

describe('requireApiKey bad-key lockout', () => {
  const IP = '203.0.113.7';
  const bad = () => requireApiKey(reqWith(`Bearer ${KEY}`, IP));

  beforeEach(() => {
    vi.stubEnv('EDGE_CLIENT_IP_HEADER', 'cf-connecting-ip');
    findActiveKeyByHash.mockResolvedValue(null);
  });

  it('refuses an IP after 5 bad keys, as rate_limited, before the lookup', async () => {
    for (let i = 0; i < 5; i++)
      await expectApiError(bad(), 'unauthorized', 401);
    findActiveKeyByHash.mockResolvedValue(row());
    const locked = requireApiKey(reqWith(`Bearer ${KEY}`, IP));
    await expectApiError(locked, 'rate_limited', 429);
    const err = (await locked.catch((e: unknown) => e)) as ApiError;
    // The per-key limit's answer, word for word and header for header.
    expect(err.message).toBe('Rate limit exceeded for this API key');
    expect(Object.keys(err.headers ?? {}).sort()).toEqual([
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ]);
    expect(Number(err.headers?.['Retry-After'])).toBeGreaterThan(890);
    expect(findActiveKeyByHash).toHaveBeenCalledTimes(5);
    // Another IP is not locked.
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`, '198.51.100.9'));
    expect(ctx.keyId).toBe('key-1');
  });

  it('a good key clears the run of bad ones', async () => {
    for (let i = 0; i < 4; i++)
      await expectApiError(bad(), 'unauthorized', 401);
    findActiveKeyByHash.mockResolvedValueOnce(row());
    await requireApiKey(reqWith(`Bearer ${KEY}`, IP));
    for (let i = 0; i < 4; i++)
      await expectApiError(bad(), 'unauthorized', 401);
    findActiveKeyByHash.mockResolvedValueOnce(row());
    expect((await requireApiKey(reqWith(`Bearer ${KEY}`, IP))).keyId).toBe(
      'key-1'
    );
  });

  it('is off without a client IP, rather than one bucket for every caller', async () => {
    vi.stubEnv('EDGE_CLIENT_IP_HEADER', '');
    for (let i = 0; i < 25; i++) {
      await expectApiError(
        requireApiKey(reqWith(`Bearer ${KEY}`)),
        'unauthorized',
        401
      );
    }
    findActiveKeyByHash.mockResolvedValue(row());
    expect((await requireApiKey(reqWith(`Bearer ${KEY}`))).keyId).toBe('key-1');
  });

  it('fails open when the lockout store is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = async () => {
      throw new Error('db down');
    };
    vi.spyOn(lockStore, 'state').mockImplementation(down);
    vi.spyOn(lockStore, 'fail').mockImplementation(down);
    vi.spyOn(lockStore, 'clear').mockImplementation(down);
    for (let i = 0; i < 6; i++)
      await expectApiError(bad(), 'unauthorized', 401);
    findActiveKeyByHash.mockResolvedValue(row());
    expect((await requireApiKey(reqWith(`Bearer ${KEY}`, IP))).keyId).toBe(
      'key-1'
    );
    expect(warn).toHaveBeenCalled();
  });
});
