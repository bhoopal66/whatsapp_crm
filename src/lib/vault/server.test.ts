// The vault's server wiring: no keys means no store, and building it never throws.
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/groups/server', () => ({
  supabaseAdmin: () => {
    throw new Error('supabaseKey is required: secret-ish detail');
  },
}));

import { vaultStore } from './server';
import { VaultStore } from './store';

const b64 = (n: number) => randomBytes(n).toString('base64');
const ENV = {
  VAULT_KEYS: `k1:${b64(32)}`,
  VAULT_CURRENT_KEY: 'k1',
  VAULT_BLIND_KEY: b64(32),
};
const fakeAdmin = () => ({ rpc: vi.fn() }) as unknown as SupabaseClient;

describe('vaultStore', () => {
  it('no vault keys: NOT_CONFIGURED, and no client is built', () => {
    const admin = vi.fn(fakeAdmin);
    expect(vaultStore({}, admin)).toEqual({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
    expect(admin).not.toHaveBeenCalled();
  });

  it('bad keys pass the loader reason through', () => {
    expect(vaultStore({ ...ENV, VAULT_CURRENT_KEY: 'k9' }, fakeAdmin)).toEqual({
      ok: false,
      reason: 'INVALID_CURRENT_KEY',
    });
  });

  it('configured: a VaultStore on the service-role client', () => {
    const r = vaultStore(ENV, fakeAdmin);
    expect(r.ok && r.store).toBeInstanceOf(VaultStore);
  });

  it('a client that cannot be built is UNAVAILABLE, not an exception', () => {
    expect(vaultStore(ENV)).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  });
});
