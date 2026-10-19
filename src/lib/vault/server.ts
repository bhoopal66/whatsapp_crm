/**
 * Server-only wiring for the vault (module 019c, migration 121): the store on the service-role client with the keys
 * from the environment (keys.ts). Routes check the caller first; the store passes the caller as p_actor and the
 * vault_* functions decide every permission. Never throws and never logs: a vault with no keys, bad keys or no
 * service-role client answers { ok: false, reason } with a fixed reason.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/groups/server';
import { loadVaultKeys, type VaultKeysResult } from './keys';
import { VaultStore } from './store';

export type VaultStoreResult =
  | { readonly ok: true; readonly store: VaultStore }
  | {
      readonly ok: false;
      readonly reason:
        Extract<VaultKeysResult, { ok: false }>['reason'] | 'UNAVAILABLE';
    };

export function vaultStore(
  env: Record<string, string | undefined> = process.env,
  admin: () => SupabaseClient = supabaseAdmin
): VaultStoreResult {
  const keys = loadVaultKeys(env);
  if (!keys.ok) return { ok: false, reason: keys.reason };
  try {
    return {
      ok: true,
      store: new VaultStore(admin(), keys.keys, keys.blindKey),
    };
  } catch {
    // createClient throws without a service-role key; the error text is not passed on.
    return { ok: false, reason: 'UNAVAILABLE' };
  }
}
