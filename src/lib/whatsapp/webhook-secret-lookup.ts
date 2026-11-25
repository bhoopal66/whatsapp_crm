/**
 * The `whatsapp_config` row a webhook secret belongs to (Whapi's
 * `?secret=`, Meta's `hub.verify_token`), through a per-process
 * SecretIndex so an anonymous flood of wrong secrets cannot make every
 * request read and decrypt every row (secret-index.ts says how).
 *
 * A hit re-reads that one row by id and compares the secret again in
 * constant time: what the route gets is always the row as it is now.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { secretsMatch } from '@/lib/whatsapp/whapi-webhook-auth';
import { SecretIndex } from './secret-index';

type Provider = 'whapi' | 'meta';
type KeyRow = { id: string; verify_token: string | null };

const indexes = new Map<Provider, SecretIndex<KeyRow>>();

function indexFor(provider: Provider, db: () => SupabaseClient) {
  let idx = indexes.get(provider);
  if (!idx) {
    idx = new SecretIndex<KeyRow>({
      loadAll: async () => {
        const { data, error } = await db()
          .from('whatsapp_config')
          .select('id, verify_token')
          .eq('provider', provider);
        if (error || !data) {
          console.error(
            `[webhook-secret] could not load ${provider} configs:`,
            error
          );
          return null;
        }
        return data as KeyRow[];
      },
      idOf: (r) => r.id,
      // A row encrypted under a rotated ENCRYPTION_KEY throws and is
      // skipped, as before.
      secretOf: (r) => (r.verify_token ? decrypt(r.verify_token) : null),
    });
    indexes.set(provider, idx);
  }
  return idx;
}

/** Tests: start each case from an empty index. */
export function resetWebhookSecretIndexes(): void {
  indexes.clear();
}

/** The whole row whose secret this is, or null; `failed` when the
 *  configs could not be read at all (the route answers 503). */
export async function findConfigBySecret(
  provider: Provider,
  secret: string,
  db: () => SupabaseClient
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ failed: boolean; row: any | null }> {
  const hit = await indexFor(provider, db).find(secret);
  if (hit.failed) return { failed: true, row: null };
  if (!hit.id) return { failed: false, row: null };
  const { data, error } = await db()
    .from('whatsapp_config')
    .select('*')
    .eq('id', hit.id)
    .eq('provider', provider)
    .maybeSingle();
  if (error) {
    console.error(
      `[webhook-secret] could not load the ${provider} config:`,
      error
    );
    return { failed: true, row: null };
  }
  if (!data?.verify_token) return { failed: false, row: null };
  try {
    return secretsMatch(secret, decrypt(data.verify_token))
      ? { failed: false, row: data }
      : { failed: false, row: null };
  } catch {
    return { failed: false, row: null };
  }
}
