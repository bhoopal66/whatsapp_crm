import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateApiKey, hashApiKey } from '@/lib/api-keys/keys';
import { toApiErrorResponse } from '@/lib/api/v1/respond';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

// The service-role client over two in-memory tables: api_keys by
// key_hash, accounts by id. Only the calls the auth path makes.
const db = vi.hoisted(() => ({
  apiKeys: new Map<string, Record<string, unknown>>(),
  accounts: new Map<string, Record<string, unknown>>(),
  accountsError: null as { message: string } | null,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => {
            if (table === 'accounts' && db.accountsError) {
              return { data: null, error: db.accountsError };
            }
            const rows = table === 'api_keys' ? db.apiKeys : db.accounts;
            return { data: rows.get(value) ?? null, error: null };
          },
        }),
      }),
      // touchLastUsed's fire-and-forget bump.
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}));
vi.mock('@/lib/auth/edge-guards', () => ({ edgeAuthGuards: () => ({}) }));

const { findActiveKeyByHash } = await import('./store');
const { requireApiKey } = await import('@/lib/auth/api-context');

const KEY = generateApiKey().plaintext;
const HASH = hashApiKey(KEY);

function request(): Request {
  return new Request('https://crm.example.com/api/v1/me', {
    headers: { authorization: `Bearer ${KEY}` },
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
  db.accountsError = null;
  db.apiKeys.clear();
  db.accounts.clear();
  db.apiKeys.set(HASH, {
    id: 'key-1',
    account_id: 'acct-1',
    created_by: 'user-1',
    name: 'Compass',
    scopes: ['contacts:read'],
    expires_at: null,
    revoked_at: null,
  });
  db.accounts.set('acct-1', { archived_at: null });
});

describe('findActiveKeyByHash', () => {
  it('resolves a live key of a live workspace', async () => {
    await expect(findActiveKeyByHash(HASH)).resolves.toMatchObject({
      id: 'key-1',
      account_id: 'acct-1',
    });
  });

  it('refuses a revoked key', async () => {
    db.apiKeys.get(HASH)!.revoked_at = '2026-10-01T00:00:00Z';
    await expect(findActiveKeyByHash(HASH)).resolves.toBeNull();
  });

  // Migration 105: an archived workspace is closed to its keys too.
  it('refuses a key of an archived workspace, and takes it back on restore', async () => {
    db.accounts.set('acct-1', { archived_at: '2026-10-13T08:00:00Z' });
    await expect(findActiveKeyByHash(HASH)).resolves.toBeNull();

    db.accounts.set('acct-1', { archived_at: null });
    await expect(findActiveKeyByHash(HASH)).resolves.not.toBeNull();
  });

  it('fails closed when the workspace cannot be read', async () => {
    db.accountsError = { message: 'connection reset' };
    await expect(findActiveKeyByHash(HASH)).resolves.toBeNull();
  });
});

describe('requireApiKey with an archived workspace', () => {
  it('answers 401 unauthorized, as for any unusable key', async () => {
    db.accounts.set('acct-1', { archived_at: '2026-10-13T08:00:00Z' });
    const err = await requireApiKey(request()).catch((e: unknown) => e);
    const res = toApiErrorResponse(err);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'unauthorized', message: 'Missing or invalid API key' },
    });

    db.accounts.set('acct-1', { archived_at: null });
    await expect(requireApiKey(request())).resolves.toMatchObject({
      accountId: 'acct-1',
      keyId: 'key-1',
    });
  });
});
