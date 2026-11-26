// The secret columns of `whatsapp_config`, server-only.
//
// Since migration 285 no signed-in session may read them, whatever its
// role: the columns are not granted. So a read that needs one is two
// reads. The caller's own client answers which rows it may see (RLS, as
// before) and this module adds the secrets of exactly those rows through
// the service role. Keep that order: reading the rows here as well would
// make application code, not RLS, decide whose numbers these are.

import { supabaseAdmin } from '@/lib/flows/admin-client';

export const CHANNEL_SECRET_COLUMNS = [
  'access_token',
  'verify_token',
  'app_secret',
] as const;

export type ChannelSecretColumn = (typeof CHANNEL_SECRET_COLUMNS)[number];

/**
 * `rows`, each with the named secrets (still ciphertext). A row that
 * already carries them is left alone. Throws when the read fails, or
 * when a row is gone by now: a number without its token must never read
 * as a number whose token is empty.
 */
export async function withChannelSecrets<
  T extends { id: string },
  K extends ChannelSecretColumn,
>(
  rows: T[],
  columns: readonly K[]
): Promise<Array<T & Record<K, string | null>>> {
  type Full = T & Record<K, string | null>;
  const lacking = rows.filter((r) => columns.some((c) => !(c in r)));
  if (lacking.length === 0) return rows as Full[];

  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select(['id', ...columns].join(', '))
    .in(
      'id',
      lacking.map((r) => r.id)
    );
  if (error) throw new Error(`channel secrets: ${error.message}`);
  const byId = new Map(
    ((data ?? []) as unknown as Array<{ id: string }>).map((r) => [r.id, r])
  );
  return rows.map((r) => {
    if (columns.every((c) => c in r)) return r as Full;
    const found = byId.get(r.id);
    if (!found) throw new Error(`channel secrets: no row ${r.id}`);
    return { ...r, ...found } as Full;
  });
}
