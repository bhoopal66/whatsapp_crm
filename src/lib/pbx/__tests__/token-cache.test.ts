import { describe, expect, it } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';
import { createTokenManager, type CachedTokens } from '../yeastar';
import { BASE, endpointOf, fakeFetch } from '../yeastar/__tests__/fixtures';
import { MAX_SWAP_ATTEMPTS, createDbTokenCache } from '../token-cache';
import { createFakeDb, type FakeDb, type Row } from './fake-db';

const NOW = Date.parse('2026-10-12T08:00:00Z');
const tokens = (access: string): CachedTokens => ({
  accessToken: access,
  accessTokenExpiresAt: NOW + 30 * 60_000,
  refreshToken: `${access}-refresh`,
  refreshTokenExpiresAt: NOW + 24 * 3600_000,
});

/** pbx_token_swap: compare-and-set on the stamp, as migration 089 does. */
function withSwap(fake: FakeDb, beforeSwap?: (row: Row, call: number) => void) {
  let calls = 0;
  let tick = 0;
  fake.rpcs.pbx_token_swap = (args) => {
    const row = fake.tables.pbx_connection_secrets.find(
      (r) => r.connection_id === args.p_connection_id
    )!;
    const col = args.p_kind === 'sdk' ? 'sdk_token_cache' : 'token_cache';
    beforeSwap?.(row, ++calls);
    if ((row[`${col}_updated_at`] ?? null) !== args.p_expected_updated_at) {
      return { data: false, error: null };
    }
    row[`${col}_enc`] = args.p_new_enc;
    row[`${col}_updated_at`] =
      `2026-10-12T08:00:00.${String(++tick).padStart(3, '0')}Z`;
    return { data: true, error: null };
  };
}

function setup(row: Row = {}) {
  const fake = createFakeDb({
    pbx_connection_secrets: [{ connection_id: 'c1', ...row }],
  });
  withSwap(fake);
  return fake;
}

describe('createDbTokenCache', () => {
  it('stores the tokens encrypted through pbx_token_swap, with the stamp it read', async () => {
    const fake = setup({ token_cache_updated_at: '2026-10-12T07:00:00.000Z' });
    const cache = createDbTokenCache(fake.db, 'c1', 'api');
    expect(await cache.read()).toBeNull();
    await cache.withLock(async () => cache.write(tokens('plaintext-token')));

    const swap = fake.log.find((l) => l.table === 'rpc:pbx_token_swap');
    expect(swap?.payload).toMatchObject({
      p_connection_id: 'c1',
      p_expected_updated_at: '2026-10-12T07:00:00.000Z',
      p_kind: 'api',
    });
    const stored = fake.tables.pbx_connection_secrets[0];
    expect(String(stored.token_cache_enc)).not.toContain('plaintext-token');
    expect(await cache.read()).toEqual(tokens('plaintext-token'));
    // The SDK pair has its own columns.
    expect(await createDbTokenCache(fake.db, 'c1', 'sdk').read()).toBeNull();
  });

  it('a locked function that writes nothing makes no swap', async () => {
    const fake = setup();
    const cache = createDbTokenCache(fake.db, 'c1', 'api');
    expect(await cache.withLock(async () => 'x')).toBe('x');
    expect(fake.log.some((l) => l.op === 'rpc')).toBe(false);
  });

  it('treats an unreadable cache as empty', async () => {
    const fake = setup({ token_cache_enc: 'not-ciphertext' });
    expect(await createDbTokenCache(fake.db, 'c1', 'api').read()).toBeNull();
    fake.tables.pbx_connection_secrets[0].token_cache_enc = encrypt('{"x":1}');
    expect(await createDbTokenCache(fake.db, 'c1', 'api').read()).toBeNull();
  });

  it("a lost swap hands back the winner's token, not the one it minted", async () => {
    const fake = createFakeDb({
      pbx_connection_secrets: [
        { connection_id: 'c1', token_cache_updated_at: null },
      ],
    });
    // Another process stores its token between our read and our swap.
    withSwap(fake, (row, call) => {
      if (call !== 1) return;
      row.token_cache_enc = encrypt(JSON.stringify(tokens('winner')));
      row.token_cache_updated_at = '2026-10-12T08:00:00.500Z';
    });
    const { fetch, calls } = fakeFetch(() => ({
      errcode: 0,
      errmsg: 'SUCCESS',
      access_token: 'loser',
      access_token_expire_time: 1800,
      refresh_token: 'loser-refresh',
      refresh_token_expire_time: 86400,
    }));
    const manager = createTokenManager({
      connection: { baseUrl: BASE, clientId: 'id', clientSecret: 'secret' },
      cache: createDbTokenCache(fake.db, 'c1', 'api'),
      fetch,
      now: () => NOW,
    });

    expect(await manager.getAccessToken()).toBe('winner');
    expect(calls.map(endpointOf)).toEqual(['get_token']);
    const reread = await createDbTokenCache(fake.db, 'c1', 'api').read();
    expect(reread?.accessToken).toBe('winner');
  });

  it(`gives up after ${MAX_SWAP_ATTEMPTS} lost swaps instead of keeping its own token`, async () => {
    const fake = setup();
    fake.rpcs.pbx_token_swap = () => ({ data: false, error: null });
    const cache = createDbTokenCache(fake.db, 'c1', 'api');
    await expect(
      cache.withLock(async () => {
        await cache.write(tokens('mine'));
        return 'mine';
      })
    ).rejects.toThrow(/compare-and-set/);
    expect(fake.log.filter((l) => l.op === 'rpc')).toHaveLength(
      MAX_SWAP_ATTEMPTS
    );
  });

  it('serialises locked work per connection and kind inside one process', async () => {
    const fake = setup();
    const order: string[] = [];
    const slow = (name: string) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${name}:end`);
    };
    // Two caches, as two requests would build them.
    await Promise.all([
      createDbTokenCache(fake.db, 'c1', 'api').withLock(slow('a')),
      createDbTokenCache(fake.db, 'c1', 'api').withLock(slow('b')),
    ]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('throws when the connection has no secrets row', async () => {
    const fake = createFakeDb({ pbx_connection_secrets: [] });
    const cache = createDbTokenCache(fake.db, 'c1', 'api');
    await expect(cache.withLock(async () => 1)).rejects.toThrow(
      /no secrets row/
    );
  });
});
