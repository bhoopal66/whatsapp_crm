// ============================================================
// API key store — the *auth-path* data access for public API keys.
//
// Only the read side lives here, and deliberately so: it runs with
// the service-role client because a public-API caller has no Supabase
// session, so RLS (which keys off `auth.uid()`) can't scope the
// lookup. The management side (list / create / revoke) runs in the
// dashboard under a real cookie session and goes through the RLS
// client *inline* in the route handlers — same pattern as
// `/api/account/invitations`. Keeping the RLS-bypassing surface tiny
// and read-only here makes it easy to audit.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';

/** Shape of an `api_keys` row as the auth path consumes it. */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  created_by: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Look up an *active* key by its SHA-256 hash. Returns null if no
 * row matches, or if the matching row is revoked or expired, or its
 * workspace is archived — so callers never have to re-check liveness.
 * Uses the service-role client (RLS-bypassing); the hash is the only
 * credential, so this is the moment that establishes the caller's
 * account.
 */
export async function findActiveKeyByHash(
  hash: string
): Promise<ApiKeyRow | null> {
  return (await lookupKeyByHash(hash)).key;
}

/**
 * findActiveKeyByHash, also saying whether a null `key` is a live key
 * of an archived workspace: a real key held back until the workspace is
 * restored, which requireApiKey does not count as a bad key.
 */
export async function lookupKeyByHash(
  hash: string
): Promise<{ key: ApiKeyRow | null; archived: boolean }> {
  const none = { key: null, archived: false };
  const { data, error } = await supabaseAdmin()
    .from('api_keys')
    .select('id, account_id, created_by, name, scopes, expires_at, revoked_at')
    .eq('key_hash', hash)
    .maybeSingle();

  if (error) {
    console.error('[api-keys/store] lookup error:', error.message);
    return none;
  }
  if (!data) return none;

  // Liveness checks in JS rather than SQL so the failure modes are
  // explicit and the index stays a simple equality lookup.
  if (data.revoked_at) return none;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return none;
  }

  // An archived workspace (migration 105) is closed to its keys too:
  // /api/v1, the MCP server and Compass stop until it is restored, and
  // the key works again then. A point lookup by id, not an embed: see
  // getCurrentAccount on PostgREST's schema cache (issue #294). Fails
  // closed, like the key lookup above.
  const { data: account, error: accountErr } = await supabaseAdmin()
    .from('accounts')
    .select('archived_at')
    .eq('id', data.account_id)
    .maybeSingle();
  if (accountErr) {
    console.error('[api-keys/store] account lookup error:', accountErr.message);
    return none;
  }
  if (!account) return none;
  if (account.archived_at) return { key: null, archived: true };

  return { key: data as ApiKeyRow, archived: false };
}

/**
 * Fetch the account name for a resolved key, so `/api/v1/me` and any
 * future endpoint can echo it without a second round trip in the
 * route. Service-role; the key already proved account membership.
 */
export async function getAccountName(
  accountId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('name')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  return (data.name as string) ?? null;
}

/**
 * Best-effort `last_used_at` bump. Fire-and-forget from the auth
 * path — a failed update just means the "last used" column lags;
 * it must never fail the request the caller is actually making.
 */
export function touchLastUsed(id: string): void {
  void supabaseAdmin()
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', id)
    .then(({ error }) => {
      if (error) {
        console.warn(
          '[api-keys/store] last_used_at bump failed:',
          error.message
        );
      }
    });
}
