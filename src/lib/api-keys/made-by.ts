// ============================================================
// Who made a live API key, for the hand-over screens (Settings →
// Members). A key outlives its maker's role: an integration may run on
// it, so nothing here revokes anything; the screens list the keys and
// an admin chooses (DELETE /api/account/api-keys/[id]).
//
// Reads go through the caller's client, as an admin: RLS already lets
// an admin read `api_keys` with `created_by`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { hasMinRole, isAccountRole } from '@/lib/auth/roles';

export interface MadeKey {
  id: string;
  name: string;
  lastUsedAt: string | null;
  /** auth user id of the maker; null once their login is gone. */
  createdBy: string | null;
}

interface KeyRow {
  id: string;
  name: string;
  last_used_at: string | null;
  created_by: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * The account's live keys: not revoked, not expired. Null when the read
 * failed, so a screen can say "could not be read" rather than "none".
 */
export async function listLiveKeys(
  supabase: SupabaseClient,
  accountId: string,
  now: number = Date.now()
): Promise<MadeKey[] | null> {
  let data: unknown;
  try {
    const res = await supabase
      .from('api_keys')
      .select('id, name, last_used_at, created_by, expires_at, revoked_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    if (res.error) {
      console.error('[api-keys/made-by] read error:', res.error.message);
      return null;
    }
    data = res.data;
  } catch (err) {
    console.error('[api-keys/made-by] read failed:', err);
    return null;
  }
  if (!Array.isArray(data)) return null;
  return (data as KeyRow[])
    .filter(
      (k) =>
        !k.revoked_at &&
        !(k.expires_at && new Date(k.expires_at).getTime() <= now)
    )
    .map((k) => ({
      id: k.id,
      name: k.name,
      lastUsedAt: k.last_used_at ?? null,
      createdBy: k.created_by ?? null,
    }));
}

/** A roster row, as far as the rule below needs it. */
export interface KeyMaker {
  user_id: string;
  account_role: string;
  deactivated_at: string | null;
}

/**
 * The keys whose maker no longer stands behind them: deactivated, no
 * longer admin or owner, no longer a member of the workspace, or unknown
 * (NULL). `people` is the workspace's profile rows.
 */
export function keysOfLeavers(
  keys: readonly MadeKey[],
  people: readonly KeyMaker[]
): MadeKey[] {
  const byId = new Map(people.map((p) => [p.user_id, p]));
  return keys.filter((k) => {
    const maker = k.createdBy ? byId.get(k.createdBy) : undefined;
    if (!maker) return true;
    if (maker.deactivated_at) return true;
    return !(
      isAccountRole(maker.account_role) &&
      hasMinRole(maker.account_role, 'admin')
    );
  });
}

/** The routes' `keys`: null (not readable) for anything but a list. */
export function parseMadeKeys(value: unknown): MadeKey[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((r: Record<string, unknown> | null) =>
    typeof r?.id === 'string'
      ? [
          {
            id: r.id,
            name: typeof r.name === 'string' ? r.name : '',
            lastUsedAt: typeof r.lastUsedAt === 'string' ? r.lastUsedAt : null,
            createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
          },
        ]
      : []
  );
}
